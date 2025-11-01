import { BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import type { ActiveContext } from '../common/ipc'

type WindowManagerDeps = {
  getActiveContext: () => ActiveContext
}

export type WindowManager = {
  createMainWindow(): BrowserWindow
  getMainWindow(): BrowserWindow | null
  ensureMainWindow(): BrowserWindow
  sendToRenderer(channel: string, payload?: unknown): void
  openSearchWindow(): void
  focusMainWindow(): void
  sendSearchContext(context: ActiveContext): void
}

export const createWindowManager = ({ getActiveContext }: WindowManagerDeps): WindowManager => {
  let mainWindow: BrowserWindow | null = null
  let searchWindow: BrowserWindow | null = null

  const getMainWindowInternal = (): BrowserWindow | null => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      return mainWindow
    }
    const existing = BrowserWindow.getAllWindows().find((win) => win.title !== 'Search')
    mainWindow = existing ?? null
    return mainWindow
  }

  const ensureMainWindowInternal = (): BrowserWindow => {
    const win = getMainWindowInternal()
    if (!win) {
      throw new Error('Main window is not available')
    }
    return win
  }

  const sendSearchContext = (context: ActiveContext): void => {
    if (searchWindow && !searchWindow.isDestroyed()) {
      searchWindow.webContents.send('search:context', context)
    }
  }

  const createMainWindow = (): BrowserWindow => {
    const window = new BrowserWindow({
      width: 900,
      height: 670,
      show: false,
      autoHideMenuBar: true,
      ...(process.platform === 'linux' ? { icon } : {}),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false
      }
    })

    mainWindow = window

    window.on('ready-to-show', () => {
      window.show()
    })

    window.on('closed', () => {
      if (mainWindow === window) {
        mainWindow = null
      }
    })

    window.webContents.setWindowOpenHandler((details) => {
      shell.openExternal(details.url)
      return { action: 'deny' }
    })

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      window.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
      window.loadFile(join(__dirname, '../renderer/index.html'))
    }

    return window
  }

  const openSearchWindow = (): void => {
    const parent = ensureMainWindowInternal()

    if (searchWindow && !searchWindow.isDestroyed()) {
      searchWindow.focus()
      sendSearchContext(getActiveContext())
      return
    }

    searchWindow = new BrowserWindow({
      width: 420,
      height: 528,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      parent,
      modal: false,
      title: 'Search',
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false
      }
    })

    searchWindow.on('ready-to-show', () => {
      searchWindow?.show()
    })

    searchWindow.on('closed', () => {
      searchWindow = null
    })

    searchWindow.webContents.once('did-finish-load', () => {
      sendSearchContext(getActiveContext())
    })

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      searchWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/search.html`)
    } else {
      searchWindow.loadFile(join(__dirname, '../renderer/search.html'))
    }
  }

  const sendToRenderer = (channel: string, payload?: unknown): void => {
    const win = getMainWindowInternal()
    win?.webContents.send(channel, payload)
  }

  const focusMainWindow = (): void => {
    const win = ensureMainWindowInternal()
    if (win.isMinimized()) {
      win.restore()
    }
    win.focus()
    win.show()
  }

  return {
    createMainWindow,
    getMainWindow: getMainWindowInternal,
    ensureMainWindow: ensureMainWindowInternal,
    sendToRenderer,
    openSearchWindow,
    focusMainWindow,
    sendSearchContext
  }
}
