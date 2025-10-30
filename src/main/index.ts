import { app, shell, BrowserWindow, ipcMain, dialog, Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { promises as fs } from 'fs'
import { randomUUID } from 'crypto'

type SearchableTab = {
  id: string
  title: string
  filePath?: string
  content: string
}

type OpenFileResult = {
  filePath: string
  content: string
}

type SaveFilePayload = {
  filePath?: string
  content: string
  defaultPath?: string
}

type SearchScope =
  | {
      kind: 'workspace'
    }
  | {
      kind: 'search'
      searchId: string
    }

type SearchRequest = {
  query: string
  isRegex: boolean
  matchCase: boolean
  scope?: SearchScope
  excludeQuery?: string
}

type SearchMatch = {
  line: number
  column: number
  match: string
  preview: string
}

type SearchResponseItem = {
  tabId: string
  title: string
  filePath?: string
  matches: SearchMatch[]
}

type SearchResponsePayload = {
  searchId: string
  parentSearchId?: string
  request: SearchRequest
  results: SearchResponseItem[]
}

type ActiveContext =
  | { kind: 'welcome' }
  | { kind: 'file'; tabId: string }
  | { kind: 'search'; searchId: string }

type StoredSearchResultSet = {
  searchId: string
  parentSearchId?: string
  request: SearchRequest
  results: SearchResponseItem[]
}

let mainWindow: BrowserWindow | null = null
let searchWindow: BrowserWindow | null = null
const tabStore = new Map<string, SearchableTab>()
const searchResultsStore = new Map<string, StoredSearchResultSet>()
let activeContext: ActiveContext = { kind: 'welcome' }

const generateSearchId = (): string => {
  try {
    return randomUUID()
  } catch {
    return `search-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
  }
}

const sendSearchContextToWindow = (): void => {
  if (searchWindow && !searchWindow.isDestroyed()) {
    searchWindow.webContents.send('search:context', activeContext)
  }
}

const getMainWindow = (): BrowserWindow | null => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow
  }
  const existing = BrowserWindow.getAllWindows().find((win) => win.title !== 'Search')
  mainWindow = existing ?? null
  return mainWindow
}

const ensureMainWindow = (): BrowserWindow => {
  const win = getMainWindow()
  if (!win) {
    throw new Error('Main window is not available')
  }
  return win
}

const sendToRenderer = (channel: string, payload?: any): void => {
  const win = getMainWindow()
  if (win) {
    win.webContents.send(channel, payload)
  }
}

function createMainWindow(): BrowserWindow {
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

  window.on('ready-to-show', () => {
    window.show()
  })

  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

function createSearchWindow(): void {
  const parent = ensureMainWindow()

  if (searchWindow && !searchWindow.isDestroyed()) {
    searchWindow.focus()
    sendSearchContextToWindow()
    return
  }

  searchWindow = new BrowserWindow({
    width: 420,
    height: 440,
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
    sendSearchContextToWindow()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    searchWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/search.html`)
  } else {
    searchWindow.loadFile(join(__dirname, '../renderer/search.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  mainWindow = createMainWindow()
  registerIpcHandlers()
  buildApplicationMenu()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow()
      buildApplicationMenu()
    }
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

function buildApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = []

  if (process.platform === 'darwin') {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    })
  }

  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      {
        label: 'New',
        accelerator: 'CmdOrCtrl+N',
        click: () => sendToRenderer('menu:new-file')
      },
      {
        label: 'Open…',
        accelerator: 'CmdOrCtrl+O',
        click: () => sendToRenderer('menu:open-file')
      },
      { type: 'separator' },
      {
        label: 'Save',
        accelerator: 'CmdOrCtrl+S',
        click: () => sendToRenderer('menu:save-file')
      },
      {
        label: 'Save As…',
        accelerator: 'CmdOrCtrl+Shift+S',
        click: () => sendToRenderer('menu:save-file-as')
      },
      { type: 'separator' },
      {
        label: 'Close Tab',
        accelerator: 'CmdOrCtrl+W',
        click: () => sendToRenderer('menu:close-tab')
      },
      ...(process.platform === 'darwin' ? [] : [{ role: 'quit' } satisfies MenuItemConstructorOptions])
    ]
  }

  const editMenu: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' }
    ]
  }

  const searchMenu: MenuItemConstructorOptions = {
    label: 'Search',
    submenu: [
      {
        label: 'Find…',
        accelerator: 'CmdOrCtrl+F',
        click: () => createSearchWindow()
      }
    ]
  }

  const reloadMenuItem: MenuItemConstructorOptions = is.dev ? { role: 'reload' } : { role: 'forceReload' }

  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      reloadMenuItem,
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' }
    ]
  }

  const windowMenu: MenuItemConstructorOptions = {
    role: 'window',
    submenu:
      process.platform === 'darwin'
        ? [
            { role: 'minimize' },
            { role: 'zoom' },
            { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', role: 'close' },
            { type: 'separator' },
            { role: 'front' }
          ]
        : [{ role: 'minimize' }, { role: 'close' }]
  }

  template.push(fileMenu, editMenu, searchMenu, viewMenu, windowMenu)

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

function registerIpcHandlers(): void {
  ipcMain.handle('open-file-dialog', async () => {
    const win = ensureMainWindow()
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
      const win = ensureMainWindow()
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

    const existing = Array.from(tabStore.values()).find((tab) => tab.filePath === targetPath)
    if (existing) {
      tabStore.set(existing.id, { ...existing, content })
    }

    return { canceled: false, filePath: targetPath }
  })

  ipcMain.handle('perform-search', (_event, request: SearchRequest): SearchResponsePayload => {
    const scope = request.scope ?? { kind: 'workspace' }
    const trimmedQuery = request.query.trim()
    const trimmedExclude = request.excludeQuery?.trim() ?? ''
    const normalizedRequest: SearchRequest = {
      ...request,
      query: trimmedQuery,
      scope,
      excludeQuery: trimmedExclude.length ? trimmedExclude : undefined
    }

    let matcher: RegExp | null = null
    if (trimmedQuery.length && normalizedRequest.isRegex) {
      try {
        matcher = new RegExp(trimmedQuery, normalizedRequest.matchCase ? 'g' : 'gi')
      } catch (error) {
        console.error('Invalid regular expression', error)
        throw error
      }
    }

    let excludeMatcher: RegExp | null = null
    if (normalizedRequest.excludeQuery && normalizedRequest.isRegex) {
      try {
        excludeMatcher = new RegExp(
          normalizedRequest.excludeQuery,
          normalizedRequest.matchCase ? 'g' : 'gi'
        )
      } catch (error) {
        console.error('Invalid exclusion regular expression', error)
        throw error
      }
    }

    const findOptions: FindMatchOptions = {
      query: trimmedQuery,
      isRegex: normalizedRequest.isRegex,
      matchCase: normalizedRequest.matchCase,
      matcher,
      excludeQuery: normalizedRequest.excludeQuery,
      excludeMatcher
    }

    let results: SearchResponseItem[] = []
    if (!trimmedQuery.length) {
      results = []
    } else if (scope.kind === 'search') {
      const base = searchResultsStore.get(scope.searchId)
      if (base) {
        results = filterSearchResults(base.results, findOptions)
      } else {
        results = []
      }
    } else {
      for (const tab of tabStore.values()) {
        const matches = findMatches(tab.content, findOptions)
        if (matches.length) {
          results.push({
            tabId: tab.id,
            title: tab.title,
            filePath: tab.filePath,
            matches
          })
        }
      }
    }

    const payload: SearchResponsePayload = {
      searchId: generateSearchId(),
      parentSearchId: scope.kind === 'search' ? scope.searchId : undefined,
      request: normalizedRequest,
      results
    }

    searchResultsStore.set(payload.searchId, payload)
    return payload
  })

  ipcMain.on('sync-tab-state', (_event, tab: SearchableTab) => {
    tabStore.set(tab.id, tab)
  })

  ipcMain.on('remove-tab-state', (_event, tabId: string) => {
    tabStore.delete(tabId)
  })

  ipcMain.on('display-search-results', (_event, payload: SearchResponsePayload) => {
    sendToRenderer('search:results', payload)
  })

  ipcMain.on('navigate-to-file-line', (_event, payload: { tabId: string; line: number; column?: number }) => {
    sendToRenderer('search:navigate', payload)
  })

  ipcMain.on('open-search-window', () => {
    createSearchWindow()
  })

  ipcMain.on('dispose-search-results', (_event, searchId: string) => {
    searchResultsStore.delete(searchId)
  })

  ipcMain.on('update-active-context', (_event, context: ActiveContext) => {
    activeContext = context
    sendSearchContextToWindow()
  })
}

type FindMatchOptions = {
  query: string
  isRegex: boolean
  matchCase: boolean
  matcher: RegExp | null
  excludeQuery?: string
  excludeMatcher: RegExp | null
}

function findMatches(content: string, options: FindMatchOptions): SearchMatch[] {
  const lines = content.split(/\r?\n/)
  const matches: SearchMatch[] = []
  const excludeNeedle =
    options.excludeQuery && !options.isRegex
      ? options.matchCase
        ? options.excludeQuery
        : options.excludeQuery.toLowerCase()
      : undefined

  const shouldExcludeLine = (lineText: string): boolean => {
    if (!options.excludeQuery) {
      return false
    }
    if (options.isRegex && options.excludeMatcher) {
      const tester = new RegExp(options.excludeMatcher.source, options.excludeMatcher.flags)
      return tester.test(lineText)
    }
    const haystack = options.matchCase ? lineText : lineText.toLowerCase()
    return excludeNeedle ? haystack.includes(excludeNeedle) : false
  }

  lines.forEach((lineText, index) => {
    if (!lineText.length && !options.query.length) {
      return
    }

    if (shouldExcludeLine(lineText)) {
      return
    }

    if (options.isRegex && options.matcher) {
      const localMatcher = new RegExp(options.matcher.source, options.matcher.flags)
      let execMatch: RegExpExecArray | null
      while ((execMatch = localMatcher.exec(lineText)) !== null) {
        matches.push({
          line: index + 1,
          column: execMatch.index + 1,
          match: execMatch[0],
          preview: lineText
        })
        if (execMatch[0].length === 0) {
          localMatcher.lastIndex += 1
        }
        if (!localMatcher.global) break
      }
    } else {
      const haystack = options.matchCase ? lineText : lineText.toLowerCase()
      const needle = options.matchCase ? options.query : options.query.toLowerCase()
      let fromIndex = 0
      while (fromIndex <= haystack.length) {
        const hit = haystack.indexOf(needle, fromIndex)
        if (hit === -1) break
        matches.push({
          line: index + 1,
          column: hit + 1,
          match: lineText.slice(hit, hit + options.query.length),
          preview: lineText
        })
        fromIndex = hit + (needle.length || 1)
      }
    }
  })

  return matches
}

function filterSearchResults(
  baseResults: SearchResponseItem[],
  options: FindMatchOptions
): SearchResponseItem[] {
  if (!options.query.length) {
    return []
  }

  const result: SearchResponseItem[] = []

  baseResults.forEach((item) => {
    const aggregatedMatches: SearchMatch[] = []

    item.matches.forEach((match) => {
      const nestedMatches = findMatches(match.preview, options)
      nestedMatches.forEach((nested) => {
        aggregatedMatches.push({
          line: match.line,
          column: nested.column,
          match: nested.match,
          preview: match.preview
        })
      })
    })

    if (aggregatedMatches.length > 0) {
      result.push({
        tabId: item.tabId,
        title: item.title,
        filePath: item.filePath,
        matches: aggregatedMatches
      })
    }
  })

  return result
}
