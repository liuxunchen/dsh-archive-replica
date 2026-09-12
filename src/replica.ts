/**
 * The replica engine: publish this machine's archive set into a shared vault
 * directory and import the ids other machines published there.
 *
 * Both directions run through the workspace registry's own `archiveSession`,
 * so replication is a consumer of the committed registry state and never a
 * second writer of it. Publishing is driven by the storage domain's
 * `domain/changed` event (the same event the Web client's workspace feed
 * folds), so a newly archived Session reaches the vault as soon as its write
 * is durable.
 *
 * The vault also carries an unarchive journal (`unarchived-<machine>.json`).
 * A revocation wins over every publication: a revoked id is never imported and
 * never republished, so one machine undoing a mistaken archive is not replayed
 * back by another machine's monotone union. The registry itself has no
 * unarchive path, so the plugin reports the ids it cannot unhide and leaves
 * applying them to the offline helper.
 *
 * @module @deepseek-ai/dsh-archive-replica/replica
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionId as SessionIdentity } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceUnknownSessionError, workspaceDomainState } from '@deepseek-ai/dsh-workspace'
import {
  parseUnarchiveDocument,
  parseVaultDocument,
  renderVaultDocument,
  unionSessionIds,
  vaultFileName,
} from './vault.ts'

/** The archive surface this engine consumes from the workspace registry. */
export interface ArchiveRegistryPort {
  /** The registry-global archive set, in archive order. */
  readonly archivedSessionIds: readonly SessionIdentity[]
  /**
   * Archive one Session durably.
   * @param sessionId - Session to archive.
   * @throws WorkspaceUnknownSessionError when no live or persisted Session has
   *   that id — the caller treats the id as belonging to another machine.
   */
  archiveSession(sessionId: SessionIdentity): Promise<void>
}

/** Logging surface the engine writes to. */
export interface ArchiveReplicaLogger {
  /**
   * Report an applied replication step.
   * @param format - Message format.
   * @param args - Format arguments.
   */
  info(format: string, ...args: readonly unknown[]): void
  /**
   * Report a skipped or failed candidate.
   * @param format - Message format.
   * @param args - Format arguments.
   */
  warn(format: string, ...args: readonly unknown[]): void
}

/** Watch and publication behavior of one replica, with defaults already applied. */
export interface ArchiveReplicaSpec {
  /** Existing directory shared with the other machines. */
  readonly directory: string
  /** Stable machine id naming this machine's vault document. */
  readonly machineId: string
  /** Keep looking for other machines' publications while the plugin runs. */
  readonly watch: boolean
  /** Interval between directory scans, in milliseconds. */
  readonly pollIntervalMs: number
  /**
   * This machine's fingerprint, published with its document so a second machine
   * misconfigured with the same machineId can be told apart from this one.
   */
  readonly fingerprint?: string
}

/** Configuration knobs accepted before defaulting. */
export interface ArchiveReplicaRequest {
  /** Existing directory shared with the other machines. */
  readonly directory: string
  /** Stable machine id naming this machine's vault document. */
  readonly machineId: string
  /** Keep looking for other machines' publications while the plugin runs. */
  readonly watch?: boolean
  /** Interval between directory scans, in milliseconds. */
  readonly pollIntervalMs?: number
  /** This machine's fingerprint; see {@link ArchiveReplicaSpec.fingerprint}. */
  readonly fingerprint?: string
}

/** Construction options of {@link ArchiveReplica}. */
export interface ArchiveReplicaOptions extends ArchiveReplicaSpec {
  /** Registry archive surface. */
  readonly registry: ArchiveRegistryPort
  /** Log sink. */
  readonly logger: ArchiveReplicaLogger
  /** Publication-time source, injectable for deterministic tests. */
  readonly now?: () => Date
}

/** Outcome of one reconciliation pass. */
export interface ReconcileResult {
  /** Ids newly archived on this machine. */
  readonly imported: number
  /** Ids this machine holds no Session for; another machine's Session. */
  readonly skipped: number
  /** Ids whose archive attempt failed and will be retried. */
  readonly failed: number
  /** Ids skipped because the vault revokes them. */
  readonly revoked: number
}

/** What one directory scan found. */
export interface VaultState {
  /** Every id the directory's archive documents publish, unioned. */
  readonly published: readonly string[]
  /** Every id the directory's unarchive journals revoke. */
  readonly revoked: ReadonlySet<string>
}

/**
 * Default directory-scan interval. Scanning rather than subscribing keeps the
 * plugin free of third-party runtime dependencies and works on the mounts a
 * file-sync client presents, where filesystem notifications are unreliable.
 */
