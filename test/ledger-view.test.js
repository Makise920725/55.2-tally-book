const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../miniprogram/store/store');
const { ACCT, accountBalances } = require('../miniprogram/domain/ledger');
const { buildLedgerEvents, summarizeEvents, dayStatsByDate, groupEventsByDate, accountBalanceFromEvents, accountLabel, KIND_LABELS, ACCOUNT_LABELS } = require('../miniprogram/domain/ledger-view');
const { exportLedgerCsv, LEDGER_CSV_HEADER, ledgerCsvRows } = require('../miniprogram/utils/csv');

const useMemoryStorage = () => { global.wx = { getStorageSync: () => null, setStorageSync: () => {}, removeStorageSync: () => {} }; };

// 场景一：同一天里发生额度划入、普通支出、专项、校准和晚间退款。
function fullDay() {
  useMemoryStorage();
  store.reset();
  store.allocateDay({ date: '2026-09-24' });
  store.addExpense({ date: '2026-09-24', category: 'meal', amountYuan: 30 });
  store.addSpecial({ date: '2026-09-24', reason: 'Q4 水电', amountYuan: 405.88 });
  store.addAdjust({ date: '2026-09-24', acct: ACCT.POCKET3, realBalanceYuan: 100, bookBalanceYuan: 120, note: '小数点看错' });
  store.settleDay({ date: '2026-09-24' });
  store.executePayday(1, '2026-09-24');
  return store.getState();
}

function overSpentDay() {
  useMemoryStorage();
  store.reset();
  store.allocateDay({ date: '2026-09-24' });
  store.addExpense({ date: '2026-09-24', category: 'meal', amountYuan: 70 });
  return store.getState();
}

const typesOf = events => [...new Set(events.map(item => item.type))].sort();
const kindsOf = events => [...new Set(events.map(item => item.kind))].sort();
const findKind = (events, kind) => events.find(item => item.kind === kind);

test('四类账本数据都能投影成统一流水', () => {
  const events = buildLedgerEvents(fullDay());
  assert.deepEqual(typesOf(events), ['adjust', 'expense', 'special', 'transfer']);
  assert.deepEqual(kindsOf(events), ['adjust', 'bill_repay', 'daily_alloc', 'daily_refund', 'expense', 'payday_budget', 'payday_income', 'payday_save', 'special'].sort());
});

test('日额度划入 / 专项 / 校准都能在流水里看到，并带账户方向', () => {
  const state = fullDay();
  const day = buildLedgerEvents(state, { startDate: '2026-09-24', endDate: '2026-09-24', perspective: ACCT.BANK1 });
  const alloc = findKind(day, 'daily_alloc');
  assert.equal(alloc.title, '日额度划入');
  assert.equal(alloc.flowText, '余额宝 → 工资卡');
  assert.equal(alloc.amountText, '+ ¥55.19');
  assert.equal(findKind(day, 'daily_refund').amountText, '− ¥25.19');
  const special = findKind(day, 'special');
  assert.equal(special.title, 'Q4 水电');
  assert.equal(special.flowText, '小荷包 → 支出');
  assert.equal(special.amountText, '− ¥405.88');
  const adjust = findKind(day, 'adjust');
  assert.equal(adjust.amountText, '− ¥20.00');
  assert.equal(adjust.direction, '调减');
  assert.equal(adjust.account, ACCT.POCKET3);
});

test('超支补差以划入方向出现在当天流水', () => {
  const day = buildLedgerEvents(overSpentDay(), { startDate: '2026-09-24', endDate: '2026-09-24', perspective: ACCT.BANK1 });
  const cover = findKind(day, 'overspend_cover');
  assert.ok(cover, '应当存在 overspend_cover 流水');
  assert.equal(cover.title, '超支补差');
  assert.equal(cover.flowText, '余额宝 → 工资卡');
  assert.equal(cover.amountText, '+ ¥14.81');
});

test('校准差额可正可负，并按符号参与合计', () => {
  const negative = buildLedgerEvents(fullDay(), { types: ['adjust'] })[0];
  assert.equal(negative.amountFen, -2000);
  const state = fullDay();
  state.ledger.adjusts.push({ id: 'adjust_up', date: '2026-09-25', acct: ACCT.BANK1, realBalance: 12000, bookBalance: 10000, diff: 2000, note: '利息' });
  const positive = buildLedgerEvents(state, { types: ['adjust'], startDate: '2026-09-25', endDate: '2026-09-25' })[0];
  assert.equal(positive.amountFen, 2000);
  assert.equal(positive.direction, '调增');
  assert.equal(summarizeEvents(buildLedgerEvents(state, { types: ['adjust'] })).adjustFen, 0);
});

