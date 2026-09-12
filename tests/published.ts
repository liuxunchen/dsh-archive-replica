import { readFileSync } from 'node:fs'

/** One published vault document as these specs read it. */
export interface PublishedDocument {
  /** Machine that wrote the document. */
  readonly machine: string
  /** Archived Session ids the document publishes. */
  readonly archivedSessionIds: readonly string[]
}

/**
 * Read one published vault document.
 * @param path - Document path.
 * @returns the document, or undefined when it is missing or malformed.
 */
export function publishedDocument(path: string): PublishedDocument | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const document = parsed as { machine?: unknown; archivedSessionIds?: unknown }
  if (typeof document.machine !== 'string' || !Array.isArray(document.archivedSessionIds)) return undefined
  return {
    machine: document.machine,
    archivedSessionIds: document.archivedSessionIds.filter(
      (id): id is string => typeof id === 'string',
    ),
  }
}

/**
 * Poll one published document until it lists exactly the expected ids.
 * `vi.waitFor` cannot be used for these assertions: while it polls, the
 * replication work being awaited — an event-driven publication on the same
 * event loop — makes no progress, so the wait could only time out.
 * @param path - Document path.
 * @param expected - Ids the document must list, in order.
 * @returns the matched ids.
 * @throws when the document never reaches that content.
 */
export async function settleTo(path: string, expected: readonly string[]): Promise<readonly string[]> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const ids = publishedDocument(path)?.archivedSessionIds
    if (ids !== undefined && ids.length === expected.length
      && ids.every((id, index) => id === expected[index])) return ids
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`published document ${path} never became ${JSON.stringify(expected)}`)
}
