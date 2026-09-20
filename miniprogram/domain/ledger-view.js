// 统一流水视图层：把 expenses / transfers / specials / adjusts 四类记录投影成同一种「账务事件」。
// 这一层只负责展示、筛选、排序和聚合；账户余额仍然由 domain/ledger.accountBalances 派生，
// 任何写账逻辑都不能改用这里的输出。
const { ACCT } = require('./ledger');
const { formatFen } = require('./money');

const TYPE_LABELS = Object.freeze({
  expense: '支出', transfer: '账户划转', special: '专项支出', adjust: '余额校准'
});

const KIND_LABELS = Object.freeze({
  payday_income: '工资到账',
  bill_repay: '还账单',
  payday_budget: '预算入余额宝',
  payday_save: '转入小荷包',
  daily_alloc: '日额度划入',
  overspend_cover: '超支补差',
  daily_refund: '日结退款'
});

const ACCOUNT_LABELS = Object.freeze({
  [ACCT.BANK1]: '工资卡',
  [ACCT.POOL2]: '余额宝',
  [ACCT.POCKET3]: '小荷包',
  [ACCT.BILL]: '账单',
  [ACCT.OUT]: '支出'
});

// 发薪日四步在同一毫秒批量落库，createdAt 分不出先后；这里按 SOP 顺序（到账→还款→入池→转存）展示，
// 其余流水仍按 id 倒序兜底，保证顺序稳定可复现。
const KIND_SEQUENCE = Object.freeze({ payday_income: 1, bill_repay: 2, payday_budget: 3, payday_save: 4 });

function pad(value) { return String(value).padStart(2, '0'); }

