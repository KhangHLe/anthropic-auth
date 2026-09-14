import {
  type PrimeManager,
  primeStorageFingerprint,
} from '@cortexkit/anthropic-auth-core'

type PrimeManagerEntry = {
  manager: PrimeManager
  slots: Set<string>
}

type PrimeManagerAdoption = {
  slot: string
  rebind: (manager: PrimeManager) => void
}

// Each project slot owns one fingerprint at a time, while slots sharing a
// storage identity adopt one process-wide manager. Moving a slot releases its
// old owner so an unreferenced timer cannot survive a project reload.
const primeManagers = new Map<string, PrimeManagerEntry>()
const slotFingerprints = new Map<string, string>()

export function adoptPrimeManager(
  storagePath: string,
  create: () => PrimeManager,
  adoption: PrimeManagerAdoption,
): PrimeManager {
  const fingerprint = primeStorageFingerprint(storagePath)
  const previousFingerprint = slotFingerprints.get(adoption.slot)
  if (previousFingerprint && previousFingerprint !== fingerprint) {
    const previous = primeManagers.get(previousFingerprint)
    if (previous) {
      previous.slots.delete(adoption.slot)
      if (previous.slots.size === 0) {
        previous.manager.stop()
        primeManagers.delete(previousFingerprint)
      }
    }
  }

  slotFingerprints.set(adoption.slot, fingerprint)
  const existing = primeManagers.get(fingerprint)
  if (existing) {
    existing.slots.add(adoption.slot)
    adoption.rebind(existing.manager)
    return existing.manager
  }

  const manager = create()
  primeManagers.set(fingerprint, {
    manager,
    slots: new Set([adoption.slot]),
  })
  return manager
}

// Each adopting slot owns its own release; releasing the last slot stops the
// shared manager so a disposed instance cannot leave a timer alive for a
// sibling project that still depends on the same storage path.
export function releasePrimeManager(storagePath: string, slot: string): void {
  const fingerprint = primeStorageFingerprint(storagePath)
  const entry = primeManagers.get(fingerprint)
  if (entry) {
    entry.slots.delete(slot)
    if (entry.slots.size === 0) {
      entry.manager.stop()
      primeManagers.delete(fingerprint)
    }
  }
  // A late release must not clobber a successor's slot mapping; the slot may
  // already have been re-adopted under a different storage path, and the next
  // adopt relies on this map to detach it from the previous owner.
  if (slotFingerprints.get(slot) === fingerprint) {
    slotFingerprints.delete(slot)
  }
}
