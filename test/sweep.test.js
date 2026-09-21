// 发薪日第五步「清理上期结余」：余额宝里超出“本期剩余计划开销”的钱，
// 必须靠一笔真实的 carry_over 划转才能进小荷包——不点就不会动，也不会有第二笔账。
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../miniprogram/store/store');
const { accountBalances, ACCT } = require('../miniprogram/domain/ledger');
const { poolSurplus } = require('../miniprogram/domain/plan');
const { buildLedgerEvents, accountBalanceFromEvents, KIND_LABELS } = require('../miniprogram/domain/ledger-view');

const useMemoryStorage = () => { global.wx = { getStorageSync: () => null, setStorageSync: () => {}, removeStorageSync: () => {} }; };
const balancesOf = state => accountBalances(state.ledger.transfers, state.ledger.expenses, state.openingBalances, state.ledger.specials, state.ledger.adjusts);
const sweeps = state => state.ledger.transfers.filter(item => item.kind === 'carry_over');

test('余粮口径是纯函数：余额减去剩余天数的计划开销', () => {
  assert.deepEqual(poolSurplus({ poolBalance: 154051, dailyBudget: 4829, asOfDate: '2026-09-27', rangeEnd: '2026-10-22' }),
    { remainingDays: 26, needed: 125554, surplus: 28497 });
  assert.deepEqual(poolSurplus({ poolBalance: 100, dailyBudget: 4829, asOfDate: '2026-09-27', rangeEnd: '2026-09-27' }),
    { remainingDays: 1, needed: 4829, surplus: 0 }, '池子不够时不提示清理');
  assert.throws(() => poolSurplus({ poolBalance: 1.5, dailyBudget: 4829, asOfDate: '2026-09-27', rangeEnd: '2026-10-22' }));
});

test('改情景后的余粮把“情景差额”和“没花完的预算”一起算清，转完只剩本期开销', () => {
  useMemoryStorage();
  store.reset();
  store.executePayday(1, '2026-09-24');
  for (const date of ['2026-09-24', '2026-09-25', '2026-09-26']) {
    store.allocateDay({ date });
    store.addExpense({ date, category: 'meal', amountYuan: 20 });
    store.settleDay({ date });
  }
  store.setScenario('省', '2026-09-27');
  const preview = store.previewPoolSurplus('2026-09-27');
  assert.equal(preview.poolBalance, 154051, '余额宝 = 中情景入池 1600.51 − 已花 60');
  assert.equal(preview.remainingDays, 26);
  assert.equal(preview.remainingNeed, 4829 * 26, '按“省”的情景算剩余开销');
  assert.equal(preview.surplus, 154051 - 4829 * 26, '含改情景多出来的 200.10');

  const before = balancesOf(store.getState());
  const result = store.sweepPoolSurplus({ asOfDate: '2026-09-27' });
  assert.equal(result.swept, preview.surplus, '预览金额 = 实际转走金额');
  assert.equal(result.transfer.from, ACCT.POOL2);
  assert.equal(result.transfer.to, ACCT.POCKET3);
  const after = balancesOf(result.state);
  assert.equal(after.POOL2, before.POOL2 - preview.surplus);
  assert.equal(after.POCKET3, before.POCKET3 + preview.surplus);
  assert.equal(after.POOL2, 4829 * 26, '转完余额宝只剩本期剩余计划开销');
  assert.equal(after.BANK1 + after.POOL2 + after.POCKET3 + after.BILL + after.OUT, 0, '清理只是搬钱，不创造钱');
  assert.equal(store.previewPoolSurplus('2026-09-27').surplus, 0, '再点一次就没有了：天然幂等');
  assert.equal(store.sweepPoolSurplus({ asOfDate: '2026-09-27' }).skipped, true);
  assert.equal(sweeps(store.getState()).length, 1, '不重复写账');
});

