import { useEffect, useState } from 'react'
import type { MarketBook, MarketInterval, MarketTick, MarketType } from '../types'

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

export function useMarketData(marketType: MarketType, symbol: string, interval: MarketInterval) {
  const subscriptionKey = `${marketType}:${symbol}`
  const [tickState, setTickState] = useState<{ key: string; value: MarketTick }>(() => ({ key: subscriptionKey, value: fallbackFor(symbol) }))
  const [bookState, setBookState] = useState<{ key: string; value: MarketBook }>(() => ({ key: subscriptionKey, value: emptyBook() }))

  useEffect(() => {
    let active = true

    if (window.atlas) {
      const options = { marketType, symbol, interval }
      window.atlas.market.subscribe(options).catch(() => {
        if (active) setTickState((current) => current.key === subscriptionKey ? { ...current, value: { ...current.value, connected: false } } : current)
      })
      const off = window.atlas.market.onUpdate((update) => {
        if (!active || update.marketType !== marketType) return
        if (update.type === 'connection') {
          setTickState((current) => current.key === subscriptionKey ? { ...current, value: { ...current.value, connected: update.connected } } : current)
        } else if (update.symbol === symbol && update.type === 'ticker') {
          setTickState({ key: subscriptionKey, value: { symbol, price: update.price, change: update.change, high: update.high, low: update.low, volume: update.volume, quoteVolume: update.quoteVolume, connected: true } })
        } else if (update.symbol === symbol && update.type === 'book') {
          setBookState({ key: subscriptionKey, value: { bid: update.bid, bidSize: update.bidSize, ask: update.ask, askSize: update.askSize } })
        }
      })
      return () => {
        active = false
        off()
        window.atlas?.market.unsubscribe(options)
      }
    }

    const streamBase = marketType === 'futures' ? 'wss://fstream.binance.com/ws' : 'wss://stream.binance.com:9443/ws'
    const socket = new WebSocket(streamBase)
    socket.onopen = () => {
      socket.send(JSON.stringify({ method: 'SUBSCRIBE', params: [`${symbol.toLowerCase()}@ticker`, `${symbol.toLowerCase()}@bookTicker`], id: 1 }))
    }
    socket.onmessage = (event) => {
      const data = JSON.parse(event.data) as Record<string, string>
      if (!active || data.s !== symbol) return
      if (data.e === '24hrTicker') {
        setTickState({ key: subscriptionKey, value: { symbol: data.s, price: Number(data.c), change: Number(data.P), high: Number(data.h), low: Number(data.l), volume: Number(data.v), quoteVolume: Number(data.q), connected: true } })
      } else if (data.b && data.a) {
        setBookState({ key: subscriptionKey, value: { bid: Number(data.b), bidSize: Number(data.B), ask: Number(data.a), askSize: Number(data.A) } })
      }
    }
    socket.onclose = () => setTickState((current) => current.key === subscriptionKey ? { ...current, value: { ...current.value, connected: false } } : current)
    return () => {
      active = false
      socket.close()
    }
  }, [interval, marketType, subscriptionKey, symbol])

  return {
    tick: tickState.key === subscriptionKey ? tickState.value : fallbackFor(symbol),
    book: bookState.key === subscriptionKey ? bookState.value : emptyBook(),
  }
}
