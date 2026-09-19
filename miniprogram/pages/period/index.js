const { derivePeriods, periodForDate, isPlanStarted } = require('../../domain/plan');
const { todayKey } = require('../../domain/calendar');
const { formatFen } = require('../../domain/money');
const { sum, dailySeries } = require('../../domain/ledger');
const store = require('../../store/store');

Page({
  data: { periods: [], current: null, started: false, lastEnd: '', startDate: '' },
  onLoad() { this.unsubscribe = store.subscribe(() => this.refresh()); this.refresh(); },
  onUnload() { if (this.unsubscribe) this.unsubscribe(); },
  refresh() {
    const state = store.getState();
    const periodList = state.periods && state.periods.length ? state.periods : derivePeriods();
    const periods = periodList.map(item => ({ ...item, save: formatFen(item.saveToPocket), pocket: formatFen(item.pocketAfter), budget: formatFen(item.budgetToPool), bill: formatFen(item.billTotal) }));
    const today = todayKey();
    const current = periodForDate(today, periodList);
    // 计划尚未开始或已全部结束时不再展示“本期”，否则会拿第 1 期的数据冒充当前周期。
    const base = { periods, started: isPlanStarted(today, state.config.startDate), lastEnd: periods.at(-1) ? periods.at(-1).rangeEnd : '', startDate: state.config.startDate };
    if (!current) { this.setData({ ...base, current: null }); return; }
    const spent = sum(state.ledger.expenses, item => item.date >= current.rangeStart && item.date <= current.rangeEnd);
    const mode = state.mode || 'daily';
    const allocation = mode === 'three-day' ? state.config.dailyBudget * 3 : state.config.dailyBudget;
    this.setData({ ...base, current: { ...current, budget: formatFen(current.budgetToPool), spent: formatFen(spent), left: formatFen(current.budgetToPool - spent), modeText: mode === 'three-day' ? '三天一结' : '每日结算', allocation: formatFen(allocation), series: dailySeries(state.ledger.expenses, current.rangeStart, current.days, { budget: state.config.dailyBudget, limit: Math.max(state.config.dailyBudget * 1.5, 7000) }) } });
  }
});