test('流水按业务日期、创建时间、id 依次倒序排列', () => {
  const state = {
    categories: [{ id: 'meal', name: '吃饭' }],
    ledger: {
      expenses: [
        { id: 'e_early', date: '2026-09-24', category: 'meal', amount: 100, createdAt: '2026-09-24T01:00:00.000Z' },
        { id: 'e_late', date: '2026-09-24', category: 'meal', amount: 100, createdAt: '2026-09-24T09:00:00.000Z' },
        { id: 'e_no_time', date: '2026-09-24', category: 'meal', amount: 100 },
        { id: 'e_next', date: '2026-09-25', category: 'meal', amount: 100 }
      ],
      transfers: [], specials: [], adjusts: []
    }
  };
  assert.deepEqual(buildLedgerEvents(state).map(item => item.id), ['e_next', 'e_late', 'e_early', 'e_no_time']);
  // 同一毫秒写入的发薪日四步按 SOP 顺序展示：到账 → 还款 → 入池 → 转存。
  const batch = { categories: [], ledger: { expenses: [], transfers: [
    { id: 'pay_in_1', date: '2026-09-24', from: ACCT.OUT, to: ACCT.BANK1, amount: 1, kind: 'payday_income', createdAt: '2026-09-24T01:00:00.000Z' },
    { id: 'save_1', date: '2026-09-24', from: ACCT.BANK1, to: ACCT.POCKET3, amount: 1, kind: 'payday_save', createdAt: '2026-09-24T01:00:00.000Z' },
    { id: 'bill_1', date: '2026-09-24', from: ACCT.BANK1, to: ACCT.BILL, amount: 1, kind: 'bill_repay', createdAt: '2026-09-24T01:00:00.000Z' },
    { id: 'budget_1', date: '2026-09-24', from: ACCT.BANK1, to: ACCT.POOL2, amount: 1, kind: 'payday_budget', createdAt: '2026-09-24T01:00:00.000Z' },
    { id: 'z_alloc', date: '2026-09-24', from: ACCT.POOL2, to: ACCT.BANK1, amount: 1, kind: 'daily_alloc', createdAt: '2026-09-24T01:00:00.000Z' }
  ], specials: [], adjusts: [] } };
  const ordered = buildLedgerEvents(batch).map(item => item.id).filter(id => id !== 'z_alloc');
  assert.deepEqual(ordered, ['pay_in_1', 'bill_1', 'budget_1', 'save_1'], '发薪四步要按 SOP 顺序出现');
  assert.equal(buildLedgerEvents(batch).length, 5);
});

function dedupe(list) { return [...new Set(list)]; }

test('老数据没有 createdAt 时标记时间未记录，不伪造时间', () => {
  const events = buildLedgerEvents({ categories: [{ id: 'meal', name: '吃饭' }], ledger: { expenses: [{ id: 'legacy', date: '2026-09-24', category: 'meal', amount: 1000 }], transfers: [], specials: [], adjusts: [] } });
  assert.equal(events.length, 1);
  assert.equal(events[0].exactTime, false);
  assert.equal(events[0].timeText, '时间未记录');
  assert.equal(events[0].timeShort, '时间未记录');
  assert.equal(events[0].createdAtText, '');
});

test('今日筛选不会漏掉账户划转', () => {
  const events = buildLedgerEvents(fullDay(), { startDate: '2026-09-24', endDate: '2026-09-24', perspective: ACCT.BANK1 });
  assert.ok(events.some(item => item.kind === 'daily_alloc'));
  assert.ok(events.some(item => item.kind === 'daily_refund'));
  assert.ok(events.some(item => item.kind === 'payday_save'));
  assert.ok(events.some(item => item.kind === 'bill_repay'));
  const summary = summarizeEvents(events);
  assert.equal(summary.byKind.daily_alloc, 5519);
  assert.equal(summary.expenseFen, 3000);
  assert.equal(summary.specialFen, 40588);
});

test('本期区间与单日筛选都能覆盖当天全部流水', () => {
  const state = fullDay();
  const period = buildLedgerEvents(state, { startDate: '2026-09-24', endDate: '2026-10-22' });
  const day = buildLedgerEvents(state, { startDate: '2026-09-24', endDate: '2026-09-24' });
  assert.equal(period.length, day.length);
  const stats = dayStatsByDate(period)['2026-09-24'];
  assert.equal(stats.expenseCount, 1);
  assert.equal(stats.spent, 3000);
  assert.equal(stats.hasAlloc, true);
  assert.equal(stats.allocAmount, 5519);
  assert.equal(stats.refundAmount, 2519);
  assert.equal(stats.coverAmount, 0);
  assert.equal(stats.flowCount, day.length);
  const groups = groupEventsByDate(period);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].expenseText, '支出 ¥30.00 · 专项 ¥405.88');
});

