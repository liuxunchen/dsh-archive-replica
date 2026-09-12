import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionId as SessionIdentity } from '@deepseek-ai/dsh-session'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceUnknownSessionError } from '@deepseek-ai/dsh-workspace'
import { ArchiveReplica } from '../src/replica.ts'
import type { ArchiveRegistryPort, ArchiveReplicaLogger } from '../src/replica.ts'
import { renderVaultDocument, vaultFileName } from '../src/vault.ts'
import { publishedDocument, settleTo } from './published.ts'

/** Registry double: the archive surface plus which Sessions this machine holds. */
class FakeRegistry implements ArchiveRegistryPort {
  readonly archived: SessionIdentity[] = []
  readonly attempts: string[] = []
  /** Ids whose archive attempt fails with an unrelated storage fault. */
  readonly failing = new Set<string>()

  constructor(private readonly known: ReadonlySet<string>, archived: readonly string[] = []) {
    this.archived.push(...archived.map(id => SessionId(id)))
  }

  get archivedSessionIds(): readonly SessionIdentity[] {
    return this.archived
  }

  async archiveSession(sessionId: SessionIdentity): Promise<void> {
    this.attempts.push(String(sessionId))
    if (!this.known.has(String(sessionId))) throw new WorkspaceUnknownSessionError(sessionId)
    if (this.failing.has(String(sessionId))) throw new Error('storage unit is unavailable')
    if (!this.archived.some(id => String(id) === String(sessionId))) this.archived.push(sessionId)
  }
}

/** Logger double keeping rendered lines per severity. */
function fakeLogger(): ArchiveReplicaLogger & { readonly infoLines: string[]; readonly warnLines: string[] } {
  const infoLines: string[] = []
  const warnLines: string[] = []
  return {
    infoLines,
    warnLines,
    info: (format, ...args) => { infoLines.push(render(format, args)) },
    warn: (format, ...args) => { warnLines.push(render(format, args)) },
  }
}

