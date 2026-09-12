/**
 * Machine identity in the vault: the fingerprint that tells two machines
 * configured with one `machineId` apart, and the wiring that publishes it.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionId as SessionIdentity } from '@deepseek-ai/dsh-session'
import { machineFingerprint, reportMachineIdCollision } from '../src/index.ts'
import { ArchiveReplica } from '../src/replica.ts'
import type { ArchiveRegistryPort, ArchiveReplicaLogger } from '../src/replica.ts'
import { parseVaultFingerprint, renderVaultDocument, vaultFileName } from '../src/vault.ts'

const STAMP = '2026-09-12T00:00:00.000Z'

/** Registry double holding a fixed archive set. */
class FakeRegistry implements ArchiveRegistryPort {
  constructor(private readonly archived: readonly string[] = []) {}

  get archivedSessionIds(): readonly SessionIdentity[] {
    return this.archived.map(id => SessionId(id))
  }

  async archiveSession(): Promise<void> {}
}

/** Logger double keeping rendered lines per severity. */
function fakeLogger(): ArchiveReplicaLogger & { readonly warnLines: string[] } {
  const warnLines: string[] = []
  return {
    warnLines,
    info: () => {},
    warn: (format, ...args) => {
      let index = 0
      warnLines.push(format.replaceAll(/%[sd]/gu, () => String(args[index++])))
    },
  }
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

/** Fresh temporary directory removed after the test. */
async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-archive-fingerprint-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}

describe('machine fingerprints', () => {
  it('states a non-empty fingerprint for this host', () => {
    const fingerprint = machineFingerprint()
    expect(fingerprint.length).toBeGreaterThan(0)
    expect(fingerprint).not.toContain(' ')
  })

  it('round-trips through a vault document and stays absent when unstated', () => {
    const stated = renderVaultDocument('alpha', ['session-a'], STAMP, 'laptop:0123456789ab')
    expect(parseVaultFingerprint(stated)).toBe('laptop:0123456789ab')
    const unstated = renderVaultDocument('alpha', ['session-a'], STAMP)
    expect(parseVaultFingerprint(unstated)).toBeUndefined()
  })

  it('publishes this machine fingerprint with its document', async () => {
    const directory = await tempDir()
    const replica = new ArchiveReplica({
      directory,
      machineId: 'alpha',
      registry: new FakeRegistry(['session-a']),
      logger: fakeLogger(),
      watch: false,
      pollIntervalMs: 20,
      fingerprint: 'laptop:0123456789ab',
    })

    await replica.start()

    const text = await readFile(join(directory, vaultFileName('alpha')), 'utf8')
    expect(parseVaultFingerprint(text)).toBe('laptop:0123456789ab')
    await replica.stop()
  })
})

describe('machineId collision', () => {
  it('stays quiet when the document is this machine own', async () => {
    const directory = await tempDir()
    await writeFile(
      join(directory, vaultFileName('alpha')),
      renderVaultDocument('alpha', [], STAMP, 'this:0123456789ab'),
    )
    const logger = fakeLogger()

    expect(reportMachineIdCollision(logger, directory, 'alpha', 'this:0123456789ab')).toBeUndefined()
    expect(logger.warnLines).toEqual([])
  })

  it('warns when another machine already published under this id', async () => {
    const directory = await tempDir()
    await writeFile(
      join(directory, vaultFileName('alpha')),
      renderVaultDocument('alpha', [], STAMP, 'other:ffffffffffff'),
    )
    const logger = fakeLogger()

    expect(reportMachineIdCollision(logger, directory, 'alpha', 'this:0123456789ab'))
      .toBe('other:ffffffffffff')
    expect(logger.warnLines).toHaveLength(1)
    expect(logger.warnLines[0]).toContain('other:ffffffffffff')
    expect(logger.warnLines[0]).toContain('machineId')
  })

  it('stays quiet for a document written before fingerprints existed', async () => {
    const directory = await tempDir()
    await writeFile(
      join(directory, vaultFileName('alpha')),
      renderVaultDocument('alpha', ['session-a'], STAMP),
    )
    const logger = fakeLogger()

    expect(reportMachineIdCollision(logger, directory, 'alpha', 'this:0123456789ab')).toBeUndefined()
    expect(logger.warnLines).toEqual([])
  })

  it('stays quiet when no document exists yet', async () => {
    const directory = await tempDir()
    const logger = fakeLogger()

    expect(reportMachineIdCollision(logger, directory, 'alpha', 'this:0123456789ab')).toBeUndefined()
    expect(logger.warnLines).toEqual([])
  })
})
