export const isDesktop = Boolean(window.atlas)

export async function saveSecrets(namespace: string, values: Record<string, string>) {
  if (window.atlas) return window.atlas.saveSecrets(namespace, values)

  // Browser preview never persists credentials; it only exercises the UI flow.
  return { ok: true }
}

export async function getVaultStatus(namespace: string): Promise<{ configured: boolean; config?: Record<string, string> }> {
  return window.atlas?.vaultStatus(namespace) ?? { configured: false }
}