// createdAt 存的是 UTC ISO 串，展示必须换成本地墙钟时间，否则 UTC+8 会整整差 8 小时。
function formatCreatedAt(iso) {
  if (typeof iso !== 'string' || !iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// OUT 账户既是「支出归集」也是「计划外资金来源」：作为来源时显示「外部」，作为去向时显示「支出」。
function accountLabel(acct, role = 'to') {
  if (!acct) return '';
  if (acct === ACCT.OUT && role === 'from') return '外部';
  return ACCOUNT_LABELS[acct] || acct;
}

function accountName(acct) { return acct ? (ACCOUNT_LABELS[acct] || acct) : ''; }

// 某笔事件对某个账户的净影响（分）。带符号累加，与 accountBalances 的记账方向完全一致，
// 因此负向的冲正记录会把钱加回来。
function eventEffectOn(event, account) {
  if (!account || !event) return 0;
  if (event.type === 'adjust') return event.account === account ? event.amountFen : 0;
  let effect = 0;
  if (event.from === account) effect -= event.amountFen;
  if (event.to === account) effect += event.amountFen;
  return effect;
}

// 逐笔合计应等于派生余额：储蓄页用它自检「余额由哪些流水组成」。
function accountBalanceFromEvents(events, account, opening = 0) {
  return (events || []).reduce((total, event) => total + eventEffectOn(event, account), opening);
}

function touchesAccount(event, account) {
  if (!account) return true;
  if (event.type === 'adjust') return event.account === account;
  return event.from === account || event.to === account || event.account === account;
}

function compareEvents(a, b) {
  if (a.eventDate !== b.eventDate) return a.eventDate < b.eventDate ? 1 : -1;
  const left = a.createdAtText || '';
  const right = b.createdAtText || '';
  if (left !== right) return left < right ? 1 : -1; // 缺创建时间的排在同日最后，不伪造时间
  if (a.sequence && b.sequence && a.sequence !== b.sequence) return a.sequence - b.sequence;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

function finalize(event, perspective) {
  const amountAbs = Math.abs(event.amountFen);
  const exactTime = Boolean(event.createdAtText);
  const reversal = Boolean(event.reversalOf);
  let signedFen;
  if (reversal) signedFen = amountAbs;                       // 冲正是把钱加回来
  else if (event.type === 'expense' || event.type === 'special') signedFen = -amountAbs;
  else if (event.type === 'adjust') signedFen = event.amountFen;
  else signedFen = perspective ? eventEffectOn(event, perspective) : 0;
  const sign = signedFen > 0 ? '+' : signedFen < 0 ? '−' : '';
  // 冲正行的钱是“退回来”，方向按资金实际流向显示；记账字段 from/to 仍保持原始方向，供余额复算。
  const flow = event.type === 'adjust'
    ? accountName(event.account)
    : event.reversalOf
      ? `${accountLabel(event.to, 'to')} → ${accountLabel(event.from, 'from')}`
      : `${accountLabel(event.from, 'from')} → ${accountLabel(event.to, 'to')}`;
  const direction = reversal ? '冲正'
    : event.type === 'transfer' ? '划入'
    : event.type === 'adjust' ? (event.amountFen >= 0 ? '调增' : '调减')
    : event.type === 'special' ? '专项' : '支出';
  const next = {
    ...event,
    reversal,
    exactTime,
    typeLabel: reversal ? (event.type === 'special' ? '专项冲正' : '支出冲正') : TYPE_LABELS[event.type],
    kindLabel: reversal ? (event.type === 'special' ? '专项冲正' : '支出冲正')
      : event.type === 'transfer' ? (KIND_LABELS[event.kind] || event.kind || '账户划转') : TYPE_LABELS[event.type],
    flowText: flow,
    direction,
    signedFen,
    amountText: `${sign ? `${sign} ` : ''}¥${formatFen(amountAbs)}`,
    // 支出/专项按绝对值导出，校准与负向冲正按带符号值导出，便于在 Excel 里逐笔重算余额。
    plainAmountText: formatFen(event.type === 'adjust' || event.amountFen < 0 ? event.amountFen : amountAbs),
    timeText: exactTime ? event.createdAtText : '时间未记录',
    timeShort: exactTime ? event.createdAtText.slice(5, 16) : '时间未记录'
  };
  const haystack = [next.id, next.title, next.subtitle, next.note, next.kind, next.batchKey, next.reversalOf,
    next.typeLabel, next.kindLabel,
    accountLabel(next.from, 'from'), accountLabel(next.to, 'to'), accountName(next.account), next.categoryId, next.eventDate, next.plainAmountText]
    .filter(Boolean).join(' ').toLowerCase();
  return { ...next, searchText: haystack };
}

// state -> 统一事件列表（已按 eventDate、createdAt、id 倒序）
// options: { startDate, endDate, types: string[], account, keyword, perspective }
function buildLedgerEvents(state, options = {}) {
  const { startDate, endDate, types, account, keyword, perspective, hideReversals } = options;
  const ledger = (state && state.ledger) || {};
  // 先累计每条原始记录“已被冲正多少”，视图层才能把误记和它的冲正配成一对，并算出还能不能再冲。
  const reversedFen = { expenses: new Map(), specials: new Map() };
  ['expenses', 'specials'].forEach(source => {
    (ledger[source] || []).forEach(item => {
      if (!item.reversalOf) return;
      const map = reversedFen[source];
      map.set(item.reversalOf, (map.get(item.reversalOf) || 0) + Math.abs(item.amount));
    });
  });
  const reversalInfo = (source, item) => {
    const isReversal = Boolean(item.reversalOf) || item.amount < 0;
    const doneFen = isReversal ? 0 : (reversedFen[source].get(item.id) || 0);
    const totalFen = Math.abs(item.amount);
    return {
      isReversal,
      reversedFen: doneFen,
      remainingFen: Math.max(0, totalFen - doneFen),
      reversed: doneFen > 0,
      reversedFully: doneFen >= totalFen,
      reversible: !isReversal && totalFen - doneFen > 0
    };
  };
  const categoryNames = {};
  ((state && state.categories) || []).forEach(item => { categoryNames[item.id] = item.name; });
  const typeFilter = Array.isArray(types) && types.length ? new Set(types) : null;
  const kw = typeof keyword === 'string' ? keyword.trim().toLowerCase() : '';
  const events = [];

  const accept = event => (!typeFilter || typeFilter.has(event.type))
    && (!startDate || event.eventDate >= startDate)
    && (!endDate || event.eventDate <= endDate)
    && touchesAccount(event, account)
    // “隐藏冲正对”= 当作没发生过：负向冲正、被完全冲掉的原单、由冲正产生的补退一起隐藏。
    // 部分冲正不能隐藏，否则合计会重新出现那笔误记（余额自检始终用全量事件）。
    && (!hideReversals || (!event.reversalOf && !event.reversedFully && !event.trueUp))
    && (!kw || event.searchText.indexOf(kw) >= 0);

  (ledger.expenses || []).forEach((item, index) => {
    const name = categoryNames[item.category] || item.category || '支出';
    const flags = reversalInfo('expenses', item);
    const isReversal = flags.isReversal;
    const createdAtText = formatCreatedAt(item.createdAt);
    events.push(finalize({
      id: item.id || `expense_${index}`,
      eventDate: item.date,
      createdAt: item.createdAt || '',
      createdAtText,
      type: 'expense',
      kind: isReversal ? 'reversal' : 'expense',
      reversalOf: item.reversalOf || '',
      reversed: flags.reversed,
      reversedFully: flags.reversedFully,
      reversible: flags.reversible,
      reversedFen: flags.reversedFen,
      remainingFen: flags.remainingFen,
      title: isReversal ? `冲正 · ${name}` : name,
      amountFen: item.amount,
      from: item.account || ACCT.BANK1,
      to: ACCT.OUT,
      account: item.account || ACCT.BANK1,
      categoryId: item.category || '',
      categoryName: name,
      note: item.note || '',
      subtitle: isReversal ? `${accountLabel(item.account || ACCT.BANK1, 'to')} 冲正回` : `${accountLabel(item.account || ACCT.BANK1, 'from')} 支出`,
      raw: item
    }, perspective));
  });

  (ledger.transfers || []).forEach((item, index) => {
    const label = item.trueUp ? '冲正补退' : KIND_LABELS[item.kind] || item.kind || '账户划转';
    const createdAtText = formatCreatedAt(item.createdAt);
    events.push(finalize({
      id: item.id || `transfer_${index}`,
      eventDate: item.date,
      createdAt: item.createdAt || '',
      createdAtText,
      type: 'transfer',
      kind: item.kind || '',
      trueUp: Boolean(item.trueUp),
      batchKey: item.batchKey || '',
      sequence: KIND_SEQUENCE[item.kind] || 0,
      title: label,
      subtitle: `${accountLabel(item.from, 'from')} → ${accountLabel(item.to, 'to')}`,
      amountFen: item.amount,
      from: item.from,
      to: item.to,
      account: item.from,
      categoryId: '',
      categoryName: '',
      note: item.note || '',
      source: 'transfers',
      raw: item
    }, perspective));
  });

  (ledger.specials || []).forEach((item, index) => {
    const createdAtText = formatCreatedAt(item.createdAt);
    const from = item.from || ACCT.POCKET3;
    const flags = reversalInfo('specials', item);
    const reason = item.reason || '专项支出';
    events.push(finalize({
      id: item.id || `special_${index}`,
      eventDate: item.date,
      createdAt: item.createdAt || '',
      createdAtText,
      type: 'special',
      kind: flags.isReversal ? 'special_reversal' : 'special',
      reversalOf: item.reversalOf || '',
      reversed: flags.reversed,
      reversedFully: flags.reversedFully,
      reversible: flags.reversible,
      reversedFen: flags.reversedFen,
      remainingFen: flags.remainingFen,
      title: flags.isReversal ? `冲正 · ${reason}` : reason,
      subtitle: `${accountLabel(from, 'from')} 专项`,
      amountFen: item.amount,
      from,
      to: item.to || ACCT.OUT,
      account: from,
      categoryId: '',
      categoryName: reason,
      note: item.note || '',
      source: 'specials',
      raw: item
    }, perspective));
  });

  (ledger.adjusts || []).forEach((item, index) => {
    const createdAtText = formatCreatedAt(item.createdAt);
    const acctName = accountName(item.acct);
    const book = Number.isInteger(item.bookBalance) ? formatFen(item.bookBalance) : '';
    const real = Number.isInteger(item.realBalance) ? formatFen(item.realBalance) : '';
    events.push(finalize({
      id: item.id || `adjust_${index}`,
      eventDate: item.date,
      createdAt: item.createdAt || '',
      createdAtText,
      type: 'adjust',
      kind: 'adjust',
      title: '余额校准',
      subtitle: book && real ? `${acctName}　账面 ¥${book} → 真实 ¥${real}` : `${acctName} 校准`,
      amountFen: item.diff || 0,
      from: null,
      to: null,
      account: item.acct,
      categoryId: '',
      categoryName: '',
      note: item.note || '',
      source: 'adjusts',
      raw: item
    }, perspective));
  });

  return events.filter(accept).sort(compareEvents);
}

function summarizeEvents(events) {
  const result = { count: 0, expenseFen: 0, transferFen: 0, specialFen: 0, adjustFen: 0, reversalFen: 0, byKind: {} };
  (events || []).forEach(event => {
    result.count += 1;
    if (event.reversalOf) result.reversalFen += Math.abs(event.amountFen);
    // 支出与专项都可能带负向冲正，合计一律按带符号净额，页面才不会出现“金额翻倍”。
    if (event.type === 'expense') result.expenseFen += event.amountFen;
    else if (event.type === 'special') result.specialFen += event.amountFen;
    else if (event.type === 'adjust') result.adjustFen += event.amountFen;
    else result.transferFen += Math.abs(event.amountFen);
    const key = event.type === 'transfer' ? event.kind : event.type;
    result.byKind[key] = (result.byKind[key] || 0) + (event.type === 'expense' ? event.amountFen : Math.abs(event.amountFen));
  });
  return result;
}

// 本期柱状图用：某一天的支出笔数、额度划入、超支补差、日结退款等账务动作概览。
function dayStatsByDate(events) {
  const stats = {};
  const slot = date => stats[date] || (stats[date] = {
    date, spent: 0, expenseCount: 0, reversalCount: 0, specialFen: 0, adjustFen: 0, transferFen: 0,
    hasAlloc: false, allocAmount: 0, coverAmount: 0, refundAmount: 0, flowCount: 0
  });
  (events || []).forEach(event => {
    const item = slot(event.eventDate);
    item.flowCount += 1;
    if (event.type === 'expense') {
      item.spent += event.amountFen;                                   // 冲正是负向支出，当天支出随之下降
      if (event.reversalOf) item.reversalCount += 1;
      else item.expenseCount += 1;
    }
    else if (event.type === 'special') item.specialFen += event.amountFen;
    else if (event.type === 'adjust') item.adjustFen += event.amountFen;
    else {
      item.transferFen += Math.abs(event.amountFen);
      if (event.kind === 'daily_alloc') { item.hasAlloc = true; item.allocAmount += Math.abs(event.amountFen); }
      if (event.kind === 'overspend_cover') item.coverAmount += Math.abs(event.amountFen);
      if (event.kind === 'daily_refund') item.refundAmount += Math.abs(event.amountFen);
    }
  });
  return stats;
}

// 按业务日期分组，用于流水页的日头 + 当日小计。
function groupEventsByDate(events) {
  const groups = [];
  const index = new Map();
  (events || []).forEach(event => {
    let group = index.get(event.eventDate);
    if (!group) {
      group = { date: event.eventDate, label: event.eventDate.slice(5).replace('-', '/'), count: 0, expenseText: '', expenseFen: 0, specialFen: 0, reversalCount: 0, items: [] };
      index.set(event.eventDate, group);
      groups.push(group);
    }
    group.items.push(event);
    group.count += 1;
    if (event.type === 'expense') group.expenseFen += event.amountFen;
    if (event.reversalOf) group.reversalCount += 1;
    if (event.type === 'special') group.specialFen += Math.abs(event.amountFen);
  });
  // 组头一句「支出 ¥x · 专项 ¥y」，让扫一眼日期就知道当天发生了什么量级的事。
  groups.forEach(group => {
    const parts = [`支出 ¥${formatFen(group.expenseFen)}`];
    if (group.specialFen) parts.push(`专项 ¥${formatFen(group.specialFen)}`);
    group.expenseText = parts.join(' · ');
  });
  return groups;
}

module.exports = {
  TYPE_LABELS, KIND_LABELS, ACCOUNT_LABELS,
  buildLedgerEvents, compareEvents, formatCreatedAt, accountLabel, accountName,
  eventEffectOn, accountBalanceFromEvents, touchesAccount, summarizeEvents,
  dayStatsByDate, groupEventsByDate
};
