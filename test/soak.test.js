// 浸泡测试：把整个计划（2026-09-24 → 2027-02-05）跑若干遍，随机支出 / 漏划额（走补划）/
// 封账 / 冲正 / 切结算模式 / 切预算情景，逐日检查账本不变量。
// 这类 bug（重复退款、批次身份漂移、视图与派生余额不一致）只在长剧本里才会撞出来。
const test = require('node:test');
const assert = require('node:assert/strict');
const root = '../miniprogram/';
const store = require(root + 'store/store');
const { accountBalances } = require(root + 'domain/ledger');
const { buildLedgerEvents, accountBalanceFromEvents } = require(root + 'domain/ledger-view');
const { CONFIG } = require(root + 'domain/plan');
const { parseDate, dateKey } = require(root + 'domain/calendar');

const rng = seed => { let s = seed; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; };
const scenarios = ['省', '中', '松'];
const cats = ['meal', 'cat', 'daily', 'snack', 'charge'];
const nextDay = date => { const d = parseDate(date); d.setUTCDate(d.getUTCDate() + 1); return dateKey(d); };
const shiftDay = (date, delta) => { const d = parseDate(date); d.setUTCDate(d.getUTCDate() + delta); return dateKey(d); };
const yuanOf = fen => (fen / 100).toFixed(2);

// 随机自选安置：账单先随机少还一点，剩下的在余额宝/小荷包之间随机分（合计恒等于到账额）。
// 用**独立的 rng**，不去动主 rand() 的序列 —— 2932412 / 245502 这些种子撞出过真实缺陷，
// 它们的剧本必须原样保留成长期回归。
function randomSplit(rand, income, billRoom) {
  const bill = Math.floor(Math.max(0, billRoom) * rand());
  const rest = income - bill;
  const pool = Math.floor(rest * rand());
  return { billYuan: yuanOf(bill), poolYuan: yuanOf(pool), saveYuan: yuanOf(rest - pool) };
}

// 批次口径与 store 内部一致：带 batchKey 的划转只认 batchKey，其余按业务日期落批
function batchNet(state, range) {
  const key = `${range.start}~${range.end}`;
  const inBatch = t => (t.batchKey ? t.batchKey === key : t.date >= range.start && t.date <= range.end);
  const part = kind => state.ledger.transfers.filter(t => t.kind === kind && inBatch(t)).reduce((total, t) => total + t.amount, 0);
  const spent = state.ledger.expenses.filter(e => e.date >= range.start && e.date <= range.end).reduce((total, e) => total + e.amount, 0);
  return { net: part('daily_alloc') + part('overspend_cover') - spent - part('daily_refund') };
}

function batchesOf(state) {
  const map = new Map();
  Object.keys(state.daySlots).forEach(key => {
    const slot = state.daySlots[key] || {};
    if (slot.batchStart && slot.batchEnd) map.set(`${slot.batchStart}~${slot.batchEnd}`, { start: slot.batchStart, end: slot.batchEnd, closed: Boolean(slot.closed) });
  });
  state.ledger.expenses.forEach(item => {
    if (![...map.values()].some(range => item.date >= range.start && item.date <= range.end)) {
      map.set(`${item.date}~${item.date}`, { start: item.date, end: item.date, closed: Boolean((state.daySlots[item.date] || {}).closed) });
    }
  });
  return [...map.values()];
}

