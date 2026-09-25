const { createExpense, createExpenseReversal, createTransfer, createSpecial, createSpecialReversal, accountBalances, sum, ACCT } = require('../domain/ledger');
const { yuanToFen } = require('../domain/money');
const { parseDate, dateKey, todayKey } = require('../domain/calendar');
const { CONFIG, periodsForState, periodForDate, poolSurplus, placementFor, SCENARIOS } = require('../domain/plan');
const storage = require('../utils/storage');

let state = null;
const listeners = new Set();
let idSeed = 0;

// Date.now() 在同一毫秒内的连续操作会撞 id，叠加计数器保证流水 id 唯一。
function uid(prefix) { idSeed += 1; return `${prefix}_${Date.now()}_${idSeed}`; }

function getState() { if (!state) state = storage.load(); return state; }
function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
function notify() { listeners.forEach(listener => listener(state)); }

// 写入的唯一出口：先把候选状态落盘，成功之后才替换内存状态并通知页面。
// 持久化失败时内存保持原样 —— 屏幕上看到的账本和存下来的账本永远是同一份，
// 不会再出现「提示已记账、重启小程序这笔账就没了」。页面必须处理 persisted:false 并提示失败。
function commit(next) {
  const previous = state === null ? getState() : state;
  const result = storage.persist(next);
  if (!result.ok) return { state: previous, persisted: false, error: result.error || 'persist-failed' };
  state = next;
  notify();
  return { state, persisted: true };
}

// 期次是派生数据：改情景、执行发薪日之后都必须按“当前情景 + 已执行流水”重算，
// 已执行期次的金额以流水为准，所以重算不会追溯改写历史。目标储蓄额随之跟随真实轨迹。
function refreshPeriods(next) {
  const periods = periodsForState(next);
  const last = periods[periods.length - 1];
  return { ...next, periods, config: { ...next.config, targetSavings: last ? last.pocketAfter : next.config.targetSavings } };
}

function planOperationBlock(current, date) {
  if (date < current.config.startDate) return 'not_started';
  if (date > current.config.deadline) return 'ended';
  return null;
}

// 金额只有一个换算入口：调用方给原始「元」值，由 domain/money.yuanToFen 负责取整，
// 页面不再自己 Math.round(x * 100)，避免 1.005、指数形式在不同入口取整口径不一致。
function toFenOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  try { const fen = yuanToFen(value); return Number.isInteger(fen) ? fen : null; } catch (error) { return null; }
}

// 记账金额必须是正整数分；非法（空、非数字、0、负数、超两位小数的怪值）一律返回 null 由调用方提示。
function amountToFen(value) {
  const fen = toFenOrNull(value);
  return fen !== null && fen > 0 ? fen : null;
}

const chars = text => Array.from(text);
const CATEGORY_NAME_LIMIT = 12;
const CATEGORY_MARK_LIMIT = 2;
const ADJUST_ACCOUNTS = [ACCT.BANK1, ACCT.POOL2, ACCT.POCKET3, ACCT.BILL, ACCT.OUT];
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function addExpense({ date, category, amountYuan, note = '' }) {
  const current = getState();
  const planBlock = planOperationBlock(current, date);
  if (planBlock) return { state: current, persisted: true, blocked: planBlock };
  const amountFen = amountToFen(amountYuan);
  if (amountFen === null) return { state: current, persisted: true, blocked: 'bad_amount' };
  const range = resolveBatchRange(current, date);
  if (batchIsClosed(current, range)) {
    return { state: current, persisted: true, blocked: 'closed' };
  }
  const expense = createExpense({ id: uid('expense'), date, category, amount: amountFen, note });
  const { start, end } = range;
  const beforeSpent = sumExpensesBetween(current.ledger.expenses, start, end);
  const afterSpent = beforeSpent + expense.amount;
  const budget = allocationOf(current, range, current.config.dailyBudget);
  const beforeOver = Math.max(0, beforeSpent - budget);
  const afterOver = Math.max(0, afterSpent - budget);
  const transfers = [...current.ledger.transfers];
  if (afterOver > beforeOver) {
    transfers.push(createTransfer({ id: uid('cover'), date, from: ACCT.POOL2, to: ACCT.BANK1, amount: afterOver - beforeOver, kind: 'overspend_cover' }));
  }
  let daySlots = current.daySlots || {};
  if (!hasAllocationRecord(current, start) && !Number.isInteger((daySlots[start] || {}).plannedBudget)) {
    // 钉阈值的同时把批次身份一起登记下来：阈值、批次范围、日后补划的金额必须是同一个批次，
    // 否则“单日阈值 + 后来的多日批次”会少划一天额度，封账后工资卡凭空短钱（浸泡种子 324692）。
    daySlots = markBatchSlots(daySlots, range, { plannedBudget: budget });
  }
  // coverFen / budgetFen 一并回传：页面要报的是“这一笔真实产生了多少补差”，
  // 自己拿当前情景额度再估一遍，会在改过情景的那天说出没发生过的补差。
  const result = commit({ ...current, daySlots, ledger: { ...current.ledger, expenses: [...current.ledger.expenses, expense], transfers } });
  return { ...result, coverFen: Math.max(0, afterOver - beforeOver), budgetFen: budget };
}

// 三天一结时，一个批次的额度在第 1 天一次性划入，但要到第 3 天才整批结算。
function batchRange(date, mode) {
  if (mode !== 'three-day') return { start: date, end: date };
  const { CONFIG, daysFrom } = require('../domain/plan');
  const groupStart = Math.floor(daysFrom(CONFIG.startDate, date) / 3) * 3;
  const start = parseDate(CONFIG.startDate);
  start.setUTCDate(start.getUTCDate() + groupStart);
  const end = new Date(start.getTime());
  end.setUTCDate(end.getUTCDate() + 2);
  const deadline = parseDate(CONFIG.deadline);
  if (end > deadline) end.setTime(deadline.getTime());
  return { start: dateKey(start), end: dateKey(end) };
}

function sumExpensesBetween(expenses, start, end) {
  return expenses.reduce((total, item) => (item.date >= start && item.date <= end ? total + item.amount : total), 0);
}

// 批次跨几个自然日：三日一批正常是 3 天，最后一个批次可能被计划截止日截短（只剩 1 天也照实算）。
function batchDayCount(range) {
  const { daysFrom } = require('../domain/plan');
  return Math.max(1, daysFrom(range.start, range.end) + 1);
}

// 一个批次的计划额度：每日模式是 1 天额度，三天一结是“批次天数 × 日额度”。
// 用批次天数而不是固定 3 倍，且沿用批次自己记录的模式，不能被当前模式带跑。
function plannedBatchBudget(dailyBudget, mode, range) {
  return mode === 'three-day' ? dailyBudget * batchDayCount(range) : dailyBudget;
}

// 批次实际划入额：优先取批次首日真实存在的 daily_alloc 流水，其次取日槽记录，最后才回落到计划值。
function allocationOf(current, range, fallbackBudget) {
  const { start, end } = range;
  const mode = range.mode || current.mode;
  const allocationTransfer = current.ledger.transfers.find(item => item.date === start && item.kind === 'daily_alloc');
  if (allocationTransfer) return allocationTransfer.amount;
  const slot = (current.daySlots || {})[start];
  if (slot && Number.isInteger(slot.allocated)) return slot.allocated;
  // 批次首日实际没划入时，阈值在“第一笔支出落地那一刻”钉住（plannedBudget），
  // 否则事后改预算情景会把同一批次的补差阈值搬来搬去，越改越补得越多。
  if (slot && Number.isInteger(slot.plannedBudget)) return slot.plannedBudget;
  return plannedBatchBudget(fallbackBudget, mode, { start, end });
}