test('超支补差与退款计入同一天的统计', () => {
  const stats = dayStatsByDate(buildLedgerEvents(overSpentDay()))['2026-09-24'];
  assert.equal(stats.coverAmount, 1481);
  assert.equal(stats.hasAlloc, true);
  assert.equal(stats.refundAmount, 0);
});

test('储蓄页只看涉及小荷包的流水，且逐笔合计等于派生余额', () => {
  const state = fullDay();
  const events = buildLedgerEvents(state, { account: ACCT.POCKET3, perspective: ACCT.POCKET3 });
  assert.ok(events.length > 0);
  events.forEach(event => assert.ok([event.from, event.to, event.account].includes(ACCT.POCKET3)));
  assert.ok(events.some(item => item.kind === 'payday_save'));
  assert.ok(events.some(item => item.type === 'special'));
  assert.ok(events.some(item => item.type === 'adjust'));
  assert.ok(!events.some(item => item.type === 'expense'), '工资卡支出不应出现在小荷包流水里');
  const balances = accountBalances(state.ledger.transfers, state.ledger.expenses, state.openingBalances, state.ledger.specials, state.ledger.adjusts);
  assert.equal(accountBalanceFromEvents(events, ACCT.POCKET3, state.openingBalances[ACCT.POCKET3]), balances[ACCT.POCKET3]);
});

test('逐笔流水合计对所有账户都能复现派生余额', () => {
  const state = fullDay();
  const events = buildLedgerEvents(state);
  const balances = accountBalances(state.ledger.transfers, state.ledger.expenses, state.openingBalances, state.ledger.specials, state.ledger.adjusts);
  [ACCT.BANK1, ACCT.POOL2, ACCT.POCKET3, ACCT.BILL, ACCT.OUT].forEach(acct => {
    assert.equal(accountBalanceFromEvents(events, acct, state.openingBalances[acct]), balances[acct], acct);
  });
});

test('关键字与类型筛选可用，类型名和账户名统一', () => {
  const state = fullDay();
  assert.ok(buildLedgerEvents(state, { keyword: '水电' }).every(item => item.type === 'special'));
  assert.ok(buildLedgerEvents(state, { keyword: '余额宝' }).length >= 2);
  assert.deepEqual(typesOf(buildLedgerEvents(state, { types: ['transfer'] })), ['transfer']);
  assert.equal(accountLabel(ACCT.OUT, 'from'), '外部');
  assert.equal(accountLabel(ACCT.OUT, 'to'), '支出');
  assert.equal(KIND_LABELS.daily_alloc, '日额度划入');
  assert.equal(ACCOUNT_LABELS[ACCT.POCKET3], '小荷包');
});

test('CSV 导出四类流水并带 ID、时间、方向和账户', () => {
  const csv = exportLedgerCsv(fullDay());
  const lines = csv.replace('\ufeff', '').split('\n');
  assert.equal(lines[0], LEDGER_CSV_HEADER.join(','));
  const rows = ledgerCsvRows(fullDay());
  assert.deepEqual([...new Set(rows.map(row => row[4]))].sort(), ['专项支出', '余额校准', '支出', '账户划转']);
  const alloc = rows.find(row => row[0].startsWith('alloc'));
  assert.deepEqual(alloc.slice(1, 4), ['2026-09-24', alloc[2], '是']);
  assert.equal(alloc[4], '账户划转');
  assert.equal(alloc[5], '日额度划入');
  assert.equal(alloc[6], '55.19');
  assert.equal(alloc[7], '划入');
  assert.deepEqual(alloc.slice(8, 10), ['余额宝', '工资卡']);
  assert.match(alloc[2], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  const adjust = rows.find(row => row[4] === '余额校准');
  assert.equal(adjust[6], '-20.00');
  assert.equal(adjust[10], '小荷包');
});

test('CSV 转义与表头不丢列，金额保留两位小数', () => {
  const csv = exportLedgerCsv({ categories: [{ id: 'meal', name: '吃饭' }], ledger: { expenses: [{ id: 'e1', date: '2026-09-24', category: 'meal', amount: 1500, note: '午饭,"面"', createdAt: '2026-09-24T04:16:03.000Z' }], transfers: [], specials: [], adjusts: [] } });
  const lines = csv.replace('\ufeff', '').split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[1].split(',').filter(cell => cell.length).length >= 10);
  assert.ok(lines[1].includes('"午饭,""面"""'));
  assert.ok(lines[1].includes('15.00'));
  assert.ok(csv.startsWith('\ufeff'));
});
