interface TradingViewWidgetOptions {
  autosize?: boolean
  width?: number | string
  height?: number | string
  symbol: string
  interval?: string
  timezone?: string
  theme?: 'light' | 'dark'
  style?: string
  locale?: string
  toolbar_bg?: string
  enable_publishing?: boolean
  allow_symbol_change?: boolean
  save_image?: boolean
  container_id: string
  hide_side_toolbar?: boolean
  studies?: string[]
}

interface TradingViewStatic {
  widget: new (options: TradingViewWidgetOptions) => unknown
}

interface Window {
  TradingView?: TradingViewStatic
}
