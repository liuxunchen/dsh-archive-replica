/**
 * Plugin-row behavior: configuration resolution and validation, and the effect
 * lifecycle that starts and stops one replica. The registry is a stub service
 * here — the real one is covered by the composition spec — while `readdir` is
 * mocked because the failure under test is the vault directory disappearing.
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId as SessionIdentity } from '@deepseek-ai/dsh-session'
import * as ArchiveReplica from '../src/index.ts'
import { resolveReplicaSpec } from '../src/replica.ts'
import type { ArchiveRegistryPort } from '../src/replica.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readdir: vi.fn(actual.readdir) }
})

/** One buffered log record, as the Cordis logger keeps it. */
interface BufferedMessage {
  readonly name: string
  readonly args: readonly unknown[]
}

const contexts: Context[] = []
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()!.fiber.dispose()
  while (cleanups.length > 0) await cleanups.pop()!()
  vi.mocked(readdir).mockClear()
})

/** Fresh existing directory. */
async function scratchDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-archive-replica-plugin-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}

/** Context carrying a stub registry service the plugin can inject. */
function registryContext(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  const archived: SessionIdentity[] = []
  const registry: ArchiveRegistryPort = {
    get archivedSessionIds(): readonly SessionIdentity[] {
      return archived
    },
    archiveSession: async (sessionId: SessionIdentity) => { archived.push(sessionId) },
  }
  ctx.provide('workspaceRegistry', registry as never)
  return ctx
}

/**
 * Messages the plugin row logged under its own name, minus the startup line.
 *
 * That line names this machine's fingerprint, which differs per host and is not
 * what these assertions are about.
 */
function pluginLog(ctx: Context): BufferedMessage[] {
  const { buffer } = ctx.logger as unknown as { buffer: BufferedMessage[] }
  return buffer.filter(message => message.name === ArchiveReplica.name
    && !String(message.args[0]).startsWith('replicating the Session archive set'))
}

describe('archive-replica configuration', () => {
  it('states both identities and defaults the rest', () => {
    expect(ArchiveReplica.Config({ directory: '/vault', machineId: 'alpha' })).toEqual({
      directory: '/vault',
      machineId: 'alpha',
      watch: true,
      pollIntervalMs: 2000,
    })
    expect(() => ArchiveReplica.Config({ directory: '/vault' } as unknown as ArchiveReplica.Config))
      .toThrow()
    expect(() => ArchiveReplica.Config({ machineId: 'alpha' } as unknown as ArchiveReplica.Config))
      .toThrow()
  })

  it('resolves the spec defaults in one place', () => {
    expect(resolveReplicaSpec({ directory: '/vault', machineId: 'alpha' })).toEqual({
      directory: '/vault',
      machineId: 'alpha',
      watch: true,
      pollIntervalMs: 2000,
    })
  })

  it('exposes the plugin row surface', () => {
    expect(ArchiveReplica.name).toBe('archive-replica')
    expect(ArchiveReplica.inject).toEqual(['workspaceRegistry'])
  })
})

describe('archive-replica lifecycle', () => {
  it('starts a replica and stops it when the plugin is disposed', async () => {
    const directory = await scratchDirectory()
    const ctx = registryContext()

    await ctx.plugin(ArchiveReplica, { directory, machineId: 'alpha', watch: false })

    await expect(ctx.fiber.dispose()).resolves.toBeUndefined()
    expect(pluginLog(ctx)).toEqual([])
  })

  it('logs a start failure carried by an Error', async () => {
    const directory = await scratchDirectory()
    const ctx = registryContext()
    // Armed before mounting: the replica's first pass is the next `readdir`.
    vi.mocked(readdir).mockRejectedValueOnce(new Error('ENOENT: vault vanished'))

    await ctx.plugin(ArchiveReplica, { directory, machineId: 'alpha', watch: false })

    // The startup pass rejects on a later tick, so the log line is awaited.
    await vi.waitFor(() => {
      expect(pluginLog(ctx).map(message => message.args)).toEqual([
        ['starting replication in %s failed: %s', directory, 'ENOENT: vault vanished'],
      ])
    })
    await expect(ctx.fiber.dispose()).resolves.toBeUndefined()
  })

  it('logs a start failure carried by a non-Error rejection', async () => {
    const directory = await scratchDirectory()
    const ctx = registryContext()
    vi.mocked(readdir).mockRejectedValueOnce('sync client offline')

    await ctx.plugin(ArchiveReplica, { directory, machineId: 'alpha', watch: false })

    await vi.waitFor(() => {
      expect(pluginLog(ctx).map(message => message.args)).toEqual([
        ['starting replication in %s failed: %s', directory, 'sync client offline'],
      ])
    })
    await expect(ctx.fiber.dispose()).resolves.toBeUndefined()
  })

  it('refuses a directory that does not exist and a machine id that cannot name a file', async () => {
    const ctx = registryContext()
    await expect(ctx.plugin(ArchiveReplica, { directory: join(tmpdir(), 'archive-replica-absent'), machineId: 'a' }))
      .rejects.toThrow(/does not exist/u)
    await expect(ctx.plugin(ArchiveReplica, {
      directory: await scratchDirectory(),
      machineId: 'not a file name',
    })).rejects.toThrow(/machineId/u)
  })
})
