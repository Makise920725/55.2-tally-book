const { derivePeriods } = require('../../domain/plan');
const { formatFen } = require('../../domain/money');
const store = require('../../store/store');

Page({
  data: { period: null, steps: [] },
  onLoad() { this.unsubscribe = store.subscribe(() => this.refresh()); this.refresh(); },
  onUnload() { if (this.unsubscribe) this.unsubscribe(); },
  refresh() {
    const state = store.getState();
    const item = state.periods[0] || derivePeriods()[0];
    const stepNames = ['工资与生活费到账', '偿还账单（划转，不是支出）', '放入余额宝预算池', '存入小荷包', '清理上期结余'];
    const steps = stepNames.map((name, index) => ({ index: index + 1, name, done: !!state.paydaySteps[`1-${index + 1}`], amount: index === 0 ? formatFen(item.totalIn) : index === 1 ? formatFen(item.billTotal) : index === 2 ? formatFen(item.budgetToPool) : index === 3 ? formatFen(item.saveToPocket) : '省多少转多少' }));
    this.setData({ period: { ...item, total: formatFen(item.totalIn), bill: formatFen(item.billTotal), budget: formatFen(item.budgetToPool), save: formatFen(item.saveToPocket) }, steps, completed: steps.every(step => step.done) });
  },
  toggleStep(event) { store.togglePaydayStep(1, event.currentTarget.dataset.step); }
});
