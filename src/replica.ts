/**
 * The replica engine: publish this machine's archive set into a shared vault
 * directory and import the archive sets other machines published there.
 *
 * One direction only. Every archive goes through the workspace registry's own
 * `archiveSession`, so replication is a consumer of the committed registry
 * state and never a second writer of it, and nothing here ever removes an id
 * from the registry — unarchiving is the registry's own `unarchiveSession`,
 * applied by hand on the machine that wants the Session back.
 *
 * Publishing is driven by the storage domain's `domain/changed` event (the same
 * event the Web client's workspace feed folds), so a newly archived Session
 * reaches the vault as soon as its write is durable.
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
import { WorkspaceActiveSessionError, WorkspaceUnknownSessionError, workspaceDomainState } from '@deepseek-ai/dsh-workspace'
import { parseVaultDocument, renderVaultDocument, unionSessionIds, vaultFileName } from './vault.ts'

/** The archive surface this engine consumes from the workspace registry. */
export interface ArchiveRegistryPort {
  /** The registry-global archive set, in archive order. */
  readonly archivedSessionIds: readonly SessionIdentity[]
  /**
   * Archive one Session durably.
   * @param sessionId - Session to archive.
   * @throws WorkspaceUnknownSessionError when no live or persisted Session has
   *   that id — the caller treats the id as belonging to another machine.
   * @throws WorkspaceActiveSessionError when the Session has running work — the
   *   caller leaves it to the machine that is running it.
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
  /** Keep looking for other machines' publications while the plugin runs; omission takes the default. */
  readonly watch?: boolean | undefined
  /** Interval between directory scans, in milliseconds; omission takes the default. */
  readonly pollIntervalMs?: number | undefined
  /** This machine's fingerprint; see {@link ArchiveReplicaSpec.fingerprint}. */
  readonly fingerprint?: string | undefined
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
  /**
   * Ids this machine is running right now, so the registry refused the archive.
   * Retried on every later pass: the Session becomes archivable as soon as its
   * work stops.
   */
  readonly active: number
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
  private reportedActive = false
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
    if (this.disposed) return { imported: 0, skipped: 0, failed: 0, active: 0 }
    const published = await this.readPublishedIds()
    const archived = new Set<string>(this.registry.archivedSessionIds.map(String))
    const running: string[] = []
    let imported = 0
    let skipped = 0
    let failed = 0
    for (const id of published) {
      if (archived.has(id)) continue
      const outcome = await this.archive(SessionId(id))
      if (outcome.status === 'imported') {
        archived.add(id)
        imported += 1
      } else if (outcome.status === 'unknown') {
        skipped += 1
      } else if (outcome.status === 'active') {
        running.push(outcome.report)
      } else {
        failed += 1
      }
    }
    if (imported > 0) {
      this.logger.info('archived %d Session(s) published by another machine', imported)
    }
    this.reportRunning(running)
    return { imported, skipped, failed, active: running.length }
  }

  /** One publication, on the caller's chain slot. */
  private async publishNow(committed?: readonly string[]): Promise<void> {
    if (this.disposed) return
    const current = committed ?? this.registry.archivedSessionIds.map(String)
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
   * Archive one published id, classifying what the registry answered.
   *
   * A Session another machine archived may be running here — a Session log
   * reaches this machine, its turn does not. That one is left alone: the
   * archive is retried on every later pass, so it lands by itself once the work
   * stops, while archiving it now would mean stopping work on this machine on
   * the strength of a decision taken on another one.
   * @param sessionId - Published id to archive.
   * @returns what the attempt did, naming the work in the way of an active one.
   */
  private async archive(
    sessionId: SessionIdentity,
  ): Promise<{ readonly status: 'imported' | 'unknown' | 'failed' } | { readonly status: 'active'; readonly report: string }> {
    try {
      await this.registry.archiveSession(sessionId)
      this.reportedFailures.delete(String(sessionId))
      return { status: 'imported' }
    } catch (error) {
      if (error instanceof WorkspaceUnknownSessionError) return { status: 'unknown' }
      if (error instanceof WorkspaceActiveSessionError) {
        return { status: 'active', report: `${String(sessionId)} (${activityKinds(error)})` }
      }
      this.reportOnce(String(sessionId), error)
      return { status: 'failed' }
    }
  }

  /**
   * Report the published ids this machine is running, once per busy period.
   *
   * Those ids are retried on every pass, so a line per pass would repeat every
   * two seconds for as long as the work lasts. One line when the state appears —
   * and nothing until every one of them has stopped — is what an operator can
   * act on.
   * @param running - Rendered ids this pass could not archive because they are
   *   running here, each with the work that is in the way.
   */
  private reportRunning(running: readonly string[]): void {
    if (running.length === 0) {
      this.reportedActive = false
      return
    }
    if (this.reportedActive) return
    this.reportedActive = true
    this.logger.warn(
      '%d Session(s) published by another machine are running here, so this machine keeps them visible until the work stops; each is retried on every scan: %s',
      running.length,
      running.join(', '),
    )
  }

  /**
   * Read every vault document in the shared directory and union their ids.
   *
   * Selection is by content, not by file name: a sync client's conflict copy or
   * a renamed document still carries archives, while a half-written or foreign
   * JSON file parses as nothing and is ignored.
   * @returns the unioned ids, in first-seen order.
   */
  private async readPublishedIds(): Promise<readonly string[]> {
    const entries = await readdir(this.spec.directory, { withFileTypes: true })
    const lists: string[][] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      try {
        const archived = parseVaultDocument(await readFile(join(this.spec.directory, entry.name), 'utf8'))
        if (archived !== undefined) lists.push([...archived])
      } catch (error) {
        // A sync client can hold a file mid-transfer; the next event retries it.
        this.reportOnce(entry.name, error)
      }
    }
    return unionSessionIds(...lists)
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

/** The activity families keeping one Session out of the archive set. */
function activityKinds(error: WorkspaceActiveSessionError): string {
  return error.activity.map(entry => entry.kind).join(', ')
}

/** Readable message of an unknown rejection. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
