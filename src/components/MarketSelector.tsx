import { Check, ChevronDown, RefreshCw, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useMarketCatalog } from '../hooks/useMarketCatalog'
import type { MarketType } from '../types'

interface MarketSelectorProps {
  marketType: MarketType
  value: string
  onChange: (symbol: string) => void
}

export function MarketSelector({ marketType, value, onChange }: MarketSelectorProps) {
  const { markets, loading, error, refresh } = useMarketCatalog(marketType)
  const [openFor, setOpenFor] = useState<MarketType | null>(null)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const open = openFor === marketType

  const filtered = useMemo(() => {
    const normalized = query.trim().toUpperCase().replace(/[\s/_-]/g, '')
    if (!normalized) return markets
    return markets.filter((market) => (
      market.symbol.includes(normalized)
      || market.baseAsset.includes(normalized)
      || `${market.baseAsset}${market.quoteAsset}`.includes(normalized)
    ))
  }, [markets, query])

  const selected = markets.find((market) => market.symbol === value)
  const baseAsset = selected?.baseAsset || value.replace(/USDT$/, '')
  const quoteAsset = selected?.quoteAsset || 'USDT'

  useEffect(() => {
    if (!open) return
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpenFor(null)
    }
    document.addEventListener('mousedown', closeOnOutsideClick)
    requestAnimationFrame(() => searchRef.current?.focus())
    return () => document.removeEventListener('mousedown', closeOnOutsideClick)
  }, [open])

  useEffect(() => {
    if (loading || !markets.length || markets.some((market) => market.symbol === value)) return
    onChange((markets.find((market) => market.symbol === 'BTCUSDT') || markets[0]).symbol)
  }, [loading, markets, onChange, value])

  const select = (symbol: string) => {
    onChange(symbol)
    setOpenFor(null)
    setQuery('')
  }

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpenFor(null)
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((current) => Math.min(current + 1, filtered.length - 1))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((current) => Math.max(current - 1, 0))
      return
    }
    if (event.key === 'Enter' && filtered[activeIndex]) {
      event.preventDefault()
      select(filtered[activeIndex].symbol)
    }
  }

  return (
    <div className="market-selector" ref={rootRef}>
      <button
        type="button"
        className="market-selector-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            setOpenFor(null)
          } else {
            setQuery('')
            setActiveIndex(0)
            setOpenFor(marketType)
          }
        }}
      >
        <span className="market-selector-symbol">{baseAsset}</span>
        <span className="market-selector-quote">/ {quoteAsset}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>

      {open && (
        <section className="market-selector-popover" aria-label="选择交易对">
          <header className="market-selector-search">
            <Search size={15} aria-hidden="true" />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => { setQuery(event.target.value); setActiveIndex(0) }}
              onKeyDown={handleSearchKeyDown}
              placeholder="搜索币种或交易对"
              aria-label="搜索交易对"
              aria-controls="market-selector-list"
              aria-activedescendant={filtered[activeIndex] ? `market-${marketType}-${filtered[activeIndex].symbol}` : undefined}
            />
            {query && <button type="button" onClick={() => { setQuery(''); setActiveIndex(0) }} aria-label="清除搜索"><X size={14} /></button>}
          </header>

          <div className="market-selector-meta">
            <span>{marketType === 'spot' ? 'Binance 现货' : 'Binance USDT 永续'}</span>
            <span>{loading ? '同步中' : `${filtered.length} 个交易对`}</span>
          </div>

          <div id="market-selector-list" className="market-selector-list" role="listbox" aria-label="交易对">
            {loading && <div className="market-selector-state">正在获取 Binance 交易对</div>}
            {!loading && error && (
              <div className="market-selector-state market-selector-error">
                <span>{error}</span>
                <button type="button" onClick={refresh}><RefreshCw size={14} />重试</button>
              </div>
            )}
            {!loading && !error && filtered.map((market, index) => (
              <button
                id={`market-${marketType}-${market.symbol}`}
                type="button"
                role="option"
                aria-selected={market.symbol === value}
                className={`${market.symbol === value ? 'selected' : ''} ${index === activeIndex ? 'keyboard-active' : ''}`}
                key={market.symbol}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => select(market.symbol)}
              >
                <span className="market-selector-asset">{market.baseAsset}</span>
                <span className="market-selector-pair">{market.baseAsset} / {market.quoteAsset}</span>
                {market.symbol === value && <Check size={15} aria-hidden="true" />}
              </button>
            ))}
            {!loading && !error && filtered.length === 0 && <div className="market-selector-state">未找到匹配的交易对</div>}
          </div>
        </section>
      )}
    </div>
  )
}
