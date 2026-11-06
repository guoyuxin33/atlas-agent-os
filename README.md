# Atlas Agent OS

Atlas 是一个面向数字资产交易的 Electron 桌面 Agent 工作台。它将 Binance 行情、账户与订单、AI 对话、Skills、MCP 工具、风险提示和操作审计集中在原生桌面窗口中，不是浏览器网页。

当前版本为 `v0.2`。它已经具备可运行的模拟交易链路，并提供 Binance 测试网与生产环境的签名 REST 接口；生产环境具有更高风险，真实订单链路尚未在开发测试中实际下单验证。

## 当前实现

- Electron 桌面应用、macOS 应用菜单和安装包构建
- `Paper / Testnet / Live` 三种环境切换
- Binance 现货与 USDT 永续合约行情、账户快照、订单查询和下单接口
- 现货和合约分别复用一条公共 WebSocket，按交易对与周期动态订阅、取消订阅并自动重连
- 实时 24 小时行情、最优买卖价和 K 线更新
- `1m / 5m / 15m / 1h / 4h / 1d` 周期，工作台分页加载 2,000 根历史 K 线
- 持久化 Paper 账户、订单、现货成本、合约持仓、实时收益与重启恢复；持仓表支持现货和合约市价/限价部分或全部平仓
- USDT 永续单向/双向持仓、全仓/逐仓、`1-125x` 杠杆、逐仓保证金增减、强平价与保证金率
- 闭合 K 线驱动的真实 Agent 运行时，内置 5 类策略、确定性风控、逐步日志、立即评估、断线补偿、运行状态恢复和生产订单逐单确认
- OpenAI-compatible `chat/completions` AI 对话，可连接 CCSwitch、本地模型网关或兼容的第三方模型 API
- AI 多会话管理与历史消息本机持久化
- 内置 Skills 开关，AI 请求会携带已启用 Skill 与当前市场上下文
- Streamable HTTP MCP：初始化会话、发现工具和调用工具
- Electron `safeStorage` 系统加密凭证库，Secret 不返回渲染进程
- 统一 HTTP/HTTPS 网络代理，同时覆盖远程 REST、WebSocket、模型与 MCP 请求
- 生产订单二次确认；AI 不能直接绕过确认和风控提交生产订单

## 本地运行

```bash
npm install
npm run desktop:dev
```

如所在网络无法直连 Binance，可通过“连接 > 网络出口”保存 HTTP/HTTPS 代理，或在启动时设置 `ATLAS_PROXY_URL`。

## 本地验证

```bash
npm run build
npm run lint
npm run verify:paper
```

`verify:paper` 使用隔离的临时用户目录和公共行情桩，只执行 Paper 订单；它不会调用 Testnet 或 Live 下单接口。

## 构建桌面应用

```bash
npm run desktop:pack
npm run desktop:dist
```

构建产物输出到 `release/`。未签名的本地构建仅适合开发测试；正式发布需要 Apple Developer ID 签名与公证。

## 网络代理

可以在应用的“连接 > 网络出口”中配置 HTTP/HTTPS 代理，也可以在启动前设置环境变量。优先级依次是 `ATLAS_PROXY_URL`、`HTTPS_PROXY`、`HTTP_PROXY`、应用内配置：

```bash
ATLAS_PROXY_URL=http://127.0.0.1:7890 npm run desktop:dev
```

`localhost`、`127.0.0.1` 和 `::1` 上的 CCSwitch、模型服务或 MCP 服务会自动直连。修改应用内代理后，行情 WebSocket 会重新连接。

## 安全边界

- 渲染进程启用 `contextIsolation`、禁用 Node.js 集成并开启沙箱
- API Key、API Secret 和模型密钥由主进程使用 `safeStorage` 加密保存
- Atlas 不实现提币功能，也不会向 Agent 暴露提币权限
- 生产订单必须由用户在界面中二次确认；模型只能提供分析或交易意图
- 真实下单没有在测试过程中执行，使用生产环境前必须先在 Paper 和 Testnet 验证策略、数量精度、权限与风控
- 建议生产环境使用专用子账户、IP 白名单和仅交易的最小权限 API Key
- 当前 MCP 只支持 Streamable HTTP，不支持本地 stdio MCP Server

## 实时性与容量边界

行情中心在 Electron 主进程内按现货/合约复用连接，通过引用计数管理动态订阅，再向工作台窗口分发更新。该结构减少重复连接，适合单台桌面设备同时观察多个交易对与周期。

当前实现不是交易所级共置系统，也不是多节点高频交易平台：没有跨进程事件总线、多实例订阅协调、持久化订单状态机或微秒级延迟保证。正式承担高并发自动交易前，需要增加独立 Worker、背压与限流、顺序一致性、断线补偿、指标监控和故障恢复。

详细设计与限制见 [docs/architecture.md](docs/architecture.md)。

## 设计

界面遵循 quiet chrome / rich data 的交易操作台方向，使用 `unslop` 方法校正间距、颜色、图标、文案、排版、布局、细节、视觉和动效。

Unslop method by [@heydamir](https://x.com/heydamir), CC BY 4.0.
