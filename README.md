# Atlas Agent OS

[English](README.md) | [简体中文](README.zh-CN.md)

Atlas Agent OS is an Electron desktop workstation for digital-asset trading. It brings Binance market data, account and order operations, autonomous strategy Agents, AI supervision, Skills, MCP tools, risk controls, and execution audit logs into one native desktop application.

> [!WARNING]
> Atlas can submit real orders when Live mode is configured. Use dedicated API keys with withdrawal disabled, least-privilege trading permissions, and an IP whitelist. Validate every strategy in Paper and Testnet before considering Live use.

![Atlas trading workbench](docs/assets/workbench.png)

## What is implemented

### Trading workspace

- Paper, Binance Testnet, and Binance Live environments with an explicit environment switch.
- Binance Spot and USDT-M Futures market data, account snapshots, open orders, order submission, and position operations.
- Shared Spot/Futures WebSocket connections with dynamic subscriptions, automatic reconnects, best bid/ask, 24-hour statistics, and live K-line updates.
- Exchange-wide symbol selection and `1m / 5m / 15m / 1h / 4h / 1d` intervals, with up to 2,000 historical candles loaded in the workbench.
- Persistent Paper balances, costs, orders, Futures positions, realized/unrealized PnL, and restart recovery.
- Market or limit entry and partial/full position closing from the positions table.
- One-way and Hedge position modes, Cross and Isolated margin, `1-125x` leverage, isolated-margin adjustments, liquidation price, and margin ratio.
- Per-trade and portfolio PnL views that refresh with the latest account and mark-price snapshots.

Spot positions cannot open a naked short. Use USDT-M Futures when a strategy must open both long and short positions.

### Agent runtime and AI

- Editable Agents with symbol, Spot/Futures market, environment, interval, strategy, long-only/short-only/auto direction, risk per trade, notional cap, and intelligence settings.
- Five built-in live strategies: moving-average crossover, Donchian breakout, RSI reversal, Bollinger reversion, and ATR breakout.
- Closed-candle execution in the Electron main process, immediate evaluation, reconnect catch-up, retry handling, persisted runtime state, and step-by-step audit logs.
- Strategy-only and AI-supervised decision modes. AI supervision fails closed when the selected model, Skill, or MCP tool is unavailable, and approved decisions must still pass deterministic risk controls.
- Per-Agent Skill selection, MCP server binding, and an explicit MCP tool allowlist.
- Production Agent intents require per-order confirmation and expire if they are not approved in time.

![Atlas Agent runtime and AI supervision](docs/assets/agents.png)

### Models, chat, Skills, and MCP

- AI assistant with multiple local sessions, persistent history, Markdown responses, and market context.
- Native Anthropic and Gemini protocols plus OpenAI-compatible Chat Completions/Responses routing.
- Provider presets for OpenAI, Anthropic, Gemini, DeepSeek, Qwen, Kimi, MiniMax, OpenRouter, CCSwitch, Ollama, LM Studio, and custom compatible endpoints.
- Model discovery, manual model entry, and configurable reasoning effort where the provider supports it.
- Built-in Skills and Streamable HTTP MCP discovery/calls with tool authorization. Local stdio MCP servers are not yet supported.

### Strategy review and desktop safety

- Local strategy parameter editing and Paper backtests over real public candle history.
- Order, position, Agent-log, review, and export views.
- Credentials encrypted through Electron `safeStorage`; secrets are never returned to the renderer process.
- `contextIsolation`, renderer sandboxing, Node.js integration disabled, and single-instance protection.
- Shared HTTP/HTTPS proxy support for Binance, remote models, and MCP, with automatic bypass for local services.
- No withdrawal API or withdrawal capability is implemented.

## Run locally

Requirements: a current Node.js/npm installation and macOS, Windows, or Linux supported by Electron.

```bash
npm install
npm run desktop:dev
```

The development command starts Vite and the Electron desktop window. Atlas is not intended to run as a browser-only trading terminal.

If Binance is unavailable on the current network, configure an HTTP/HTTPS proxy in **Connections > Network egress**, or set it before launch:

```bash
ATLAS_PROXY_URL=http://127.0.0.1:7890 npm run desktop:dev
```

Local CCSwitch, model, and MCP services on `localhost`, `127.0.0.1`, and `::1` bypass the proxy automatically.

## Configure Binance

1. Open **Connections** and configure Binance credentials for Testnet or Live.
2. Grant only the Spot and/or Futures trading permissions that are required. Do not grant withdrawal permission.
3. Restrict the API key to the machine's stable public IP where possible.
4. Verify the workflow in Paper, then Testnet, before switching to Live.

An API key does not remove Binance request limits. Atlas reduces request volume through shared WebSockets and caches, but the exchange can still throttle an IP or API key. An IP pool is neither required nor recommended for bypassing rate limits; respect Binance limits and backoff signals instead.

## Configure a model

Open **Connections > Models and reasoning**, select a provider, set its endpoint and API key, choose a discovered model or enter one manually, select the supported reasoning effort, and run the connection test. OpenAI-compatible gateways such as CCSwitch can be configured with their own Base URL.

## Verification and packaging

```bash
npm run lint
npm run build
npm run verify
npm run desktop:pack
npm run desktop:dist
```

`npm run verify` covers public market data, isolated Paper Futures behavior, and chat-session persistence. Paper verification uses an isolated temporary user directory and does not submit Testnet or Live orders.

Desktop artifacts are written to `release/`. Local macOS builds are unsigned; public distribution requires platform signing and notarization.

## Safety and operating boundaries

- No Testnet or Live order was executed during development verification. Signed exchange paths are implemented, but must be validated with your own restricted account and credentials.
- Live orders require an explicit confirmation in the desktop application. Models cannot bypass this confirmation or deterministic risk checks.
- Atlas is a single-machine trading workstation, not an exchange-colocated HFT system. It does not promise microsecond latency, multi-node coordination, or lossless execution during every network or exchange failure.
- Market data, order acknowledgements, fills, and positions can temporarily diverge during reconnects or exchange incidents. Monitor execution logs and the Binance account independently.
- Trading involves substantial risk. This project is engineering software, not investment advice or a profitability guarantee.

See [the architecture notes](docs/architecture.md) for the process boundaries, data flow, and current scaling limits.

## Interface direction

The desktop interface follows a quiet-chrome, rich-data trading workstation direction. It was reviewed with the `unslop` method for spacing, color, icons, copy, typography, layout, detail, visuals, and motion.

Unslop method by [@heydamir](https://x.com/heydamir), CC BY 4.0.
