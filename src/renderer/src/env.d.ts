/// <reference types="vite/client" />

import type { ElectronAPI } from '@electron-toolkit/preload'
import type {
  ActiveContext,
  LogEditorApi,
  RemoveListener,
  SaveFilePayload,
  SaveFileResult,
  SearchMatch,
  SearchRequest,
  SearchResponsePayload,
  SearchResultItem,
  SearchScope,
  SearchableTab
} from '../../common/ipc'

export type {
  ActiveContext,
  LogEditorApi,
  RemoveListener,
  SaveFilePayload,
  SaveFileResult,
  SearchMatch,
  SearchRequest,
  SearchResponsePayload,
  SearchResultItem,
  SearchScope,
  SearchableTab
} from '../../common/ipc'

type ExtendedElectronAPI = ElectronAPI & {
  path: {
    basename: (path: string, ext?: string) => string
  }
}

declare global {
  interface Window {
    electron: ExtendedElectronAPI
    api: LogEditorApi
  }
}
