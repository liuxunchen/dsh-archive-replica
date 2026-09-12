/**
 * The unarchive journal: a revocation wins over every publication, and the
 * retired script-side sidecar is reported instead of silently replayed.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionId as SessionIdentity } from '@deepseek-ai/dsh-session'
import { WorkspaceUnknownSessionError } from '@deepseek-ai/dsh-workspace'
import { ArchiveReplica } from '../src/replica.ts'
import type { ArchiveRegistryPort, ArchiveReplicaLogger } from '../src/replica.ts'
import { reportRetiredSidecar } from '../src/index.ts'
import {
  parseUnarchiveDocument,
  parseVaultDocument,
  renderUnarchiveDocument,
  renderVaultDocument,
  unarchiveFileName,
  vaultFileName,
} from '../src/vault.ts'
import { publishedDocument } from './published.ts'

const STAMP = '2026-09-12T00:00:00.000Z'

/** Registry double: the archive surface plus which Sessions this machine holds. */
class FakeRegistry implements ArchiveRegistryPort {
  readonly archived: SessionIdentity[] = []
  readonly attempts: string[] = []

  constructor(private readonly known: ReadonlySet<string>, archived: readonly string[] = []) {
    this.archived.push(...archived.map(id => SessionId(id)))
  }

  get archivedSessionIds(): readonly SessionIdentity[] {
    return this.archived
  }

  async archiveSession(sessionId: SessionIdentity): Promise<void> {
    this.attempts.push(String(sessionId))
    if (!this.known.has(String(sessionId))) throw new WorkspaceUnknownSessionError(sessionId)
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

/** Fresh temporary directory removed after the test. */
async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-archive-unarchive-'))
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
    watch: options.watch ?? false,
    pollIntervalMs: 20,
    now: () => new Date(STAMP),
  })
}

describe('unarchive documents', () => {
  it('round-trips a rendered journal', () => {
    const text = renderUnarchiveDocument('host-a', ['session-a', 'session-b'], STAMP)
    expect(parseUnarchiveDocument(text)).toEqual(['session-a', 'session-b'])
    expect(JSON.parse(text)).toMatchObject({ version: 1, machine: 'host-a' })
    expect(unarchiveFileName('host-a')).toBe('unarchived-host-a.json')
  })

  it('never mistakes one document kind for the other', () => {
    const archive = renderVaultDocument('host-a', ['session-a'], STAMP)
    const journal = renderUnarchiveDocument('host-a', ['session-a'], STAMP)
    expect(parseUnarchiveDocument(archive)).toBeUndefined()
    expect(parseVaultDocument(journal)).toBeUndefined()
  })

  it('ignores foreign and damaged journals', () => {
    expect(parseUnarchiveDocument('not json')).toBeUndefined()
    expect(parseUnarchiveDocument('[]')).toBeUndefined()
    expect(parseUnarchiveDocument('{"version":2,"unarchivedSessionIds":["session-a"]}')).toBeUndefined()
    expect(parseUnarchiveDocument('{"version":1,"unarchivedSessionIds":["session-a","/etc/passwd"]}'))
      .toEqual(['session-a'])
  })
})

describe('revocation beats publication', () => {
  it('never imports an id the vault revokes', async () => {
    const directory = await tempDir()
    await writeFile(join(directory, vaultFileName('beta')), renderVaultDocument(
      'beta',
      ['session-kept', 'session-undone'],
      STAMP,
    ))
    await writeFile(join(directory, unarchiveFileName('alpha')), renderUnarchiveDocument(
      'alpha',
      ['session-undone'],
      STAMP,
    ))
    const registry = new FakeRegistry(new Set(['session-kept', 'session-undone']))
    const replica = replicaOver(directory, registry, fakeLogger())

    await replica.start()

    expect(registry.archived.map(String)).toEqual(['session-kept'])
    expect(registry.attempts).toEqual(['session-kept'])
    await replica.stop()
  })

  it('drops a revoked id from this machine own publication', async () => {
    const directory = await tempDir()
    await writeFile(join(directory, unarchiveFileName('beta')), renderUnarchiveDocument(
      'beta',
      ['session-b'],
      STAMP,
    ))
    const registry = new FakeRegistry(new Set(), ['session-a', 'session-b'])
    const replica = replicaOver(directory, registry, fakeLogger())

    await replica.start()

    expect(publishedDocument(join(directory, vaultFileName('alpha')))?.archivedSessionIds)
      .toEqual(['session-a'])
    await replica.stop()
  })

  it('reports a revocation this machine cannot apply, once per set', async () => {
    const directory = await tempDir()
    await writeFile(join(directory, unarchiveFileName('beta')), renderUnarchiveDocument(
      'beta',
      ['session-hidden'],
      STAMP,
    ))
    const registry = new FakeRegistry(new Set(), ['session-hidden'])
    const logger = fakeLogger()
    const replica = replicaOver(directory, registry, logger)

    await replica.start()
    await replica.reconcile()
    await replica.reconcile()

    const reported = logger.warnLines.filter(line => line.includes('revoked in the vault'))
    expect(reported).toHaveLength(1)
    expect(reported[0]).toContain('session-hidden')
    await replica.stop()
  })

  it('republishes within one scan when a journal appears while running', async () => {
    const directory = await tempDir()
    const registry = new FakeRegistry(new Set(), ['session-a'])
    const replica = replicaOver(directory, registry, fakeLogger())
    await replica.start()
    expect(publishedDocument(join(directory, vaultFileName('alpha')))?.archivedSessionIds)
      .toEqual(['session-a'])

    await writeFile(join(directory, unarchiveFileName('beta')), renderUnarchiveDocument(
      'beta',
      ['session-a'],
      STAMP,
    ))
    await replica.reconcile()

    expect(publishedDocument(join(directory, vaultFileName('alpha')))?.archivedSessionIds)
      .toEqual([])
    await replica.stop()
  })

  it('says nothing when no journal revokes anything', async () => {
    const directory = await tempDir()
    const registry = new FakeRegistry(new Set(), ['session-a'])
    const logger = fakeLogger()
    const replica = replicaOver(directory, registry, logger)

    await replica.start()
    await replica.reconcile()

    expect(logger.warnLines).toEqual([])
    await replica.stop()
  })
})

describe('retired script-side sidecar', () => {
  it('reports a leftover sidecar that still lists archives', async () => {
    const home = await tempDir()
    await mkdir(join(home, 'sessions'), { recursive: true })
    await mkdir(join(home, 'dsh-sync'), { recursive: true })
    const sidecar = join(home, 'dsh-sync', 'archived-sessions.json')
    await writeFile(sidecar, JSON.stringify({
      version: 1,
      updatedAt: STAMP,
      archivedSessionIds: ['session-a', 'session-b'],
    }))
    const logger = fakeLogger()

    expect(reportRetiredSidecar(logger, home)).toEqual({ path: sidecar, count: 2 })
    expect(logger.warnLines).toHaveLength(1)
    expect(logger.warnLines[0]).toContain('dsh-web-sync.mjs')
  })

  it('stays silent when the sidecar is absent or empty', async () => {
    const home = await tempDir()
    const logger = fakeLogger()
    expect(reportRetiredSidecar(logger, home)).toBeUndefined()

    await mkdir(join(home, 'sessions'), { recursive: true })
    await mkdir(join(home, 'dsh-sync'), { recursive: true })
    await writeFile(join(home, 'dsh-sync', 'archived-sessions.json'), '{"version":1,"archivedSessionIds":[]}')
    expect(reportRetiredSidecar(logger, home)).toBeUndefined()
    expect(logger.warnLines).toEqual([])
  })
})