// 该批次是否已有真实划入依据（流水或日槽），用于决定要不要钉住计划额度。
function hasAllocationRecord(current, rangeStart) {
  const slot = (current.daySlots || {})[rangeStart] || {};
  return current.ledger.transfers.some(item => item.date === rangeStart && item.kind === 'daily_alloc')
    || Number.isInteger(slot.allocated);
}

function shiftDay(date, delta) {
  const d = parseDate(date);
  d.setUTCDate(d.getUTCDate() + delta);
  return dateKey(d);
}

// 一个日子已经归属的批次（没有批次身份时返回 null）。
function slotIdentity(slots, key) {
  const slot = slots[key] || {};
  return slot.batchStart && slot.batchEnd ? { start: slot.batchStart, end: slot.batchEnd, mode: slot.batchMode } : null;
}

// 候选批次必须裁掉“已经归属别的批次”的日子：一天只属于一个批次，
// 否则切换结算模式后再去动历史某天，会把已封账的批次并进新批次，
// 同一笔退款被两套批次口径各算一次 → 余额宝被超退。
function clipBatchRange(slots, grid, date) {
  let start = grid.start;
  let end = grid.end;
  Object.keys(slots).forEach(key => {
    const identity = slotIdentity(slots, key);
    if (!identity) return;
    if (identity.start === grid.start && identity.end === grid.end) return;
    // 日期是 YYYY-MM-DD，按字符串比较即可（千万别用 Math.max，那会算出 NaN）
    if (key < date) {
      if (identity.end >= start && identity.start <= date) { const candidate = shiftDay(identity.end, 1); if (candidate > start) start = candidate; }
    } else if (key > date) {
      if (identity.start <= end && identity.end >= date) { const candidate = shiftDay(identity.start, -1); if (candidate < end) end = candidate; }
    }
  });
  if (start > date) start = date;
  if (end < date) end = date;
  return { start, end };
}

function resolveBatchRange(current, date) {
  const slots = current.daySlots || {};
  const recorded = Object.values(slots).find(slot => slot && slot.batchStart && slot.batchEnd && date >= slot.batchStart && date <= slot.batchEnd);
  if (recorded) return { start: recorded.batchStart, end: recorded.batchEnd, mode: recorded.batchMode || current.mode };
  const grid = batchRange(date, current.mode);
  return { ...clipBatchRange(slots, grid, date), mode: current.mode };
}

function batchIsClosed(current, range) {
  return Object.keys(current.daySlots || {}).some(date => date >= range.start && date <= range.end && current.daySlots[date].closed);
}

