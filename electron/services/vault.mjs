import { app, safeStorage } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

function validateNamespace(namespace) {
  if (!/^[a-z0-9-]{1,40}$/.test(namespace)) throw new Error('Invalid vault namespace')
}

export async function saveVault(namespace, values) {
  validateNamespace(namespace)
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Invalid vault payload')
  if (!safeStorage.isEncryptionAvailable()) throw new Error('System encryption is unavailable')

  const allowed = Object.fromEntries(
    Object.entries(values)
      .filter(([key, value]) => /^[a-zA-Z0-9_-]{1,40}$/.test(key) && typeof value === 'string')
      .map(([key, value]) => [key, value.slice(0, 4096)]),
  )
  const encrypted = safeStorage.encryptString(JSON.stringify(allowed))
  const vaultDirectory = join(app.getPath('userData'), 'vault')
  await mkdir(vaultDirectory, { recursive: true })
  await writeFile(join(vaultDirectory, `${namespace}.bin`), encrypted, { mode: 0o600 })
  return { ok: true }
}

export async function loadVault(namespace) {
  validateNamespace(namespace)
  if (!safeStorage.isEncryptionAvailable()) throw new Error('System encryption is unavailable')
  try {
    const encrypted = await readFile(join(app.getPath('userData'), 'vault', `${namespace}.bin`))
    return JSON.parse(safeStorage.decryptString(encrypted))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}
