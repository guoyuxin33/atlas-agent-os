const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('atlas', {
  runtimeInfo: () => ipcRenderer.invoke('runtime:info'),
  saveSecrets: (namespace, values) => ipcRenderer.invoke('vault:save', namespace, values),
  vaultStatus: (namespace) => ipcRenderer.invoke('vault:status', namespace),
  market: {
    history: (options) => ipcRenderer.invoke('market:history', options),
    markets: (options) => ipcRenderer.invoke('market:markets', options),
    subscribe: (options) => ipcRenderer.invoke('market:subscribe', options),
    unsubscribe: (options) => ipcRenderer.invoke('market:unsubscribe', options),
    onUpdate: (callback) => {
      const listener = (_event, update) => {
        const updates = Array.isArray(update) ? update : [update]
        updates.forEach((item) => callback(item))
      }
      ipcRenderer.on('market:update', listener)
      return () => ipcRenderer.removeListener('market:update', listener)
    },
  },
  binance: {
    test: (options) => ipcRenderer.invoke('binance:test', options),
    account: (options) => ipcRenderer.invoke('binance:account', options),
    orders: (options) => ipcRenderer.invoke('binance:orders', options),
    futuresConfig: (options) => ipcRenderer.invoke('binance:futuresConfig', options),
    futuresPositionMode: (options) => ipcRenderer.invoke('binance:futuresPositionMode', options),
    setFuturesLeverage: (options) => ipcRenderer.invoke('binance:setFuturesLeverage', options),
    setFuturesMarginType: (options) => ipcRenderer.invoke('binance:setFuturesMarginType', options),
    setFuturesPositionMode: (options) => ipcRenderer.invoke('binance:setFuturesPositionMode', options),
    adjustFuturesMargin: (options) => ipcRenderer.invoke('binance:adjustFuturesMargin', options),
    placeOrder: (order) => ipcRenderer.invoke('binance:placeOrder', order),
    subscribeAccount: (options) => ipcRenderer.invoke('binance:subscribeAccount', options),
    unsubscribeAccount: (options) => ipcRenderer.invoke('binance:unsubscribeAccount', options),
    onAccountUpdate: (callback) => {
      const listener = (_event, update) => callback(update)
      ipcRenderer.on('account:update', listener)
      return () => ipcRenderer.removeListener('account:update', listener)
    },
  },
  risk: {
    setHalted: (halted) => ipcRenderer.invoke('risk:setHalted', halted),
    status: () => ipcRenderer.invoke('risk:status'),
  },
  agents: {
    create: (definition) => ipcRenderer.invoke('agents:create', definition),
    start: (agentId) => ipcRenderer.invoke('agents:start', agentId),
    pause: (agentId) => ipcRenderer.invoke('agents:pause', agentId),
    list: () => ipcRenderer.invoke('agents:list'),
    logs: (options) => ipcRenderer.invoke('agents:logs', options),
    confirmIntent: (intentId) => ipcRenderer.invoke('agents:confirm-intent', intentId),
  },
  ai: {
    chat: (payload) => ipcRenderer.invoke('ai:chat', payload),
    models: (options) => ipcRenderer.invoke('models:list', options),
    sessions: {
      bootstrap: () => ipcRenderer.invoke('chat-sessions:bootstrap'),
      create: (input) => ipcRenderer.invoke('chat-sessions:create', input),
      open: (sessionId) => ipcRenderer.invoke('chat-sessions:open', sessionId),
      rename: (sessionId, title) => ipcRenderer.invoke('chat-sessions:rename', sessionId, title),
      delete: (sessionId) => ipcRenderer.invoke('chat-sessions:delete', sessionId),
      append: (sessionId, message) => ipcRenderer.invoke('chat-sessions:append', sessionId, message),
    },
  },
  mcp: {
    connect: (options) => ipcRenderer.invoke('mcp:connect', options),
    call: (options) => ipcRenderer.invoke('mcp:call', options),
  },
  network: {
    test: (options) => ipcRenderer.invoke('network:test', options),
  },
})
