# Atlas Agent OS

Atlas 是一个面向数字资产交易的桌面 Agent 工作台。它把实时行情、策略 Agent、模型路由、风险检查、订单执行和审计记录放进同一个原生应用窗口。

当前版本是可运行的桌面产品原型，默认工作在 Binance Testnet / 模拟盘语义下。公共行情和 K 线来自 Binance 实时接口；真实账户下单尚未启用。

## 已实现

- Electron 原生桌面窗口和 macOS 应用菜单
- Binance 公共 WebSocket 实时行情
- Binance 15 分钟 K 线与断线回退数据
- Agent 列表、运行状态与启停交互
- 模拟下单和风险闸门
- 交易所连接与权限范围界面
- CCSwitch / OpenAI 兼容模型路由配置
- 系统级加密凭证存储
- 紧急停止、持仓敞口和决策审计

## 本地运行

```bash
npm install
npm run desktop:dev
```

## 构建桌面应用

```bash
npm run desktop:pack
npm run desktop:dist
```

构建产物输出到 `release/`。未签名的本地构建仅适合开发测试；正式发布需要 Apple Developer ID 签名与公证。

## 安全边界

- 渲染进程启用 `contextIsolation`、禁用 Node.js 集成并开启沙箱
- API 密钥通过 preload 白名单 IPC 传递，使用 Electron `safeStorage` 加密
- Agent 不获得提币权限
- 下单请求必须经过确定性规则校验，模型不能绕过风控
- 首次接入真实账户前应使用专用子账户、IP 白名单和最小权限 API Key

详细架构见 [docs/architecture.md](docs/architecture.md)。

## 设计

界面遵循 quiet chrome / rich data 的交易操作台方向，使用 `unslop` 方法做间距、颜色、图标、文案、排版、布局、细节、视觉和动效校正。

Unslop method by [@heydamir](https://x.com/heydamir), CC BY 4.0.
