const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../miniprogram/store/store');
const { ACCT, accountBalances } = require('../miniprogram/domain/ledger');
const { buildLedgerEvents, accountBalanceFromEvents, dayStatsByDate, summarizeEvents } = require('../miniprogram/domain/ledger-view');
const { exportLedgerCsv, ledgerCsvRows } = require('../miniprogram/utils/csv');

const useMemoryStorage = () => { global.wx = { getStorageSync: () => null, setStorageSync: () => {}, removeStorageSync: () => {} }; };
const D = '2026-09-24';
const balancesOf = state => accountBalances(state.ledger.transfers, state.ledger.expenses, state.openingBalances, state.ledger.specials, state.ledger.adjusts);
const expenseId = state => state.ledger.expenses.find(item => !item.reversalOf).id;

function openBatch({ amountYuan = 70, mode = 'daily' } = {}) {
  useMemoryStorage();
  store.reset();
  if (mode === 'three-day') store.setMode('three-day');
  store.allocateDay({ date: D });
  store.addExpense({ date: D, category: 'meal', amountYuan });
  return expenseId(store.getState());
}

function closedBatch({ amountYuan = 30 } = {}) {
  const id = openBatch({ amountYuan });
  store.settleDay({ date: D });
  return id;
}

test('未封账批次冲正：只追加负向支出，结算按修正后的支出重算', () => {
  const id = openBatch({ amountYuan: 70 });          // 超支 14.81，由余额宝补差
  const before = store.getState();
  const result = store.reverseExpense({ id, asOfDate: D });
  assert.equal(result.blocked, undefined);
  assert.equal(result.trueUp, null, '还没结算，不需要补退');
  assert.equal(result.reversal.amount, -7000);
  assert.equal(result.reversal.date, D, '冲正记录要挂在原支出日期，修正的是那一天的账');
  assert.equal(result.reversal.reversalOf, id);
  assert.equal(result.reversal.category, 'meal');
  // 原始记录一个字都没改
  assert.deepEqual(store.getState().ledger.expenses[0], before.ledger.expenses[0]);
  // 补差 14.81 是真实发生过的转账，不撤销；批次净支出归零后，55.19 + 14.81 全部退回余额宝。
  const settled = store.settleDay({ date: D });
  assert.equal(settled.transfer.amount, 7000, '应退 = 划入 55.19 + 补差 14.81 − 修正后支出 0');
  const balances = balancesOf(store.getState());
  assert.equal(balances[ACCT.BANK1], 0);
  assert.equal(balances[ACCT.POOL2], 0);
});

test('已封账批次冲正：追加补退划转，工资卡与余额宝同时归位', () => {
  const id = closedBatch({ amountYuan: 30 });        // 已退 25.19
  const result = store.reverseExpense({ id, asOfDate: '2026-09-25' });
  assert.equal(result.batchClosed, true);
  assert.equal(result.trueUp.kind, 'daily_refund', '沿用 daily_refund 口径，结算才会把它算进已退额');
  assert.equal(result.trueUp.amount, 3000);
  assert.equal(result.trueUp.date, '2026-09-25', '补退是今天真实要转的钱');
  assert.equal(result.trueUp.batchKey, `${D}~${D}`, '但归属仍是原批次');
  const state = store.getState();
  const balances = balancesOf(state);
  assert.equal(balances[ACCT.BANK1], 0, '批次闭环后工资卡不应留下钱');
  assert.equal(balances[ACCT.POOL2], 0, '余额宝为这个批次付出的钱全部收回');
  assert.equal(state.daySlots[D].refunded, 5519);
});

