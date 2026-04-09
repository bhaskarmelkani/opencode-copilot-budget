/** @jsxImportSource @opentui/solid */
/**
 * opencode-copilot-budget
 *
 * Displays your GitHub Copilot premium request budget in the OpenCode TUI
 * sidebar. Refreshes after prompt submit, after each AI response, and via an
 * inline manual refresh action. Only visible when the active provider is
 * `github-copilot`.
 *
 * Display format:
 *   Copilot Budget
 *   ████████░░░░░░░░ 12% Used Refresh 🔄
 *   117 / 1000 Premium Requests
 *   Resets on 1 May
 *
 * Token discovery (in priority order):
 *   1. GITHUB_TOKEN environment variable
 *   2. GH_TOKEN environment variable
 *   3. `gh auth token` (GitHub CLI)
 *
 * Install:
 *   opencode plugin opencode-copilot-budget
 *
 * Or add manually to ~/.config/opencode/tui.json:
 *   { "plugin": ["opencode-copilot-budget"] }
 */

import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, createResource, createSignal, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const id = "copilot-budget.sidebar"

const execFileAsync = promisify(execFile)

const COPILOT_USER_ENDPOINT = "https://api.github.com/copilot_internal/user"
const CACHE_TTL_MS = 5 * 60 * 1000
const REQUEST_TIMEOUT_MS = 10_000
const BAR_WIDTH = 16
const BAR_FILL_COLOR = "#3fb950" // GitHub green
const BAR_DANGER_COLOR = "#f85149" // red when >= 90%

// VS Code impersonation headers — kept as constants for easy version updates
const EDITOR_VERSION = "vscode/1.96.2"
const EDITOR_PLUGIN_VERSION = "copilot-chat/0.26.7"
const USER_AGENT = "GitHubCopilotChat/0.26.7"
const GITHUB_API_VERSION = "2026-01-01"

// ─── Types ───────────────────────────────────────────────────────────────────

type CopilotUsageData = {
  used: number
  entitlement: number
  percent: number
  unlimited: boolean
  overageCount: number
  overagePermitted: boolean
  resetDate: string | null
  tier: "paid" | "free"
}

type CopilotBudgetOptions = {
  title?: string
}

// ─── Cache ───────────────────────────────────────────────────────────────────

type CacheEntry = { data: CopilotUsageData | null; timestamp: number }
let _cache: CacheEntry | null = null

function bustCache() {
  _cache = null
}

// ─── Token Discovery ─────────────────────────────────────────────────────────

async function discoverToken(): Promise<string | null> {
  // 1. GITHUB_TOKEN — standard env var (CI / devcontainers / manual export)
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN

  // 2. GH_TOKEN — alias used by GitHub CLI and many CI environments
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN

  // 3. GitHub CLI — for users who ran `gh auth login`
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], { timeout: 5_000 })
    const token = stdout.trim()
    if (token) return token
  } catch {
    // gh not installed or not authenticated — silent fallthrough
  }

  return null
}

// ─── Response Parsing ────────────────────────────────────────────────────────

