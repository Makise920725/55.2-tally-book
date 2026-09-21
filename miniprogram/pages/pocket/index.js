const { CONFIG, derivePeriods, progressToTarget, daysUntil } = require('../../domain/plan');
const { formatFen } = require('../../domain/money');
const { accountBalances, ACCT, sum } = require('../../domain/ledger');
const { buildLedgerEvents, accountBalanceFromEvents, summarizeEvents } = require('../../domain/ledger-view');
const sweep = require('../../utils/sweep');
const { todayKey } = require('../../domain/calendar');
const store = require('../../store/store');

const PREVIEW_LIMIT = 8;

Page({
  data: {
    current: '', target: '', goal: '', goalProgress: 0, goalMarker: 0, targetProgress: 0, daysLeft: 0,
    bankBalance: '0.00', poolBalance: '0.00', pocketBalance: '0.00',
    pocketEvents: [], pocketMore: 0, pocketNetText: '0.00', pocketMatched: true, pocketIncomeText: '0.00', pocketSpecialText: '0.00', pocketAdjustText: '0.00',
    specialReason: '', specialAmount: '', periods: [], surplusCard: null, poolLeftoverHint: ''
  },
  onLoad() { this.unsubscribe = store.subscribe(() => this.refresh()); this.refresh(); },
  onShow() { this.refresh(); },
  onUnload() { if (this.unsubscribe) this.unsubscribe(); },
  refresh() {
    const state = store.getState();
    const surplus = store.previewPoolSurplus(todayKey());
    let actualAfter = 0;
    const periods = (state.periods || derivePeriods()).map(item => {
      const swept = sum(state.ledger.transfers, transfer => transfer.kind === 'carry_over' && transfer.date >= item.rangeStart && transfer.date <= item.rangeEnd);
      // 第五步转进来的余粮算“已经存下”；但计划列仍只按 payday_save 派生，否则一笔钱会被数两次。
      const saved = sum(state.ledger.transfers, transfer => (transfer.kind === 'payday_save' && transfer.date === item.payDate) || transfer.kind === 'carry_over' && transfer.date >= item.rangeStart && transfer.date <= item.rangeEnd);
      const special = sum(state.ledger.specials || [], expense => expense.date >= item.rangeStart && expense.date <= item.rangeEnd);
      actualAfter += saved - special;
      return {
      ...item,
      save: formatFen(item.saveToPocket),
      pocket: formatFen(item.pocketAfter),
      special: item.specialOut ? `专项 −¥${formatFen(item.specialOut)}` : '无专项支出',
      actualAfter: formatFen(actualAfter),
      sweptText: swept ? `含清理转入 ¥${formatFen(swept)}` : '',
      completed: !!(state.executedPaydays && state.executedPaydays[item.index])
    }; });
    const balances = accountBalances(state.ledger.transfers, state.ledger.expenses, state.openingBalances, state.ledger.specials, state.ledger.adjusts);
    const currentFen = balances[ACCT.POCKET3];
    const targetFen = periods.at(-1).pocketAfter;
    // “小荷包余额由哪些流水组成”：逐笔合计与派生余额必须一致，不一致就直接显示差额，避免只看总数猜。
    const pocketEvents = buildLedgerEvents(state, { account: ACCT.POCKET3, perspective: ACCT.POCKET3 });
    const netFen = accountBalanceFromEvents(pocketEvents, ACCT.POCKET3, state.openingBalances ? state.openingBalances[ACCT.POCKET3] : 0);
    const totals = summarizeEvents(pocketEvents);
    const incomeFen = pocketEvents.reduce((total, item) => total + (item.to === ACCT.POCKET3 ? Math.abs(item.amountFen) : 0), 0);
    this.setData({
      current: formatFen(currentFen), target: formatFen(targetFen), goal: formatFen(CONFIG.goalMinimum),
      goalProgress: progressToTarget(currentFen, targetFen).toFixed(1), goalMarker: progressToTarget(CONFIG.goalMinimum, targetFen).toFixed(1),
      targetProgress: progressToTarget(currentFen, targetFen).toFixed(1), daysLeft: Math.max(0, daysUntil(CONFIG.deadline)),
      bankBalance: formatFen(balances[ACCT.BANK1]), poolBalance: formatFen(balances[ACCT.POOL2]), pocketBalance: formatFen(balances[ACCT.POCKET3]),
      pocketEvents: pocketEvents.slice(0, PREVIEW_LIMIT), pocketMore: Math.max(0, pocketEvents.length - PREVIEW_LIMIT),
      pocketNetText: formatFen(netFen), pocketIncomeText: formatFen(incomeFen), pocketSpecialText: formatFen(totals.specialFen),
      // 校准净额可正可负，文案自带符号，避免「¥-0.20」这种双负号。
      pocketAdjustText: totals.adjustFen ? `${totals.adjustFen < 0 ? '−' : '+'} ¥${formatFen(Math.abs(totals.adjustFen))}` : '¥0.00', pocketMatched: netFen === currentFen,
      periods,
      // 余粮卡片只在“还能写账且真有钱可转”时出现；计划结束后只提示钱还留在余额宝
      surplusCard: surplus.surplus > 0 && !surplus.blocked ? {
        amountText: formatFen(surplus.surplus),
        detail: sweep.describe(surplus),
        hint: surplus.rangeEnd === surplus.deadline
          ? `第 ${surplus.periodIndex} 期是最后一期：${surplus.deadline} 之后账本转为只读，余粮请在截止日前转走`
          : ''
      } : null,
      poolLeftoverHint: surplus.blocked === 'ended' && balances[ACCT.POOL2] > 0
        ? `计划已结束、账本只读：余额宝里还留着 ¥${formatFen(balances[ACCT.POOL2])} 未清理`
        : ''
    });
  },
  // 第五步「清理上期结余」：确认后把余额宝用不完的余粮真实转进小荷包
  sweepSurplus() { sweep.sweepWithConfirm(() => this.refresh()); },
  openPocketLedger() { wx.navigateTo({ url: `/pages/ledger/index?account=${ACCT.POCKET3}` }); },
  inputSpecialReason(event) { this.setData({ specialReason: event.detail.value }); },
  inputSpecialAmount(event) { this.setData({ specialAmount: event.detail.value }); },
  saveSpecial() {
    if (!this.data.specialReason || !this.data.specialAmount) { wx.showToast({ title: '请填写专项名称和金额', icon: 'none' }); return; }
    const result = store.addSpecial({ date: todayKey(), reason: this.data.specialReason, amountYuan: this.data.specialAmount });
    if (result.blocked) { wx.showToast({ title: result.blocked === 'ended' ? '计划已结束，不能再登记专项' : '计划尚未开始', icon: 'none' }); return; }
    this.setData({ specialReason: '', specialAmount: '' });
    wx.showToast({ title: '专项支出已记录', icon: 'none' });
  }
});
