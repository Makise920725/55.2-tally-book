const { CONFIG, derivePeriods, progressToTarget, daysUntil } = require('../../domain/plan');
const { formatFen } = require('../../domain/money');
const { accountBalances, ACCT } = require('../../domain/ledger');
const store = require('../../store/store');

Page({
  data: { current: '', target: '', goal: '', goalProgress: 0, targetProgress: 0, daysLeft: 0, bankBalance: '0.00', poolBalance: '0.00', pocketBalance: '0.00', specialReason: '', specialAmount: '', periods: [] },
  onLoad() { this.unsubscribe = store.subscribe(() => this.refresh()); this.refresh(); },
  onUnload() { if (this.unsubscribe) this.unsubscribe(); },
  refresh() {
    const state = store.getState();
    const periods = (state.periods || derivePeriods()).map(item => ({
      ...item,
      save: formatFen(item.saveToPocket),
      pocket: formatFen(item.pocketAfter),
      special: item.specialOut ? `专项 −¥${formatFen(item.specialOut)}` : '无专项支出',
      completed: Object.keys(state.paydaySteps || {}).filter(key => key.indexOf(`${item.index}-`) === 0 && state.paydaySteps[key]).length === 5
    }));
    const currentFen = periods.at(-1).pocketAfter;
    const balances = accountBalances(state.ledger.transfers, state.ledger.expenses, state.openingBalances, state.ledger.specials);
    this.setData({ current: formatFen(currentFen), target: formatFen(CONFIG.targetSavings), goal: formatFen(CONFIG.goalMinimum), goalProgress: progressToTarget(currentFen, CONFIG.goalMinimum).toFixed(1), targetProgress: progressToTarget(currentFen, CONFIG.targetSavings).toFixed(1), daysLeft: Math.max(0, daysUntil(CONFIG.deadline)), bankBalance: formatFen(balances[ACCT.BANK1]), poolBalance: formatFen(balances[ACCT.POOL2]), pocketBalance: formatFen(balances[ACCT.POCKET3]), periods });
  }
  ,inputSpecialReason(event) { this.setData({ specialReason: event.detail.value }); }
  ,inputSpecialAmount(event) { this.setData({ specialAmount: event.detail.value }); }
  ,saveSpecial() {
    if (!this.data.specialReason || !this.data.specialAmount) { wx.showToast({ title: '请填写专项名称和金额', icon: 'none' }); return; }
    store.addSpecial({ date: new Date().toISOString().slice(0, 10), reason: this.data.specialReason, amountYuan: this.data.specialAmount });
    this.setData({ specialReason: '', specialAmount: '' });
    wx.showToast({ title: '专项支出已记录', icon: 'none' });
  }
});
