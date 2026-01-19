import { ipcMain, dialog } from 'electron'
import { promises as fs, createReadStream, createWriteStream } from 'fs'
import { basename, join } from 'path'
import { TextDecoder } from 'util'
import { tmpdir } from 'os'
import type { WindowManager } from './window-manager'
import type { SearchService } from './search-service'
import type {
  ActiveContext,
  OpenedFile,
  SaveFilePayload,
  SearchRequest,
  SearchResponsePayload,
  SearchableTab,
  FileRangeRequest,
  FileRangePayload,
  WindowEditPayload,
  WindowEditResult
} from '../common/ipc'

type RegisterIpcDeps = {
  windowManager: WindowManager
  searchService: SearchService
  setActiveContext: (context: ActiveContext) => void
}

const LARGE_FILE_THRESHOLD_BYTES = 2 * 1024 * 1024
const DEFAULT_CHUNK_SIZE = 512 * 1024
const textDecoder = new TextDecoder('utf-8')
const lineCache = new Map<string, Map<number, number>>()

const countLinesInText = (value: string): number => {
  if (!value.length) {
    return 1
  }
  let count = 1
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) {
      count += 1
    }
  }
  return count
}

const countLinesInFile = async (filePath: string): Promise<number> => {
  return await new Promise((resolve, reject) => {
    let count = 0
    const stream = createReadStream(filePath, {
      encoding: 'utf-8',
      highWaterMark: 256 * 1024
    })
    stream.on('data', (chunk: string) => {
      for (let index = 0; index < chunk.length; index += 1) {
        if (chunk.charCodeAt(index) === 10) {
          count += 1
        }
      }
    })
    stream.on('end', () => {
      resolve(count + 1)
    })
    stream.on('error', (error) => {
      reject(error)
    })
  })
}

const getOrInitLineCache = (filePath: string): Map<number, number> => {
  let cache = lineCache.get(filePath)
  if (!cache) {
    cache = new Map([[0, 1]])
    lineCache.set(filePath, cache)
  }
  return cache
}

const getLineNumberForOffset = async (filePath: string, offset: number): Promise<number> => {
  if (offset <= 0) {
    return 1
  }

  const cache = getOrInitLineCache(filePath)
  let nearestOffset = 0
  let nearestLine = 1

  cache.forEach((line, cachedOffset) => {
    if (cachedOffset <= offset && cachedOffset >= nearestOffset) {
      nearestOffset = cachedOffset
      nearestLine = line
    }
  })

  if (nearestOffset === offset) {
    return nearestLine
  }

  const handle = await fs.open(filePath, 'r')
  try {
    const bufferSize = 256 * 1024
    const buffer = Buffer.alloc(bufferSize)
    let currentOffset = nearestOffset
    let currentLine = nearestLine

    while (currentOffset < offset) {
      const toRead = Math.min(bufferSize, offset - currentOffset)
      const { bytesRead } = await handle.read(buffer, 0, toRead, currentOffset)
      if (bytesRead === 0) {
        break
      }
      for (let index = 0; index < bytesRead; index += 1) {
        if (buffer[index] === 10) {
          currentLine += 1
        }
      }
      currentOffset += bytesRead
    }

    cache.set(offset, currentLine)
    return currentLine
  } finally {
    await handle.close()
  }
}

const copySegment = async (
  filePath: string,
  writeStream: ReturnType<typeof createWriteStream>,
  start: number,
  end: number | null
): Promise<void> => {
  const readStream = createReadStream(filePath, {
    start,
    end: typeof end === 'number' ? Math.max(start, end) - 1 : undefined
  })

  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error): void => {
      readStream.destroy()
      reject(error)
    }
    readStream.on('error', handleError)
    writeStream.on('error', handleError)
    readStream.on('end', () => resolve())
    readStream.pipe(writeStream, { end: false })
  })
}

