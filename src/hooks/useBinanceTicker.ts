import { useEffect, useRef, useState } from 'react'

export interface MarketTick {
  symbol: string
  price: number
  change: number
  high: number
  low: number
  volume: number
  connected: boolean
}

const fallback: MarketTick = {
  symbol: 'BTCUSDT',
  price: 68412.6,
  change: 2.34,
  high: 69138.2,
  low: 66104.8,
  volume: 28430,
  connected: false,
}

export function useBinanceTicker(symbol = 'btcusdt') {
  const [tick, setTick] = useState<MarketTick>(fallback)
  const reconnectRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    let socket: WebSocket | null = null
    let disposed = false

    const connect = () => {
      socket = new WebSocket(`wss://stream.binance.com:9443/ws/${symbol}@ticker`)

      socket.onopen = () => {
        setTick((current) => ({ ...current, connected: true }))
      }

      socket.onmessage = (event) => {
        const data = JSON.parse(event.data) as Record<string, string>
        setTick({
          symbol: data.s,
          price: Number(data.c),
          change: Number(data.P),
          high: Number(data.h),
          low: Number(data.l),
          volume: Number(data.v),
          connected: true,
        })
      }

      socket.onclose = () => {
        setTick((current) => ({ ...current, connected: false }))
        if (!disposed) reconnectRef.current = window.setTimeout(connect, 3000)
      }

      socket.onerror = () => socket?.close()
    }

    connect()

    return () => {
      disposed = true
      if (reconnectRef.current) window.clearTimeout(reconnectRef.current)
      socket?.close()
    }
  }, [symbol])

  return tick
}
