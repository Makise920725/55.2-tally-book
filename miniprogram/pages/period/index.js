const { derivePeriods, periodForDate, isPlanStarted } = require('../../domain/plan');
const { todayKey } = require('../../domain/calendar');
const { formatFen } = require('../../domain/money');
const { ACCT, sum, dailySeries } = require('../../domain/ledger');
const { buildLedgerEvents, dayStatsByDate } = require('../../domain/ledger-view');
const store = require('../../store/store');

// 柱子缺少流水时的默认值，保证模板里的字段始终存在。
const EMPTY_STATS = { expenseCount: 0, reversalCount: 0, spent: 0, hasAlloc: false, allocAmount: 0, coverAmount: 0, refundAmount: 0, flowCount: 0 };

Page({
  data: { periods: [], current: null, started: false, lastEnd: '', startDate: '', selectedDate: '', dayDetail: null },
  onLoad() { this.unsubscribe = store.subscribe(() => this.refresh()); this.refresh(); },
  onShow() { this.refresh(); },
  onUnload() { if (this.unsubscribe) this.unsubscribe(); },
  refresh() {
    const state = store.getState();
    const periodList = state.periods && state.periods.length ? state.periods : derivePeriods();
    const periods = periodList.map(item => ({ ...item, save: formatFen(item.saveToPocket), pocket: formatFen(item.pocketAfter), budget: formatFen(item.budgetToPool), bill: formatFen(item.billTotal) }));
    const today = todayKey();
    const current = periodForDate(today, periodList);
    // 计划尚未开始或已全部结束时不再展示“本期”，否则会拿第 1 期的数据冒充当前周期。
    const base = { periods, started: isPlanStarted(today, state.config.startDate), lastEnd: periods.at(-1) ? periods.at(-1).rangeEnd : '', startDate: state.config.startDate };
    this.events = [];
    if (!current) { this.setData({ ...base, current: null, selectedDate: '', dayDetail: null }); return; }
    const spent = sum(state.ledger.expenses, item => item.date >= current.rangeStart && item.date <= current.rangeEnd);
    const mode = state.mode || 'daily';
    const allocation = mode === 'three-day' ? state.config.dailyBudget * 3 : state.config.dailyBudget;
    // 柱高仍只表示普通支出；账户划转/补差/退款作为附加信息挂在同一天的柱子上。
    this.events = buildLedgerEvents(state, { startDate: current.rangeStart, endDate: current.rangeEnd, perspective: ACCT.BANK1 });
    const stats = dayStatsByDate(this.events);
    const series = dailySeries(state.ledger.expenses, current.rangeStart, current.days, { budget: state.config.dailyBudget, limit: Math.max(state.config.dailyBudget * 1.5, 7000) })
      .map(day => {
        const item = { ...EMPTY_STATS, ...(stats[day.date] || {}), date: day.date };
        return {
          ...day,
          expenseCount: item.expenseCount,
          reversalCount: item.reversalCount,
          flowCount: item.flowCount,
          hasAlloc: item.hasAlloc,
          allocAmount: item.allocAmount,
          coverAmount: item.coverAmount,
          refundAmount: item.refundAmount,
          marker: item.coverAmount > 0 ? 'cover' : (item.refundAmount > 0 ? 'refund' : (item.hasAlloc ? 'alloc' : ''))
        };
      });
    this.setData({
      ...base,
      selectedDate: this.data.selectedDate && series.some(day => day.date === this.data.selectedDate) ? this.data.selectedDate : '',
      current: {
        ...current,
        budget: formatFen(current.budgetToPool),
        spent: formatFen(spent),
        left: formatFen(current.budgetToPool - spent),
        modeText: mode === 'three-day' ? '三天一结' : '每日结算',
        allocation: formatFen(allocation),
        barMinWidth: current.days * 34,
        series
      }
    });
    this.buildDayDetail(this.data.selectedDate);
  },
  selectDay(event) {
    const date = event.currentTarget.dataset.date;
    this.setData({ selectedDate: date === this.data.selectedDate ? '' : date });
    this.buildDayDetail(this.data.selectedDate);
  },
  // 点击柱子后展示该日全部流水：支出逐笔 + 当天账务动作（划入/补差/退款等）。
  buildDayDetail(date) {
    if (!date) { this.setData({ dayDetail: null }); return; }
    const events = this.events.filter(item => item.eventDate === date);
    // 冲正是负向支出：净额必须带符号相加，笔数按原始记录统计，否则“支出 1 笔 + 冲正 1 笔”会被读成“支出 2 笔、金额翻倍”。
    const expenses = events.filter(item => item.type === 'expense');
    const reversals = expenses.filter(item => item.reversal);
    const actions = events.filter(item => item.type !== 'expense');
    const netFen = expenses.reduce((total, item) => total + item.amountFen, 0);
    const reversedFen = reversals.reduce((total, item) => total + Math.abs(item.amountFen), 0);
    this.setData({
      dayDetail: {
        date,
        expenseCount: expenses.filter(item => !item.reversal && !item.reversed).length,
        reversalCount: reversals.length,
        expenseTotal: formatFen(netFen),
        reversalTotal: formatFen(reversedFen),
        expenses: expenses.map(item => ({ id: item.id, title: item.title, amountText: item.amountText, timeShort: item.timeShort, note: item.note, reversal: item.reversal, reversed: item.reversed })),
        actions: actions.map(item => ({ id: item.id, typeLabel: item.typeLabel, title: item.title, flowText: item.flowText, amountText: item.amountText, timeShort: item.timeShort, signed: item.signedFen })),
        hasActions: actions.length > 0
      }
    });
  },
  openDayLedger() {
    const date = this.data.selectedDate || todayKey();
    wx.navigateTo({ url: `/pages/ledger/index?date=${date}&range=day` });
  },
  openPeriodLedger() {
    const current = this.data.current;
    if (!current) { wx.navigateTo({ url: '/pages/ledger/index' }); return; }
    wx.navigateTo({ url: `/pages/ledger/index?startDate=${current.rangeStart}&endDate=${current.rangeEnd}&range=period` });
  }
});
