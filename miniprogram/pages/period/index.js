const { derivePeriods } = require('../../domain/plan');
const { formatFen } = require('../../domain/money');
const { sum } = require('../../domain/ledger');
const store = require('../../store/store');

Page({
  data: { periods: [], current: null },
  onLoad() { this.unsubscribe = store.subscribe(() => this.refresh()); this.refresh(); },
  onUnload() { if (this.unsubscribe) this.unsubscribe(); },
  refresh() {
    const state = store.getState();
    const periods = state.periods.map(item => ({ ...item, save: formatFen(item.saveToPocket), pocket: formatFen(item.pocketAfter), budget: formatFen(item.budgetToPool), bill: formatFen(item.billTotal) }));
    const current = state.periods[0];
    const spent = sum(state.ledger.expenses, item => item.date >= current.rangeStart && item.date <= current.rangeEnd);
    this.setData({ periods, current: { ...current, budget: formatFen(current.budgetToPool), spent: formatFen(spent), left: formatFen(current.budgetToPool - spent) } });
  }
});
