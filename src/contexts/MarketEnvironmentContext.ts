import { createContext, useContext } from 'react'
import type { Environment } from '../types'

export const MarketEnvironmentContext = createContext<Environment>('paper')

export function useMarketEnvironment() {
  return useContext(MarketEnvironmentContext)
}
