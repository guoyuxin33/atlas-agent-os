interface AtlasRuntimeInfo {
  platform: string
  version: string
  dataPath: string
}

interface Window {
  atlas?: {
    runtimeInfo: () => Promise<AtlasRuntimeInfo>
    saveSecrets: (namespace: string, values: Record<string, string>) => Promise<{ ok: boolean }>
    vaultStatus: (namespace: string) => Promise<{ configured: boolean; config?: Record<string, string> }>
    market: {
      history: (options: { environment: import('./types').Environment; marketType: 'spot' | 'futures'; symbol: string; interval: string; limit?: number; startTime?: number; endTime?: number }) => Promise<import('./types').Candle[]>
      markets: (options: { environment: import('./types').Environment; marketType: 'spot' | 'futures' }) => Promise<Array<{ symbol: string; baseAsset: string; quoteAsset: string; status: string }>>
      subscribe: (options: { environment: import('./types').Environment; marketType: 'spot' | 'futures'; symbol: string; interval: string }) => Promise<{ ok: boolean; topic: string }>
      unsubscribe: (options: { environment: import('./types').Environment; marketType: 'spot' | 'futures'; symbol: string; interval: string }) => Promise<{ ok: boolean }>
      onUpdate: (callback: (update: import('./types').MarketUpdate) => void) => () => void
    }
    binance: {
      test: (options: { environment: string; marketTypes: string[]; apiKey?: string; apiSecret?: string }) => Promise<{ ok: boolean; latency: number }>
      account: (options: { environment: string; marketType: string; symbol?: string; positionSide?: 'LONG' | 'SHORT' | 'BOTH'; markPrice?: number }) => Promise<import('./types').AccountSnapshot>
      orders: (options: { environment: string; marketType: string; symbol?: string }) => Promise<import('./types').TradingOrder[]>
      openOrders: (options: { environment: string; marketType: string; symbol?: string }) => Promise<import('./types').TradingOrder[]>
      order: (options: { environment: string; marketType: string; symbol: string; orderId?: string | number; clientOrderId?: string }) => Promise<import('./types').TradingOrder>
      cancelOrder: (options: { environment: string; marketType: string; symbol: string; orderId?: string | number; clientOrderId?: string; confirmation?: 'LIVE_CANCEL_CONFIRMED' }) => Promise<import('./types').TradingOrder>
      futuresConfig: (options: import('./types').FuturesAccountMutation) => Promise<import('./types').FuturesConfiguration>
      futuresPositionMode: (options: import('./types').FuturesAccountMutation) => Promise<import('./types').FuturesPositionModeResult>
      setFuturesLeverage: (options: import('./types').FuturesAccountMutation & { leverage: number }) => Promise<import('./types').FuturesConfiguration>
      setFuturesMarginType: (options: import('./types').FuturesAccountMutation & { marginType: 'CROSSED' | 'ISOLATED' }) => Promise<import('./types').FuturesConfiguration>
      setFuturesPositionMode: (options: import('./types').FuturesAccountMutation & { positionMode: import('./types').FuturesPositionMode }) => Promise<import('./types').FuturesPositionModeResult>
      adjustFuturesMargin: (options: import('./types').FuturesAccountMutation & { amount: number; action: 'ADD' | 'REMOVE'; positionSide?: 'LONG' | 'SHORT' | 'BOTH' }) => Promise<import('./types').FuturesConfiguration>
      prepareOrder: (order: import('./types').TradingOrder) => Promise<import('./types').TradingOrder>
      placeOrder: (order: import('./types').TradingOrder) => Promise<import('./types').TradingOrder>
      subscribeAccount: (options: { environment: string; marketType: string }) => Promise<{ ok: boolean; mode: string; topic?: string }>
      unsubscribeAccount: (options: { environment: string; marketType: string }) => Promise<{ ok: boolean }>
      onAccountUpdate: (callback: (update: { type: 'connection' | 'account'; environment: string; marketType: string; connected?: boolean; eventType?: string; timestamp: number }) => void) => () => void
    }
    risk: {
      setHalted: (halted: boolean) => Promise<{ halted: boolean }>
      status: () => Promise<{ halted: boolean }>
    }
    agents: {
      create: (definition: import('./types').AgentCreateInput) => Promise<import('./types').AgentDefinition>
      update: (agentId: string, definition: import('./types').AgentCreateInput, expectedRevision?: number) => Promise<import('./types').AgentDefinition>
      start: (agentId: string) => Promise<import('./types').AgentDefinition>
      pause: (agentId: string) => Promise<import('./types').AgentDefinition>
      evaluateNow: (agentId: string) => Promise<{ evaluated: boolean; reason?: string; candleTime?: number; error?: string }>
      list: () => Promise<import('./types').AgentDefinition[]>
      logs: (options?: { agentId?: string; limit?: number; after?: number }) => Promise<import('./types').AgentEvent[]>
      confirmIntent: (intentId: string) => Promise<{ intent: import('./types').AgentIntent; order: import('./types').TradingOrder }>
    }
    ai: {
      chat: (payload: { messages: Array<{ role: string; content: string }>; skills: string[]; mcp?: import('./types').McpConnection; context?: Record<string, unknown> }) => Promise<{ id?: string; model: string; content: string; usage?: Record<string, number> }>
      models: (options: { provider: string; protocol: string; baseUrl: string; apiKey?: string; fallbackModels?: string[]; force?: boolean }) => Promise<{ models: Array<{ id: string; name: string; ownedBy: string }>; latency: number; cached: boolean; source: string }>
      sessions: {
        bootstrap: () => Promise<import('./types').ChatSessionState>
        create: (input?: { title?: string }) => Promise<import('./types').ChatSessionState>
        open: (sessionId: string) => Promise<import('./types').ChatSessionState>
        rename: (sessionId: string, title: string) => Promise<import('./types').ChatSessionState>
        delete: (sessionId: string) => Promise<import('./types').ChatSessionState>
        append: (sessionId: string, message: Pick<import('./types').ChatMessage, 'role' | 'content' | 'model'>) => Promise<import('./types').ChatSessionState>
      }
    }
    mcp: {
      connect: (options: { url: string; headers?: Record<string, string> }) => Promise<{ ok: boolean; serverInfo: Record<string, unknown>; tools: import('./types').McpTool[]; sessionId?: string }>
      call: (options: { url: string; name: string; arguments?: Record<string, unknown>; headers?: Record<string, string> }) => Promise<unknown>
    }
    network: {
      test: (options: { proxyUrl?: string }) => Promise<{ ok: boolean; latency: number; proxy: boolean }>
    }
  }
}

declare module '*.css'
