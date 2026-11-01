/**
 * The three composer knobs stay legal at every hop.
 *
 * `pickEffort` and `normalizeOptions` are the only places that decide what the
 * composer shows and what the turn sends, so they are asserted directly here —
 * no store, no React, nothing spawned. The last block pins the two host-side
 * permission tables, because the client falling back to `auto` is meaningless if
 * the adapters disagree about what the three modes mean.
 */
import type { KernelModel } from '../src/shared/protocol'
import { describe, expect, it } from 'vitest'
import { normalizeOptions, pickEffort } from '../src/client/lib/turn-options'
import { PERMISSION_MODE } from '../src/host/claude'
import { approvalPolicy } from '../src/host/codex'
import { PERMISSION_MODES } from '../src/shared/protocol'

const MODELS: KernelModel[] = [
  { id: 'gpt-5', label: 'GPT-5', efforts: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] },
  { id: 'gpt-5-mini', label: 'GPT-5 mini', efforts: [{ id: 'fast', label: 'Fast' }] },
  { id: 'plain', label: 'Plain', efforts: [] },
]

describe('pickEffort', () => {
  it('keeps an effort the model advertises', () => {
    expect(pickEffort(MODELS, 'gpt-5', 'high')).toBe('high')
  })

  it('falls back to the first effort when the level is stale', () => {
    expect(pickEffort(MODELS, 'gpt-5-mini', 'high')).toBe('fast')
  })

  it('fills an absent effort with the first one', () => {
    expect(pickEffort(MODELS, 'gpt-5', undefined)).toBe('low')
  })

  it('returns undefined for a model that advertises no efforts', () => {
    expect(pickEffort(MODELS, 'plain', 'high')).toBeUndefined()
  })

  it('returns undefined for an unknown model', () => {
    expect(pickEffort(MODELS, 'gone', 'low')).toBeUndefined()
    expect(pickEffort(MODELS, undefined, 'low')).toBeUndefined()
  })
})

describe('normalizeOptions', () => {
  it('does not pin a default model when none is chosen', () => {
    const next = normalizeOptions(MODELS, { permission: 'auto' })
    expect(next).toEqual({ permission: 'auto' })
    expect('model' in next).toBe(false)
  })

  it('keeps a model the catalogue lists, repaired to a legal effort', () => {
    expect(normalizeOptions(MODELS, { model: 'gpt-5-mini', effort: 'low', permission: 'auto' }))
      .toEqual({ model: 'gpt-5-mini', effort: 'fast', permission: 'auto' })
  })

  it('drops a model the catalogue does not list', () => {
    expect(normalizeOptions(MODELS, { model: 'gone', effort: 'low', permission: 'read-only' }))
      .toEqual({ permission: 'read-only' })
  })

  it('keeps the model when the catalogue is empty', () => {
    expect(normalizeOptions([], { model: 'gpt-5', effort: 'low', permission: 'auto' }))
      .toEqual({ model: 'gpt-5', effort: 'low', permission: 'auto' })
  })

  it('falls back to auto for an illegal permission', () => {
    const illegal = { permission: 'yolo' } as unknown as { permission: 'auto' }
    expect(normalizeOptions(MODELS, illegal)).toEqual({ permission: 'auto' })
  })

  it('keeps every legal permission as-is', () => {
    for (const permission of PERMISSION_MODES)
      expect(normalizeOptions(MODELS, { model: 'gpt-5', effort: 'high', permission }).permission).toBe(permission)
  })
})

describe('host permission tables', () => {
  const cwd = '/repo'

  it('maps read-only to asking and a read-only sandbox', () => {
    expect(approvalPolicy('read-only', cwd)).toEqual({
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    })
  })

  it('maps auto to asking inside the working directory', () => {
    expect(approvalPolicy('auto', cwd)).toEqual({
      approvalPolicy: 'on-request',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    })
  })

  it('maps full-access to never asking, unrestricted', () => {
    expect(approvalPolicy('full-access', cwd)).toEqual({
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    })
  })

  it('maps every mode to Claude\'s native name', () => {
    expect(PERMISSION_MODE).toEqual({
      'read-only': 'plan',
      'auto': 'acceptEdits',
      'full-access': 'bypassPermissions',
    })
  })
})