test('清理不追溯改计划列，但实际转存与逐笔合计都算上这笔', () => {
  useMemoryStorage();
  store.reset();
  store.executePayday(1, '2026-09-24');
  // 发薪日当天先把一天的账走完：没花完的 35.19 退回余额宝，第二天才有“余粮”可清
  store.allocateDay({ date: '2026-09-24' });
  store.addExpense({ date: '2026-09-24', category: 'meal', amountYuan: 20 });
  assert.equal(store.previewPoolSurplus('2026-09-24').surplus, 0, '当天还没结算，余粮应为 0：宁可不转也不多转');
  store.settleDay({ date: '2026-09-24' });
  store.sweepPoolSurplus({ asOfDate: '2026-09-25' });
  const state = store.getState();
  assert.equal(state.periods[0].saveToPocket, 185517, '计划列仍只按 payday_save 派生，避免一笔钱数两次');
  const swept = sweeps(state)[0];
  assert.equal(swept.kind, 'carry_over');
  assert.equal(swept.date, '2026-09-25', '业务日期就是点确认的那一天');
  assert.equal(swept.amount, 3519, '转走的是 09-24 没花完退回余额宝的钱');
  assert.match(swept.note, /清理余额宝余粮/);
  assert.equal(KIND_LABELS.carry_over, '清理余粮转存');
  ['POOL2', 'POCKET3'].forEach(acct => {
    const events = buildLedgerEvents(state, { account: acct, perspective: acct });
    assert.equal(accountBalanceFromEvents(events, acct, 0), balancesOf(state)[acct], `${acct} 逐笔合计必须等于派生余额`);
  });
  const pocketEvents = buildLedgerEvents(state, { account: ACCT.POCKET3, perspective: ACCT.POCKET3 });
  const carried = pocketEvents.find(item => item.kind === 'carry_over');
  assert.ok(carried, '小荷包流水里能看到这笔清理转存');
  assert.equal(carried.kindLabel, '清理余粮转存');
  assert.equal(carried.typeLabel, '账户划转');
  assert.equal(carried.direction, '划入');
});

test('计划区间外不给清理：截止日后账本只读', () => {
  useMemoryStorage();
  store.reset();
  store.executePayday(1, '2026-09-24');
  assert.equal(store.sweepPoolSurplus({ asOfDate: '2026-09-23' }).blocked, 'not_started');
  assert.equal(store.sweepPoolSurplus({ asOfDate: '2027-02-06' }).blocked, 'ended');
  assert.equal(store.previewPoolSurplus('2027-02-06').blocked, 'ended');
  assert.equal(sweeps(store.getState()).length, 0, '被挡住时一个字都不写');
});

test('余额校准会把差额算进余粮：校准就是“真实余额”的口径', () => {
  useMemoryStorage();
  store.reset();
  store.executePayday(1, '2026-09-24');
  const before = store.previewPoolSurplus('2026-09-24').surplus;
  store.addAdjust({ date: '2026-09-24', acct: ACCT.POOL2, realBalanceYuan: 2000, bookBalanceYuan: 1600.51, note: '池子里其实还有这些' });
  const after = store.previewPoolSurplus('2026-09-24').surplus;
  assert.equal(after - before, 39949, '2000.00 − 1600.51 = 399.49，可清理的余粮同步变多');
  const result = store.sweepPoolSurplus({ asOfDate: '2026-09-24' });
  assert.equal(result.swept, after);
  assert.equal(balancesOf(result.state).POOL2, result.state.periods[0].days * store.getState().config.dailyBudget);
});

test('今天所在的批次已封账就不再为今天预留，期末余粮也能清干净', () => {
  useMemoryStorage();
  store.reset();
  store.executePayday(1, '2026-09-24');
  store.allocateDay({ date: '2026-09-24' });
  store.addExpense({ date: '2026-09-24', category: 'meal', amountYuan: 10 });
  assert.equal(store.previewPoolSurplus('2026-09-24').surplus, 0, '当天未封账：今天的额度还得留在池子里');
  store.settleDay({ date: '2026-09-24' });
  const sameDay = store.previewPoolSurplus('2026-09-24');
  assert.equal(sameDay.remainingDays, 28, '封账后今天不再预留');
  assert.equal(sameDay.surplus, 4519, '没花完的 45.19 立刻可清');
  // 截止日：结完最后一天的账，余额宝里剩多少就都能转走
  store.allocateDay({ date: '2027-02-05' });
  store.addExpense({ date: '2027-02-05', category: 'meal', amountYuan: 5 });
  assert.equal(store.settleDay({ date: '2027-02-05' }).blocked, undefined);
  const final = store.previewPoolSurplus('2027-02-05');
  assert.equal(final.remainingDays, 0);
  assert.equal(final.surplus, final.poolBalance, '期末不再预留任何开销');
  assert.equal(store.sweepPoolSurplus({ asOfDate: '2027-02-05' }).swept, final.surplus);
  assert.equal(store.previewPoolSurplus('2027-02-06').blocked, 'ended', '截止日之后就真的只读了');
});
