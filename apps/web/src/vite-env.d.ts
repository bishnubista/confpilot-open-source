/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEFAULT_EVENT_SLUG?: string
  readonly VITE_SOURCE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
