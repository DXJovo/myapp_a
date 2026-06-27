# FundPilot 基金方案桌面客户端

一个基于 Rust + Tauri + React 的桌面客户端，用多角色投研流程辅助查看自选基金、A 股与美股标的的实时/近实时行情，并生成组合权重、再平衡和风控建议。

## 功能

- 自选列表：支持 A 股、场内基金、开放式基金、美股和美股 ETF。
- 真实数据：东方财富、天天基金估值、CNBC、USD/CNY 汇率。
- 真实搜索：按代码或名称搜索 A 股/基金/美股标的。
- 组合方案：目标权重、持有份额、人民币折算市值、再平衡金额。
- FundPilot 决策面板：基本面、情绪、市场/宏观、技术分析师，多空研究员，交易员，风控与组合经理。
- 桌面运行：Tauri 桌面端直接调用 Rust 数据命令，不依赖 localhost API。
- 浏览器调试：保留 Rust HTTP API 和 Vite 调试模式。
- 导出方案：可导出当前组合和行情快照 JSON。

## 开发运行

```bash
npm install
npm run dev
```

## 构建桌面 exe

```bash
npm run desktop:build
```

构建后的 exe 默认位于：

```text
target/release/fundpilot-desktop.exe
```

## 浏览器调试模式

```bash
npm run dev:browser
```

然后打开：

```text
http://localhost:5173
```

## 安装包

```bash
npm run desktop:bundle
```

Windows 安装包需要 Tauri 下载或本机安装 WiX/NSIS。若网络环境无法下载 WiX，`desktop:build` 仍可正常生成 exe。

## 数据说明

免费公开行情源可能存在延迟、限流或字段变化。页面中的策略评分和组合建议仅用于研究和辅助决策，不构成投资建议。
