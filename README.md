# 55块2 · tally-book

按 `plan/` 搭建的原生微信小程序项目。

## 当前阶段

- Step 1：领域层 `money / calendar / plan / ledger`
- Step 2：五期数字校验
- 小程序入口与五个 Tab 页面骨架
- Git 初始版本控制

## 开发

```bash
nvm use
npm test
```

项目使用 `.nvmrc` 固定 Node.js `24.21.0`。首次进入项目目录后执行 `nvm use`；若本机尚未安装该版本，执行 `nvm install`。

使用微信开发者工具打开本目录，`project.config.json` 已将小程序根目录设为 `miniprogram/`。

## 架构约束

- 金额在领域层统一用“分”存储，展示时才转换为元。
- 领域层为纯函数，不依赖微信 API。
- 账户余额由追加式流水派生，不保存不可追溯的死余额。
- `Expense` 是真实支出；还款、预算分配、日终退款均是 `Transfer`。
