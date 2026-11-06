import { app, BrowserWindow, ipcMain, Menu, safeStorage, shell } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'

const __dirname = dirname(fileURLToPath(import.meta.url))
const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL)

app.setName('Atlas Agent OS')

function createMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{
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
        { role: 'quit' },
      ],
    }] : []),
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        ...(process.platform === 'darwin' ? [{ type: 'separator' }, { role: 'front', label: '全部置于前台' }] : [{ role: 'close', label: '关闭' }]),
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: 'Binance API 文档',
          click: () => shell.openExternal('https://developers.binance.com/docs/binance-spot-api-docs'),
        },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1040,
    minHeight: 700,
    show: false,
    backgroundColor: '#101112',
    title: 'Atlas Agent OS',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 18, y: 20 } : undefined,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDevelopment) {
    window.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    window.loadFile(join(__dirname, '..', 'dist', 'index.html'))
  }
}

ipcMain.handle('runtime:info', () => ({
  platform: process.platform,
  version: app.getVersion(),
  dataPath: app.getPath('userData'),
}))

ipcMain.handle('vault:save', async (_event, namespace, values) => {
  if (!/^[a-z0-9-]{1,40}$/.test(namespace)) throw new Error('Invalid vault namespace')
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
})

app.whenReady().then(() => {
  createMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
