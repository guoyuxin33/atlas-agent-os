import { useEffect, useState } from 'react'
import type { Environment, MarketBook, MarketInterval, MarketTick, MarketType } from '../types'

const TICK_STALE_AFTER_MS = 10_000

function fallbackFor(symbol: string): MarketTick {
  return {
    symbol,
    price: 0,
    change: 0,
    high: 0,
    low: 0,
    volume: 0,
    quoteVolume: 0,
    connected: false,
  }
}

function emptyBook(): MarketBook {
  return { bid: 0, bidSize: 0, ask: 0, askSize: 0 }
}

export function useMarketData(environment: Environment, marketType: MarketType, symbol: string, interval: MarketInterval, refreshKey = 0) {
  const publicEnvironment = environment === 'testnet' ? 'testnet' : 'live'
  const subscriptionKey = `${publicEnvironment}:${marketType}:${symbol}`
  const [tickState, setTickState] = useState<{ key: string; value: MarketTick }>(() => ({ key: subscriptionKey, value: fallbackFor(symbol) }))
  const [bookState, setBookState] = useState<{ key: string; value: MarketBook }>(() => ({ key: subscriptionKey, value: emptyBook() }))

  useEffect(() => {
    let active = true
    let lastTickerAt = 0
    const markStale = () => {
      if (!active || !lastTickerAt || Date.now() - lastTickerAt <= TICK_STALE_AFTER_MS) return
      setTickState((current) => current.key === subscriptionKey && current.value.connected
        ? { ...current, value: { ...current.value, connected: false } }
        : current)
    }
    const staleTimer = window.setInterval(markStale, 1_000)

    if (window.atlas) {
      const options = { environment, marketType, symbol, interval }
      window.atlas.market.subscribe(options).catch(() => {
        if (active) setTickState((current) => current.key === subscriptionKey ? { ...current, value: { ...current.value, connected: false } } : current)
      })
      const off = window.atlas.market.onUpdate((update) => {
        if (!active || update.environment !== publicEnvironment || update.marketType !== marketType) return
        if (update.type === 'connection') {
          const hasFreshTicker = lastTickerAt > 0 && Date.now() - lastTickerAt <= TICK_STALE_AFTER_MS
          setTickState((current) => current.key === subscriptionKey ? { ...current, value: { ...current.value, connected: update.connected && hasFreshTicker } } : current)
        } else if (update.symbol === symbol && update.type === 'ticker') {
          lastTickerAt = Date.now()
          setTickState({ key: subscriptionKey, value: { symbol, price: update.price, change: update.change, high: update.high, low: update.low, volume: update.volume, quoteVolume: update.quoteVolume, connected: true } })
        } else if (update.symbol === symbol && update.type === 'book') {
          setBookState({ key: subscriptionKey, value: { bid: update.bid, bidSize: update.bidSize, ask: update.ask, askSize: update.askSize } })
        }
      })
      return () => {
        active = false
        window.clearInterval(staleTimer)
        off()
        window.atlas?.market.unsubscribe(options)
      }
    }

    const streamBase = environment === 'testnet'
      ? marketType === 'futures' ? 'wss://stream.binancefuture.com/ws' : 'wss://stream.testnet.binance.vision/ws'
      : marketType === 'futures' ? 'wss://fstream.binance.com/ws' : 'wss://stream.binance.com:9443/ws'
    const socket = new WebSocket(streamBase)
    socket.onopen = () => {
      socket.send(JSON.stringify({ method: 'SUBSCRIBE', params: [`${symbol.toLowerCase()}@ticker`, `${symbol.toLowerCase()}@bookTicker`], id: 1 }))
    }
    socket.onmessage = (event) => {
      const data = JSON.parse(event.data) as Record<string, string>
      if (!active || data.s !== symbol) return
      if (data.e === '24hrTicker') {
        lastTickerAt = Date.now()
        setTickState({ key: subscriptionKey, value: { symbol: data.s, price: Number(data.c), change: Number(data.P), high: Number(data.h), low: Number(data.l), volume: Number(data.v), quoteVolume: Number(data.q), connected: true } })
      } else if (data.b && data.a) {
        setBookState({ key: subscriptionKey, value: { bid: Number(data.b), bidSize: Number(data.B), ask: Number(data.a), askSize: Number(data.A) } })
      }
    }
    socket.onclose = () => setTickState((current) => current.key === subscriptionKey ? { ...current, value: { ...current.value, connected: false } } : current)
    return () => {
      active = false
      window.clearInterval(staleTimer)
      socket.close()
    }
  }, [environment, interval, marketType, publicEnvironment, refreshKey, subscriptionKey, symbol])

  return {
    tick: tickState.key === subscriptionKey ? tickState.value : fallbackFor(symbol),
    book: bookState.key === subscriptionKey ? bookState.value : emptyBook(),
  }
}
