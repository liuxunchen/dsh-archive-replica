/**
 * Cross-machine replication of the registry-global Session archive set.
 *
 * Archiving lives in this machine's workspace registry and not in the Session
 * logs, so a second machine reading the same Session directory keeps its own
 * archive set ([package limitation](../../workspace/README.md#known-limitations-and-deferred-work)).
 * This plugin closes that gap without becoming a second writer of the registry:
 * it consumes `ctx.workspaceRegistry`, publishes this machine's archive set into
 * a directory an external file-sync tool replicates, and archives locally the
 * ids other machines published there.
 *
 * One file per machine (`archive-<machineId>.json`) keeps every vault document
 * single-writer, so a sync client's conflict handling can never drop a
 * published archive. A companion journal (`unarchived-<machineId>.json`) carries
 * the opposite direction, so undoing a mistaken archive is not replayed back by
 * the union of everyone else's documents.
 *
 * @module @deepseek-ai/dsh-archive-replica
 */

import { readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ArchiveReplica, resolveReplicaSpec } from './replica.ts'
import type { ArchiveReplicaLogger } from './replica.ts'
import { isMachineId, parseVaultFingerprint, vaultFileName } from './vault.ts'

/** Cordis plugin name. */
export const name = 'archive-replica'

/** The archive replica reads the registry and never writes it directly. */
export const inject = ['workspaceRegistry']

/** Plugin configuration. */
export interface Config {
  /**
   * Existing directory that every participating machine reads and writes
   * through its own file-sync tool. Required: a default under the harness home
   * would look configured while replicating nothing.
   */
  directory: string
  /**
   * Stable id of this machine, naming its vault document. Required, and
   * distinct per machine: two machines sharing one id would share one document
   * and lose each other's archives to last-write-wins.
   */
  machineId: string
  /** Keep scanning the directory for other machines' publications. @default true */
  watch?: boolean
  /** Interval between directory scans, in milliseconds. @default 2000 */
  pollIntervalMs?: number
}

/** Configuration schema: both identities are stated, never defaulted. */
export const Config: z<Config> = z.object({
  directory: z.string().required(),
  machineId: z.string().required(),
  watch: z.boolean().default(true),
  pollIntervalMs: z.number().step(1).min(1).default(2000),
})

/** One retired sidecar that still lists archives. */
export interface RetiredSidecarReport {
  /** Path of the retired file. */
  readonly path: string
  /** Ids the file still lists. */
  readonly count: number
}

/**
 * Mount the archive replica on one harness home.
 * @param ctx - Host plugin context carrying the workspace registry.
 * @param config - Shared directory and this machine's identity.
 */
export function apply(ctx: Context, config: Config): void {
  const directory = resolve(config.directory)
  if (!isMachineId(config.machineId)) {
    throw new Error(`archive-replica: machineId ${JSON.stringify(config.machineId)} must match [A-Za-z0-9._-]{1,64}`)
  }
  if (!isDirectory(directory)) {
    throw new Error(`archive-replica: shared directory ${JSON.stringify(directory)} does not exist`)
  }
  const logger = ctx.logger(name)
  const fingerprint = machineFingerprint()
  logger.info(
    'replicating the Session archive set through %s as %s (%s)',
    directory,
    config.machineId,
    fingerprint,
  )
  reportMachineIdCollision(logger, directory, config.machineId, fingerprint)
  reportRetiredSidecar(logger)
  const replica = new ArchiveReplica({
    // Stated field by field rather than spread: the lint rule forbids spreading a
    // value whose type may carry a prototype, and the resolved spec is explicit anyway.
    ...resolveReplicaSpec({
      directory: config.directory,
      machineId: config.machineId,
      ...(config.watch === undefined ? {} : { watch: config.watch }),
      ...(config.pollIntervalMs === undefined ? {} : { pollIntervalMs: config.pollIntervalMs }),
      fingerprint,
    }),
    registry: ctx.workspaceRegistry,
    logger,
  })
  ctx.effect(() => {
    const started = replica.start()
    void started.catch((error: unknown) => {
      logger.error('starting replication in %s failed: %s', directory, messageOf(error))
    })
    return async () => {
      await started.catch(() => undefined)
      await replica.stop()
    }
  }, 'archive-replica vault')
  ctx.on('domain/changed', (change) => {
    replica.observeDomainChange(change)
  })
}