function markBatchSlots(daySlots, range, values) {
  const next = { ...daySlots };
  let cursor = parseDate(range.start);
  const end = parseDate(range.end);
  while (cursor <= end) {
    const key = dateKey(cursor);
    const existing = next[key] || {};
    const identity = slotIdentity(next, key);
    // 第二道防线：一天只属于一个批次，已登记的批次身份不会被后来的模式/批次改写
    const conflict = identity && (identity.start !== range.start || identity.end !== range.end);
    if (!conflict) next[key] = { ...existing, ...values, batchStart: range.start, batchEnd: range.end, batchMode: range.mode };
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return next;
}

// 结算的唯一决策口径：settleDay（写入）与 previewSettlement（页面预览）共用，杜绝两套算法。
function settlementPlan(current, date, budget) {
  // 计划区间外没有额度可退，否则会把整日预算凭空退回余额宝。
  const planBlock = planOperationBlock(current, date);
  if (planBlock) return { blocked: planBlock };
  if ((current.daySlots || {})[date] && current.daySlots[date].closed) return { alreadyClosed: true };
  const range = resolveBatchRange(current, date);
  if (!hasAllocationRecord(current, range.start)) return { blocked: 'not_allocated', range, allocationDate: range.start };
  if (range.mode === 'three-day' && date < range.end) {
    return { batchPending: true, range, allocationDate: range.start, settlementDate: range.end };
  }
  // 余额宝已经为该批次补过的超支额，不能再当成“余粮”退回，否则池子会被扣两次；
  // 撤销封账后重复结算时，也要先扣掉本批次已登记的退款（含冲正补退），否则会重复退回余额宝。
  const numbers = batchNumbers(current, range, budget);
  return { range, numbers, allocationDate: range.start, settlementDate: range.end, due: numbers.due };
}

function settleDay({ date, dailyBudget } = {}) {
  const current = getState();
  // 兜底必须用当前情景的每日额度，硬编码 CONFIG.dailyBudget 会在“省 / 松”情景下退错钱。
  const budget = Number.isInteger(dailyBudget) ? dailyBudget : current.config.dailyBudget;
  const plan = settlementPlan(current, date, budget);
  if (plan.blocked) return { state: current, persisted: true, transfer: null, blocked: plan.blocked };
  if (plan.alreadyClosed) return { state: current, persisted: true, transfer: null, alreadyClosed: true };
  if (plan.batchPending) return { state: current, persisted: true, batchPending: true, allocationDate: plan.allocationDate, settlementDate: plan.settlementDate };
  const { range, numbers } = plan;
  const { allocated, refunded: alreadyRefunded, due: amount } = numbers;
  if (!amount) {
    const daySlots = markBatchSlots(current.daySlots, range, { allocated, closed: true, refunded: alreadyRefunded });
    return { ...commit({ ...current, daySlots }), transfer: null, alreadyRefunded, range };
  }
  const transfer = createTransfer({ id: uid('refund'), date, from: ACCT.BANK1, to: ACCT.POOL2, amount, kind: 'daily_refund' });
  const daySlots = markBatchSlots(current.daySlots, range, { allocated, closed: true, refunded: alreadyRefunded + amount });
  return { ...commit({ ...current, daySlots, ledger: { ...current.ledger, transfers: [...current.ledger.transfers, transfer] } }), transfer, alreadyRefunded, range };
}

// 只读预览：页面要告诉用户“结算这天会退多少”，但不能自己再算一套口径。
function previewSettlement(date) {
  const current = getState();
  const plan = settlementPlan(current, date, current.config.dailyBudget);
  if (plan.blocked || plan.alreadyClosed || plan.batchPending) return { date, ...plan };
  const { allocated, spent, covered, refunded, due } = plan.numbers;
  return { date, range: plan.range, allocationDate: plan.allocationDate, settlementDate: plan.settlementDate, allocated, spent, covered, refunded, due };
}

function batchKeyOf(range) { return `${range.start}~${range.end}`; }

// 划转默认按日期落进批次；但“冲正补退”这类划转发生在今天、归属的是历史批次，
// 所以带 batchKey 的记录只认 batchKey，避免被当成当天批次的退款重复核算。
function inBatch(item, range) {
  if (item.batchKey) return item.batchKey === batchKeyOf(range);
  return item.date >= range.start && item.date <= range.end;
}

function sumTransfersInBatch(transfers, range, kind) {
  return transfers.reduce((total, item) => (item.kind === kind && inBatch(item, range) ? total + item.amount : total), 0);
}

// 一个批次的结算口径：额度、实际支出（含冲正的负向金额）、已补差、已退款、应退余额。
function batchNumbers(current, range, budget) {
  const allocated = allocationOf(current, range, budget);
  const spent = sumExpensesBetween(current.ledger.expenses, range.start, range.end);
  const covered = sumTransfersInBatch(current.ledger.transfers, range, 'overspend_cover');
  const refunded = sumTransfersInBatch(current.ledger.transfers, range, 'daily_refund');
  return { allocated, spent, covered, refunded, due: Math.max(0, allocated + covered - spent - refunded) };
}

// 撤销封账必须同时撤销该批次的退款划转，否则重新结算会把同一笔钱退两次。
function reopenDay(date) {
  const current = getState();
  if (!current.daySlots || !current.daySlots[date] || !current.daySlots[date].closed) return { state: current, persisted: true };
  const { start, end } = resolveBatchRange(current, date);
  const range = { start, end };
  const refunded = sumTransfersInBatch(current.ledger.transfers, range, 'daily_refund');
  const transfers = current.ledger.transfers.filter(item => !(item.kind === 'daily_refund' && inBatch(item, range)));
  const daySlots = Object.keys(current.daySlots).reduce((acc, key) => {
    if (key >= start && key <= end) acc[key] = { ...current.daySlots[key], closed: false, reopened: true, refunded: 0 };
    else acc[key] = current.daySlots[key];
    return acc;
  }, {});
  return { ...commit({ ...current, daySlots, ledger: { ...current.ledger, transfers } }), reversedRefund: refunded };
}

function reset() {
  // 重置演示数据同样是破坏性操作：先把当前账本留进可撤销槽位，误点还能救回来。
  const current = getState();
  storage.saveRollback(current);
  // 写不进本机存储就不换内存状态：否则页面显示「已恢复初始数据」，重启又回到旧账本。
  return commit(storage.seed());
}

function batchHasActivity(current, start, end) {
  const range = { start, end };
  const inRange = item => item.date >= start && item.date <= end;
  return current.ledger.expenses.some(inRange)
    || current.ledger.transfers.some(item => ['daily_alloc', 'overspend_cover', 'daily_refund'].includes(item.kind) && inBatch(item, range));
}

function setMode(mode, asOfDate = todayKey()) {
  if (mode !== 'daily' && mode !== 'three-day') throw new TypeError('mode must be daily or three-day');
  const current = getState();
  if (mode === current.mode) return { state: current, persisted: true, unchanged: true };
  // 结算模式决定批次口径，属于计划参数：截止日后账本转为只读，不再允许改模式。
  if (planOperationBlock(current, asOfDate) === 'ended') return { state: current, persisted: true, blocked: 'ended' };
  if (!planOperationBlock(current, asOfDate)) {
    const currentBatch = batchRange(asOfDate, 'three-day');
    if (current.mode === 'three-day') {
      const closed = Object.keys(current.daySlots || {}).some(date => date >= currentBatch.start && date <= currentBatch.end && current.daySlots[date].closed);
      if (batchHasActivity(current, currentBatch.start, currentBatch.end) && !closed) {
        return { state: current, persisted: true, blocked: 'active_batch', settlementDate: currentBatch.end };
      }
    }
    if (mode === 'three-day') {
      const { daysFrom } = require('../domain/plan');
      if (daysFrom(current.config.startDate, asOfDate) % 3 !== 0) {
        return { state: current, persisted: true, blocked: 'batch_boundary' };
      }
      if (batchHasActivity(current, currentBatch.start, currentBatch.end)) {
        return { state: current, persisted: true, blocked: 'active_batch', settlementDate: currentBatch.end };
      }
    }
  }
  return commit({ ...current, mode });
}

// 余额校准是「追加一条真实余额修正」，不参与批次额度核算，因此口径单列：
// - 计划开始之前：允许（期初对账本来就要在开工前录好）；
// - 计划期间：正常校准；
// - 截止日之后：仍然允许，但打上 postPlan 标记，页面明确它是「回顾期校准」。
// 账户、日期、金额非法时拒绝并返回 blocked，不再把异常抛给页面。
function addAdjust({ date, acct, realBalanceYuan, bookBalanceYuan, note = '' }) {
  const current = getState();
  if (!DATE_ONLY_RE.test(String(date || '')) || !ADJUST_ACCOUNTS.includes(acct)) {
    return { state: current, persisted: true, blocked: 'bad_account' };
  }
  const realBalance = toFenOrNull(realBalanceYuan);
  const bookBalance = toFenOrNull(bookBalanceYuan);
  if (realBalance === null || bookBalance === null || realBalance < 0 || bookBalance < 0) {
    return { state: current, persisted: true, blocked: 'bad_amount' };
  }
  const adjust = { id: uid('adjust'), date, acct, realBalance, bookBalance, diff: realBalance - bookBalance, note, createdAt: new Date().toISOString() };
  if (date > current.config.deadline) adjust.postPlan = true;
  return commit({ ...current, ledger: { ...current.ledger, adjusts: [...current.ledger.adjusts, adjust] } });
}

// ---- 发薪日 SOP：两段到账（工资日 / 生活费日）+ 三步划转 + 清理余粮 ----
// 工资日先登记工资，生活费日（一般 28 日）再登记生活费；每一笔到账都按
// 「账单 → 预算池 → 储蓄」安置，所有完成状态由真实流水派生：手点不出勾，也不会出现负数划转。
function periodSweptFen(current, periodIndex) {
  const period = (current.periods || [])[periodIndex - 1];
  if (!period) return 0;
  return sum(current.ledger.transfers, item => item.kind === 'carry_over' && item.date >= period.rangeStart && item.date <= period.rangeEnd);
}

// 六个动作的完成状态：1 工资到账、2 生活费到账、3 还账单、4 入池、5 转存、6 清理余粮。
// 前五项在两笔收入都安置完之后必然全为真；只认流水，不认手勾。
// 3/4/5 步一律用「目标已达成 且 目标本身大于 0」判定，目标取 period.pendingXxx 的同一份口径，
// 所以 done[i] <=> pendingXxx === 0，页面文案（分母也是这个目标）永远不会和勾互相打脸。
function paydayStepStatus(current, periodIndex) {
  const period = (current.periods || [])[periodIndex - 1];
  if (!period) return { done: [false, false, false, false, false, false], transferDone: false, allDone: false, sweptFen: 0, fullyFunded: false };
  const sweptFen = periodSweptFen(current, periodIndex);
  const done = [
    period.salaryReceived,
    period.allowanceReceived,
    period.pendingBill === 0 && period.billTotal > 0,
    period.pendingPool === 0 && period.budgetToPool > 0,
    period.pendingSave === 0 && period.saveToPocket > 0,
    sweptFen > 0
  ];
  return { done, transferDone: done.slice(0, 5).every(Boolean), allDone: done.every(Boolean), sweptFen, fullyFunded: Boolean(period.fullyFunded) };
}

function isPaydayStepDone(current, periodIndex, step) {
  return paydayStepStatus(current, periodIndex).done[Number(step) - 1] === true;
}

// 所有步骤都改为流水派生，手勾会让勾与钱脱钩：统一拒绝，并保留这个入口给页面兜底提示。
function togglePaydayStep(periodIndex, step, asOfDate = todayKey()) {
  const current = getState();
  const planBlock = planOperationBlock(current, asOfDate);
  if (planBlock) return { state: current, persisted: true, blocked: planBlock };
  return { state: current, persisted: true, blocked: 'derived_step', periodIndex: Number(periodIndex), step: Number(step) };
}

// 用户自选安置：{ billYuan, poolYuan, saveYuan } 是页面输入框给的原始「元」值。
// 换算只走 domain/money 一处；三项都必须是非负整数分，合计必须**正好等于**这笔到账金额，
// 且还账单不得超过本期还没还清的部分（账单是外部固定义务，不能多还）。
// 不给 split 就用 placementFor 的推荐值（账单 → 预算池 → 储蓄），旧调用方与测试一律不受影响。
// 校验放在 store 而不是页面：页面只是草稿，钱要落账必须以这里的裁决为准。
function resolveSplit(split, amount, period) {
  if (split === undefined || split === null) return { placements: placementFor(period, amount) };
  const placements = { bill: 0, pool: 0, save: 0 };
  for (const key of ['bill', 'pool', 'save']) {
    const raw = split[`${key}Yuan`];
    if (raw === undefined || raw === null || raw === '') continue;
    const fen = toFenOrNull(raw);
    if (fen === null || fen < 0) return { blocked: 'bad_split' };
    placements[key] = fen;
  }
  const total = placements.bill + placements.pool + placements.save;
  if (total !== amount) return { blocked: 'split_mismatch', splitTotal: total, amount, diff: amount - total };
  const billRoom = Math.max(0, period.billTotal - period.billPlaced);
  if (placements.bill > billRoom) return { blocked: 'bill_over', billRoom };
  return { placements };
}

// 一次到账的安置：先写收入流水，再按「账单 → 预算池 → 储蓄」的顺序写划转。
// 金额恒为正（为 0 的那一项不写流水）；placements 由 resolveSplit 决定，可能是推荐值也可能是用户自选。
// arrivalId 是「这一笔到账」的主键：收入流水带自己的 id，每一笔安置流水（还账单/入池/转存）
// 都记下 arrivalId 指向它。撤销时整组一起删，不会误伤同一天别的手工划转 ——
// 这是唯一能把「这笔到账连同它的安置」精确摘出来的办法，按日期或按 kind 都会误伤。
function placementTransfers(period, index, { kind, amount, date, incomeId, placements, arrivalId }) {
  const income = createTransfer({ id: incomeId, date, from: ACCT.OUT, to: ACCT.BANK1, amount, kind });
  income.periodIndex = index;
  const transfers = [income];
  const attach = item => { item.periodIndex = index; item.arrivalId = arrivalId; };
  if (placements.bill > 0) {
    const item = createTransfer({ id: uid('bill'), date, from: ACCT.BANK1, to: ACCT.BILL, amount: placements.bill, kind: 'bill_repay' });
    attach(item);
    transfers.push(item);
  }
  if (placements.pool > 0) {
    const item = createTransfer({ id: uid('budget'), date, from: ACCT.BANK1, to: ACCT.POOL2, amount: placements.pool, kind: 'payday_budget' });
    attach(item);
    transfers.push(item);
  }
  if (placements.save > 0) {
    const item = createTransfer({ id: uid('save'), date, from: ACCT.BANK1, to: ACCT.POCKET3, amount: placements.save, kind: 'payday_save' });
    attach(item);
    transfers.push(item);
  }
  return { transfers, placements };
}

// 期次越界一律返回 null，由调用方转成 { blocked: 'bad_period' }：
// store 的对外入口统一「返回 blocked，不抛异常」，页面才不需要包 try/catch。
function periodAt(current, periodIndex) {
  const index = Number(periodIndex);
  if (!Number.isInteger(index) || index < 1) return null;
  return (current.periods || [])[index - 1] || null;
}

// YYYY-MM-DD 光看格式挡不住 2026-09-31 这种不存在的日子：往日历里往返一趟，回不来就是假日期。
// 假日期会被 resolveBatchRange 当成一个真实批次，把 daySlots 和结算口径一起带歪。
// 校验通过就返回规范化的 YYYY-MM-DD 字符串，否则返回 null：
// 后面的区间比较一律用这个返回值，避免调用方传进 String 对象之类让比较口径漂移。
function realDateOr(date) {
  const text = String(date === undefined || date === null ? '' : date);
  if (!DATE_ONLY_RE.test(text)) return null;
  try { return dateKey(parseDate(text)) === text ? text : null; } catch (error) { return null; }
}

// 两段登记各自的「纯规划」部分：只判断能不能登记、要写哪几笔流水，绝不落盘。
// 写入入口（registerSalaryDay / registerAllowance）与兼容入口（executePayday）共用同一份规划，
// 这样「同日到账」也能在一次 commit 里原子落地，预览与写入不可能变成两套算法。

// 工资日登记：业务日期固定在发薪日（工资何时到账是确定的），不允许早于发薪日预登记。
function planSalaryDay(current, periodIndex, asOfDate, split) {
  const period = periodAt(current, periodIndex);
  if (!period) return { blocked: 'bad_period' };
  // 计划截止日后账本只读：不得再补登任何一期发薪日。
  if (planOperationBlock(current, asOfDate) === 'ended') return { blocked: 'ended', payDate: period.payDate };
  if (period.salaryReceived) return { alreadyReceived: true, payDate: period.payDate };
  if (period.payDate > asOfDate) return { blocked: 'not_reached', payDate: period.payDate };
  const resolved = resolveSplit(split, period.salary, period);
  if (resolved.blocked) return { blocked: resolved.blocked, payDate: period.payDate, ...resolved };
  const placed = placementTransfers(period, period.index, {
    kind: 'payday_income', amount: period.salary, date: period.payDate,
    incomeId: `pay_in_${period.index}`, placements: resolved.placements, arrivalId: `pay_in_${period.index}`
  });
  return {
    ...placed,
    payDate: period.payDate,
    next: {
      ...current,
      executedPaydays: { ...current.executedPaydays, [period.index]: true },
      ledger: { ...current.ledger, transfers: [...current.ledger.transfers, ...placed.transfers] }
    }
  };
}

// 生活费登记：金额固定 2,000；必须先登记工资（生活费不会早于工资日到），
// 到账日期可选（默认今天，落在本期区间内、且不能晚于今天），到账当天登记后自动补足预算池并转存余额。
function planAllowance(current, periodIndex, { date, asOfDate, split }) {
  const period = periodAt(current, periodIndex);
  if (!period) return { blocked: 'bad_period' };
  const block = planOperationBlock(current, asOfDate);
  if (block) return { blocked: block, payDate: period.payDate };
  const day = realDateOr(date);
  if (!day) return { blocked: 'bad_date', payDate: period.payDate };
  if (period.allowanceReceived) return { alreadyReceived: true, payDate: period.payDate };
  if (!period.salaryReceived) return { blocked: 'salary_pending', payDate: period.payDate };
  if (day < period.payDate || day > period.rangeEnd) {
    return { blocked: 'outside_range', payDate: period.payDate, rangeEnd: period.rangeEnd };
  }
  if (day > asOfDate) return { blocked: 'not_reached', payDate: period.payDate };
  const resolved = resolveSplit(split, CONFIG.monthlyAllowance, period);
  if (resolved.blocked) return { blocked: resolved.blocked, payDate: period.payDate, ...resolved };
  const placed = placementTransfers(period, period.index, {
    kind: 'allowance_income', amount: CONFIG.monthlyAllowance, date: day,
    incomeId: `allow_${period.index}`, placements: resolved.placements, arrivalId: `allow_${period.index}`
  });
  return {
    ...placed,
    payDate: period.payDate,
    allowanceDate: day,
    next: { ...current, ledger: { ...current.ledger, transfers: [...current.ledger.transfers, ...placed.transfers] } }
  };
}

// 工资日登记：写「工资到账 + 还账单 + 入池 +（够的话）转存」，业务日期固定在发薪日。
// split 缺省 = 按推荐安置；给了就以用户填的为准（store 会重新校验合计与账单上限）。
function registerSalaryDay(periodIndex = 1, asOfDate = todayKey(), { split } = {}) {
  const current = getState();
  const plan = planSalaryDay(current, periodIndex, asOfDate, split);
  if (plan.blocked) {
    return { state: current, persisted: true, blocked: plan.blocked, payDate: plan.payDate, splitTotal: plan.splitTotal, amount: plan.amount, diff: plan.diff, billRoom: plan.billRoom };
  }
  if (plan.alreadyReceived) {
    return { state: current, persisted: true, alreadyReceived: true, alreadyExecuted: true, payDate: plan.payDate };
  }
  return { ...commit(refreshPeriods(plan.next)), placements: plan.placements, payDate: plan.payDate, salaryReceived: true };
}

// 生活费日登记：金额固定 2,000，写「生活费到账 + 补池 +（剩余）转存」，业务日期 = 用户选的真实到账日。
function registerAllowance(periodIndex = 1, { date = todayKey(), asOfDate = todayKey(), split } = {}) {
  const current = getState();
  const plan = planAllowance(current, periodIndex, { date, asOfDate, split });
  if (plan.blocked) {
    return { state: current, persisted: true, blocked: plan.blocked, payDate: plan.payDate, rangeEnd: plan.rangeEnd, splitTotal: plan.splitTotal, amount: plan.amount, diff: plan.diff, billRoom: plan.billRoom };
  }
  if (plan.alreadyReceived) return { state: current, persisted: true, alreadyReceived: true, payDate: plan.payDate };
  return {
    ...commit(refreshPeriods(plan.next)), placements: plan.placements,
    payDate: plan.payDate, allowanceDate: plan.allowanceDate, allowanceReceived: true
  };
}

// 兼容入口：工资与生活费同一天到账时的两步合一（旧调用方与浸泡测试仍可用）。
// 已经登记过工资的期次不再走这里：生活费另有专用入口，避免把 28 日的到账写成工资日。
// 两段必须在**同一次 commit** 里落地：早先的实现是「先提交工资、再提交生活费」，
// 第二段写盘失败时会返回 persisted:false，页面弹「本次改动没有保存」——可工资那几笔其实已经存下来了。
function executePayday(periodIndex = 1, asOfDate = todayKey()) {
  const current = getState();
  const salary = planSalaryDay(current, periodIndex, asOfDate, undefined);
  if (salary.blocked) return { state: current, persisted: true, blocked: salary.blocked, payDate: salary.payDate };
  if (salary.alreadyReceived) {
    return { state: current, persisted: true, alreadyReceived: true, alreadyExecuted: true, payDate: salary.payDate };
  }
  // 生活费要按「工资落库之后」的期次口径算缺口，所以先在内存里推演一遍（不落盘）。
  const afterSalary = refreshPeriods(salary.next);
  const allowance = planAllowance(afterSalary, periodIndex, { date: salary.payDate, asOfDate, split: undefined });
  // 账本里已经有本期生活费（例如旧口径遗留）时，只补工资这一段，别把工资也一起拦下。
  if (allowance.alreadyReceived) {
    return { ...commit(afterSalary), placements: salary.placements, payDate: salary.payDate, salaryReceived: true, alreadyExecuted: false };
  }
  if (allowance.blocked) return { state: current, persisted: true, blocked: allowance.blocked, payDate: salary.payDate };
  const next = { ...afterSalary, ledger: { ...afterSalary.ledger, transfers: [...afterSalary.ledger.transfers, ...allowance.transfers] } };
  return {
    ...commit(refreshPeriods(next)), placements: allowance.placements, payDate: salary.payDate,
    salaryReceived: true, allowanceDate: allowance.allowanceDate, allowanceReceived: true, alreadyExecuted: false
  };
}

function addSpecial({ date, reason, amountYuan, note = '' }) {
  const current = getState();
  const planBlock = planOperationBlock(current, date);
  if (planBlock) return { state: current, persisted: true, blocked: planBlock };
  const title = typeof reason === 'string' ? reason.trim() : '';
  if (!title) return { state: current, persisted: true, blocked: 'bad_reason' };
  const amountFen = amountToFen(amountYuan);
  if (amountFen === null) return { state: current, persisted: true, blocked: 'bad_amount' };
  const special = createSpecial({ id: uid('special'), date, reason: title, amount: amountFen, note });
  return commit({ ...current, ledger: { ...current.ledger, specials: [...(current.ledger.specials || []), special] } });
}

// 预算情景是“从今往后按多少花”的决定：
// 已执行期次的四笔划转以流水为准（不会因切换情景而追溯改动），未执行期次按新日额度重算。
function setScenario(scenario, asOfDate = todayKey()) {
  if (!Object.prototype.hasOwnProperty.call(SCENARIOS, scenario)) throw new TypeError('unknown scenario');
  const current = getState();
  // 计划截止日后账本进入只读回顾态，情景属于计划参数，同样不许再改（否则会重写历史期次口径）。
  if (planOperationBlock(current, asOfDate) === 'ended') return { state: current, persisted: true, blocked: 'ended' };
  if (scenario === current.config.scenario) {
    return { state: current, persisted: true, unchanged: true, frozen: [], replanned: [] };
  }
  const dailyBudget = SCENARIOS[scenario];
  const next = refreshPeriods({ ...current, config: { ...current.config, dailyBudget, scenario } });
  // 锁定 = 两笔收入都到齐、口径已落成流水；只登记了工资的期次，未安置部分仍按新情景重算。
  const frozen = next.periods.filter(item => item.fullyFunded).map(item => item.index);
  const replanned = next.periods.filter(item => !item.fullyFunded).map(item => item.index);
  return { ...commit(next), scenario, dailyBudget, frozen, replanned };
}

// 划额：一个批次只划一次，金额 = 批次天数 × 当前情景日额度。
// 三天一结时若首日漏点，批次内后面任意一天都能“补划”：流水仍落在批次首日（业务日期），
// createdAt 记录真实操作时刻。否则该批次永远划不进钱、settleDay 卡在 not_allocated 封不了账。
// 划额的唯一决策口径：allocateDay（写入）与 previewAllocation（页面预览）共用。
// 一个批次只划一次；批次首日漏划时允许在本批任意一天补划，流水仍落在批次首日。
function allocationPlan(current, date) {
  const planBlock = planOperationBlock(current, date);
  if (planBlock) return { blocked: planBlock };
  const range = resolveBatchRange(current, date);
  // 已封账说明本批次已经结算清楚，再点一次会把额度重复划进工资卡。
  if (batchIsClosed(current, range)) return { blocked: 'closed', range };
  if (current.ledger.transfers.some(item => item.date === range.start && item.kind === 'daily_alloc')) {
    return { alreadyAllocated: true, range, allocationDate: range.start };
  }
  // 补划金额必须沿用该批次已经钉住的额度（plannedBudget）：那几天的超支补差就是按它算的。
  // 若改用“今天的情景额度”，就会出现「按 ¥63.73 补了差、只划进 ¥55.19」的窟窿，
  // 封账时工资卡凭空短钱（浸泡测试实测 −8.54）。allocationOf 的取值顺序天然满足这一点。
  const pinned = allocationOf(current, range, current.config.dailyBudget);
  return {
    range,
    amount: pinned,
    allocationDate: range.start,
    spanDays: batchDayCount(range),
    catchUp: range.start !== date,
    fromPinnedBudget: Number.isInteger(((current.daySlots || {})[range.start] || {}).plannedBudget)
  };
}

function allocateDay({ date }) {
  const current = getState();
  const plan = allocationPlan(current, date);
  if (plan.blocked) return { state: current, persisted: true, blocked: plan.blocked };
  if (plan.alreadyAllocated) return { state: current, persisted: true, alreadyAllocated: true, allocationDate: plan.allocationDate };
  const transfer = createTransfer({ id: uid('alloc'), date: plan.allocationDate, from: ACCT.POOL2, to: ACCT.BANK1, amount: plan.amount, kind: 'daily_alloc' });
  // 日槽按整批登记：批次首日拿 allocated，其余各天至少记住自己属于哪个批次（含 batchMode）。
  const daySlots = markBatchSlots(current.daySlots, plan.range, { allocated: plan.amount });
  return {
    ...commit({ ...current, daySlots, ledger: { ...current.ledger, transfers: [...current.ledger.transfers, transfer] } }),
    transfer, allocationDate: plan.allocationDate, spanDays: plan.spanDays, catchUp: plan.catchUp, range: plan.range
  };
}

// 只读预览：某天要不要补划、补多少、落在哪一天。
function previewAllocation(date) { return { date, ...allocationPlan(getState(), date) }; }

// ---- 冲正（追加式更正）：支出与专项共用一套 planner ----
// 原记录一个字都不改，只追加一条负向记录，落在**原始记录的日期**上，
// 因此它永远和原单属于同一个批次（即便之后切换了结算模式）。
// 批次未封账时不需要任何补退，结算会按修正后的净支出重算补差与退款；
// 批次已封账时，把该批次“应退 − 已退”的差额作为一笔 daily_refund 补退给余额宝。
function reversibleInfo(current, source, id) {
  const list = (current.ledger || {})[source] || [];
  const original = list.find(item => item.id === id);
  if (!original) return { blocked: 'not_found' };
  // 冲正记录本身不能再被冲正；负向金额一律视为冲正记录。
  if (original.reversalOf || original.amount < 0) return { blocked: 'is_reversal' };
  const reversedFen = list.reduce((total, item) => (item.reversalOf === original.id ? total + Math.abs(item.amount) : total), 0);
  const remainingFen = original.amount - reversedFen;
  if (remainingFen <= 0) return { blocked: 'already_reversed' };
  return { original, reversedFen, remainingFen };
}

// 纯函数：只算不改状态，preview 与写入共用同一份算法，杜绝两套口径。
function planReversal(current, entry, asOfDate) {
  const source = entry.source === 'specials' ? 'specials' : 'expenses';
  const info = reversibleInfo(current, source, entry.id);
  if (info.blocked) return { blocked: info.blocked, source };
  const { original, reversedFen, remainingFen } = info;
  // 部分冲正的金额：amountFen（整数分，内部调用）或 amountYuan（原始字符串，页面输入）二选一，
  // 换算只走 domain/money 一处；两者都没给就是整笔冲正。
  const hasFen = entry.amountFen !== undefined && entry.amountFen !== null;
  const hasYuan = entry.amountYuan !== undefined && entry.amountYuan !== null && entry.amountYuan !== '';
  let portion = remainingFen;
  if (hasFen || hasYuan) {
    const parsed = hasFen ? entry.amountFen : toFenOrNull(entry.amountYuan);
    portion = Number.isInteger(parsed) ? parsed : NaN;
  }
  if (!Number.isInteger(portion) || portion <= 0 || portion > remainingFen) {
    return { blocked: 'bad_amount', source, remainingFen, reversedFen };
  }
  const dayBlock = planOperationBlock(current, asOfDate);
  if (dayBlock) return { blocked: dayBlock, source, remainingFen, reversedFen };
  const note = `${original.note ? `原备注：${original.note}` : ''}`;

  if (source === 'specials') {
    const reversal = createSpecialReversal({
      id: uid('special_reversal'), date: original.date, reason: original.reason, amount: portion,
      reversalOf: original.id, from: original.from || ACCT.POCKET3,
      note: `冲正 ${original.id}${note ? `（${note.replace('原备注：', '原备注：')}）` : ''}`
    });
    return {
      state: { ...current, ledger: { ...current.ledger, specials: [...(current.ledger.specials || []), reversal] } },
      reversal, trueUp: null, range: null, batchClosed: false, portionFen: portion, remainingFen: remainingFen - portion
    };
  }

  const range = resolveBatchRange(current, original.date);
  const numbers = batchNumbers(current, range, current.config.dailyBudget);
  const batchClosed = batchIsClosed(current, range);
  // 冲正后该批次“应退”比“已退”多出的部分，就是今天必须真实转回余额宝的钱。
  const dueAfterReversal = Math.max(0, numbers.allocated + numbers.covered - (numbers.spent - portion) - numbers.refunded);
  const trueUpFen = batchClosed ? dueAfterReversal : 0;
  const reversal = createExpenseReversal({
    id: uid('reversal'), date: original.date, category: original.category, amount: portion,
    reversalOf: original.id, account: original.account || ACCT.BANK1,
    note: `冲正 ${original.id}${note ? `（${note}）` : ''}`
  });
  let next = { ...current, ledger: { ...current.ledger, expenses: [...current.ledger.expenses, reversal] } };
  let trueUp = null;
  if (trueUpFen > 0) {
    trueUp = createTransfer({ id: uid('trueup'), date: asOfDate, from: ACCT.BANK1, to: ACCT.POOL2, amount: trueUpFen, kind: 'daily_refund' });
    trueUp.batchKey = batchKeyOf(range);
    // kind 仍是 daily_refund，结算核算才会把它算进“已退”；trueUp 只用于展示时区分文案。
    trueUp.trueUp = true;
    trueUp.note = `冲正补退 · 批次 ${range.start} → ${range.end}`;
    // range 自带批次当初记录的 batchMode，不能拿当前模式覆盖：
    // 否则“三日批次 → 切每日 → 冲正旧批次 → 撤销封账”会让整个三日批次在首日提前退款。
    next = {
      ...next,
      daySlots: markBatchSlots(next.daySlots, range, { allocated: numbers.allocated, closed: true, refunded: numbers.refunded + trueUpFen }),
      ledger: { ...next.ledger, transfers: [...next.ledger.transfers, trueUp] }
    };
  }
  return { state: next, reversal, trueUp, range, batchClosed, portionFen: portion, reversedFen: reversedFen + portion, remainingFen: remainingFen - portion, numbers };
}

// entries: [{ source: 'expenses' | 'specials', id, amountFen? }]；原子写入，任一条不成立就整体不落地。
function reverseEntries({ entries = [], asOfDate = todayKey() } = {}) {
  const current = getState();
  return runReversals(current, entries, asOfDate, { commitResult: true });
}

function runReversals(current, entries, asOfDate, { commitResult }) {
  let working = current;
  const plans = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = typeof entries[index] === 'string' ? { source: 'expenses', id: entries[index] } : entries[index];
    const planned = planReversal(working, entry, asOfDate);
    if (planned.blocked) {
      return { state: current, persisted: true, blocked: planned.blocked, failedIndex: index, failedId: entry.id, remainingFen: planned.remainingFen };
    }
    working = planned.state;
    plans.push(planned);
  }
  const summary = {
    count: plans.length,
    amountFen: plans.reduce((total, item) => total + item.portionFen, 0),
    trueUpFen: plans.reduce((total, item) => total + (item.trueUp ? item.trueUp.amount : 0), 0),
    trueUpCount: plans.filter(item => item.trueUp).length,
    closedCount: plans.filter(item => item.batchClosed).length
  };
  if (!commitResult) return { blocked: null, plans, summary };
  return {
    ...commit(working),
    plans,
    reversals: plans.map(item => item.reversal),
    trueUps: plans.filter(item => item.trueUp).map(item => item.trueUp),
    summary
  };
}