function parseResponse(body: unknown): CopilotUsageData | null {
  if (!body || typeof body !== "object") return null
  const data = body as Record<string, unknown>

  // Paid tier: quota_snapshots.premium_interactions
  const snapshots = data.quota_snapshots as Record<string, unknown> | undefined
  if (snapshots?.premium_interactions && typeof snapshots.premium_interactions === "object") {
    const pi = snapshots.premium_interactions as Record<string, unknown>
    const entitlement = Number(pi.entitlement ?? 0)
    const remaining = Number(pi.remaining ?? 0)
    const unlimited = Boolean(pi.unlimited)
    const used = unlimited
      ? Number(pi.used ?? Math.max(0, entitlement - remaining))
      : Math.max(0, entitlement - remaining)
    const percent = unlimited || entitlement === 0 ? 0 : Math.round((used / entitlement) * 100)

    return {
      used: Math.round(used),
      entitlement,
      percent,
      unlimited,
      overageCount: Number(pi.overage_count ?? 0),
      overagePermitted: Boolean(pi.overage_permitted),
      resetDate: (data.quota_reset_date_utc as string | undefined) ?? null,
      tier: "paid",
    }
  }

  // Free tier: limited_user_quotas or monthly_quotas
  const luq = data.limited_user_quotas as Record<string, unknown> | undefined
  const mq = data.monthly_quotas as Record<string, unknown> | undefined
  if (luq || mq) {
    const piLuq = (luq?.premium_interactions as Record<string, unknown> | undefined) ?? {}
    const piMq = (mq?.premium_interactions as Record<string, unknown> | undefined) ?? {}
    const pi = Object.keys(piLuq).length ? piLuq : piMq

    // Both sources empty — can't derive meaningful usage data
    if (!Object.keys(pi).length) return null

    const entitlement = Number(pi.entitlement ?? 0)
    const remaining = Number(pi.remaining ?? 0)
    const unlimited = Boolean(pi.unlimited)
    const used = Math.max(0, entitlement - remaining)
    const percent = unlimited || entitlement === 0 ? 0 : Math.round((used / entitlement) * 100)
    const resetDate =
      (data.limited_user_reset_date as string | undefined) ??
      (data.quota_reset_date_utc as string | undefined) ??
      null

    return {
      used: Math.round(used),
      entitlement,
      percent,
      unlimited,
      overageCount: 0,
      overagePermitted: false,
      resetDate,
      tier: "free",
    }
  }

  return null
}

// ─── Fetch (with caching) ────────────────────────────────────────────────────

async function fetchCopilotUsage(): Promise<CopilotUsageData | null> {
  if (_cache !== null && Date.now() - _cache.timestamp < CACHE_TTL_MS) {
    return _cache.data
  }

  const token = await discoverToken()
  if (!token) {
    _cache = { data: null, timestamp: Date.now() }
    return null
  }

  try {
    const response = await fetch(COPILOT_USER_ENDPOINT, {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/json",
        // Match the headers sent by VS Code's official Copilot Chat extension.
        "Editor-Version": EDITOR_VERSION,
        "Editor-Plugin-Version": EDITOR_PLUGIN_VERSION,
        "User-Agent": USER_AGENT,
        "X-Github-Api-Version": GITHUB_API_VERSION,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!response.ok) {
      _cache = { data: null, timestamp: Date.now() }
      return null
    }

    const body = (await response.json()) as unknown
    const parsed = parseResponse(body)
    _cache = { data: parsed, timestamp: Date.now() }
    return parsed
  } catch {
    _cache = { data: null, timestamp: Date.now() }
    return null
  }
}

// ─── UI ──────────────────────────────────────────────────────────────────────

function formatResetDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString(undefined, { day: "numeric", month: "long" })
  } catch {
    return dateStr
  }
}

function ProgressBar(props: { percent: number }) {
  const clampedPercent = Math.min(100, Math.max(0, props.percent))
  const filled = Math.round((clampedPercent / 100) * BAR_WIDTH)
  const empty = BAR_WIDTH - filled
  const color = clampedPercent >= 90 ? BAR_DANGER_COLOR : BAR_FILL_COLOR
  return (
    <text fg={color}>{`${"▬".repeat(filled)}${"╌".repeat(empty)} ${clampedPercent}% Used`}</text>
  )
}

function resolveTitle(options: unknown): string {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return "Copilot Budget"
  }

  const title = (options as CopilotBudgetOptions).title
  return typeof title === "string" && title.trim() ? title.trim() : "Copilot Budget"
}

