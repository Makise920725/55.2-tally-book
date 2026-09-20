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
  const problems = [];
  let catchUps = 0;
  let sealedBatches = 0;
  for (let date = CONFIG.startDate; date <= CONFIG.deadline && problems.length < 5; date = nextDay(date)) {
    const periods = store.getState().periods;
    const payday = periods.find(item => item.payDate === date);
    if (payday) store.executePayday(payday.index, date);
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
    if (settled.transfer && settled.transfer.amount < 0) problems.push(`${date} 退款为负`);
    if (rand() < 0.06) {
      const list = store.getState().ledger.expenses.filter(item => item.amount > 0 && !item.reversalOf);
      if (list.length) {
        const target = list[Math.floor(rand() * list.length)];
        store.reverseExpense({ id: target.id, amountYuan: rand() < 0.5 ? target.amount / 200 : undefined, asOfDate: date });
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
    if (state.periods.some(item => item.executed && item.budgetToPool !== state.ledger.transfers
      .filter(t => t.kind === 'payday_budget' && t.date === item.payDate).reduce((total, t) => total + t.amount, 0))) {
      problems.push(`${date} 已执行期次预算与实际划转不一致`);
    }
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
  return { problems, catchUps, sealedBatches };
}

test('浸泡：随机漏划额 + 切模式 + 切情景 + 冲正，账本不变量始终成立', () => {
  // 2932412 是历史上真会撞出“已封账批次被重新归批 + 超退”的剧本，保留成长期回归
  const results = [7919, 104729, 209458, 2932412, 942561, 418].map(soak);
  const problems = results.flatMap(item => item.problems);
  assert.ok(results.some(item => item.catchUps > 0), '剧本应当真的走过补划路径');
  assert.ok(results.every(item => item.sealedBatches > 100), '剧本应当封掉足够多的批次');
  assert.deepEqual(problems, []);
});