const DEFAULT_POLL_INTERVAL_MS = 2_000

/**
 * Resolve the replica spec from configuration: defaulting happens here, never
 * inline in the engine.
 * @param request - Configured knobs.
 * @returns the fully resolved spec.
 */
export function resolveReplicaSpec(request: ArchiveReplicaRequest): ArchiveReplicaSpec {
  return {
    directory: request.directory,
    machineId: request.machineId,
    watch: request.watch ?? true,
    pollIntervalMs: request.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    ...(request.fingerprint === undefined ? {} : { fingerprint: request.fingerprint }),
  }
}

/**
 * Replicate one machine's archive set through a shared directory.
 *
 * Every operation runs on one promise chain, so a scan, a publication and a
 * shutdown cannot interleave a read-modify-write of the same file.
 */
export class ArchiveReplica {
  private readonly spec: ArchiveReplicaSpec
  private readonly registry: ArchiveRegistryPort
  private readonly logger: ArchiveReplicaLogger
  private readonly now: () => Date

  private timer: NodeJS.Timeout | undefined
  private tail: Promise<void> = Promise.resolve()
  private disposed = false
  private scanning = false
  private published: readonly string[] | undefined
  private publishedRevocations: string | undefined
  private reportedRevocations: string | undefined
  private readonly reportedFailures = new Map<string, string>()

  /**
   * @param options - Resolved spec plus the registry surface, log sink, and clock.
   */
  constructor(options: ArchiveReplicaOptions) {
    this.spec = options
    this.registry = options.registry
    this.logger = options.logger
    this.now = options.now ?? (() => new Date())
  }

  /**
   * Import what the other machines published, publish this machine's own set,
   * then keep scanning the directory for later publications.
   * @returns resolution once the initial pass and the scan loop are running.
   */
  async start(): Promise<void> {
    await this.enqueue(async () => {
      await this.reconcileNow()
      await this.publishNow()
    })
    if (this.disposed || !this.spec.watch) return
    this.timer = setInterval(() => { void this.scan() }, this.spec.pollIntervalMs)
  }

  /**
   * Stop scanning and stop applying further work. In-flight operations finish;
   * later ones observe disposal and do nothing.
   * @returns resolution once in-flight work settled.
   */
  async stop(): Promise<void> {
    this.disposed = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    await this.tail
  }

  /**
   * One directory scan, skipping a tick whose predecessor has not settled.
   * Disposal needs no check here: `stop` clears the interval, and both queued
   * operations observe disposal themselves.
   * @returns resolution once the scan pass settles.
   */
  private async scan(): Promise<void> {
    if (this.scanning) return
    this.scanning = true
    try {
      await this.reconcile()
    } catch (error) {
      this.logger.warn('scanning %s failed: %s', this.spec.directory, messageOf(error))
    } finally {
      this.scanning = false
    }
  }

  /**
   * React to one durable domain write by republishing when the archive set moved.
   * @param change - Storage-domain change event payload.
   */
  observeDomainChange(change: DomainChanged): void {
    if (this.disposed) return
    if (change.domain !== 'workspace' || change.table !== '' || change.operation !== 'put') return
    // The committed snapshot travels with the event: the registry publishes its
    // in-memory state only after this emit, so its archive getter still reports
    // the previous set here. The Web client's Workspace feed reads the payload
    // for the same reason.
    const committed = workspaceDomainState.parse(change.value).archivedSessionIds.map(String)
    void this.publish(committed).catch((error: unknown) => {
      this.logger.warn('publishing after an archive change failed: %s', messageOf(error))
    })
  }

  /**
   * Archive every published id this machine has not archived yet.
   * @returns the pass outcome.
   */
  reconcile(): Promise<ReconcileResult> {
    return this.enqueue(async () => this.reconcileNow())
  }

  /**
   * Write an archive set to this machine's own vault document.
   * @param committed - Archive set to publish; omission reads the registry's
   *   current set, which is authoritative outside a change event.
   * @returns resolution after the document is durable, or immediately when the
   *   published content is unchanged.
   */
  publish(committed?: readonly string[]): Promise<void> {
    return this.enqueue(async () => this.publishNow(committed))
  }

