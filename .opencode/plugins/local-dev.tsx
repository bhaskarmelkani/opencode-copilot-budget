import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

import plugin from "../../src/index.tsx"

const tui: TuiPlugin = async (api, options, meta) => {
  await plugin.tui(api, options, meta)
}

const localPlugin: TuiPluginModule & { id: string } = {
  id: "copilot-budget.sidebar.local",
  tui,
}

export default localPlugin
