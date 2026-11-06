import { useCallback, useEffect, useState } from 'react'
import type { Environment, MarketType } from '../types'

export interface MarketCatalogItem {
  symbol: string
  baseAsset: string
  quoteAsset: string
  status: string
}

export function useMarketCatalog(environment: Environment, marketType: MarketType) {
  const [revision, setRevision] = useState(0)
  const [catalog, setCatalog] = useState<{
    key: string
    markets: MarketCatalogItem[]
    error: string | null
  }>({ key: '', markets: [], error: null })
  const requestKey = `${environment}:${marketType}:${revision}`

  const refresh = useCallback(() => setRevision((current) => current + 1), [])

  useEffect(() => {
    let active = true

    const load = async () => {
      try {
        if (!window.atlas) throw new Error('交易对目录需要在 Atlas 桌面应用中运行')
        const result = await window.atlas.market.markets({ environment, marketType })
        if (active) setCatalog({ key: requestKey, markets: result, error: null })
      } catch (caught) {
        if (active) setCatalog({ key: requestKey, markets: [], error: caught instanceof Error ? caught.message : '无法获取 Binance 交易对' })
      }
    }

    load()
    return () => { active = false }
  }, [environment, marketType, requestKey])

  const current = catalog.key === requestKey
  return {
    markets: current ? catalog.markets : [],
    loading: !current,
    error: current ? catalog.error : null,
    refresh,
  }
}
