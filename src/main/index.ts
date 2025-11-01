import { app, BrowserWindow } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { createWindowManager } from './window-manager'
import { buildApplicationMenu } from './menu'
import { createSearchService } from './search-service'
import { registerIpcHandlers } from './ipc'
import type { ActiveContext } from '../common/ipc'

let activeContext: ActiveContext = { kind: 'welcome' }

const searchService = createSearchService()
const windowManager = createWindowManager({
  getActiveContext: () => activeContext
})

const setActiveContext = (context: ActiveContext): void => {
  activeContext = context
  windowManager.sendSearchContext(context)
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  windowManager.createMainWindow()
  registerIpcHandlers({
    windowManager,
    searchService,
    setActiveContext
  })

  buildApplicationMenu({
    sendToRenderer: windowManager.sendToRenderer,
    openSearchWindow: windowManager.openSearchWindow
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      windowManager.createMainWindow()
      buildApplicationMenu({
        sendToRenderer: windowManager.sendToRenderer,
        openSearchWindow: windowManager.openSearchWindow
      })
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
