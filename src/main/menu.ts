import { app, Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { is } from '@electron-toolkit/utils'

type MenuDeps = {
  sendToRenderer: (channel: string, payload?: unknown) => void
  openSearchWindow: () => void
}

export const buildApplicationMenu = ({ sendToRenderer, openSearchWindow }: MenuDeps): void => {
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
        click: () => openSearchWindow()
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