// 冲正前先算清楚会连带发生什么，让页面在确认弹窗里把金额写明白。
function previewReversal(entries, asOfDate = todayKey()) {
  const list = typeof entries === 'string' ? [{ source: 'expenses', id: entries }]
    : (Array.isArray(entries) ? entries.map(entry => (typeof entry === 'string' ? { source: 'expenses', id: entry } : entry)) : [entries]);
  return runReversals(getState(), list, asOfDate, { commitResult: false });
}

function singleResult(result, source) {
  if (result.blocked) return result;
  const plan = result.plans[0];
  return {
    ...result, reversal: plan.reversal, trueUp: plan.trueUp, range: plan.range,
    batchClosed: plan.batchClosed, amountFen: plan.portionFen,
    reversedFen: plan.reversedFen, remainingFen: plan.remainingFen, source
  };
}

// 不传 amountYuan 就整笔冲正；传了就只冲这一部分（累计不得超过原始金额）。
// 不传 amountYuan 就整笔冲正；传了就只冲这一部分（累计不得超过原始金额）。
// 页面把键盘里的原始字符串直接交进来，换算统一由领域层负责。
function reverseExpense({ id, amountYuan, asOfDate = todayKey() } = {}) {
  return singleResult(reverseEntries({ entries: [{ source: 'expenses', id, amountYuan }], asOfDate }), 'expenses');
}