test('重复冲正与冲正记录本身都被拒绝；计划结束后账本只读', () => {
  const id = closedBatch();
  assert.equal(store.reverseExpense({ id, asOfDate: '2026-09-25' }).blocked, undefined);
  assert.equal(store.reverseExpense({ id, asOfDate: '2026-09-25' }).blocked, 'already_reversed');
  const reversal = store.getState().ledger.expenses.find(item => item.reversalOf);
  assert.equal(store.reverseExpense({ id: reversal.id, asOfDate: '2026-09-25' }).blocked, 'is_reversal');
  assert.equal(store.reverseExpense({ id: 'nope', asOfDate: '2026-09-25' }).blocked, 'not_found');
  assert.equal(store.reverseExpense({ id: reversal.id, asOfDate: '2027-03-01' }).blocked, 'is_reversal');
  useMemoryStorage();
  store.reset();
  const lateId = closedBatch();
  assert.equal(store.reverseExpense({ id: lateId, asOfDate: '2027-03-01' }).blocked, 'ended');
});

test('冲正后再次结算不会重复退款；撤销封账会连补退一起撤销后只退一次', () => {
  const id = closedBatch({ amountYuan: 30 });
  store.reverseExpense({ id, asOfDate: '2026-09-25' });
  const again = store.settleDay({ date: D });
  assert.equal(again.alreadyClosed, true);
  assert.equal(again.transfer, null);
  const refundCount = () => store.getState().ledger.transfers.filter(item => item.kind === 'daily_refund').length;
  assert.equal(refundCount(), 2, '原退款 + 补退');
  store.reopenDay(D);
  assert.equal(refundCount(), 0, '撤销封账必须把补退一并撤销，否则重结会退两次');
  store.settleDay({ date: D });
  assert.equal(refundCount(), 1);
  const state = store.getState();
  assert.equal(balancesOf(state)[ACCT.BANK1], 0);
  assert.equal(balancesOf(state)[ACCT.POOL2], 0);
});

test('三天一结：冲正 D1 的支出按 D1 所在批次核算，不污染当天批次', () => {
  const id = openBatch({ amountYuan: 100, mode: 'three-day' });  // 批次 09-24 → 09-26，额度 165.57
  store.reverseExpense({ id, asOfDate: '2026-09-25' });
  const state = store.getState();
  const refunds = state.ledger.transfers.filter(item => item.kind === 'daily_refund');
  assert.equal(refunds.length, 0, '未结算的批次不会因冲正产生退款');
  const settled = store.settleDay({ date: '2026-09-26' });
  assert.equal(settled.transfer.amount, 16557, '整个批次支出被冲掉，额度全额退回余额宝');
  const balances = balancesOf(store.getState());
  assert.equal(balances[ACCT.BANK1], 0);
  assert.equal(balances[ACCT.POOL2], 0);
});

test('补退落在别的日期时，仍只归属原批次：新批次结算不受影响', () => {
  const id = closedBatch({ amountYuan: 30 });
  store.reverseExpense({ id, asOfDate: '2026-09-25' });
  // 09-25 现在是“另一个每日批次”，它自己结算时不该把 09-25 的补退当成自己的退款
  store.allocateDay({ date: '2026-09-25' });
  store.addExpense({ date: '2026-09-25', category: 'meal', amountYuan: 10 });
  const settled = store.settleDay({ date: '2026-09-25' });
  assert.equal(settled.transfer.amount, 4519, '09-25 只退自己的 55.19 − 10');
});

test('验收：误记 70（其实 40）→ 冲正 → 补记 40 → 下一批次正常闭环', () => {
  const id = closedBatch({ amountYuan: 70 });        // 划入 55.19 + 补差 14.81，支出记成 70，结算无可退
  let state = store.getState();
  assert.equal(balancesOf(state)[ACCT.BANK1], 0);
  assert.equal(balancesOf(state)[ACCT.POOL2], -7000);
  const done = store.reverseExpense({ id, asOfDate: '2026-09-25' });
  assert.equal(done.trueUp.amount, 7000, '误记的 70 全部要还给余额宝');
  store.allocateDay({ date: '2026-09-25' });
  store.addExpense({ date: '2026-09-25', category: 'meal', amountYuan: 40 });   // 补记正确金额
  store.settleDay({ date: '2026-09-25' });
  state = store.getState();
  assert.equal(balancesOf(state)[ACCT.BANK1], 0, '工资卡不留钱');
  // 真实消费 40 元最终由余额宝承担（OUT 账户累计 +40），误记的部分一分不剩
  assert.equal(balancesOf(state)[ACCT.POOL2], -4000);
  assert.equal(balancesOf(state)[ACCT.OUT], 4000);
  const events = buildLedgerEvents(state, { perspective: ACCT.BANK1 });
  assert.equal(summarizeEvents(events).expenseFen, 4000, '账本净支出等于真实花费');
  assert.equal(accountBalanceFromEvents(events, ACCT.BANK1, 0), balancesOf(state)[ACCT.BANK1]);
});

