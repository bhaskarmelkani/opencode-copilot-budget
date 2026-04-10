/**
 * Tests for the `refresh()` guard and `autosync()` delegation introduced in
 * the "guard refresh() against concurrent in-flight calls" PR.
 *
 * The logic under test lives inside `UsageDetail` as closures and cannot be
 * imported directly.  We mirror the exact implementation pattern using the
 * same SolidJS primitives (createSignal / plain boolean flag for loading) so
 * we verify the algorithm in isolation without mounting the full TUI component.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { createRoot, createSignal } from "solid-js"

// ---------------------------------------------------------------------------
// Helper: builds the same refresh/autosync closure pair that UsageDetail uses,
// but accepts injected mocks for bustCache, refetch, and the loading flag so
// we can control every input from tests.
// ---------------------------------------------------------------------------

function makeRefreshPair({
  bustCache,
  refetch,
  loadingRef,
}: {
  bustCache: () => void
  refetch: () => Promise<unknown>
  /** Returns the current value of usage.loading */
  loadingRef: () => boolean
}) {
  const [manualRefreshing, setManualRefreshing] = createSignal(false)

  // Exact implementation copied from UsageDetail (post-PR)
  const refresh = async () => {
    if (manualRefreshing() || loadingRef()) return
    setManualRefreshing(true)
    bustCache()
    try {
      await refetch()
    } finally {
      setManualRefreshing(false)
    }
  }

  const autosync = () => {
    void refresh()
  }

  return { refresh, autosync, manualRefreshing }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("refresh() – concurrent-call guard", () => {
  let bustCache: ReturnType<typeof vi.fn>
  let refetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    bustCache = vi.fn()
    refetch = vi.fn().mockResolvedValue(undefined)
  })

  it("calls bustCache and refetch when not already refreshing and usage is not loading", async () => {
    await createRoot(async (dispose) => {
      const { refresh } = makeRefreshPair({
        bustCache,
        refetch,
        loadingRef: () => false,
      })

      await refresh()

      expect(bustCache).toHaveBeenCalledTimes(1)
      expect(refetch).toHaveBeenCalledTimes(1)
      dispose()
    })
  })

  it("returns early (no bustCache, no refetch) when manualRefreshing is true", async () => {
    await createRoot(async (dispose) => {
      // Make refetch hang so manualRefreshing stays true during the second call
      let resolveRefetch!: () => void
      refetch = vi.fn(
        () =>
          new Promise<void>((res) => {
            resolveRefetch = res
          }),
      )

      const { refresh } = makeRefreshPair({
        bustCache,
        refetch,
        loadingRef: () => false,
      })

      // First call – starts the in-flight operation
      const first = refresh()

      // Second call – should be a no-op because manualRefreshing is now true
      await refresh()

      expect(bustCache).toHaveBeenCalledTimes(1) // only from first call
      expect(refetch).toHaveBeenCalledTimes(1) // only from first call

      resolveRefetch()
      await first
      dispose()
    })
  })

  it("returns early (no bustCache, no refetch) when usage.loading is true", async () => {
    await createRoot(async (dispose) => {
      const { refresh } = makeRefreshPair({
        bustCache,
        refetch,
        loadingRef: () => true, // simulate resource still loading
      })

      await refresh()

      expect(bustCache).not.toHaveBeenCalled()
      expect(refetch).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("proceeds normally after a previous refresh completes (manualRefreshing resets to false)", async () => {
    await createRoot(async (dispose) => {
      const { refresh } = makeRefreshPair({
        bustCache,
        refetch,
        loadingRef: () => false,
      })

      await refresh()
      await refresh()

      expect(bustCache).toHaveBeenCalledTimes(2)
      expect(refetch).toHaveBeenCalledTimes(2)
      dispose()
    })
  })

  it("resets manualRefreshing to false even when refetch throws", async () => {
    await createRoot(async (dispose) => {
      refetch = vi.fn().mockRejectedValue(new Error("network error"))

      const { refresh, manualRefreshing } = makeRefreshPair({
        bustCache,
        refetch,
        loadingRef: () => false,
      })

      // refresh should not propagate the error (uses try/finally, no re-throw)
      await refresh()

      expect(manualRefreshing()).toBe(false)
      dispose()
    })
  })

  it("ignores concurrent calls even when called many times simultaneously", async () => {
    await createRoot(async (dispose) => {
      let resolveRefetch!: () => void
      refetch = vi.fn(
        () =>
          new Promise<void>((res) => {
            resolveRefetch = res
          }),
      )

      const { refresh } = makeRefreshPair({
        bustCache,
        refetch,
        loadingRef: () => false,
      })

      // Fire five concurrent calls
      const calls = [refresh(), refresh(), refresh(), refresh(), refresh()]

      // All but the first should have returned early
      expect(bustCache).toHaveBeenCalledTimes(1)
      expect(refetch).toHaveBeenCalledTimes(1)

      resolveRefetch()
      await Promise.all(calls)
      dispose()
    })
  })
})

// ---------------------------------------------------------------------------
// autosync() – delegation to refresh()
// ---------------------------------------------------------------------------

describe("autosync() – delegates to refresh()", () => {
  let bustCache: ReturnType<typeof vi.fn>
  let refetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    bustCache = vi.fn()
    refetch = vi.fn().mockResolvedValue(undefined)
  })

  it("triggers bustCache and refetch when conditions allow (delegates to refresh)", async () => {
    await createRoot(async (dispose) => {
      const { autosync } = makeRefreshPair({
        bustCache,
        refetch,
        loadingRef: () => false,
      })

      autosync()
      // Let the microtask queue drain so the async refresh() body runs
      await new Promise((res) => setTimeout(res, 0))

      expect(bustCache).toHaveBeenCalledTimes(1)
      expect(refetch).toHaveBeenCalledTimes(1)
      dispose()
    })
  })

  it("respects the manualRefreshing guard when called while a refresh is in flight", async () => {
    await createRoot(async (dispose) => {
      let resolveRefetch!: () => void
      refetch = vi.fn(
        () =>
          new Promise<void>((res) => {
            resolveRefetch = res
          }),
      )

      const { autosync } = makeRefreshPair({
        bustCache,
        refetch,
        loadingRef: () => false,
      })

      autosync() // first call – starts in-flight refresh
      await new Promise((res) => setTimeout(res, 0)) // let it enter manualRefreshing=true

      autosync() // second call – should be no-op
      await new Promise((res) => setTimeout(res, 0))

      expect(bustCache).toHaveBeenCalledTimes(1)
      expect(refetch).toHaveBeenCalledTimes(1)

      resolveRefetch()
      await new Promise((res) => setTimeout(res, 0))
      dispose()
    })
  })

  it("respects the usage.loading guard (delegates to refresh which checks loading)", async () => {
    await createRoot(async (dispose) => {
      const { autosync } = makeRefreshPair({
        bustCache,
        refetch,
        loadingRef: () => true, // usage still loading
      })

      autosync()
      await new Promise((res) => setTimeout(res, 0))

      expect(bustCache).not.toHaveBeenCalled()
      expect(refetch).not.toHaveBeenCalled()
      dispose()
    })
  })

  // Regression: in the pre-PR code autosync called bustCache+refetch directly
  // and therefore bypassed the manualRefreshing guard.  This test would have
  // failed against the old implementation.
  it("regression: autosync does NOT bypass the concurrent-call guard", async () => {
    await createRoot(async (dispose) => {
      let resolveRefetch!: () => void
      refetch = vi.fn(
        () =>
          new Promise<void>((res) => {
            resolveRefetch = res
          }),
      )

      const { refresh, autosync } = makeRefreshPair({
        bustCache,
        refetch,
        loadingRef: () => false,
      })

      // Start a manual refresh (puts manualRefreshing=true)
      const manualCall = refresh()
      await new Promise((res) => setTimeout(res, 0))

      // autosync fires while the manual refresh is still in flight
      autosync()
      await new Promise((res) => setTimeout(res, 0))

      // bustCache + refetch should only have been called once (by the manual refresh)
      expect(bustCache).toHaveBeenCalledTimes(1)
      expect(refetch).toHaveBeenCalledTimes(1)

      resolveRefetch()
      await manualCall
      dispose()
    })
  })
})