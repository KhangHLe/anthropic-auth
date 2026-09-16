import { describe, expect, test } from 'bun:test'
import { basename, win32 } from 'node:path'

import {
  __deriveCustodyManifestStaleLockPrefix,
  type CustodyHandleResolution,
  custodyCredentialIdFromResolution,
} from '../claustrum.ts'

describe('custody manifest stale-lock prefix', () => {
  test('derives prefixes from POSIX and Windows path basenames', () => {
    expect(
      __deriveCustodyManifestStaleLockPrefix(
        '/tmp/handles.json.lock',
        basename,
      ),
    ).toBe('handles.json.lock.stale-')
    expect(
      __deriveCustodyManifestStaleLockPrefix(
        'C:\\Users\\x\\handles.json.lock',
        win32.basename,
      ),
    ).toBe('handles.json.lock.stale-')
  })
})

describe('custodyCredentialIdFromResolution', () => {
  test("returns a resolved manifest binding's credential id verbatim, not the derived form", () => {
    // The provider-default main case: the manifest carries `oauth:anthropic`,
    // not `oauth:anthropic:main`. This is the assertion round 2's e2e test
    // could not make — it had to feed the id in by hand because the helper
    // was inline.
    const resolution: CustodyHandleResolution = {
      status: 'resolved',
      source: 'manifest',
      handle: 'ckh_a'.padEnd(47, '_'),
      credentialId: 'oauth:anthropic',
    }
    expect(custodyCredentialIdFromResolution(resolution, 'main')).toBe(
      'oauth:anthropic',
    )
  })

  test('derives from the label when the resolved source is legacy', () => {
    const resolution: CustodyHandleResolution = {
      status: 'resolved',
      source: 'legacy',
      handle: 'ckh_b'.padEnd(47, '_'),
    }
    expect(custodyCredentialIdFromResolution(resolution, 'work-alt')).toBe(
      'oauth:anthropic:work-alt',
    )
  })

  test('derives from the label when the resolution is unresolved', () => {
    const resolution: CustodyHandleResolution = {
      status: 'unresolved',
      reason: 'missing-entry',
    }
    expect(custodyCredentialIdFromResolution(resolution, 'main')).toBe(
      'oauth:anthropic:main',
    )
  })

  test("derives from the label when the manifest binding's credential id is undefined", () => {
    const resolution = {
      status: 'resolved' as const,
      source: 'manifest' as const,
      handle: 'ckh_c'.padEnd(47, '_'),
      credentialId: undefined,
    }
    expect(custodyCredentialIdFromResolution(resolution, 'main')).toBe(
      'oauth:anthropic:main',
    )
  })
})