function reverseSpecial({ id, amountYuan, asOfDate = todayKey() } = {}) {
  return singleResult(reverseEntries({ entries: [{ source: 'specials', id, amountYuan }], asOfDate }), 'specials');
}

// ---- 备份与恢复：换机不再靠手动重录 ----
function backupMeta() {
  const meta = storage.readMeta();
  return { lastBackupAt: meta.lastBackupAt || '', lastRestoreAt: meta.lastRestoreAt || '', canUndoRestore: Boolean(storage.readRollback()) };
}

function markBackedUp() {
  storage.writeMeta({ lastBackupAt: new Date().toISOString() });
  return backupMeta();
}

// 恢复是整体替换：先把当前账本存进可撤销槽位，再写入新账本。
// commit 是「先落盘、后换内存」的，所以任何一步写不进去，内存和磁盘都还是原账本，绝不留半套状态。
function restoreFromBackup(nextState) {
  const current = getState();
  if (!storage.saveRollback(current).ok) return { ok: false, error: 'rollback-failed' };
  const result = commit(storage.migrate(nextState));
  if (!result.persisted) return { ok: false, error: 'persist-failed', state: getState() };
  storage.writeMeta({ lastRestoreAt: new Date().toISOString() });
  return { ok: true, state: result.state, meta: backupMeta() };
}

