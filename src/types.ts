export type Environment = 'paper' | 'testnet' | 'live'
export type MarketType = 'spot' | 'futures'
export type MarketInterval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d'
export type FuturesPositionMode = 'ONE_WAY' | 'HEDGE'

export interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface MarketTick {
  symbol: string
  price: number
  change: number
  high: number
  low: number
  volume: number
  quoteVolume: number
  connected: boolean
}

export interface MarketBook {
  bid: number
  bidSize: number
  ask: number
  askSize: number
}

export type MarketUpdate =
  | { type: 'connection'; marketType: MarketType; connected: boolean; timestamp: number }
  | ({ type: 'ticker'; marketType: MarketType; timestamp: number } & Omit<MarketTick, 'connected'>)
  | { type: 'kline'; marketType: MarketType; symbol: string; interval: MarketInterval; candle: Candle; closed: boolean; timestamp: number }
  | ({ type: 'book'; marketType: MarketType; symbol: string; timestamp: number } & MarketBook)

export interface AccountSnapshot {
  source: 'paper' | 'binance'
  environment: Environment
  marketType: MarketType
  totalWalletBalance: number
  availableBalance: number
  unrealizedPnl: number
  realizedPnl?: number
  todayPnl: number
  balances: Array<Record<string, string>>
  positions: Array<Record<string, string>>
  portfolio: PortfolioPosition[]
  futuresConfig?: FuturesConfiguration
  updatedAt: number
}

export interface FuturesConfiguration {
  symbol: string
  leverage: number
  marginType: 'CROSSED' | 'ISOLATED'
  isolatedMargin: number
  positionAmt: number
  positionMode: FuturesPositionMode
  positionSide: 'LONG' | 'SHORT' | 'BOTH'
  source?: 'paper' | 'binance'
  environment?: Environment
}

export interface FuturesPositionModeResult {
  positionMode: FuturesPositionMode
  source: 'paper' | 'binance'
  environment: Environment
}

export interface PortfolioPosition {
  symbol: string
  asset: string
  marketType: MarketType
  side: 'LONG' | 'SHORT'
  quantity: string
  positionAmt?: string
  entryPrice: string
  markPrice: string
  marketValue: string
  unrealizedPnl: string
  unrealizedProfit?: string
  returnRate: string
  returnBasis: 'cost' | 'margin' | '24h'
  leverage: string
  marginType?: 'CROSSED' | 'ISOLATED'
  isolatedMargin?: string
  isolatedWallet?: string
  positionSide?: 'LONG' | 'SHORT' | 'BOTH'
  notional?: string
  initialMargin?: string
  maintMargin?: string
  marginBalance?: string
  marginRatio?: string
  liquidationPrice?: string
  liquidationPriceEstimated?: boolean
}

export interface TradingOrder {
  id?: string
  orderId?: string | number
  symbol: string
  side: 'BUY' | 'SELL'
  type: 'MARKET' | 'LIMIT'
  quantity: string
  price?: string
  marketPrice?: string
  status?: string
  environment: Environment
  marketType: MarketType
  positionSide?: 'LONG' | 'SHORT' | 'BOTH'
  reduceOnly?: boolean
  leverage?: number
  marginType?: 'CROSSED' | 'ISOLATED'
  confirmation?: string
  clientOrderId?: string
  transactTime?: number
}

export type AgentStrategy = 'ma-crossover' | 'donchian' | 'rsi' | 'bollinger' | 'atr-breakout'
export type AgentStatus = 'paused' | 'running'
export type AgentIntentStatus = 'pending' | 'executed' | 'rejected' | 'expired'

export interface AgentRiskSettings {
  riskFraction: number
  maxNotional: number
  maxQuantity?: number
}

export interface AgentIntent {
  id: string
  agentId: string
  environment: 'live'
  status: AgentIntentStatus
  order: TradingOrder
  reason: string
  candleTime: number
  createdAt: number
  expiresAt: number
  updatedAt?: number
  result?: unknown
  error?: string
}

export interface AgentDefinition {
  id: string
  name: string
  strategy: AgentStrategy
  environment: Environment
  marketType: MarketType
  symbol: string
  interval: MarketInterval
  status: AgentStatus
  params: Record<string, string | number | boolean>
  risk: AgentRiskSettings
  runtime: {
    lastEvaluatedCandle?: number
    position?: 'flat' | 'long' | 'short'
  }
  pendingIntents?: AgentIntent[]
  createdAt: number
  updatedAt: number
}

export type AgentCreateInput = Omit<AgentDefinition, 'id' | 'status' | 'params' | 'risk' | 'runtime' | 'pendingIntents' | 'createdAt' | 'updatedAt'> & {
  risk?: Partial<AgentRiskSettings>
  params?: Record<string, string | number | boolean>
}

export interface AgentEvent {
  id: string
  agentId: string
  type: string
  level: 'info' | 'warning' | 'error'
  message: string
  data?: Record<string, unknown>
  timestamp: number
}

export interface FuturesAccountMutation {
  environment: Environment
  symbol: string
  positionSide?: 'LONG' | 'SHORT' | 'BOTH'
  confirmation?: 'LIVE_ACCOUNT_CONFIRMED'
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  model?: string
}

export interface ChatSession {
  id: string
  title: string
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
}

export interface ChatSessionSummary {
  id: string
  title: string
  preview: string
  messageCount: number
  createdAt: number
  updatedAt: number
}

export interface ChatSessionState {
  sessions: ChatSessionSummary[]
  activeSession: ChatSession
}

export interface McpTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface McpConnection {
  url: string
  tools: McpTool[]
}