/**
 * Fingerprint this machine, so a second machine configured with the same
 * `machineId` can be told apart from it.
 *
 * `machineId` is operator-chosen and defaults to the short hostname — which two
 * machines really do share, as one pair of laptops here does. The kernel machine
 * id is the part that differs, so the fingerprint is `host:kernelIdPrefix`.
 * @returns the fingerprint; a machine whose id file is unreadable contributes
 *   its hostname alone, which still separates differently named machines.
 */
export function machineFingerprint(): string {
  let host = 'unknown'
  try {
    host = hostname().split('.')[0] || 'unknown'
  } catch {
    // A failed hostname lookup leaves the placeholder; the kernel id still counts.
  }
  let kernelId = ''
  try {
    kernelId = readFileSync('/etc/machine-id', 'utf8').trim().slice(0, 12)
  } catch {
    // Non-Linux hosts and unreadable files fall back to the hostname alone.
  }
  return kernelId === '' ? host : `${host}:${kernelId}`
}

/**
 * Report the one misconfiguration replication cannot survive: two machines
 * sharing a `machineId`.
 *
 * Both write `archive-<machineId>.json`, so each publication replaces the other
 * machine's archive set and each machine's list silently follows the last writer.
 * The document records the fingerprint of the machine that wrote it, which is
 * enough to say so before the first overwrite.
 * @param logger - Sink for the warning.
 * @param directory - Shared directory.
 * @param machineId - This machine's configured id.
 * @param fingerprint - This machine's fingerprint; see {@link machineFingerprint}.
 * @returns the foreign fingerprint found, or undefined when the id is this
 *   machine's own (or no document exists yet).
 */
export function reportMachineIdCollision(
  logger: ArchiveReplicaLogger,
  directory: string,
  machineId: string,
  fingerprint: string,
): string | undefined {
  const path = join(directory, vaultFileName(machineId))
  let existing: string | undefined
  try {
    existing = parseVaultFingerprint(readFileSync(path, 'utf8'))
  } catch {
    // No document yet: this machine is the first to publish under that id.
    return undefined
  }
  if (existing === undefined || existing === fingerprint) return undefined
  logger.warn(
    'machineId %s is already published by another machine (document fingerprint %s, this machine %s). Both write %s, so each would overwrite the other: give this machine its own machineId in the profile row.',
    machineId,
    existing,
    fingerprint,
    path,
  )
  return existing
}

/**
 * Warn when the retired script-side sidecar still lists archives.
 *
 * That launcher (`dsh-web-sync.mjs`) merged its own sidecar back into the
 * registry before every start, so a leftover file silently replay a
 * revocation — exactly the failure this plugin's unarchive journal exists to
 * prevent. One explicit line at startup is cheaper than rediscovering it.
 * @param logger - Sink for the warning.
 * @param dshHome - Harness home; defaults to `$DSH_HOME`, then `~/.dsh`.
 * @returns what was reported, or undefined when the sidecar is absent or empty.
 */
export function reportRetiredSidecar(
  logger: ArchiveReplicaLogger,
  dshHome: string = process.env.DSH_HOME ?? join(homedir(), '.dsh'),
): RetiredSidecarReport | undefined {
  const path = retiredSidecarPath(dshHome)
  const count = listedIds(path)
  if (count === undefined || count === 0) return undefined
  logger.warn(
    'retired script-side sidecar %s still lists %d archived Session(s): its launcher writes those ids back into the registry on every start, so a revocation there would be replayed. Delete the file, or stop launching dsh through dsh-web-sync.mjs.',
    path,
    count,
  )
  return { path, count }
}

/**
 * Path the retired script derived its sidecar from: the directory holding the
 * real Session root, plus `dsh-sync/archived-sessions.json`.
 * @param dshHome - Harness home.
 * @returns the sidecar path, whether or not it exists.
 */
function retiredSidecarPath(dshHome: string): string {
  const sessions = join(dshHome, 'sessions')
  let real = sessions
  try {
    real = realpathSync(sessions)
  } catch {
    // A missing or unreadable link keeps the literal path; the read then fails
    // and the check reports nothing.
  }
  return join(dirname(real), 'dsh-sync', 'archived-sessions.json')
}

/**
 * How many archived ids one sidecar lists.
 * @param path - Candidate sidecar file.
 * @returns the id count, or undefined when it is missing, unreadable, or not a sidecar.
 */
function listedIds(path: string): number | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const ids = (parsed as { archivedSessionIds?: unknown }).archivedSessionIds
  return Array.isArray(ids) ? ids.length : undefined
}

/** Whether a path is an existing directory. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Readable message of an unknown rejection. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
