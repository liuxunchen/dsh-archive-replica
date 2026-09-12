import { describe, expect, it } from 'vitest'
import {
  isMachineId,
  parseVaultDocument,
  renderVaultDocument,
  unionSessionIds,
  vaultFileName,
} from '../src/vault.ts'

describe('vault documents', () => {
  it('names one document per machine', () => {
    expect(vaultFileName('host-a')).toBe('archive-host-a.json')
    expect(vaultFileName('1234')).toBe('archive-1234.json')
  })

  it('accepts file-name-safe machine ids only', () => {
    expect(isMachineId('host-a')).toBe(true)
    expect(isMachineId('lab-1234.local')).toBe(true)
    expect(isMachineId('')).toBe(false)
    expect(isMachineId('two words')).toBe(false)
    expect(isMachineId('path/segment')).toBe(false)
    expect(isMachineId('a'.repeat(65))).toBe(false)
  })

  it('round-trips a rendered document', () => {
    const text = renderVaultDocument('host-a', ['session-a', 'session-b'], '2026-09-12T00:00:00.000Z')
    expect(parseVaultDocument(text)).toEqual(['session-a', 'session-b'])
    expect(JSON.parse(text)).toMatchObject({ version: 1, machine: 'host-a' })
  })

  it('ignores foreign, damaged, and id-invalid content', () => {
    expect(parseVaultDocument('not json')).toBeUndefined()
    expect(parseVaultDocument('[]')).toBeUndefined()
    expect(parseVaultDocument('{"version":2,"archivedSessionIds":["session-a"]}')).toBeUndefined()
    expect(parseVaultDocument('{"version":1}')).toBeUndefined()
    expect(parseVaultDocument('{"version":1,"archivedSessionIds":["session-a","/etc/passwd"," "] }'))
      .toEqual(['session-a'])
  })

  it('unions id lists in first-seen order', () => {
    expect(unionSessionIds(['session-a', 'session-b'], ['session-b', 'session-c'], ['bad id']))
      .toEqual(['session-a', 'session-b', 'session-c'])
    expect(unionSessionIds()).toEqual([])
  })
})
