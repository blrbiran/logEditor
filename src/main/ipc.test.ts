import { beforeEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promises as fs } from 'node:fs'
import { applyWindowEdit, readFileRange, resetLineCache } from './ipc'

type TempFixture = {
  filePath: string
  cleanup: () => Promise<void>
}

const createFixture = async (content: string): Promise<TempFixture> => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'logeditor-ipc-'))
  const filePath = join(dir, 'fixture.log')
  await fs.writeFile(filePath, content, 'utf-8')
  return {
    filePath,
    cleanup: () => fs.rm(dir, { recursive: true, force: true })
  }
}

beforeEach(() => {
  resetLineCache()
})

describe('ipc helpers', () => {
  it('reads file windows with accurate metadata', async () => {
    const fixture = await createFixture(['first line', 'second line', 'third line', 'fourth'].join('\n') + '\n')
    try {
      const start = 'first line\n'.length
      const chunk = await readFileRange({
        filePath: fixture.filePath,
        start,
        length: 16
      })

      expect(chunk.start).toBe(start)
      expect(chunk.startLine).toBe(2)
      expect(chunk.lineCount).toBeGreaterThanOrEqual(2)
      expect(chunk.hasMore).toBe(true)
      expect(chunk.content).toContain('second line')

      const next = await readFileRange({
        filePath: fixture.filePath,
        start: chunk.end,
        length: 16
      })

      expect(next.startLine).toBeGreaterThan(chunk.startLine)
      expect(next.hasMore).toBe(false)
    } finally {
      await fixture.cleanup()
    }
  })

  it('applies window edits and invalidates cached line offsets', async () => {
    const original = 'AAAA\nBBBB\nCCCC\n'
    const fixture = await createFixture(original)
    try {
      // warm cache
      await readFileRange({ filePath: fixture.filePath, start: 0, length: original.length })

      const rangeStart = 'AAAA\n'.length
      const rangeEnd = rangeStart + 'BBBB\n'.length
      await applyWindowEdit({
        filePath: fixture.filePath,
        rangeStart,
        rangeEnd,
        replacement: 'BETA\nDELTA\n'
      })

      const updatedContent = await fs.readFile(fixture.filePath, 'utf-8')
      expect(updatedContent).toBe('AAAA\nBETA\nDELTA\nCCCC\n')

      const chunk = await readFileRange({ filePath: fixture.filePath, start: rangeStart, length: 18 })
      expect(chunk.content.startsWith('BETA')).toBe(true)
      expect(chunk.startLine).toBe(2)
      expect(chunk.lineCount).toBeGreaterThanOrEqual(2)
    } finally {
      await fixture.cleanup()
    }
  })
})