function undoRestore() {
  const slot = storage.readRollback();
  if (!slot) return { ok: false, error: 'no-rollback' };
  const result = commit(slot.state);
  if (!result.persisted) return { ok: false, error: 'persist-failed' };
  storage.clearRollback();
  storage.writeMeta({ lastRestoreAt: '' });
  return { ok: true, state: result.state, meta: backupMeta() };
}

// ---- 回退已登记的到账 ----
// 「昨天手滑按错了」是真实需求。两段到账一次写 2~5 笔流水（收入 + 安置），
// 而安置分账单 / 预算池 / 小荷包三个方向，用「冲正」一条条补是补不回来的（冲正只覆盖支出与专项）。
// 所以这里做整组逻辑删除：撤销之后账本恢复到登记前那个状态，不会留下半截流水。
//
// 整组的身份靠 arrivalId：收入流水用自己的 id，每一笔安置流水都记下 arrivalId 指向它。
// 按日期或按 kind 去猜都会误伤同一天别的手工划转（「用推荐分配」时账单/入池的上下游和手工操作长得一模一样）。
const ARRIVAL_KINDS = Object.freeze(['bill_repay', 'payday_budget', 'payday_save']);

// 一笔安置流水属不属于这个收入流水：
//   ① 新流水直接认 arrivalId；
//   ② 老流水（arrivalId 是后加的字段，之前登记的都没有）按事实认 —— 同一期次、
//      同一 createdAt（登记是同一毫秒内一批写完的）、同一天、账户流向正好是该 kind 的方向。
// 只按日期或只看 kind 会误伤当天别的手工划转，这几条一起卡才准。
const PLACEMENT_FLOW = Object.freeze({
  bill_repay: { from: 'BANK1', to: 'BILL' },
  payday_budget: { from: 'BANK1', to: 'POOL2' },
  payday_save: { from: 'BANK1', to: 'POCKET3' }
});

