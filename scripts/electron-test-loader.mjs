const ELECTRON_STUB_URL = 'atlas-qa:electron'
const UNDICI_STUB_URL = 'atlas-qa:undici'

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') return { url: ELECTRON_STUB_URL, shortCircuit: true }
  if (specifier === 'undici') return { url: UNDICI_STUB_URL, shortCircuit: true }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url === UNDICI_STUB_URL) {
    return {
      format: 'module',
      shortCircuit: true,
      source: `
        export class ProxyAgent { constructor(url) { this.url = url } }
        export async function fetch(url) {
          const value = String(url)
          if (!value.includes('/ticker/24hr')) throw new Error('QA blocked non-ticker network request: ' + value)
          return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
        }
      `,
    }
  }
  if (url !== ELECTRON_STUB_URL) return nextLoad(url, context)
  return {
    format: 'module',
    shortCircuit: true,
    source: `
      const paths = new Map()
      export const app = {
        getPath(name) {
          const value = paths.get(name) || (name === 'userData' ? process.env.ATLAS_QA_USER_DATA : '')
          if (!value) throw new Error('Missing Electron test path: ' + name)
          return value
        },
        setPath(name, value) { paths.set(name, value) },
        whenReady() { return Promise.resolve() },
      }
      export const safeStorage = {
        isEncryptionAvailable() { return true },
        encryptString(value) { return Buffer.from(value, 'utf8') },
        decryptString(value) { return Buffer.from(value).toString('utf8') },
      }
    `,
  }
}
