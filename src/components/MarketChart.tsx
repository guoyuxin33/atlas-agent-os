import { useEffect, useRef, useState } from 'react'
import { CandlestickSeries, ColorType, createChart, HistogramSeries, LineSeries, type CandlestickData, type HistogramData, type LineData, type Time } from 'lightweight-charts'
import type { Candle, MarketInterval, MarketType } from '../types'

interface MarketChartProps {
  marketType: MarketType
  symbol: string
  interval: MarketInterval
  showMA: boolean
}

function movingAverage(rows: Candle[], length = 20): LineData<Time>[] {
  return rows.slice(length - 1).map((row, index) => ({
    time: row.time as Time,
    value: rows.slice(index, index + length).reduce((sum, item) => sum + item.close, 0) / length,
  }))
}

export function MarketChart({ marketType, symbol, interval, showMA }: MarketChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [source, setSource] = useState<'live' | 'cached'>('cached')

  useEffect(() => {
    if (!containerRef.current) return
    let active = true
    setSource('cached')

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
    const volumeSeries = chart.addSeries(HistogramSeries, {
      color: 'rgba(214, 165, 54, 0.22)',
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    })
    const averageSeries = chart.addSeries(LineSeries, {
      color: '#d6a536',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      visible: showMA,
    })
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })
    series.setData([])
    chart.timeScale().fitContent()

    const controller = new AbortController()
    const loadHistory = window.atlas
      ? window.atlas.market.history({ marketType, symbol, interval, limit: 2000 })
      : fetch(`${marketType === 'futures' ? 'https://fapi.binance.com/fapi/v1/klines' : 'https://api.binance.com/api/v3/klines'}?symbol=${symbol}&interval=${interval}&limit=1000`, { signal: controller.signal })
        .then((response) => response.json())
        .then((rows: Array<Array<number | string>>) => rows.map((row): Candle => ({ time: Math.floor(Number(row[0]) / 1000), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) })))

    let historyRows: Candle[] = []
    loadHistory
      .then((rows) => {
        if (!active) return
        historyRows = rows
        const data: CandlestickData<Time>[] = rows.map((row) => ({
          time: row.time as Time,
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
        }))
        const volumes: HistogramData<Time>[] = rows.map((row) => ({ time: row.time as Time, value: row.volume, color: row.close >= row.open ? 'rgba(79, 189, 136, 0.22)' : 'rgba(223, 104, 104, 0.2)' }))
        series.setData(data)
        volumeSeries.setData(volumes)
        averageSeries.setData(movingAverage(rows))
        chart.timeScale().fitContent()
        setSource('live')
      })
      .catch(() => {
        if (active) setSource('cached')
      })

    const off = window.atlas?.market.onUpdate((update) => {
      if (update.type !== 'kline' || update.marketType !== marketType || update.symbol !== symbol || update.interval !== interval) return
      const candle = update.candle
      series.update({ time: candle.time as Time, open: candle.open, high: candle.high, low: candle.low, close: candle.close })
      volumeSeries.update({ time: candle.time as Time, value: candle.volume, color: candle.close >= candle.open ? 'rgba(79, 189, 136, 0.22)' : 'rgba(223, 104, 104, 0.2)' })
      if (historyRows.at(-1)?.time === candle.time) historyRows[historyRows.length - 1] = candle
      else historyRows.push(candle)
      historyRows = historyRows.slice(-2000)
      const recent = historyRows.slice(-20)
      if (showMA && recent.length === 20) averageSeries.update({ time: candle.time as Time, value: recent.reduce((sum, item) => sum + item.close, 0) / recent.length })
    })

    const resizeObserver = new ResizeObserver(([entry]) => {
      chart.applyOptions({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    resizeObserver.observe(containerRef.current)

    return () => {
      active = false
      controller.abort()
      off?.()
      resizeObserver.disconnect()
      chart.remove()
    }
  }, [interval, marketType, showMA, symbol])

  return (
    <div className="chart-shell">
      <div ref={containerRef} className="chart-canvas" />
      <span className={`chart-source ${source === 'live' ? 'is-live' : ''}`}>
        {source === 'live' ? `2,000 根历史 + 实时 · ${interval}` : '等待真实行情'}
      </span>
    </div>
  )
}