const applyWindowEdit = async ({
  filePath,
  rangeStart,
  rangeEnd,
  replacement
}: WindowEditPayload): Promise<WindowEditResult> => {
  if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd) || rangeStart < 0 || rangeEnd < rangeStart) {
    throw new Error('Invalid edit range')
  }

  const tempPath = join(tmpdir(), `logeditor-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`)
  const writeStream = createWriteStream(tempPath, { encoding: 'utf-8' })

  try {
    await copySegment(filePath, writeStream, 0, rangeStart)
    await new Promise<void>((resolve, reject) => {
      writeStream.write(replacement, (error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
    await copySegment(filePath, writeStream, rangeEnd, null)
    await new Promise<void>((resolve, reject) => {
      writeStream.end((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })

    await fs.rename(tempPath, filePath)
    lineCache.delete(filePath)
    const stats = await fs.stat(filePath)
    return {
      filePath,
      size: stats.size
    }
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

const readFileHead = async (filePath: string): Promise<OpenedFile | null> => {
  try {
    const stats = await fs.stat(filePath)
    if (!stats.isFile()) {
      return null
    }

    const totalSize = stats.size
    const chunkSize = DEFAULT_CHUNK_SIZE
    const shouldTruncate = totalSize > LARGE_FILE_THRESHOLD_BYTES
    const readLength = shouldTruncate ? Math.min(chunkSize, Number(totalSize)) : Number(totalSize)

    if (readLength === 0) {
      return {
        filePath,
        name: basename(filePath),
        content: '',
        size: totalSize,
        loadedBytes: 0,
        isTruncated: false,
        chunkSize
      }
    }

    const handle = await fs.open(filePath, 'r')
    try {
      const buffer = Buffer.alloc(readLength)
      const { bytesRead } = await handle.read(buffer, 0, readLength, 0)
      const content = textDecoder.decode(buffer.subarray(0, bytesRead))
      const loadedLineCount = countLinesInText(content)
      let lineCount = loadedLineCount
      if (shouldTruncate) {
        try {
          lineCount = await countLinesInFile(filePath)
        } catch (error) {
          console.warn(`Failed to count lines for ${filePath}`, error)
        }
      }
      return {
        filePath,
        name: basename(filePath),
        content,
        size: totalSize,
        loadedBytes: bytesRead,
        isTruncated: shouldTruncate && bytesRead < totalSize,
        chunkSize,
        lineCount,
        loadedLineCount
      }
    } finally {
      await handle.close()
    }
  } catch (error) {
    console.error(`Failed to read file head: ${filePath}`, error)
    return null
  }
}

const readFiles = async (filePaths: string[]): Promise<OpenedFile[]> => {
  const results: OpenedFile[] = []
  const seen = new Set<string>()

  for (const filePath of filePaths) {
    if (!filePath || seen.has(filePath)) {
      continue
    }
    seen.add(filePath)

    const descriptor = await readFileHead(filePath)
    if (descriptor) {
      results.push(descriptor)
    }
  }

  return results
}

const readFileRange = async ({
  filePath,
  start,
  length
}: FileRangeRequest): Promise<FileRangePayload> => {
  const safeStart = Number.isFinite(start) && start >= 0 ? Math.floor(start) : 0
  const safeLength = Number.isFinite(length) && length > 0 ? Math.floor(length) : DEFAULT_CHUNK_SIZE

  const handle = await fs.open(filePath, 'r')
  try {
    const stats = await handle.stat()
    const totalSize = stats.size
    if (safeStart >= totalSize) {
      return {
        filePath,
        start: safeStart,
        end: safeStart,
        content: '',
        totalSize,
        hasMore: false
      }
    }

    const endPosition = Math.min(totalSize, safeStart + safeLength)
    const buffer = Buffer.alloc(endPosition - safeStart)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, safeStart)
    const content = textDecoder.decode(buffer.subarray(0, bytesRead))

    const nextEnd = safeStart + bytesRead
    const startLine = await getLineNumberForOffset(filePath, safeStart)
    const lineCount = countLinesInText(content)
    getOrInitLineCache(filePath).set(nextEnd, startLine + lineCount)
    return {
      filePath,
      start: safeStart,
      end: nextEnd,
      content,
      totalSize,
      hasMore: nextEnd < totalSize,
      startLine,
      lineCount
    }
  } finally {
    await handle.close()
  }
}

export const registerIpcHandlers = ({
  windowManager,
  searchService,
  setActiveContext
}: RegisterIpcDeps): void => {
  ipcMain.on('ping', () => console.log('pong'))

  ipcMain.handle('open-file-dialog', async () => {
    const win = windowManager.ensureMainWindow()
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Open Log Files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Logs', extensions: ['log', 'txt'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })

    if (canceled || !filePaths.length) {
      return []
    }

    return readFiles(filePaths)
  })

  ipcMain.handle('read-files-from-paths', async (_event, maybePaths: unknown) => {
    if (!Array.isArray(maybePaths)) {
      return []
    }
    const filePaths = maybePaths.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    if (!filePaths.length) {
      return []
    }
    return readFiles(filePaths)
  })

  ipcMain.handle('read-file-range', async (_event, payload: FileRangeRequest) => {
    if (!payload || typeof payload.filePath !== 'string') {
      return {
        filePath: '',
        start: 0,
        end: 0,
        content: '',
        totalSize: 0,
        hasMore: false
      }
    }

    try {
      return await readFileRange(payload)
    } catch (error) {
      console.error('Failed to read file range', payload, error)
      throw error
    }
  })

  ipcMain.handle('apply-window-edit', async (_event, payload: WindowEditPayload): Promise<WindowEditResult> => {
    try {
      return await applyWindowEdit(payload)
    } catch (error) {
      console.error('Failed to apply window edit', payload?.filePath, error)
      throw error
    }
  })

  ipcMain.handle('save-file-dialog', async (_event, payload: SaveFilePayload) => {
    const { filePath, content, defaultPath, sourcePath } = payload
    let targetPath = filePath

    if (!targetPath) {
      const win = windowManager.ensureMainWindow()
      const result = await dialog.showSaveDialog(win, {
        title: 'Save Log File',
        defaultPath,
        filters: [
          { name: 'Logs', extensions: ['log', 'txt'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      })

      if (result.canceled || !result.filePath) {
        return { canceled: true }
      }

      targetPath = result.filePath
    }

    if (sourcePath) {
      await fs.copyFile(sourcePath, targetPath)
    } else if (typeof content === 'string') {
      await fs.writeFile(targetPath, content, 'utf-8')
      searchService.updateTabContentByFilePath(targetPath, content)
    } else {
      throw new Error('Missing content for save operation')
    }

    return { canceled: false, filePath: targetPath }
  })

  ipcMain.handle('perform-search', async (_event, request: SearchRequest): Promise<SearchResponsePayload> => {
    try {
      return await searchService.performSearch(request)
    } catch (error) {
      console.error('Search execution failed', error)
      throw error
    }
  })

  ipcMain.on('sync-tab-state', (_event, tab: SearchableTab) => {
    searchService.syncTabState(tab)
  })

  ipcMain.on('remove-tab-state', (_event, tabId: string) => {
    searchService.removeTabState(tabId)
  })

  ipcMain.on('display-search-results', (_event, payload: SearchResponsePayload) => {
    windowManager.sendToRenderer('search:results', payload)
  })

  ipcMain.on('navigate-to-file-line', (_event, payload: { tabId: string; line: number; column?: number }) => {
    windowManager.sendToRenderer('search:navigate', payload)
  })

  ipcMain.on('open-search-window', () => {
    windowManager.openSearchWindow()
  })

  ipcMain.on('dispose-search-results', (_event, searchId: string) => {
    searchService.disposeSearchResults(searchId)
  })

  ipcMain.on('update-active-context', (_event, context: ActiveContext) => {
    setActiveContext(context)
  })

  ipcMain.on('focus-main-window', () => {
    windowManager.focusMainWindow()
  })
}
