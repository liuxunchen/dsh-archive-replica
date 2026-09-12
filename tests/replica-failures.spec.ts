/**
 * Failure and disposal paths of the replica, driven deterministically: the scan
 * loop runs on a short interval, and spied `fs/promises` functions supply the
 * failures a sync client produces (an unreadable document mid-transfer, a
 * directory that vanished).
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { SessionId as SessionIdentity } from '@deepseek-ai/dsh-session'
import { WorkspaceUnknownSessionError } from '@deepseek-ai/dsh-workspace'
import { ArchiveReplica } from '../src/replica.ts'
import type { ArchiveRegistryPort, ArchiveReplicaLogger } from '../src/replica.ts'
import { renderVaultDocument, vaultFileName } from '../src/vault.ts'

vi.mock('@deepseek-ai/dsh-atomic-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-atomic-write')>()
  return { ...actual, writeFileAtomic: vi.fn(actual.writeFileAtomic) }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    readdir: vi.fn(actual.readdir),
    __actual: { readFile: actual.readFile, readdir: actual.readdir },
  }
})

/** The real `fs/promises` functions, for tests and for restoring after one. */
async function actualFs(): Promise<{
  readFile: typeof import('node:fs/promises').readFile
  readdir: typeof import('node:fs/promises').readdir
}> {
  const mocked = await import('node:fs/promises') as unknown as {
    __actual: {
      readFile: typeof import('node:fs/promises').readFile
      readdir: typeof import('node:fs/promises').readdir
    }
  }
  return mocked.__actual
}

/** Registry double holding one known Session. */
class FakeRegistry implements ArchiveRegistryPort {
  readonly archived: SessionIdentity[] = []
  readonly attempts: string[] = []
  constructor(private readonly known: ReadonlySet<string>) {}
  get archivedSessionIds(): readonly SessionIdentity[] {
    return this.archived
  }
  async archiveSession(sessionId: SessionIdentity): Promise<void> {
    this.attempts.push(String(sessionId))
    if (!this.known.has(String(sessionId))) throw new WorkspaceUnknownSessionError(sessionId)
    this.archived.push(sessionId)
  }
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
  // A test's implementation survives `mockClear`; restore the real functions so
  // a hanging or failing double cannot leak into the next test.
  const real = await actualFs()
  vi.mocked(readFile).mockImplementation(real.readFile)
  vi.mocked(readdir).mockImplementation(real.readdir)
  vi.mocked(writeFileAtomic).mockClear()
})

/** Fresh vault directory. */
async function vault(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-archive-replica-failure-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}

/** Replica under test; `now` is omitted to exercise the default clock. */
function replicaOver(
  directory: string,
  registry: FakeRegistry,
  logger: ArchiveReplicaLogger,
  watch = true,
): ArchiveReplica {
  return new ArchiveReplica({
    directory,
    machineId: 'alpha',
    registry,
    logger,
    watch,
    pollIntervalMs: 20,
  })
}

/** Poll the registry double until it holds exactly the expected Sessions. */
async function settleToRegistry(
  registry: FakeRegistry,
  expected: readonly string[],
): Promise<readonly string[]> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const ids = registry.archived.map(String)
    if (ids.length === expected.length && ids.every((id, index) => id === expected[index])) return ids
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`registry never became ${JSON.stringify(expected)}`)
}