/** Render one printf-style log line for assertions. */
function render(format: string, args: readonly unknown[]): string {
  let index = 0
  return format.replaceAll(/%[sd]/gu, () => String(args[index++]))
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

/** One committed workspace global write, as the registry emits it. */
function archiveChange(archivedSessionIds: readonly string[]): DomainChanged {
  return {
    domain: 'workspace',
    table: '',
    key: '',
    operation: 'put',
    value: { initialized: true, workspaceIds: [], archivedSessionIds },
  }
}

/** Fresh vault directory. */
async function vault(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-archive-replica-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}

/** Replica over a fresh vault with fast watch timing. */
function replicaOver(
  directory: string,
  registry: FakeRegistry,
  logger: ArchiveReplicaLogger,
  options: { readonly watch?: boolean } = {},
): ArchiveReplica {
  return new ArchiveReplica({
    directory,
    machineId: 'alpha',
    registry,
    logger,
    watch: options.watch ?? true,
    pollIntervalMs: 20,
    now: () => new Date('2026-09-12T00:00:00.000Z'),
  })
}

describe('archive replica reconciliation', () => {
  it('archives what other machines published and skips what this machine does not hold', async () => {
    const directory = await vault()
    await writeFile(join(directory, vaultFileName('beta')), renderVaultDocument(
      'beta',
      ['session-known', 'session-elsewhere'],
      '2026-09-11T00:00:00.000Z',
    ))
    const registry = new FakeRegistry(new Set(['session-known']))
    const logger = fakeLogger()
    const replica = replicaOver(directory, registry, logger, { watch: false })

    await replica.start()

    expect(registry.archived.map(String)).toEqual(['session-known'])
    expect(registry.attempts).toEqual(['session-known', 'session-elsewhere'])
    expect(logger.infoLines).toEqual(['archived 1 Session(s) published by another machine'])
    expect(logger.warnLines).toEqual([])
    await replica.stop()
  })

  it('publishes the archive set this machine held before the plugin was mounted', async () => {
    const directory = await vault()
    const registry = new FakeRegistry(new Set(), ['session-a', 'session-b'])
    const replica = replicaOver(directory, registry, fakeLogger(), { watch: false })

    await replica.start()

    const document = publishedDocument(join(directory, vaultFileName('alpha')))
    expect(document?.machine).toBe('alpha')
    expect(document?.archivedSessionIds).toEqual(['session-a', 'session-b'])
    await replica.stop()
  })

  it('leaves its document untouched when the archive set has not moved', async () => {
    const directory = await vault()
    const registry = new FakeRegistry(new Set(), ['session-a'])
    const replica = replicaOver(directory, registry, fakeLogger(), { watch: false })
    await replica.start()
    const path = join(directory, vaultFileName('alpha'))
    const stamp = new Date('2020-01-01T00:00:00.000Z')
    await utimes(path, stamp, stamp)

    await replica.publish()

    const { mtimeMs } = await stat(path)
    expect(mtimeMs).toBe(stamp.getTime())
    await replica.stop()
  })

  it('unions conflict copies and ignores foreign or damaged documents', async () => {
    const directory = await vault()
    await writeFile(
      join(directory, 'archive-beta (conflicted copy 2026-09-12).json'),
      renderVaultDocument('beta', ['session-from-conflict'], '2026-09-11T00:00:00.000Z'),
    )
    await writeFile(join(directory, 'notes.json'), '{"archivedSessionIds":["session-foreign"]}')
    await writeFile(join(directory, 'broken.json'), '{"version":1,"archivedSessionIds":')
    const registry = new FakeRegistry(new Set(['session-from-conflict', 'session-foreign']))
    const replica = replicaOver(directory, registry, fakeLogger(), { watch: false })

    await replica.start()

    expect(registry.archived.map(String)).toEqual(['session-from-conflict'])
    await replica.stop()
  })

  it('retries a failed id and reports the failure once', async () => {
    const directory = await vault()
    await writeFile(join(directory, vaultFileName('beta')), renderVaultDocument(
      'beta',
      ['session-broken'],
      '2026-09-11T00:00:00.000Z',
    ))
    const registry = new FakeRegistry(new Set(['session-broken']))
    registry.failing.add('session-broken')
    const logger = fakeLogger()
    const replica = replicaOver(directory, registry, logger, { watch: false })
    await replica.start()

    const first = await replica.reconcile()
    const second = await replica.reconcile()

    expect(first).toEqual({ imported: 0, skipped: 0, failed: 1, revoked: 0 })
    expect(second).toEqual({ imported: 0, skipped: 0, failed: 1, revoked: 0 })
    // One attempt from the startup pass plus one per explicit pass; the same
    // failure is reported once.
    expect(registry.attempts).toEqual(['session-broken', 'session-broken', 'session-broken'])
    expect(logger.warnLines).toEqual(['session-broken: storage unit is unavailable'])
    await replica.stop()
  })
})

describe('archive replica publication', () => {
  it('republishes on a workspace global write and ignores unrelated changes', async () => {
    const directory = await vault()
    const registry = new FakeRegistry(new Set(['session-next']))
    const replica = replicaOver(directory, registry, fakeLogger(), { watch: false })
    await replica.start()

    replica.observeDomainChange({
      domain: 'other', table: '', key: '', operation: 'put', value: {},
    })
    replica.observeDomainChange({
      domain: 'workspace', table: 'workspaces', key: 'w', operation: 'put', value: {},
    })
    await replica.reconcile()
    const path = join(directory, vaultFileName('alpha'))
    expect(publishedDocument(path)?.archivedSessionIds).toEqual([])

    await registry.archiveSession(SessionId('session-next'))
    replica.observeDomainChange(archiveChange(['session-next']))

    await settleTo(path, ['session-next'])
    await replica.stop()
  })

  it('imports a document that appears while scanning, and stops after disposal', async () => {
    const directory = await vault()
    const registry = new FakeRegistry(new Set(['session-live', 'session-late']))
    const replica = replicaOver(directory, registry, fakeLogger())
    await replica.start()

    await writeFile(join(directory, vaultFileName('beta')), renderVaultDocument(
      'beta',
      ['session-live'],
      '2026-09-11T00:00:00.000Z',
    ))
    await vi.waitFor(() => {
      expect(registry.archived.map(String)).toEqual(['session-live'])
    }, { timeout: 5000 })

    await replica.stop()
    const attempts = [...registry.attempts]
    await writeFile(join(directory, vaultFileName('gamma')), renderVaultDocument(
      'gamma',
      ['session-late'],
      '2026-09-11T00:00:00.000Z',
    ))
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(registry.attempts).toEqual(attempts)
  })
})