test('切过模式后冲正旧批次，不会把三日批次改成单日批次（不得提前退款）', () => {
  useMemoryStorage();
  store.reset();
  store.setMode('three-day');
  store.allocateDay({ date: D });
  store.addExpense({ date: D, category: 'meal', amountYuan: 30 });
  store.addExpense({ date: '2026-09-25', category: 'meal', amountYuan: 20 });
  assert.equal(store.settleDay({ date: '2026-09-26' }).transfer.amount, 11557, '批次第三天结算，退 115.57');
  store.setMode('daily');                                   // 之后改回每日结算
  const id = expenseId(store.getState());
  const done = store.reverseExpense({ id, asOfDate: '2026-09-28' });
  assert.equal(done.trueUp.amount, 3000, '误记的 30 元补退回余额宝');
  const slots = store.getState().daySlots;
  ['2026-09-24', '2026-09-25', '2026-09-26'].forEach(date => {
    assert.equal(slots[date].batchMode, 'three-day', `${date} 的批次模式必须保持三天一结`);
    assert.equal(slots[date].batchEnd, '2026-09-26');
  });
  store.reopenDay(D);
  const early = store.settleDay({ date: D });
  assert.ok(!early.transfer, '不能在批次首日就退掉整个三日批次');
  assert.equal(early.batchPending, true);
  assert.equal(store.settleDay({ date: '2026-09-26' }).transfer.amount, 14557, '到批次末日才结算，退 165.57 − 20');
});

test('视图层：冲正成对出现、金额抵消，可选隐藏', () => {
  const id = closedBatch({ amountYuan: 30 });
  store.reverseExpense({ id, asOfDate: '2026-09-25' });
  const state = store.getState();
  const events = buildLedgerEvents(state, { perspective: ACCT.BANK1 });
  const original = events.find(item => item.id === id);
  const reversal = events.find(item => item.reversalOf === id);
  const trueUp = events.find(item => item.trueUp);
  assert.equal(original.reversed, true);
  assert.equal(original.amountText, '− ¥30.00');
  assert.equal(reversal.typeLabel, '支出冲正');
  assert.equal(reversal.amountText, '+ ¥30.00');
  assert.equal(reversal.direction, '冲正');
  assert.equal(reversal.flowText, '支出 → 工资卡', '冲正的钱是退回来');
  assert.equal(trueUp.title, '冲正补退');
  assert.equal(summarizeEvents(events.filter(item => item.eventDate === D)).expenseFen, 0, '当天净支出归零');
  assert.equal(dayStatsByDate(events)[D].expenseCount, 1);
  assert.equal(dayStatsByDate(events)[D].reversalCount, 1);
  assert.equal(dayStatsByDate(events)[D].spent, 0);
  const hidden = buildLedgerEvents(state, { hideReversals: true });
  assert.ok(!hidden.some(item => item.id === id || item.reversalOf || item.trueUp), '隐藏冲正对时成对消失');
  assert.equal(summarizeEvents(hidden).expenseFen, 0, '隐藏后不该留下误记的支出');
  assert.equal(summarizeEvents(events).expenseFen, 0, '不隐藏时净额也是 0，两条口径一致');
});

