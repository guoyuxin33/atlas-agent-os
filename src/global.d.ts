interface AtlasRuntimeInfo {
  platform: string
  version: string
  dataPath: string
}

interface Window {
  atlas?: {
    runtimeInfo: () => Promise<AtlasRuntimeInfo>
    saveSecrets: (namespace: string, values: Record<string, string>) => Promise<{ ok: boolean }>
  }
}

declare module '*.css'
