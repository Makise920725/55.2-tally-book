const { CONFIG, daysUntil, isPlanStarted, isPlanEnded, isPlanActive } = require('../../domain/plan');
const { todayKey } = require('../../domain/calendar');
const { ACCT, remainingDailyBudget } = require('../../domain/ledger');
const { buildLedgerEvents, summarizeEvents } = require('../../domain/ledger-view');
const { formatFen } = require('../../domain/money');
const store = require('../../store/store');
const write = require('../../utils/write');

// 写入口的拒绝原因统一翻译成人话；store 是唯一裁决者，页面只负责说清楚。
const BLOCKED_TEXT = {
  closed: '今天已封账，可先撤销封账',
  ended: '计划已结束，账本转为只读',
  not_started: '计划还没开始',
  bad_amount: '金额要填数字，最多两位小数',
  not_allocated: '本批次还没有划额，先点上面的早间划额'
};

Page({
  data: { dailyBudget: formatFen(CONFIG.dailyBudget), remaining: formatFen(CONFIG.dailyBudget), deadline: CONFIG.deadline, amount: '', keypadAmount: '0', selectedCategory: 'meal', selectedCategoryName: '吃饭', categories: [], entries: [], summary: null, keyRows: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'delete'], keyboardVisible: false, closed: false, started: false, ended: false, active: false, daysToStart: 0, saveError: '', allowanceNotice: '', todos: [] },
  onLoad() {
    this.unsubscribe = store.subscribe(() => this.refresh());
    this.refresh();
  },
  // 今日待办：tab 栏红点那个数字，就是这张清单的长度。红点只给数字没人看得懂，
  // 所以把「它在提示什么」在今日页顶上逐条列出来 —— 谁都能立刻知道自己还差哪一步。
  // 口径与 app.js 的角标逐条对应（划额 / 结算 / 待登记工资 / 待登记生活费），
  // 不会出现「红点说有 2 件事、打开却对不上」这种情况。
  pendingTodos(state, today) {
    const todos = [];
    if (!isPlanActive(today, state.config.startDate, state.config.deadline)) return todos;
    const settle = store.previewSettlement(today);
    if (settle.blocked === 'not_allocated') {
      todos.push({ key: 'allocate', text: '早间划额：今天还没把额度从余额宝划进工资卡' });
    } else if (!settle.blocked && !settle.alreadyClosed && !settle.batchPending) {
      todos.push({ key: 'settle', text: '晚间结算：今天的账还没结，没花完的额度要退回余额宝' });
    }
    const periods = state.periods || [];
    if (periods.some(item => !item.salaryReceived && today >= item.payDate)) {
      todos.push({ key: 'salary', text: '工资到账还没登记：到「发薪日」页登记' });
    }
    const pending = periods.filter(item => item.salaryReceived && !item.allowanceReceived && today >= item.allowanceExpectedDate);
    if (pending.length) {
      const first = pending[0];
      todos.push({
        key: 'allowance',
        text: `第 ${first.index} 期生活费还没登记：预计 ${first.allowanceExpectedDate} 到账 ¥${formatFen(first.allowance)}，`
          + (today > first.rangeEnd ? '本期区间已过，到「发薪日」页用「实际到账日」补登' : '到账后到「发薪日」页登记')
      });
    }
    return todos;
  },
  // 小程序切后台/跨天时重新进入必须重算“今天”，否则会继续显示昨天的额度与封账状态。
  onShow() { this.refresh(); },
  onUnload() { if (this.unsubscribe) this.unsubscribe(); },
  refresh() {
    const state = store.getState();
    const today = todayKey();
    const started = isPlanStarted(today, state.config.startDate);
    const ended = isPlanEnded(today, state.config.deadline);
    const active = isPlanActive(today, state.config.startDate, state.config.deadline);
    // 统一流水投影：额度划入 / 超支补差 / 日结退款必须和普通支出同等可见（视角是工资卡），
    // 但“今天还能花”仍然只看普通支出，划转金额不参与消费计算。
    const entries = buildLedgerEvents(state, { startDate: today, endDate: today, perspective: ACCT.BANK1 });
    const totals = summarizeEvents(entries);
    const summary = {
      expense: formatFen(totals.expenseFen), transferIn: formatFen(totals.byKind.daily_alloc || 0),
      cover: formatFen(totals.byKind.overspend_cover || 0), refund: formatFen(totals.byKind.daily_refund || 0),
      special: formatFen(totals.specialFen),
      // 校准是差额，可正可负；0 时整枚 chip 隐藏。
      adjust: totals.adjustFen ? `${totals.adjustFen < 0 ? '−' : '+'}¥${formatFen(Math.abs(totals.adjustFen))}` : '',
      count: totals.count
    };
    // 两段到账提醒：工资已登记、生活费过了预计日还没登记，就在今日页顶上提示。
    // 必须扫全部五期，不能只看今天所属的那一期：生活费漏登是会跨期的 ——
    // 第 1 期的 ¥2,000 没登记、人已经走进第 2 期时，只查当前期就一条提醒都不会出，
    // 这笔钱会静默地从储蓄目标里消失（实测过）。多期都欠时按逾期最久的先提醒。
    const pendingAllowance = (state.periods || [])
      .filter(item => item.salaryReceived && !item.allowanceReceived && today >= item.allowanceExpectedDate)
      .sort((a, b) => a.index - b.index)[0] || null;
    const allowanceNotice = pendingAllowance
      ? `第 ${pendingAllowance.index} 期生活费还没登记：预计 ${pendingAllowance.allowanceExpectedDate} 到账 ¥${formatFen(pendingAllowance.allowance)}，`
        + (today > pendingAllowance.rangeEnd
          ? `本期区间已在 ${pendingAllowance.rangeEnd} 结束，请到发薪日页选第 ${pendingAllowance.index} 期、用「实际到账日」补登`
          : '到账后去发薪日页登记')
      : '';
    const left = remainingDailyBudget(state.ledger.expenses, today, state.config.dailyBudget);
    const todos = this.pendingTodos(state, today);
    this.setData({ dailyBudget: formatFen(state.config.dailyBudget), remaining: formatFen(left), deadline: state.config.deadline, categories: state.categories, entries, summary, closed: !!(state.daySlots[today] && state.daySlots[today].closed), started, ended, active, allowanceNotice, todos, daysToStart: Math.max(0, daysUntil(state.config.startDate)) });
  },
  selectCategory(event) { this.setData({ selectedCategory: event.currentTarget.dataset.category, selectedCategoryName: event.currentTarget.dataset.name, keyboardVisible: true }); },
  openKeyboard() { this.setData({ keyboardVisible: true }); },
  noop() {},
  inputAmount(event) { this.setData({ amount: event.detail.value, keypadAmount: event.detail.value || '0' }); },
  keypress(event) {
    const key = event.currentTarget.dataset.key;
    let value = this.data.keypadAmount === '0' ? '' : this.data.keypadAmount;
    if (key === 'delete') value = value.slice(0, -1) || '0';
    else if (key === '.') { if (value.indexOf('.') < 0) value += '.'; }
    else if (value.length < 8) value += key;
    this.setData({ keypadAmount: value, amount: value === '0' ? '' : value });
  },
  closeKeyboard() { this.setData({ keyboardVisible: false }); },
  addExpense() {
    if (!this.data.active) { wx.showToast({ title: this.data.ended ? `计划已于 ${CONFIG.deadline} 结束` : `计划将于 ${CONFIG.startDate} 开始`, icon: 'none' }); return; }
    const raw = String(this.data.keypadAmount || '').trim();
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount <= 0) {
      wx.showToast({ title: '请输入金额', icon: 'none' });
      return;
    }
    const result = store.addExpense({ date: todayKey(), category: this.data.selectedCategory, amountYuan: raw });
    if (result.blocked) {
      this.setData({ keyboardVisible: false });
      write.notifyBlocked(result, BLOCKED_TEXT, '现在不能记这笔');
      return;
    }
    // 只有真的落盘才清空输入、才说「已记一笔」：存储写失败时内存状态没变，原样留着让用户重试。
    // 补差金额取 store 回传的真实值：批次额度以当天实际划入为准，改过预算情景也不会报错数字。
    const saved = write.notify(result, result.coverFen ? `已记一笔，补差 ¥${formatFen(result.coverFen)}` : '已记一笔');
    this.setData(saved ? { amount: '', keypadAmount: '0', keyboardVisible: false, saveError: '' } : { saveError: write.PERSIST_FAILED });
  },
  settleDay() {
    if (!this.data.active) { wx.showToast({ title: this.data.ended ? `计划已于 ${CONFIG.deadline} 结束` : `计划将于 ${CONFIG.startDate} 开始`, icon: 'none' }); return; }
    // 不传 dailyBudget，让 store 用当前情景的每日额度兜底，避免“省/松”情景退错钱。
    const result = store.settleDay({ date: todayKey() });
    const title = result.batchPending ? `三天一结，请在 ${result.settlementDate} 结算`
      : result.blocked ? (BLOCKED_TEXT[result.blocked] || '现在不能结算')
      : result.alreadyClosed ? '今天已经封账'
      : result.transfer ? `已退回 ¥${formatFen(result.transfer.amount)}`
      : '本批次已退完，没有可退余额';
    this.setSaveError(result);
    write.notify(result, title);
  },
  allocateDay() {
    if (!this.data.active) { wx.showToast({ title: this.data.ended ? `计划已于 ${CONFIG.deadline} 结束` : `计划将于 ${CONFIG.startDate} 开始`, icon: 'none' }); return; }
    const result = store.allocateDay({ date: todayKey() });
    const short = date => String(date).slice(5);
    const title = result.blocked ? (BLOCKED_TEXT[result.blocked] || '现在不能划额')
      : result.alreadyAllocated ? `本批次已于 ${short(result.allocationDate)} 划入`
      : result.catchUp ? `已补划 ¥${formatFen(result.transfer.amount)}（${result.spanDays} 天额度，落在批次首日 ${short(result.allocationDate)}）`
      : `已划入 ¥${formatFen(result.transfer.amount)}`;
    this.setSaveError(result);
    write.notify(result, title);
  },
  openLedger() { wx.navigateTo({ url: `/pages/ledger/index?date=${todayKey()}&range=day` }); },
  reopenDay() {
    const result = store.reopenDay(todayKey());
    this.setSaveError(result);
    write.notify(result, result.reversedRefund ? `已撤销封账，退回的 ¥${formatFen(result.reversedRefund)} 也已撤销` : '已撤销封账');
  },
  // 存储写失败是全局状态：横幅留在页面上，直到下一次写入成功才消失。
  setSaveError(result) { this.setData({ saveError: write.persistFailed(result) ? write.PERSIST_FAILED : '' }); },
});