function RefreshButton(props: { api: TuiPluginApi; refresh: () => void; disabled: boolean }) {
  const theme = () => props.api.theme.current

  return (
    <box
      onMouseUp={() => {
        if (props.disabled) return
        props.refresh()
      }}
      paddingLeft={1}
    >
      <text fg={props.disabled ? theme().textMuted : theme().primary}>
        <b>Refresh 🔄</b>
      </text>
    </box>
  )
}

function UsageDetail(props: { api: TuiPluginApi; title: string }) {
  const theme = () => props.api.theme.current
  const [usage, { refetch }] = createResource(fetchCopilotUsage)
  const [manualRefreshing, setManualRefreshing] = createSignal(false)

  const autosync = () => {
    bustCache()
    void refetch()
  }

  const refresh = async () => {
    setManualRefreshing(true)
    bustCache()
    try {
      await refetch()
    } finally {
      setManualRefreshing(false)
    }
  }

  const triggerRefresh = () => {
    void refresh()
  }

  onMount(() => {
    const offPromptSubmit = props.api.event.on("tui.command.execute", (event) => {
      if (event.properties.command !== "prompt.submit") return
      autosync()
    })

    // Refetch whenever the AI finishes responding — exactly when a Copilot
    // request has been consumed. Bust the cache first so we always hit the
    // network and get a fresh count.
    const offSessionIdle = props.api.event.on("session.idle", () => {
      autosync()
    })

    onCleanup(() => {
      offPromptSubmit()
      offSessionIdle()
    })
  })

  return (
    <box flexDirection="column" gap={1}>
      <text fg={theme().text}><b>{props.title}</b></text>
      <Switch>
        <Match when={manualRefreshing()}>
          <text fg={theme().textMuted}>syncing...</text>
        </Match>
        <Match when={usage()}>
          {(data) => (
            <box flexDirection="column">
              <Show
                when={!data().unlimited}
                fallback={
                  <box flexDirection="row">
                    <text fg={theme().textMuted}>{`${data().used} used (unlimited)`}</text>
                    <RefreshButton
                      api={props.api}
                      refresh={triggerRefresh}
                      disabled={usage.loading || manualRefreshing()}
                    />
                  </box>
                }
              >
                <box flexDirection="row">
                  <ProgressBar percent={data().percent} />
                  <RefreshButton
                    api={props.api}
                    refresh={triggerRefresh}
                    disabled={usage.loading || manualRefreshing()}
                  />
                </box>
                <text fg={theme().textMuted}>{`${data().used} / ${data().entitlement} Premium Requests`}</text>
              </Show>
              <Show when={data().overageCount > 0}>
                <text fg={theme().warning}>{`+${data().overageCount} overage`}</text>
              </Show>
              <Show when={data().resetDate}>
                <text fg={theme().textMuted}>{"Resets on "}<b>{formatResetDate(data().resetDate!)}</b></text>
              </Show>
            </box>
          )}
        </Match>
        <Match when={usage.loading}>
          <text fg={theme().textMuted}>syncing...</text>
        </Match>
        <Match when={true}>
          <box flexDirection="row">
            <text fg={theme().textMuted}>sync unavailable</text>
            <RefreshButton
              api={props.api}
              refresh={triggerRefresh}
              disabled={usage.loading || manualRefreshing()}
            />
          </box>
        </Match>
      </Switch>
    </box>
  )
}

function View(props: { api: TuiPluginApi; title: string }) {
  const isCopilot = createMemo(() =>
    props.api.state.provider.some((p) => p.id === "github-copilot"),
  )

  return (
    <Show when={isCopilot()}>
      <UsageDetail api={props.api} title={props.title} />
    </Show>
  )
}

// ─── Plugin Registration ──────────────────────────────────────────────────────

const tui: TuiPlugin = async (api, options) => {
  const title = resolveTitle(options)

  api.slots.register({
    order: 50, // top of sidebar — before Context (100), MCP (200), LSP (300), etc.
    slots: {
      sidebar_content() {
        return <View api={api} title={title} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = { id, tui }
export default plugin
