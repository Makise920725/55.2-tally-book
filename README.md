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

## 结算不变量（2026-09-19 code review 修复）

- 早间划额 `daily_alloc`、超支补差 `overspend_cover`、晚间退款 `daily_refund` 三者互不重复：
  余额宝在一个批次上只付出 `划入 + 补差`，退款额 = `max(0, 划入 + 补差 − 批次支出 − 已退)`。
- 三天一结按“批次”（组内第 1 天划入、第 3 天结算）判断超支与退款，不再用单日额度。
- 撤销封账会同步撤销该批次的退款划转，重新结算不会把同一笔钱退两次。
- 结算/校准/专项使用本地时区日期（`domain/calendar.todayKey`），UTC+8 早上 8 点前不会写成前一天。