function belongsToArrival(item, arrival) {
  if (item.id === arrival.id) return true;
  if (item.arrivalId) return item.arrivalId === arrival.id;
  const flow = PLACEMENT_FLOW[item.kind];
  if (!flow) return false;
  return item.periodIndex === arrival.periodIndex
    && item.date === arrival.date
    && item.createdAt === arrival.createdAt
    && item.from === flow.from && item.to === flow.to;
}

function arrivalGroup(state, arrivalId) {
  if (!arrivalId) return null;
  const all = state.ledger.transfers || [];
  const arrival = all.find(item => item.id === arrivalId);
  if (!arrival) return null;
  const members = all.filter(item => belongsToArrival(item, arrival));
  const dates = members.map(item => item.date).sort();
  return { arrivalId, kind: arrival.kind, periodIndex: arrival.periodIndex, amount: arrival.amount, start: dates[0], end: dates[dates.length - 1], members };
}

// 某一期「最后一笔到账」：生活费登记了就撤生活费，否则撤工资。
function latestArrivalId(period) {
  if (period.allowanceReceived) return `allow_${period.index}`;
  if (period.salaryReceived) return `pay_in_${period.index}`;
  return null;
}

// 撤销前的检查。硬阻断只留「会把账做坏」的两种，其余一律降级成 warning 如实告诉用户：
// 划额 / 封账 / 清理余粮 / 已记支出这些**已经消费了这笔钱**的记录，撤销后并不会把复式账做坏
// （账本合计照样为 0，只是余额宝或工资卡会显示负数），重新登记这笔到账就补齐了。
// 早先把它们当硬阻断是过度保守：用户昨天按错了、今天已经划过额，就再也退不回去了。
function arrivalCheck(current, arrivalId, asOfDate = todayKey()) {
  const group = arrivalGroup(current, arrivalId);
  if (!group) return { blocked: 'not_found' };
  const { members, start, end } = group;
  const memberIds = new Set(members.map(item => item.id));
  const others = (current.ledger.transfers || []).filter(item => !memberIds.has(item.id));

  // 硬阻断①：收入流水还留着，安置流水却已经被删过（半截状态）——再删一次只会更乱。
  // 正常账本不会出现（撤销是整组删的），但用户可能手工改过备份再恢复。
  if (others.some(item => ARRIVAL_KINDS.includes(item.kind) && item.originMissing)) {
    return { blocked: 'broken_group' };
  }
  // 硬阻断②：计划已结束，账本只读。
  if (planOperationBlock(current, asOfDate) === 'ended') return { blocked: 'ended' };

  const warnings = [];
  if (others.some(item => item.kind === 'daily_alloc' && item.date >= start)) warnings.push('allocated');
  if (Object.keys(current.daySlots || {}).some(date => {
    const slot = current.daySlots[date] || {};
    return slot.closed && date >= start && date <= end;
  })) warnings.push('sealed');
  if (others.some(item => item.kind === 'carry_over' && item.date >= start)) warnings.push('swept');
  if ((current.ledger.expenses || []).some(item => item.date >= start && item.date <= end)) warnings.push('spent');

  return { group, warnings };
}

