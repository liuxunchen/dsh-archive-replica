/**
 * Real-composition guard: the replica boots from a test-only cordis.yml through
 * the actual Loader + Include path over the real workspace registry, archives
 * what another machine published into that registry, and publishes a Session
 * archived while it runs. The stubbed peers are the ones the registry's own
 * suite stubs: a memory storage backend and header-only Session persistence.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import WorkspaceRegistry from '../../workspace/src/index.ts'
import * as ArchiveReplica from '../src/index.ts'
import { renderVaultDocument, vaultFileName } from '../src/vault.ts'
import { settleTo } from './published.ts'

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Session header for a stored Session this machine holds. */
function header(id: string): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 0, isSeeded: false }
}

/** Mount the real registry over stubbed storage and header-only persistence. */
async function mountRegistry(ctx: Context, sessionIds: readonly string[]): Promise<WorkspaceRegistry> {
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const sessions = sessionIds.map(header)
  ctx.provide('sessionPersistence', {
    list: async (): Promise<SessionPersistenceSnapshot[]> => sessions.map(meta => ({
      header: meta,
      revision: SessionPersistenceRevision(`rev-${meta.id}`),
    })),
    open: () => { throw new Error('event bodies must not be opened') },
    stat: () => { throw new Error('per-session stat must not be needed') },
  } as never)
  await ctx.plugin(WorkspaceRegistry)
  return ctx.workspaceRegistry
}

/** Fresh scratch root holding the vault directory. */
async function scratchVault(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-archive-composition-'))
  const directory = join(root, 'vault')
  await mkdir(directory)
  return directory
}

/**
 * Boot the registry and the replica row from a generated cordis.yml.
 * @returns the live context, the registry, and the shared vault directory.
 */
async function compose(otherMachine?: { readonly machineId: string; readonly ids: readonly string[] }): Promise<{
  ctx: Context
  registry: WorkspaceRegistry
  directory: string
}> {
  const directory = await scratchVault()
  if (otherMachine !== undefined) {
    await writeFile(
      join(directory, vaultFileName(otherMachine.machineId)),
      renderVaultDocument(otherMachine.machineId, otherMachine.ids, '2026-09-11T00:00:00.000Z'),
    )
  }
  const ctx = new Context()
  context = ctx
  const registry = await mountRegistry(ctx, ['session-alpha', 'session-beta'])

  const configPath = join(root!, 'cordis.yml')
  await writeFile(configPath, [
    '- id: archive-replica',
    "  name: '@deepseek-ai/dsh-archive-replica'",
    '  config:',
    `    directory: ${JSON.stringify(directory)}`,
    '    machineId: alpha',
    '    pollIntervalMs: 20',
    '',
  ].join('\n'))
  ctx.baseUrl = `${pathToFileURL(root!).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-archive-replica', ArchiveReplica],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  return { ctx, registry, directory }
}

describe('archive-replica real composition', () => {
  it('imports another machine\'s publication and publishes the local archive set', async () => {
    const { registry, directory } = await compose({
      machineId: 'beta',
      ids: ['session-alpha', 'session-only-on-beta'],
    })

    // The startup pass archives what this machine holds; the other id stays out.
    await settleTo(join(directory, vaultFileName('alpha')), ['session-alpha'])
    expect(registry.archivedSessionIds.map(String)).toEqual(['session-alpha'])

    // A Session archived while the replica runs reaches this machine's document.
    await registry.archiveSession(SessionId('session-beta'))
    const published = join(directory, vaultFileName('alpha'))
    expect(await settleTo(published, ['session-alpha', 'session-beta']))
      .toEqual(['session-alpha', 'session-beta'])
  })

  it('refuses to mount without a shared directory', async () => {
    const ctx = new Context()
    context = ctx
    await mountRegistry(ctx, [])
    await expect(ctx.plugin(ArchiveReplica, {
      directory: join(tmpdir(), 'dsh-archive-missing-directory'),
      machineId: 'alpha',
    })).rejects.toThrow(/shared directory .* does not exist/u)
  })

  it('refuses a machine id that cannot name a vault document', async () => {
    const directory = await scratchVault()
    const ctx = new Context()
    context = ctx
    await mountRegistry(ctx, [])
    await expect(ctx.plugin(ArchiveReplica, { directory, machineId: 'two words' }))
      .rejects.toThrow(/machineId/u)
  })
})
