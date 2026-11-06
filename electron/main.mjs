import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentRuntime } from './services/agent-runtime.mjs'
import { chatWithModel } from './services/ai.mjs'
import { adjustFuturesPositionMargin, getAccountSnapshot, getFuturesConfiguration, getFuturesPositionMode, getOrders, placeOrder, prepareBinanceOrder, setFuturesLeverage, setFuturesMarginType, setFuturesPositionMode, testBinanceConnection } from './services/binance.mjs'
import { ChatSessionStore } from './services/chat-sessions.mjs'
import { MarketDataHub } from './services/market-data.mjs'
import { callMcpTool, connectMcp } from './services/mcp.mjs'
import { listModels } from './services/models.mjs'
import { testNetwork } from './services/network.mjs'
import { UserDataHub } from './services/user-data.mjs'
import { loadVault, saveVault } from './services/vault.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL)
let executionHalted = false

app.setName('Atlas Agent OS')
const marketHub = new MarketDataHub()
const userDataHub = new UserDataHub()
let agentRuntime = null
let chatSessionStore = null

async function getAgentRuntime() {
  if (!agentRuntime) {
    agentRuntime = new AgentRuntime({
      dataDirectory: join(app.getPath('userData'), 'agents'),
      marketHub,
      placeOrder,
      getAccountSnapshot,
      isExecutionHalted: () => executionHalted,
    })
  }
  await agentRuntime.initialize()
  return agentRuntime
}

async function getChatSessionStore() {
  if (!chatSessionStore) {
    chatSessionStore = new ChatSessionStore({ dataDirectory: join(app.getPath('userData'), 'chat-sessions') })
  }
  await chatSessionStore.initialize()
  return chatSessionStore
}

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
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error('[renderer:load]', { code, description, url })
  })
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('[renderer:preload]', { preloadPath, error })
  })
  window.webContents.on('render-process-gone', () => {
    marketHub.removeClient(window.webContents.id)
    userDataHub.removeClient(window.webContents.id)
  })
  window.webContents.on('console-message', (_event, details) => {
    if (details.level === 'warning' || details.level === 'error') {
      console.error('[renderer:console]', details)
    }
  })
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
  let nextValues = values
  if (namespace === 'model-router') {
    const current = await loadVault(namespace)
    nextValues = { ...(current || {}), ...values }
    const sameEndpoint = current?.provider === values.provider && current?.baseUrl === values.baseUrl
    if (!sameEndpoint && !Object.hasOwn(values, 'apiKey')) delete nextValues.apiKey
  }
  const result = await saveVault(namespace, nextValues)
  if (namespace === 'network') {
    marketHub.reconnectAll()
    userDataHub.reconnectAll()
  }
  return result
})

ipcMain.handle('vault:status', async (_event, namespace) => {
  const config = await loadVault(namespace)
  if (!config) return { configured: false }
  const publicConfig = Object.fromEntries(Object.entries(config).filter(([key]) => !/key|secret|token|password/i.test(key)))
  return { configured: true, config: publicConfig }
})

ipcMain.handle('market:history', (_event, options) => marketHub.history(options))
ipcMain.handle('market:markets', (_event, options) => marketHub.markets(options))
ipcMain.handle('market:subscribe', (event, options) => marketHub.subscribe(event.sender, options))
ipcMain.handle('market:unsubscribe', (event, options) => marketHub.unsubscribe(event.sender, options))

ipcMain.handle('binance:test', (_event, options) => testBinanceConnection(options))
ipcMain.handle('binance:account', (_event, options) => getAccountSnapshot(options))
ipcMain.handle('binance:orders', (_event, options) => getOrders(options))
ipcMain.handle('binance:futuresConfig', (_event, options) => getFuturesConfiguration(options))
ipcMain.handle('binance:futuresPositionMode', (_event, options) => getFuturesPositionMode(options))
ipcMain.handle('binance:setFuturesLeverage', (_event, options) => setFuturesLeverage(options))
ipcMain.handle('binance:setFuturesMarginType', (_event, options) => setFuturesMarginType(options))
ipcMain.handle('binance:setFuturesPositionMode', (_event, options) => setFuturesPositionMode(options))
ipcMain.handle('binance:adjustFuturesMargin', (_event, options) => adjustFuturesPositionMargin(options))
ipcMain.handle('binance:prepareOrder', (_event, order) => prepareBinanceOrder(order))
ipcMain.handle('binance:subscribeAccount', (event, options) => userDataHub.subscribe(event.sender, options))
ipcMain.handle('binance:unsubscribeAccount', (event, options) => userDataHub.unsubscribe(event.sender, options))
ipcMain.handle('binance:placeOrder', (_event, order) => {
  if (executionHalted) throw new Error('风控总闸已关闭，主进程拒绝订单')
  return placeOrder(order)
})
ipcMain.handle('risk:setHalted', (_event, halted) => {
  executionHalted = Boolean(halted)
  return { halted: executionHalted }
})
ipcMain.handle('risk:status', () => ({ halted: executionHalted }))

ipcMain.handle('agents:create', async (_event, definition) => (await getAgentRuntime()).create(definition))
ipcMain.handle('agents:start', async (_event, agentId) => (await getAgentRuntime()).start(agentId))
ipcMain.handle('agents:pause', async (_event, agentId) => (await getAgentRuntime()).pause(agentId))
ipcMain.handle('agents:evaluate-now', async (_event, agentId) => (await getAgentRuntime()).evaluateNow(agentId))
ipcMain.handle('agents:list', async () => (await getAgentRuntime()).list())
ipcMain.handle('agents:logs', async (_event, options) => (await getAgentRuntime()).logs(options))
ipcMain.handle('agents:confirm-intent', async (_event, intentId) => (await getAgentRuntime()).confirmIntent(intentId))

ipcMain.handle('ai:chat', (_event, payload) => chatWithModel(payload))
ipcMain.handle('chat-sessions:bootstrap', async () => (await getChatSessionStore()).bootstrap())
ipcMain.handle('chat-sessions:create', async (_event, input) => (await getChatSessionStore()).create(input))
ipcMain.handle('chat-sessions:open', async (_event, sessionId) => (await getChatSessionStore()).open(sessionId))
ipcMain.handle('chat-sessions:rename', async (_event, sessionId, title) => (await getChatSessionStore()).renameSession(sessionId, title))
ipcMain.handle('chat-sessions:delete', async (_event, sessionId) => (await getChatSessionStore()).deleteSession(sessionId))
ipcMain.handle('chat-sessions:append', async (_event, sessionId, message) => (await getChatSessionStore()).appendMessage(sessionId, message))
ipcMain.handle('models:list', async (_event, options) => {
  const current = await loadVault('model-router')
  const canReuseKey = current?.provider === options.provider && current?.baseUrl === options.baseUrl
  return listModels({ ...options, apiKey: options.apiKey || (canReuseKey ? current?.apiKey : '') }, { force: options.force })
})
ipcMain.handle('mcp:connect', (_event, options) => connectMcp(options))
ipcMain.handle('mcp:call', (_event, options) => callMcpTool(options))
ipcMain.handle('network:test', (_event, options) => testNetwork(options))

app.whenReady().then(async () => {
  createMenu()
  await getAgentRuntime()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  void agentRuntime?.close()
})

app.on('window-all-closed', () => {
  userDataHub.close()
  if (process.platform !== 'darwin') app.quit()
})