describe('archive replica scan loop', () => {
  it('imports a document another machine drops while the scan loop runs', async () => {
    const directory = await vault()
    const registry = new FakeRegistry(new Set(['session-live']))
    const replica = replicaOver(directory, registry, fakeLogger())
    await replica.start()

    await writeFile(join(directory, vaultFileName('beta')), renderVaultDocument(
      'beta', ['session-live'], '2026-09-11T00:00:00.000Z',
    ))

    // Publication is event-driven, so this double asserts the import the scan
    // loop performs; the registry's own write is what triggers publication.
    await settleToRegistry(registry, ['session-live'])
    await replica.stop()
  })

  it('reports every scan whose directory disappeared', async () => {
    const directory = await vault()
    const logger = fakeLogger()
    const replica = replicaOver(directory, new FakeRegistry(new Set()), logger)
    await replica.start()

    // A sync client unmounting the directory is the realistic failure: each
    // later scan rejects until it comes back.
    await rm(directory, { recursive: true, force: true })

    await vi.waitFor(() => {
      expect(logger.warnLines.length).toBeGreaterThan(1)
    })
    expect(logger.warnLines[0]).toContain(`scanning ${directory} failed:`)
    await replica.stop()
  })

  it('coalesces a tick that arrives while the previous scan is still running', async () => {
    const directory = await vault()
    const replica = replicaOver(directory, new FakeRegistry(new Set()), fakeLogger())
    const real = await actualFs()

    // Fake timers own the scan interval, so the overlap is deterministic: the
    // first tick hangs inside `readdir`, and every tick it outlives must be
    // dropped rather than queued behind it.
    vi.useFakeTimers()
    try {
      await replica.start()
      let scans = 0
      let release: (() => void) | undefined
      vi.mocked(readdir).mockImplementation(async (path, ...rest) => {
        scans += 1
        await new Promise<void>((resolve) => { release = resolve })
        return real.readdir(path, ...rest)
      })

      await vi.advanceTimersByTimeAsync(20)
      expect(scans).toBe(1)
      await vi.advanceTimersByTimeAsync(500)
      expect(scans).toBe(1)

      release?.()
      await vi.advanceTimersByTimeAsync(0)
      await replica.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops scanning after disposal', async () => {
    const directory = await vault()
    const registry = new FakeRegistry(new Set(['session-late']))
    const replica = replicaOver(directory, registry, fakeLogger())
    await replica.start()
    await replica.stop()

    await writeFile(join(directory, vaultFileName('beta')), renderVaultDocument(
      'beta', ['session-late'], '2026-09-11T00:00:00.000Z',
    ))
    await new Promise(resolve => setTimeout(resolve, 120))

    expect(registry.archived).toEqual([])
  })
})

describe('archive replica unreadable documents', () => {
  it('reports an unreadable document once, skips it, and imports the rest', async () => {
    const directory = await vault()
    await writeFile(join(directory, vaultFileName('beta')), renderVaultDocument(
      'beta', ['session-live'], '2026-09-11T00:00:00.000Z',
    ))
    await writeFile(join(directory, vaultFileName('gamma')), renderVaultDocument(
      'gamma', ['session-other'], '2026-09-11T00:00:00.000Z',
    ))
    // A directory named like a document covers the non-file entry, and one
    // unreadable document covers the failure a sync client's mid-transfer hold
    // produces on every pass until it releases the file.
    await mkdir(join(directory, 'nested.json'))
    const registry = new FakeRegistry(new Set(['session-live', 'session-other']))
    const logger = fakeLogger()
    const replica = replicaOver(directory, registry, logger, false)
    const real = await actualFs()
    const held = join(directory, vaultFileName('gamma'))
    vi.mocked(readFile).mockImplementation(async (path, ...rest) => {
      if (path === held) throw new Error('EBUSY: resource busy or locked')
      return real.readFile(path, ...rest)
    })

    const first = await replica.reconcile()
    const second = await replica.reconcile()

    expect(first).toEqual({ imported: 1, skipped: 0, failed: 0, revoked: 0 })
    expect(second).toEqual({ imported: 0, skipped: 0, failed: 0, revoked: 0 })
    expect(logger.warnLines).toEqual([`${vaultFileName('gamma')}: EBUSY: resource busy or locked`])
    expect(registry.archived.map(String)).toEqual(['session-live'])
    await replica.stop()
  })
})

describe('archive replica publication failures', () => {
  it('reports a publication that an archive change triggered', async () => {
    const directory = await vault()
    const logger = fakeLogger()
    const replica = replicaOver(directory, new FakeRegistry(new Set()), logger, false)
    await replica.start()
    vi.mocked(writeFileAtomic).mockRejectedValueOnce(new Error('vault is read-only'))

    replica.observeDomainChange({
      domain: 'workspace',
      table: '',
      key: '',
      operation: 'put',
      value: { initialized: true, workspaceIds: [], archivedSessionIds: ['session-next'] },
    })

    await vi.waitFor(() => {
      expect(logger.warnLines).toEqual(['publishing after an archive change failed: vault is read-only'])
    })
    await replica.stop()
  })

  it('reads a non-Error rejection into a publication warning', async () => {
    const directory = await vault()
    const logger = fakeLogger()
    const replica = replicaOver(directory, new FakeRegistry(new Set()), logger, false)
    await replica.start()
    vi.mocked(writeFileAtomic).mockRejectedValueOnce('sync client offline')

    replica.observeDomainChange({
      domain: 'workspace',
      table: '',
      key: '',
      operation: 'put',
      value: { initialized: true, workspaceIds: [], archivedSessionIds: ['session-next'] },
    })

    await vi.waitFor(() => {
      expect(logger.warnLines).toEqual(['publishing after an archive change failed: sync client offline'])
    })
    await replica.stop()
  })
})

describe('archive replica disposal', () => {
  it('applies nothing after stop, with or without a scan loop', async () => {
    const directory = await vault()
    const registry = new FakeRegistry(new Set(['session-late']))
    const logger = fakeLogger()
    const replica = replicaOver(directory, registry, logger, false)
    await replica.start()
    await replica.stop()

    await expect(replica.reconcile()).resolves.toEqual({ imported: 0, skipped: 0, failed: 0, revoked: 0 })
    await expect(replica.publish()).resolves.toBeUndefined()
    replica.observeDomainChange({
      domain: 'workspace',
      table: '',
      key: '',
      operation: 'put',
      value: { initialized: true, workspaceIds: [], archivedSessionIds: ['session-late'] },
    })
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(registry.archived).toEqual([])
    expect(logger.warnLines).toEqual([])
  })

  it('stops scanning once the loop is disposed', async () => {
    const directory = await vault()
    const logger = fakeLogger()
    const replica = replicaOver(directory, new FakeRegistry(new Set()), logger)
    await replica.start()
    await replica.stop()

    // The interval is cleared: removing the directory now produces no further
    // pass, while a live loop would warn on every tick.
    await rm(directory, { recursive: true, force: true })
    await new Promise(resolve => setTimeout(resolve, 80))

    expect(logger.warnLines).toEqual([])
  })
})
