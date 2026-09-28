/**
 * The one stale file this plugin still looks for on disk: the retired
 * script-side sidecar, whose launcher writes its ids back into the registry on
 * every start.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { reportStaleSidecar } from '../src/index.ts'
import type { ArchiveReplicaLogger } from '../src/replica.ts'

const STAMP = '2026-09-12T00:00:00.000Z'

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
})

/** Fresh temporary directory removed after the test. */
async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-archive-sidecar-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}

describe('stale script-side sidecar', () => {
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

    expect(reportStaleSidecar(logger, home)).toEqual({ path: sidecar, count: 2 })
    expect(logger.warnLines).toHaveLength(1)
    expect(logger.warnLines[0]).toContain('dsh-web-sync.mjs')
  })

  it('stays silent when the sidecar is absent or empty', async () => {
    const home = await tempDir()
    const logger = fakeLogger()
    expect(reportStaleSidecar(logger, home)).toBeUndefined()

    await mkdir(join(home, 'sessions'), { recursive: true })
    await mkdir(join(home, 'dsh-sync'), { recursive: true })
    await writeFile(join(home, 'dsh-sync', 'archived-sessions.json'), '{"version":1,"archivedSessionIds":[]}')
    expect(reportStaleSidecar(logger, home)).toBeUndefined()
    expect(logger.warnLines).toEqual([])
  })
})
