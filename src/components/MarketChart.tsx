import { useEffect, useRef, useState } from 'react'
import { CandlestickSeries, ColorType, createChart, type CandlestickData, type Time } from 'lightweight-charts'

const fallbackData: CandlestickData<Time>[] = Array.from({ length: 96 }, (_, index) => {
  const time = Math.floor(Date.now() / 1000) - (96 - index) * 900
  const wave = Math.sin(index / 7) * 620 + Math.sin(index / 2.8) * 140
  const open = 66900 + wave + index * 12
  const close = open + Math.sin(index * 1.7) * 190
  return {
    time: time as Time,
    open,
    high: Math.max(open, close) + 110,
    low: Math.min(open, close) - 100,
    close,
  }
})

export function MarketChart() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [source, setSource] = useState<'live' | 'cached'>('cached')

  useEffect(() => {
    if (!containerRef.current) return

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: '#171819' },
        textColor: '#74777a',
        fontFamily: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(242, 240, 232, 0.035)' },
        horzLines: { color: 'rgba(242, 240, 232, 0.035)' },
      },
      rightPriceScale: { borderColor: 'rgba(242, 240, 232, 0.08)', scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: { borderColor: 'rgba(242, 240, 232, 0.08)', timeVisible: true, secondsVisible: false },
      crosshair: {
        vertLine: { color: 'rgba(214, 165, 54, 0.32)', labelBackgroundColor: '#806319' },
        horzLine: { color: 'rgba(214, 165, 54, 0.32)', labelBackgroundColor: '#806319' },
      },
    })

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#4f9f78',
      downColor: '#c95d5d',
      wickUpColor: '#4f9f78',
      wickDownColor: '#c95d5d',
      borderVisible: false,
      priceLineColor: '#d6a536',
    })
    series.setData(fallbackData)
    chart.timeScale().fitContent()

    const controller = new AbortController()
    fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=120', { signal: controller.signal })
      .then((response) => response.json())
      .then((rows: Array<Array<number | string>>) => {
        const data: CandlestickData<Time>[] = rows.map((row) => ({
          time: Math.floor(Number(row[0]) / 1000) as Time,
          open: Number(row[1]),
          high: Number(row[2]),
          low: Number(row[3]),
          close: Number(row[4]),
        }))
        series.setData(data)
        chart.timeScale().fitContent()
        setSource('live')
      })
      .catch(() => setSource('cached'))

    const resizeObserver = new ResizeObserver(([entry]) => {
      chart.applyOptions({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    resizeObserver.observe(containerRef.current)

    return () => {
      controller.abort()
      resizeObserver.disconnect()
      chart.remove()
    }
  }, [])

  return (
    <div className="chart-shell">
      <div ref={containerRef} className="chart-canvas" />
      <span className={`chart-source ${source === 'live' ? 'is-live' : ''}`}>
        {source === 'live' ? 'Binance 实时 K 线' : '行情缓存'}
      </span>
    </div>
  )
}