// 页面预览：够不够格回退、回退后会变成什么样、有哪些后果要说清，都在这一个入口里算，
// 页面不自己判断（页面的按钮只是因为 disabled 而点不动，不是裁决者）。
function previewArrivalUndo(periodIndex, asOfDate = todayKey()) {
  const current = getState();
  const period = (current.periods || [])[Number(periodIndex) - 1];
  if (!period) return { blocked: 'bad_period' };
  // 旧版合并入账：一笔写死工资+账单+池+转存，根本没有独立的到账组可以摘，
  // 撤销入口只能空着 —— 早点说清楚，别让用户以为是页面坏了。
  if (period.legacyMerged) return { blocked: 'legacy_merged', periodIndex: period.index, payDate: period.payDate };
  const arrivalId = latestArrivalId(period);
  if (!arrivalId) return { blocked: 'nothing_to_undo', periodIndex: period.index };
  const checked = arrivalCheck(current, arrivalId, asOfDate);
  if (checked.blocked) return { blocked: checked.blocked, periodIndex: period.index };
  const group = checked.group;
  return {
    periodIndex: period.index,
    arrivalId: group.arrivalId,
    kind: group.kind,
    date: group.start,
    amount: group.amount,
    placements: group.members.filter(item => item.id !== group.arrivalId)
      .map(item => ({ id: item.id, kind: item.kind, amount: item.amount })),
    canUndo: true,
    warnings: checked.warnings
  };
}

function undoArrival(periodIndex, asOfDate = todayKey()) {
  const current = getState();
  const period = (current.periods || [])[Number(periodIndex) - 1];
  if (!period) return { state: current, persisted: true, blocked: 'bad_period' };
  if (period.legacyMerged) return { state: current, persisted: true, blocked: 'legacy_merged', periodIndex: period.index };
  const arrivalId = latestArrivalId(period);
  if (!arrivalId) return { state: current, persisted: true, blocked: 'nothing_to_undo' };
  const checked = arrivalCheck(current, arrivalId, asOfDate);
  if (checked.blocked) return { state: current, persisted: true, blocked: checked.blocked, periodIndex: period.index };
  const memberIds = new Set(checked.group.members.map(item => item.id));
  const executedPaydays = { ...current.executedPaydays };
  // 工资那笔被撤了就等于这期没执行过；只撤生活费时 executedPaydays 不该动。
  if (checked.group.kind === 'payday_income') delete executedPaydays[period.index];
  const next = {
    ...current,
    executedPaydays,
    ledger: { ...current.ledger, transfers: current.ledger.transfers.filter(item => !memberIds.has(item.id)) }
  };
  return {
    ...commit(refreshPeriods(next)),
    arrivalId, periodIndex: period.index, kind: checked.group.kind,
    removed: checked.group.members.length, removedFen: checked.group.amount
  };
}

// ---- 第六步「清理上期结余」：余额宝里用不完的余粮真实转进小荷包 ----
// surplusPlan 同时服务页面显示与实际写入：看到的金额和转走的金额不可能变成两套算法。
function surplusPlan(current, asOfDate) {
  const planBlock = planOperationBlock(current, asOfDate);
  if (planBlock) return { blocked: planBlock };
  const period = periodForDate(asOfDate, current.periods);
  if (!period) return { blocked: 'outside_period' };
  const balances = accountBalances(current.ledger.transfers, current.ledger.expenses, current.openingBalances, current.ledger.specials, current.ledger.adjusts);
  // 生活费还没登记时，预算池还差 allowancePlan.pool 才满，而这笔钱到账时一定会补进来：
  // 它不该占着「现在必须留在池子里」的名额，否则上一期的真实余粮会被这道缺口吞掉，
  // 第六步在工资日永远清不出钱（第 1、2 期的缺口分别是 ¥144.83 / ¥647.88）。
  const pendingPool = period.allowancePlan ? period.allowancePlan.pool : 0;
  const { remainingDays, needed, reserve, surplus } = poolSurplus({
    poolBalance: balances[ACCT.POOL2], dailyBudget: current.config.dailyBudget, asOfDate, rangeEnd: period.rangeEnd,
    daySettled: Boolean(((current.daySlots || {})[asOfDate] || {}).closed), pendingPool
  });
  return {
    periodIndex: period.index, rangeStart: period.rangeStart, rangeEnd: period.rangeEnd, deadline: current.config.deadline,
    poolBalance: balances[ACCT.POOL2], pocketBalance: balances[ACCT.POCKET3], remainingDays, remainingNeed: needed,
    pendingPool, reserve, surplus
  };
}

function previewPoolSurplus(date = todayKey()) { return { date, ...surplusPlan(getState(), date) }; }

// 跨账户搬真钱：页面必须先确认再调用。清理后余额宝只剩“剩余天数的计划开销”，
// 再点一次只会算出 0（skipped），天然幂等，不需要额外的“已清理”标记。
function sweepPoolSurplus({ asOfDate = todayKey(), amountFen } = {}) {
  const current = getState();
  const plan = surplusPlan(current, asOfDate);
  if (plan.blocked) return { state: current, persisted: true, blocked: plan.blocked };
  const amount = Number.isInteger(amountFen) && amountFen > 0 ? Math.min(amountFen, plan.surplus) : plan.surplus;
  if (!amount) return { state: current, persisted: true, skipped: true, surplus: 0, poolBalance: plan.poolBalance };
  const transfer = createTransfer({ id: uid('sweep'), date: asOfDate, from: ACCT.POOL2, to: ACCT.POCKET3, amount, kind: 'carry_over' });
  transfer.note = `清理余额宝余粮 → 小荷包（第 ${plan.periodIndex} 期剩余 ${plan.remainingDays} 天计划开销之外的钱）`;
  return {
    ...commit({ ...current, ledger: { ...current.ledger, transfers: [...current.ledger.transfers, transfer] } }),
    transfer, swept: amount, periodIndex: plan.periodIndex
  };
}

function newCategoryId() { return uid('category'); }

function addCategory({ id, name, mark }) {
  const current = getState();
  const title = typeof name === 'string' ? name.trim() : '';
  const letters = chars(title);
  const symbol = (typeof mark === 'string' ? mark.trim() : '') || letters.slice(0, 1).join('');
  if (!id || !title || letters.length > CATEGORY_NAME_LIMIT || chars(symbol).length > CATEGORY_MARK_LIMIT) {
    return { state: current, persisted: true, blocked: 'invalid' };
  }
  if (current.categories.some(item => item.id === id)) return { state: current, persisted: true, blocked: 'duplicate' };
  // 同名分类会在筛选、统计和导出里被误当成同一类：去重按 trim 后的名称，而不只是按 id。
  if (current.categories.some(item => String(item.name).trim() === title)) return { state: current, persisted: true, blocked: 'duplicate_name' };
  return commit({ ...current, categories: [...current.categories, { id, name: title, mark: symbol, custom: true }] });
}

function removeCategory(id) {
  const current = getState();
  if (current.ledger.expenses.some(item => item.category === id)) return { state: current, persisted: true, blocked: 'used' };
  return commit({ ...current, categories: current.categories.filter(item => item.id !== id) });
}

module.exports = { getState, newCategoryId, subscribe, previewArrivalUndo, undoArrival, addExpense, registerSalaryDay, registerAllowance, previewAllocation, previewSettlement, previewPoolSurplus, sweepPoolSurplus, reverseExpense, reverseSpecial, reverseEntries, previewReversal, settleDay, reopenDay, togglePaydayStep, isPaydayStepDone, paydayStepStatus, periodSweptFen, executePayday, addSpecial, setMode, setScenario, allocateDay, addCategory, removeCategory, addAdjust, reset, backupMeta, markBackedUp, restoreFromBackup, undoRestore };
