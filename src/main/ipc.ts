import { ipcMain, dialog } from 'electron'
import { promises as fs } from 'fs'
import type { WindowManager } from './window-manager'
import type { SearchService } from './search-service'
import type { ActiveContext, SaveFilePayload, SearchRequest, SearchResponsePayload, SearchableTab } from '../common/ipc'

type RegisterIpcDeps = {
  windowManager: WindowManager
  searchService: SearchService
  setActiveContext: (context: ActiveContext) => void
}

type OpenFileResult = {
  filePath: string
  content: string
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

    const results: OpenFileResult[] = []
    for (const filePath of filePaths) {
      try {
        const content = await fs.readFile(filePath, 'utf-8')
        results.push({ filePath, content })
      } catch (error) {
        console.error(`Failed to read file: ${filePath}`, error)
      }
    }

    return results
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

  ipcMain.handle('perform-search', (_event, request: SearchRequest): SearchResponsePayload => {
    try {
      return searchService.performSearch(request)
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
