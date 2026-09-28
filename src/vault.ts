/**
 * Vault documents for the cross-machine Session archive replica: one JSON file
 * per machine inside a directory that an external file-sync tool replicates.
 *
 * One writer per file is the whole point of the layout. A single shared file
 * rewritten by every machine would let a sync client's last-write-wins (or a
 * conflict copy) drop archives; with `archive-<machine>.json` each file has
 * exactly one writer, so the union of the directory is monotone. Foreign and
 * damaged files are ignored rather than fatal — a sync client may drop
 * anything into the directory, and a conflict copy is just one more document.
 *
 * Unarchiving is deliberately absent here. The registry has had its own
 * `unarchiveSession` since it grew the archive UI, so a Session is taken back
 * out of the archive set on one machine, by hand, with no cross-machine
 * channel: this module replicates the archive set and nothing else.
 *
 * @module @deepseek-ai/dsh-archive-replica/vault
 */

/** Accepted vault document stamp. */
export const VAULT_DOCUMENT_VERSION = 1

/** File-name prefix owned by this module. */
export const VAULT_FILE_PREFIX = 'archive-'

/** File-name suffix owned by this module. */
export const VAULT_FILE_SUFFIX = '.json'

/** Accepted machine id: one path-safe file-name component. */
const MACHINE_ID = /^[A-Za-z0-9._-]{1,64}$/u

/**
 * Accepted Session id text. Vault content crosses a machine boundary through a
 * third-party sync tool, so ids enter the registry only in the shape the
 * harness itself produces.
 */
const SESSION_ID_TEXT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

/** One parsed vault document. */
export interface VaultDocument {
  /** Document stamp; documents with any other stamp are foreign. */
  readonly version: number
  /** Machine that wrote the document, for operators reading the directory. */
  readonly machine: string
  /** Publication time of this document, ISO-8601. */
  readonly updatedAt: string
  /** Every Session this machine has archived, in its own archive order. */
  readonly archivedSessionIds: readonly string[]
  /**
   * Fingerprint of the publishing machine, when the writer states one.
   *
   * Two machines configured with the same `machineId` write one document and
   * overwrite each other's archive set; the fingerprint is what lets a reader —
   * and the installer — notice that before it happens. Documents written before
   * this field existed simply carry none.
   */
  readonly fingerprint?: string
}

/**
 * Whether a machine id is usable as a vault file-name component.
 * @param machineId - Candidate machine id.
 * @returns true when the id is accepted.
 */
export function isMachineId(machineId: string): boolean {
  return MACHINE_ID.test(machineId)
}

/**
 * File name a machine publishes under.
 * @param machineId - Validated machine id.
 * @returns the vault file name.
 */
export function vaultFileName(machineId: string): string {
  return `${VAULT_FILE_PREFIX}${machineId}${VAULT_FILE_SUFFIX}`
}

/**
 * Parse one vault document, discarding foreign content.
 * @param text - Raw file content.
 * @returns the archived Session ids, or undefined when the document is foreign
 *   or damaged and must be ignored.
 */
export function parseVaultDocument(text: string): readonly string[] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  if (document.version !== VAULT_DOCUMENT_VERSION) return undefined
  const ids = document.archivedSessionIds
  if (!Array.isArray(ids)) return undefined
  return ids.filter((id): id is string => typeof id === 'string' && SESSION_ID_TEXT.test(id))
}

/**
 * Read the publisher fingerprint of one vault document.
 * @param text - Raw file content.
 * @returns the stated fingerprint, or undefined for a foreign document or one
 *   written before the field existed.
 */
export function parseVaultFingerprint(text: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  if (document.version !== VAULT_DOCUMENT_VERSION) return undefined
  if (!Array.isArray(document.archivedSessionIds)) return undefined
  const fingerprint = document.fingerprint
  return typeof fingerprint === 'string' && fingerprint.length > 0 ? fingerprint : undefined
}

/**
 * Render one vault document.
 * @param machineId - Machine publishing the document.
 * @param archivedSessionIds - Session ids to publish, in archive order.
 * @param updatedAt - Publication time, ISO-8601.
 * @param fingerprint - Publishing machine's fingerprint, stated so another
 *   machine sharing this `machineId` can be told apart from this one.
 * @returns the file content.
 */
export function renderVaultDocument(
  machineId: string,
  archivedSessionIds: readonly string[],
  updatedAt: string,
  fingerprint?: string,
): string {
  const document: VaultDocument = {
    version: VAULT_DOCUMENT_VERSION,
    machine: machineId,
    updatedAt,
    archivedSessionIds,
    ...(fingerprint === undefined ? {} : { fingerprint }),
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

/**
 * Union Session id lists, keeping first-seen order and dropping invalid text.
 * @param lists - Lists in precedence order.
 * @returns the deduplicated union.
 */
export function unionSessionIds(...lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>()
  const union: string[] = []
  for (const list of lists) {
    for (const id of list) {
      if (!SESSION_ID_TEXT.test(id) || seen.has(id)) continue
      seen.add(id)
      union.push(id)
    }
  }
  return union
}