test('冲正后逐笔合计仍能复现所有账户的派生余额', () => {
  const id = closedBatch({ amountYuan: 30 });
  store.reverseExpense({ id, asOfDate: '2026-09-25' });
  store.addSpecial({ date: D, reason: 'Q4 水电', amountYuan: 405.88 });
  const state = store.getState();
  const events = buildLedgerEvents(state);
  const balances = balancesOf(state);
  [ACCT.BANK1, ACCT.POOL2, ACCT.POCKET3, ACCT.BILL, ACCT.OUT].forEach(acct => {
    assert.equal(accountBalanceFromEvents(events, acct, state.openingBalances[acct]), balances[acct], acct);
  });
});

test('部分冲正：只冲掉记错的那部分，剩余可冲额随之下降', () => {
  useMemoryStorage();
  store.reset();
  store.allocateDay({ date: D });
  store.addExpense({ date: D, category: 'meal', amountYuan: 30 });   // 误记 30，其实只花 18
  const id = expenseId(store.getState());
  assert.equal(store.reverseSpecial({ id, asOfDate: D }).blocked, 'not_found', '专项冲正不能拿支出的 id');
  const first = store.reverseExpense({ id, amountYuan: 12, asOfDate: D });
  assert.equal(first.reversal.amount, -1200);
  assert.equal(first.remainingFen, 1800);
  assert.equal(first.trueUp, null);
  assert.equal(store.getState().ledger.expenses.filter(item => item.reversalOf).length, 1);
  // 批次未封账：净支出变成 18，结算退 55.19 − 18
  assert.equal(store.settleDay({ date: D }).transfer.amount, 3719);
});

test('部分冲正不许超过剩余可冲额，冲完就不许再冲', () => {
  const id = openBatch({ amountYuan: 30 });
  assert.equal(store.reverseExpense({ id, amountYuan: 40, asOfDate: D }).blocked, 'bad_amount');
  store.reverseExpense({ id, amountYuan: 12, asOfDate: D });
  const second = store.reverseExpense({ id, amountYuan: 18.01, asOfDate: D });
  assert.equal(second.blocked, 'bad_amount');
  assert.equal(second.remainingFen, 1800, '被拒时要回传还能冲多少，页面才提示得准');
  store.reverseExpense({ id, amountYuan: 18, asOfDate: D });
  assert.equal(store.reverseExpense({ id, amountYuan: 1, asOfDate: D }).blocked, 'already_reversed');
  const state = store.getState();
  assert.equal(state.ledger.expenses.filter(item => item.reversalOf).length, 2);
  assert.equal(summarizeEvents(buildLedgerEvents(state)).expenseFen, 0, '两笔冲正后净支出归零');
});

test('已封账批次部分冲正：补退只算差额', () => {
  const id = closedBatch({ amountYuan: 30 });                   // 已退 25.19
  const done = store.reverseExpense({ id, amountYuan: 12, asOfDate: '2026-09-25' });
  assert.equal(done.trueUp.amount, 1200, '应退 37.19 − 已退 25.19 = 12.00');
  const balances = balancesOf(store.getState());
  assert.equal(balances[ACCT.BANK1], 0);
  assert.equal(balances[ACCT.POOL2], -1800, '余额宝净付出正好是真实的 18 元');
});

test('批量冲正是原子的：一条不成立就整体不写', () => {
  const id = openBatch({ amountYuan: 30 });
  const before = store.getState();
  const failed = store.reverseEntries({ entries: [{ id }, { id: 'ghost' }], asOfDate: D });
  assert.equal(failed.blocked, 'not_found');
  assert.equal(failed.failedIndex, 1);
  assert.equal(store.getState(), before, '失败后状态引用都不该变');
  assert.equal(store.getState().ledger.expenses.length, before.ledger.expenses.length);
});

