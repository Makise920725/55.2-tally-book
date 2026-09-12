const { CONFIG, derivePeriods } = require('../../domain/plan');
const { formatFen } = require('../../domain/money');
const store = require('../../store/store');

Page({
  data: { current: '', target: '', goal: '', periods: [] },
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
    this.setData({ current: formatFen(periods.at(-1).pocketAfter), target: formatFen(CONFIG.targetSavings), goal: formatFen(CONFIG.goalMinimum), periods });
  }
});
