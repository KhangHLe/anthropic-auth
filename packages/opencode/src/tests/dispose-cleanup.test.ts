import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountStorage,
  CacheKeepManager,
  FallbackAccountManager,
  PrimeManager,
  type PrimeManagerOptions,
  saveAccounts,
} from '@cortexkit/anthropic-auth-core'
import { adoptPrimeManager } from '../prime-manager-registry.ts'
// releasePrimeManager is intentionally imported via a dynamic import inside
// each prime test so its pre-fix absence (a missing export) fails only those
// tests rather than crashing the whole file at module load.
import {
  createTimerTracking,
  type PluginTimerOverrides,
} from './timer-tracking'

// Spies installed on shared prototypes before the plugin factory runs;
// restored in afterEach so unrelated tests are not affected.
const cacheKeepStopSpy = mock(() => {})
const originalCacheKeepStop = CacheKeepManager.prototype.stop
const originalFallbackStop =
  FallbackAccountManager.prototype.stopBackgroundRefresh

const timerTracking = createTimerTracking()
const { activeIntervals, disabledPluginTimerOverrides } = timerTracking

let tempDir: string
const originalFetch = globalThis.fetch

beforeEach(async () => {
  timerTracking.reset()
  cacheKeepStopSpy.mockReset()
  CacheKeepManager.prototype.stop =
    cacheKeepStopSpy as unknown as typeof CacheKeepManager.prototype.stop
  FallbackAccountManager.prototype.stopBackgroundRefresh = mock(
    () => {},
  ) as unknown as typeof FallbackAccountManager.prototype.stopBackgroundRefresh
  const { installDefaultFetchMock } = await import('./test-fetch')
  installDefaultFetchMock()
  tempDir = await mkdtemp(join(tmpdir(), 'anthropic-dispose-test-'))
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = join(
    tempDir,
    'anthropic-auth.json',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE = join(
    tempDir,
    'sidebar-state.json',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR = join(
    tempDir,
    'cachekeep-registry',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR = join(
    tempDir,
    'quota-header-feed',
  )
  await saveAccounts(baseStorage())
})

afterEach(async () => {
  try {
    CacheKeepManager.prototype.stop = originalCacheKeepStop
    FallbackAccountManager.prototype.stopBackgroundRefresh =
      originalFallbackStop
    const currentFetch = globalThis.fetch as typeof fetch | undefined
    if (currentFetch) globalThis.fetch = originalFetch
    delete process.env.OPENCODE_ANTHROPIC_AUTH_FILE
    delete process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE
    delete process.env.OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR
    delete process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
  } finally {
    expect(activeIntervals.size).toBe(0)
  }
})

function baseStorage(): AccountStorage {
  return {
    version: 1,
    main: { type: 'opencode', provider: 'anthropic' },
    fallbackOn: [401, 403, 429],
    accounts: [],
    quota: {
      enabled: true,
      checkIntervalMinutes: 5,
      minimumRemaining: { five_hour: 10, seven_day: 20 },
      failClosedOnUnknownQuota: true,
    },
  }
}

function createMockClient() {
  return {
    auth: { set: mock(() => Promise.resolve()) },
    session: {
      promptAsync: mock((_input: unknown) => Promise.resolve()),
    },
  }
}

async function getPlugin(
  timerOverrides?: PluginTimerOverrides,
  directory?: string,
) {
  const { AnthropicAuthPlugin } = await import('../index')
  const defaultTimerOverrides = disabledPluginTimerOverrides()
  return (await (
    AnthropicAuthPlugin as unknown as (
      ctx: Parameters<typeof AnthropicAuthPlugin>[0],
      timers?: PluginTimerOverrides,
    ) => ReturnType<typeof AnthropicAuthPlugin>
  )(
    {
      // @ts-expect-error: minimal mock for testing
      client: createMockClient(),
      ...(directory && { directory }),
    },
    { ...defaultTimerOverrides, ...timerOverrides },
  )) as Promise<any>
}

describe('dispose stops per-instance background services', () => {
  test('dispose clears the fallback background refresh interval', async () => {
    const plugin = await getPlugin()
    // startBackgroundRefresh sets a real interval via runtimeTimers.setInterval;
    // disabledPluginTimerOverrides replaced those with no-op mocks, so the
    // call count is what proves the manager wired up its timer.
    expect(timerTracking.disabledIntervalCalls).toBeGreaterThanOrEqual(1)
    const intervalCallsBeforeDispose = timerTracking.disabledIntervalCalls

    await plugin.dispose?.()

    // The fallbackManager stop path uses its own clearIntervalImpl (which
    // runtimeOverrides provides); a fresh spy confirms the disposal happened.
    const fallbackStopSpy = FallbackAccountManager.prototype
      .stopBackgroundRefresh as unknown as { mock?: { calls: unknown[] } }
    expect(fallbackStopSpy.mock?.calls.length ?? 0).toBeGreaterThanOrEqual(1)
    // Disposing must not schedule any additional intervals for this instance.
    expect(timerTracking.disabledIntervalCalls).toBe(intervalCallsBeforeDispose)
  })

  test('dispose calls cacheKeepManager.stop', async () => {
    const plugin = await getPlugin()
    cacheKeepStopSpy.mockClear()

    await plugin.dispose?.()

    expect(cacheKeepStopSpy).toHaveBeenCalledTimes(1)
  })
})

describe('releasePrimeManager slot accounting', () => {
  const storageOptions = (path: string): PrimeManagerOptions => ({
    storagePath: path,
    getAccountFingerprint: async () => '0123456789abcdef',
    loadStorage: async () => null,
    refreshQuota: async () => ({
      quota: {
        usedPercent: 0,
        remainingPercent: 100,
        checkedAt: Date.now(),
      },
      fresh: true,
    }),
    sendPrime: async () => ({ ok: true, status: 200, ms: 1 }),
    recordSuccess: async () => ({
      count: 1,
      inputTokens: 0,
      outputTokens: 0,
      since: Date.now(),
    }),
  })

  async function importRelease(): Promise<
    (storagePath: string, slot: string) => void
  > {
    const mod = await import('../prime-manager-registry.ts')
    if (typeof mod.releasePrimeManager !== 'function') {
      throw new Error('releasePrimeManager is not exported')
    }
    return mod.releasePrimeManager as (
      storagePath: string,
      slot: string,
    ) => void
  }

  test('releasing one of two slots keeps the shared manager alive for the sibling', async () => {
    const releasePrimeManager = await importRelease()
    const path = join(
      tmpdir(),
      `prime-shared-${Date.now()}-${Math.random()}.json`,
    )
    const first = adoptPrimeManager(
      path,
      () => new PrimeManager(storageOptions(path)),
      { slot: 'slot-a', rebind: () => {} },
    )
    const second = adoptPrimeManager(
      path,
      () => {
        throw new Error('same-path adoption should not construct a duplicate')
      },
      { slot: 'slot-b', rebind: () => {} },
    )
    expect(second).toBe(first)
    first.start()

    releasePrimeManager(path, 'slot-a')

    // The sibling still holds a slot, so the manager must still be present
    // in the registry (verifiable by re-adopting the slot returns the same
    // instance) AND must still be running.
    expect(first.isStopped()).toBe(false)
    const readopted = adoptPrimeManager(
      path,
      () => {
        throw new Error('manager should still be adopted by slot-b')
      },
      { slot: 'slot-b', rebind: () => {} },
    )
    expect(readopted).toBe(first)

    // Cleanup so the orphan slot-b does not leak into the next case.
    releasePrimeManager(path, 'slot-b')
    expect(first.isStopped()).toBe(true)
  })

  test('releasing the last slot evicts and stops the manager', async () => {
    const releasePrimeManager = await importRelease()
    const path = join(
      tmpdir(),
      `prime-last-slot-${Date.now()}-${Math.random()}.json`,
    )
    const manager = adoptPrimeManager(
      path,
      () => new PrimeManager(storageOptions(path)),
      { slot: 'slot-solo', rebind: () => {} },
    )
    manager.start()

    releasePrimeManager(path, 'slot-solo')

    expect(manager.isStopped()).toBe(true)
    // A subsequent adoption must construct a brand-new manager (registry entry
    // gone), which proves the slot bookkeeping cleared the entry.
    let constructed = 0
    adoptPrimeManager(
      path,
      () => {
        constructed += 1
        return new PrimeManager(storageOptions(path))
      },
      { slot: 'slot-solo', rebind: () => {} },
    )
    expect(constructed).toBe(1)
  })

  test('releasing an unknown slot is a no-op', async () => {
    const releasePrimeManager = await importRelease()
    const path = join(
      tmpdir(),
      `prime-unknown-${Date.now()}-${Math.random()}.json`,
    )
    const manager = adoptPrimeManager(
      path,
      () => new PrimeManager(storageOptions(path)),
      { slot: 'slot-known', rebind: () => {} },
    )
    manager.start()

    expect(() => releasePrimeManager(path, 'slot-does-not-exist')).not.toThrow()
    expect(manager.isStopped()).toBe(false)
    // Idempotent: second release of the same slot must also not throw.
    releasePrimeManager(path, 'slot-known')
    expect(() => releasePrimeManager(path, 'slot-known')).not.toThrow()

    // Cleanup: the manager is already stopped from the first 'slot-known' call.
  })

  test('a late release does not clobber a successor slot mapping', async () => {
    const releasePrimeManager = await importRelease()
    const pathX = join(
      tmpdir(),
      `prime-late-x-${Date.now()}-${Math.random()}.json`,
    )
    const pathY = join(
      tmpdir(),
      `prime-late-y-${Date.now()}-${Math.random()}.json`,
    )
    const pathZ = join(
      tmpdir(),
      `prime-late-z-${Date.now()}-${Math.random()}.json`,
    )

    // Instance A adopts slot D under path X.
    const initialX = adoptPrimeManager(
      pathX,
      () => new PrimeManager(storageOptions(pathX)),
      { slot: 'D', rebind: () => {} },
    )
    initialX.start()

    // The slot is later re-adopted under path Y; adoptPrimeManager detaches
    // it from the pathX entry and stops/evicts that entry. From here on,
    // slot D belongs to pathY.
    const managerY = adoptPrimeManager(
      pathY,
      () => new PrimeManager(storageOptions(pathY)),
      { slot: 'D', rebind: () => {} },
    )
    managerY.start()
    expect(initialX.isStopped()).toBe(true)

    // Instance A's dispose arrives late and calls release for (pathX, D).
    // The pathX entry is already gone, so the only effect should be on
    // slotFingerprints — and ONLY if the slot still points at pathX. With
    // the unconditional delete, this clobbers pathY's mapping for D.
    releasePrimeManager(pathX, 'D')

    // Now adopt slot D under path Z. The previous-fingerprint lookup must
    // still see pathY so adoptPrimeManager detaches D from managerY before
    // binding it to a new owner.
    const managerZ = adoptPrimeManager(
      pathZ,
      () => new PrimeManager(storageOptions(pathZ)),
      { slot: 'D', rebind: () => {} },
    )
    managerZ.start()

    // Per-key assertion: the pathY entry must have detached D, leaving it
    // empty (no other slots were adopted there) so it stopped and was
    // evicted from the registry.
    expect(managerY.isStopped()).toBe(true)
    // A fresh adoption under path Y must construct a brand-new manager
    // rather than reusing managerY — that proves the entry was evicted.
    let constructedUnderY = 0
    adoptPrimeManager(
      pathY,
      () => {
        constructedUnderY += 1
        return new PrimeManager(storageOptions(pathY))
      },
      { slot: 're-entry', rebind: () => {} },
    )
    expect(constructedUnderY).toBe(1)

    // Cleanup so subsequent tests are not affected.
    releasePrimeManager(pathZ, 'D')
    releasePrimeManager(pathY, 're-entry')
  })
})