test('批量冲正：混合已封账与未封账批次，各自算补退', () => {
  useMemoryStorage();
  store.reset();
  store.allocateDay({ date: D });
  store.addExpense({ date: D, category: 'meal', amountYuan: 30 });
  store.settleDay({ date: D });                                  // 批次 09-24 已封账，退 25.19
  store.allocateDay({ date: '2026-09-25' });
  store.addExpense({ date: '2026-09-25', category: 'meal', amountYuan: 20 });   // 批次 09-25 未封账
  const day24 = expenseId(store.getState());
  const day25 = store.getState().ledger.expenses.find(item => item.date === '2026-09-25').id;
  const done = store.reverseEntries({ entries: [{ id: day24 }, { id: day25 }], asOfDate: '2026-09-26' });
  assert.equal(done.blocked, undefined);
  assert.deepEqual(done.summary, { count: 2, amountFen: 5000, trueUpFen: 3000, trueUpCount: 1, closedCount: 1 });
  assert.equal(done.trueUps.length, 1);
  const state = store.getState();
  // 09-24 批次闭环，09-25 批次未结算，所以工资卡正好留着 09-25 的全部余粮 55.19
  assert.equal(balancesOf(state)[ACCT.BANK1], 5519);
  store.settleDay({ date: '2026-09-25' });
  assert.equal(balancesOf(store.getState())[ACCT.BANK1], 0, '未封账批次靠正常结算收口，不需要额外补退');
  const events = buildLedgerEvents(state);
  [ACCT.BANK1, ACCT.POOL2, ACCT.POCKET3, ACCT.BILL, ACCT.OUT].forEach(acct => {
    assert.equal(accountBalanceFromEvents(events, acct, state.openingBalances[acct]), balancesOf(state)[acct], acct);
  });
});

test('专项支出也能冲正：小荷包余额复原，不需要补退', () => {
  useMemoryStorage();
  store.reset();
  store.executePayday(1, D);
  store.addSpecial({ date: D, reason: 'Q4 水电', amountYuan: 405.88 });
  const state = store.getState();
  const special = state.ledger.specials[0];
  assert.equal(balancesOf(state)[ACCT.POCKET3], 185517 - 40588);
  const done = store.reverseSpecial({ id: special.id, asOfDate: D });
  assert.equal(done.reversal.amount, -40588);
  assert.equal(done.reversal.reversalOf, special.id);
  assert.equal(done.trueUp, null);
  assert.equal(balancesOf(store.getState())[ACCT.POCKET3], 185517, '小荷包余额回到冲正前');
  assert.equal(store.reverseSpecial({ id: special.id }).blocked, 'already_reversed');
  assert.equal(store.reverseSpecial({ id: done.reversal.id }).blocked, 'is_reversal');
  const events = buildLedgerEvents(store.getState(), { account: ACCT.POCKET3, perspective: ACCT.POCKET3 });
  const row = events.find(item => item.reversalOf === special.id);
  assert.equal(row.typeLabel, '专项冲正');
  assert.equal(row.amountText, '+ ¥405.88');
  assert.equal(row.title, '冲正 · Q4 水电');
  assert.equal(summarizeEvents(events).specialFen, 0, '专项合计按净额');
  assert.ok(!buildLedgerEvents(store.getState(), { account: ACCT.POCKET3, hideReversals: true }).some(item => item.type === 'special'));
});

test('CSV 保留误记与冲正两行，金额可直接在 Excel 里复算', () => {
  const id = closedBatch({ amountYuan: 30 });
  store.reverseExpense({ id, asOfDate: '2026-09-25' });
  const rows = ledgerCsvRows(store.getState());
  const original = rows.find(row => row[0] === id);
  const reversal = rows.find(row => row[4] === '支出冲正');
  assert.equal(reversal[5], `冲正 · 吃饭`);
  const trueUp = rows.find(row => row[5] === '冲正补退');
  assert.equal(original[7], '支出');
  assert.deepEqual(reversal.slice(1, 3), [D, reversal[2]]);
  assert.equal(reversal[4], '支出冲正');
  assert.equal(reversal[6], '-30.00', '带符号，方便逐笔重算');
  assert.equal(reversal[7], '冲正');
  assert.ok(reversal[11].includes(id), '备注里能追溯到被冲正的流水 ID');
  assert.ok(trueUp[11].includes('冲正补退'));
  assert.equal(trueUp[4], '账户划转');
  assert.equal(trueUp[7], '划入');
  assert.match(exportLedgerCsv(store.getState()), /冲正补退 · 批次 2026-09-24 → 2026-09-24/);
});
