import { ipcMain, dialog } from 'electron'
import { promises as fs } from 'fs'
import { basename } from 'path'
import { TextDecoder } from 'util'
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
  FileRangePayload
} from '../common/ipc'

type RegisterIpcDeps = {
  windowManager: WindowManager
  searchService: SearchService
  setActiveContext: (context: ActiveContext) => void
}

const LARGE_FILE_THRESHOLD_BYTES = 2 * 1024 * 1024
const DEFAULT_CHUNK_SIZE = 512 * 1024
const textDecoder = new TextDecoder('utf-8')

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
      return {
        filePath,
        name: basename(filePath),
        content,
        size: totalSize,
        loadedBytes: bytesRead,
        isTruncated: shouldTruncate && bytesRead < totalSize,
        chunkSize
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
    return {
      filePath,
      start: safeStart,
      end: nextEnd,
      content,
      totalSize,
      hasMore: nextEnd < totalSize
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

  ipcMain.handle('save-file-dialog', async (_event, payload: SaveFilePayload) => {
    const { filePath, content, defaultPath } = payload
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

    await fs.writeFile(targetPath, content, 'utf-8')
    searchService.updateTabContentByFilePath(targetPath, content)

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