  /** One reconciliation pass, on the caller's chain slot. */
  private async reconcileNow(): Promise<ReconcileResult> {
    if (this.disposed) return { imported: 0, skipped: 0, failed: 0, revoked: 0 }
    const state = await this.readVaultState()
    const archived = new Set<string>(this.registry.archivedSessionIds.map(String))
    let imported = 0
    let skipped = 0
    let failed = 0
    let revoked = 0
    for (const id of state.published) {
      // A revocation outranks every publication: without this the other
      // machine's monotone union would replay the archive we just undid.
      if (state.revoked.has(id)) {
        revoked += 1
        continue
      }
      if (archived.has(id)) continue
      try {
        await this.registry.archiveSession(SessionId(id))
        archived.add(id)
        imported += 1
        this.reportedFailures.delete(id)
      } catch (error) {
        if (error instanceof WorkspaceUnknownSessionError) {
          skipped += 1
          continue
        }
        failed += 1
        this.reportOnce(id, error)
      }
    }
    if (imported > 0) {
      this.logger.info('archived %d Session(s) published by another machine', imported)
    }
    this.reportStaleRevocations(state.revoked)
    await this.republishOnRevocationChange(state.revoked)
    return { imported, skipped, failed, revoked }
  }

  /** One publication, on the caller's chain slot. */
  private async publishNow(committed?: readonly string[]): Promise<void> {
    if (this.disposed) return
    const { revoked } = await this.readVaultState()
    const current = (committed ?? this.registry.archivedSessionIds.map(String))
      .filter(id => !revoked.has(id))
    if (this.published !== undefined && sameIds(this.published, current)) return
    const path = join(this.spec.directory, vaultFileName(this.spec.machineId))
    const content = renderVaultDocument(
      this.spec.machineId,
      current,
      this.now().toISOString(),
      this.spec.fingerprint,
    )
    await writeFileAtomic(path, content, { mode: 0o600 })
    this.published = current
  }

  /**
   * Republish when the revocations changed even though the registry did not.
   *
   * A journal arrives from the file-sync tool, never from a registry write, so
   * `domain/changed` does not fire for it. Without this check a revocation would
   * reach this machine's document only the next time something else is archived.
   * @param revoked - Ids the vault revokes in this pass.
   */
  private async republishOnRevocationChange(revoked: ReadonlySet<string>): Promise<void> {
    const key = [...revoked].sort().join(',')
    if (this.publishedRevocations === key) return
    this.publishedRevocations = key
    await this.publishNow()
  }

  /**
   * Report a revocation this machine cannot apply by itself.
   *
   * The registry only archives, so a revoked id that is still in this machine's
   * archive set stays hidden until the offline helper rewrites the registry
   * with dsh stopped. Reporting once per distinct set keeps a two-second scan
   * loop from repeating the same line.
   * @param revoked - Ids the vault revokes.
   */
  private reportStaleRevocations(revoked: ReadonlySet<string>): void {
    if (revoked.size === 0) {
      this.reportedRevocations = undefined
      return
    }
    const stale = this.registry.archivedSessionIds
      .map(String)
      .filter(id => revoked.has(id))
      .sort()
    if (stale.length === 0) {
      this.reportedRevocations = undefined
      return
    }
    const key = stale.join(',')
    if (this.reportedRevocations === key) return
    this.reportedRevocations = key
    this.logger.warn(
      '%d Session(s) are revoked in the vault but still archived here; with dsh stopped run unarchive-session.sh to apply: %s',
      stale.length,
      key,
    )
  }

  /**
   * Read every document in the shared directory: archive documents contribute
   * published ids, unarchive journals contribute revocations.
   *
   * Selection is by content, not by file name: a sync client's conflict copy or
   * a renamed document still carries archives, while a half-written or foreign
   * JSON file parses as nothing and is ignored.
   * @returns the unioned ids and the revocation set.
   */
  private async readVaultState(): Promise<VaultState> {
    const entries = await readdir(this.spec.directory, { withFileTypes: true })
    const lists: string[][] = []
    const revoked = new Set<string>()
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const path = join(this.spec.directory, entry.name)
      try {
        const text = await readFile(path, 'utf8')
        const archived = parseVaultDocument(text)
        if (archived !== undefined) {
          lists.push([...archived])
          continue
        }
        const unarchived = parseUnarchiveDocument(text)
        if (unarchived === undefined) continue
        for (const id of unarchived) revoked.add(id)
      } catch (error) {
        // A sync client can hold a file mid-transfer; the next event retries it.
        this.reportOnce(entry.name, error)
      }
    }
    return { published: unionSessionIds(...lists), revoked }
  }

  /** Warn about one failure per subject, so a retry loop stays readable. */
  private reportOnce(subject: string, error: unknown): void {
    const message = messageOf(error)
    if (this.reportedFailures.get(subject) === message) return
    this.reportedFailures.set(subject, message)
    this.logger.warn('%s: %s', subject, message)
  }

  /** Run one operation after every operation enqueued before it. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}

/** Compare two id lists positionally. */
function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

/** Readable message of an unknown rejection. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