function soak(seed) {
  global.wx = { getStorageSync: () => null, setStorageSync: () => {}, removeStorageSync: () => {} };
  store.reset();
  const rand = rng(seed);
  const allowanceRand = rng(seed + 977);
  const splitRand = rng(seed + 31337);
  // 待登记的生活费：工资日那天定下「生活费哪天到」，等循环真的走到那天再登记，
  // 保证任何时刻账本都只包含「已经到账」的钱。
  const pendingAllowances = [];
  const problems = [];
  let catchUps = 0;
  let sealedBatches = 0;
  let sweeps = 0;
  let customSplits = 0;
  for (let date = CONFIG.startDate; date <= CONFIG.deadline && problems.length < 5; date = nextDay(date)) {
    const periods = store.getState().periods;
    // 两段到账：工资日登记工资；生活费延后 1–6 天到，到账那天再登记。
    const payday = periods.find(item => item.payDate === date);
    if (payday) {
      // 一半概率自己决定三个口袋各放多少，另一半走推荐值（两条路径都要泡）
      const useSplit = splitRand() < 0.5;
      const billRoom = Math.max(0, payday.billTotal - payday.billPlaced);
      const registered = store.registerSalaryDay(payday.index, date, useSplit ? { split: randomSplit(splitRand, payday.salary, billRoom) } : {});
      if (registered.blocked) problems.push(`${date} 工资登记被拒: ${registered.blocked}`);
      else if (useSplit) customSplits += 1;
      const allowanceDate = shiftDay(date, 1 + Math.floor(allowanceRand() * 6));
      if (allowanceDate <= CONFIG.deadline && allowanceDate <= payday.rangeEnd && allowanceRand() < 0.9) {
        pendingAllowances.push({ index: payday.index, date: allowanceDate });
      }
    }
    for (let i = pendingAllowances.length - 1; i >= 0; i -= 1) {
      if (pendingAllowances[i].date !== date) continue;
      const due = pendingAllowances[i];
      const per = store.getState().periods[due.index - 1];
      const useSplit = splitRand() < 0.5;
      const result = store.registerAllowance(due.index, {
        date: due.date, asOfDate: date,
        ...(useSplit ? { split: randomSplit(splitRand, CONFIG.monthlyAllowance, Math.max(0, per.billTotal - per.billPlaced)) } : {})
      });
      if (!result.blocked && useSplit) customSplits += 1;
      // 重复登记走的是 alreadyReceived 标记，不是 blocked；这里任何 blocked 都算问题。
      if (result.blocked) problems.push(`${date} 生活费登记被拒: ${result.blocked}`);
      pendingAllowances.splice(i, 1);
    }
    if (rand() < 0.08) store.setScenario(scenarios[Math.floor(rand() * 3)], date);
    if (rand() < 0.05) store.setMode(store.getState().mode === 'three-day' ? 'daily' : 'three-day', date);
    if (rand() < 0.25) { /* 今天忘了点“早间划额”，之后某天补划 */ } else {
      const result = store.allocateDay({ date });
      if (result.catchUp) catchUps += 1;
    }
    for (let i = 0, n = Math.floor(rand() * 4); i < n; i += 1) {
      store.addExpense({ date, category: cats[Math.floor(rand() * cats.length)], amountYuan: rand() < 0.12 ? 60 + Math.floor(rand() * 40) : 1 + Math.floor(rand() * 50) });
    }
    const settled = store.settleDay({ date });
    // 10% 概率回到本期更早的某天补划（本期页新增的入口），六成概率顺手把那天的账结掉：
    // 补划后不结算，钱会半浮在工资卡上，所以两条路径要一起泡。
    if (rand() < 0.1) {
      const past = shiftDay(date, -(1 + Math.floor(rand() * 3)));
      const backfill = store.allocateDay({ date: past });
      if (backfill.catchUp) catchUps += 1;
      if (rand() < 0.6) store.settleDay({ date: past });
    }
    if (settled.transfer && settled.transfer.amount < 0) problems.push(`${date} 退款为负`);
    if (rand() < 0.06) {
      const list = store.getState().ledger.expenses.filter(item => item.amount > 0 && !item.reversalOf);
      if (list.length) {
        const target = list[Math.floor(rand() * list.length)];
        store.reverseExpense({ id: target.id, amountYuan: rand() < 0.5 ? target.amount / 200 : undefined, asOfDate: date });
      }
    }
    // 8% 概率执行第六步「清理上期结余」：转完之后必须刚好只剩本期剩余开销，且不创造钱
    if (rand() < 0.08) {
      const before = accountBalances(store.getState().ledger.transfers, store.getState().ledger.expenses, store.getState().openingBalances, store.getState().ledger.specials, store.getState().ledger.adjusts);
      // 两段到账：工资日之后池子还差 pendingPool 才满，这笔钱生活费到账时一定会补进来，
      // 所以现在只需留「剩余开销 − 待补池」。少了这一项，上一期的真实余粮会被缺口吞掉，
      // 第六步在工资日永远算出 0（第 1、2 期缺口分别是 ¥144.83 / ¥647.88）。
      const pv = store.previewPoolSurplus(date);
      if (!pv.blocked && pv.reserve !== Math.max(0, pv.remainingNeed - (pv.pendingPool || 0))) {
        problems.push(`${date} reserve ${pv.reserve} 与「剩余开销 ${pv.remainingNeed} − 待补池 ${pv.pendingPool}」对不上`);
      }
      const swept = store.sweepPoolSurplus({ asOfDate: date });
      if (swept.transfer) {
        sweeps += 1;
        const after = accountBalances(store.getState().ledger.transfers, store.getState().ledger.expenses, store.getState().openingBalances, store.getState().ledger.specials, store.getState().ledger.adjusts);
        if (after.POOL2 + after.POCKET3 !== before.POOL2 + before.POCKET3) problems.push(`${date} 清理余粮凭空创造/蒸发了钱`);
        if (after.POOL2 < 0) problems.push(`${date} 清理过度，余额宝被转成负数`);
        if (store.previewPoolSurplus(date).surplus !== 0) problems.push(`${date} 清理后仍算出余粮，口径没收敛`);
        if (store.sweepPoolSurplus({ asOfDate: date }).skipped !== true) problems.push(`${date} 同一天重复清理却没有 skipped`);
      }
    }
    const state = store.getState();
    const balances = accountBalances(state.ledger.transfers, state.ledger.expenses, state.openingBalances, state.ledger.specials, state.ledger.adjusts);
    if (balances.BANK1 + balances.POOL2 + balances.POCKET3 + balances.BILL + balances.OUT !== 0) problems.push(`${date} 复式记账不平`);
    if (balances.POCKET3 < 0) problems.push(`${date} 小荷包为负`);
    ['BANK1', 'POOL2', 'POCKET3'].forEach(acct => {
      const net = accountBalanceFromEvents(buildLedgerEvents(state, { account: acct, perspective: acct }), acct, 0);
      if (net !== balances[acct]) problems.push(`${date} ${acct} 视图逐笔合计 ${net} ≠ 派生余额 ${balances[acct]}`);
    });
    // 两段到账后入池会分工资日/生活费日两次发生，按期次核对（新流水带 periodIndex，旧流水按发薪日）。
    state.periods.forEach(item => {
      const placed = state.ledger.transfers
        .filter(t => t.kind === 'payday_budget' && (Number.isInteger(t.periodIndex) ? t.periodIndex === item.index : t.date === item.payDate))
        .reduce((total, t) => total + t.amount, 0);
      if (placed !== item.poolPlaced) problems.push(`${date} 第 ${item.index} 期入池金额与流水不一致`);
      // 自选安置之后这两条尤其要钉住：钱进来多少就必须有多少落到三个口袋之一，且账单不能被多还。
      const total = item.billPlaced + item.poolPlaced + item.savePlaced;
      if (total !== item.salaryIn + item.allowanceIn) {
        problems.push(`${date} 第 ${item.index} 期已安置 ${total} != 已到账 ${item.salaryIn + item.allowanceIn}`);
      }
      if (item.billPlaced > item.planBill) problems.push(`${date} 第 ${item.index} 期账单被多还了 ${item.billPlaced - item.planBill}`);
      if (item.fullyFunded && item.savePlaced !== item.saveToPocket) problems.push(`${date} 第 ${item.index} 期到齐后转存口径漂移`);
    });
    const allocDates = state.ledger.transfers.filter(t => t.kind === 'daily_alloc').map(t => t.date);
    if (new Set(allocDates).size !== allocDates.length) problems.push(`${date} 同一天出现多笔划额`);
    allocDates.forEach(day => {
      const slot = state.daySlots[day] || {};
      if (slot.batchStart && slot.batchStart !== day) problems.push(`${day} 的划额没落在批次首日 ${slot.batchStart}`);
    });
    batchesOf(state).forEach(range => {
      if (!range.closed) return;
      sealedBatches += 1;
      const { net } = batchNet(state, range);
      if (net !== 0) problems.push(`${date} 已封账批次 ${range.start}~${range.end} 未归零，差 ${net}`);
    });
  }
  return { problems, catchUps, sealedBatches, sweeps, customSplits };
}

test('浸泡：随机漏划额 + 切模式 + 切情景 + 冲正，账本不变量始终成立', () => {
  // 2932412 曾撞出“已封账批次被重新归批 + 超退”；245502 曾撞出
  // “补划没沿用批次钉住的额度 → 封账后工资卡短钱”。两个剧本都保留成长期回归。
  const results = [7919, 104729, 209458, 2932412, 942561, 245502].map(soak);
  const problems = results.flatMap(item => item.problems);
  assert.ok(results.some(item => item.catchUps > 0), '剧本应当真的走过补划路径');
  assert.ok(results.some(item => item.sweeps > 0), '剧本应当真的走过第六步清理');
  assert.ok(results.every(item => item.sealedBatches > 100), '剧本应当封掉足够多的批次');
  assert.ok(results.some(item => item.customSplits > 0), '剧本应当真的走过自选安置');
  assert.deepEqual(problems, []);
});
