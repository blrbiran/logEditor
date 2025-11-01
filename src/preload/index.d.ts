import type { ElectronAPI } from '@electron-toolkit/preload'
import type { LogEditorApi } from '../common/ipc'

declare global {
  interface Window {
    electron: ElectronAPI
    api: LogEditorApi
  }
}

export {}
