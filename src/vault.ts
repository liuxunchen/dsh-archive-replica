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
 * The same directory also carries the unarchive journal:
 * `unarchived-<machine>.json` lists the Sessions one machine took back out of
 * the archive set. Archiving is one-way in the registry, so this journal is the
 * only channel that may shrink the union; every reader applies it after — and
 * over — the archive documents, which is what keeps a revoked Session from
 * being replayed back by another machine's publication.
 *
 * @module @deepseek-ai/dsh-archive-replica/vault
 */

/** Accepted vault document stamp, shared by archive and unarchive documents. */
export const VAULT_DOCUMENT_VERSION = 1

/** File-name prefix owned by this module. */
export const VAULT_FILE_PREFIX = 'archive-'

/** File-name prefix owned by the unarchive journal. */
export const UNARCHIVE_FILE_PREFIX = 'unarchived-'

/** File-name suffix shared by both document kinds. */
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

/** One parsed unarchive document. */
export interface UnarchiveDocument {
  /** Document stamp; documents with any other stamp are foreign. */
  readonly version: number
  /** Machine that wrote the document, for operators reading the directory. */
  readonly machine: string
  /** Publication time of this document, ISO-8601. */
  readonly updatedAt: string
  /**
   * Sessions this machine took out of the archive set, in its own revocation
   * order. A revocation is global: every machine drops these ids from what it
   * imports and from what it publishes.
   */
  readonly unarchivedSessionIds: readonly string[]
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
 * File name a machine publishes its unarchive journal under.
 * @param machineId - Validated machine id.
 * @returns the journal file name.
 */
export function unarchiveFileName(machineId: string): string {
  return `${UNARCHIVE_FILE_PREFIX}${machineId}${VAULT_FILE_SUFFIX}`
}

/**
 * Parse one vault document, discarding foreign content.
 * @param text - Raw file content.
 * @returns the archived Session ids, or undefined when the document is foreign
 *   or damaged and must be ignored.
 */
export function parseVaultDocument(text: string): readonly string[] | undefined {
  const parsed = parseDocument(text, 'archivedSessionIds')
  return parsed === undefined ? undefined : filterSessionIds(parsed.ids)
}

/**
 * Read the publisher fingerprint of one vault document.
 * @param text - Raw file content.
 * @returns the stated fingerprint, or undefined for a foreign document or one
 *   written before the field existed.
 */
export function parseVaultFingerprint(text: string): string | undefined {
  const parsed = parseDocument(text, 'archivedSessionIds')
  const fingerprint = parsed?.document.fingerprint
  return typeof fingerprint === 'string' && fingerprint.length > 0 ? fingerprint : undefined
}

/**
 * Parse one unarchive document, discarding foreign content.
 * @param text - Raw file content.
 * @returns the revoked Session ids, or undefined when the document is foreign
 *   or damaged and must be ignored.
 */
export function parseUnarchiveDocument(text: string): readonly string[] | undefined {
  const parsed = parseDocument(text, 'unarchivedSessionIds')
  return parsed === undefined ? undefined : filterSessionIds(parsed.ids)
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
 * Render one unarchive document.
 * @param machineId - Machine publishing the journal.
 * @param unarchivedSessionIds - Session ids to revoke, in revocation order.
 * @param updatedAt - Publication time, ISO-8601.
 * @returns the file content.
 */
export function renderUnarchiveDocument(
  machineId: string,
  unarchivedSessionIds: readonly string[],
  updatedAt: string,
): string {
  const document: UnarchiveDocument = {
    version: VAULT_DOCUMENT_VERSION,
    machine: machineId,
    updatedAt,
    unarchivedSessionIds,
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

/**
 * Read the id array one document kind carries, rejecting the other kind and
 * every foreign shape. A document is identified by its own field, so an
 * archive document is never mistaken for a journal or the reverse.
 * @param text - Raw file content.
 * @param field - Id-array field this document kind must carry.
 * @returns the document and its raw id array, or undefined when this document
 *   is not that kind.
 */
function parseDocument(
  text: string,
  field: 'archivedSessionIds' | 'unarchivedSessionIds',
): { readonly document: Record<string, unknown>; readonly ids: readonly unknown[] } | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  if (document.version !== VAULT_DOCUMENT_VERSION) return undefined
  const ids = document[field]
  return Array.isArray(ids) ? { document, ids } : undefined
}

/**
 * Keep only well-formed Session ids.
 * @param ids - Raw id values from a document.
 * @returns the accepted ids in document order.
 */
function filterSessionIds(ids: readonly unknown[]): readonly string[] {
  return ids.filter((id): id is string => typeof id === 'string' && SESSION_ID_TEXT.test(id))
}
