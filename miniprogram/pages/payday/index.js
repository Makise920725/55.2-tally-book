const { derivePeriods, periodForDate } = require('../../domain/plan');
const { todayKey } = require('../../domain/calendar');
const { formatFen } = require('../../domain/money');
const store = require('../../store/store');

Page({
  data: { period: null, steps: [], periodIndex: 1, periodOptions: ['第 1 期', '第 2 期', '第 3 期', '第 4 期', '第 5 期'] },
  onLoad() {
    this.selectCurrentPeriod();
    this.unsubscribe = store.subscribe(() => this.refresh());
    this.refresh();
  },
  onShow() { this.selectCurrentPeriod(); },
  onUnload() { if (this.unsubscribe) this.unsubscribe(); },
  // 默认停在“今天所属期次”：计划开始前落到第 1 期，全部结束后落到最后一期。
  selectCurrentPeriod() {
    const state = store.getState();
    const periods = state.periods || derivePeriods();
    const item = periodForDate(todayKey(), periods);
    const periodIndex = item ? item.index : (todayKey() < periods[0].payDate ? periods[0].index : periods.at(-1).index);
    this.setData({ periodIndex });
  },
  refresh() {
    const state = store.getState();
    const item = state.periods[(this.data.periodIndex || 1) - 1] || derivePeriods()[0];
    const stepNames = ['工资与生活费到账', '偿还账单（划转，不是支出）', '放入余额宝预算池', '存入小荷包', '清理上期结余'];
    const periodIndex = this.data.periodIndex || 1;
    const steps = stepNames.map((name, index) => ({ index: index + 1, name, done: !!state.paydaySteps[`${periodIndex}-${index + 1}`], amount: index === 0 ? formatFen(item.totalIn) : index === 1 ? formatFen(item.billTotal) : index === 2 ? formatFen(item.budgetToPool) : index === 3 ? formatFen(item.saveToPocket) : '省多少转多少' }));
    this.setData({ period: { ...item, total: formatFen(item.totalIn), bill: formatFen(item.billTotal), budget: formatFen(item.budgetToPool), save: formatFen(item.saveToPocket) }, steps, completed: steps.every(step => step.done) });
  },
  togglePeriod(event) { this.setData({ periodIndex: Number(event.detail.value) + 1 }, () => this.refresh()); },
  toggleStep(event) { store.togglePaydayStep(this.data.periodIndex, event.currentTarget.dataset.step); },
  execute() {
    const result = store.executePayday(this.data.periodIndex, todayKey());
    if (result.blocked) { wx.showToast({ title: `本期到账日是 ${result.payDate}，到账后再登记`, icon: 'none' }); return; }
    wx.showToast({ title: result.alreadyExecuted ? '本期已执行' : '五步划转已登记', icon: 'none' });
  }
});
