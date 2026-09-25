const { derivePeriods, periodForDate } = require('../../domain/plan');
const { todayKey } = require('../../domain/calendar');
const { formatFen, yuanToFen } = require('../../domain/money');
const store = require('../../store/store');
const sweep = require('../../utils/sweep');
const write = require('../../utils/write');

// SOP 六步：两笔到账 + 三步划转 + 清理余粮。每一步的完成状态都由真实流水派生，页面不再手勾。
const STEP_NAMES = ['工资到账', '生活费到账', '偿还账单（划转，不是支出）', '放入余额宝预算池', '存入小荷包', '清理上期结余'];
// 被业务规则拒绝时的提示：store 是唯一裁决者，页面只负责说清原因。
const BLOCKED_TEXT = {
  ended: '计划已结束，账本转为只读',
  not_started: '计划还没开始',
  not_reached: '到账日到了再登记',
  derived_step: '步骤完成以真实流水为准，不用手勾',
  salary_pending: '先登记工资到账，再登记生活费',
  outside_range: '生活费要落在本期区间内，请用下面的日期选择器按真实到账日登记',
  bad_date: '到账日期不合法，请重新选择',
  bad_period: '期次不存在，请重新选择',
  bad_split: '安置金额要填数字，最多两位小数',
  split_mismatch: '三项合计必须正好等于到账金额',
  bill_over: '还账单不能超过本期还没还清的部分',
  nothing_to_undo: '本期没有已经登记、可以回退的到账',
  legacy_merged: '本期是旧版本合并登记的，直接删会留下半截流水；请到「我的」用备份恢复回到按错之前',
  legacy_group: '本期流水是旧版本合并登记的，直接删会留下半截流水；请到「我的」用备份恢复'
};

// 撤销之后会「看起来不对劲」的后果，逐条翻译给用户：这些都不影响记账正确性
// （账本合计照样为 0），只是余额会显示成负数，重新登记这笔到账就补齐了。
const WARN_TEXT = {
  allocated: '这笔钱已经划过额度：余额宝会显示成负数，重新登记这笔到账就补齐',
  sealed: '这一天已经封账：封账记录会留着，余额宝或工资卡可能显示负数，重新登记就补齐',
  swept: '这笔钱已经有一部分清理进了小荷包：池子会显示负数，把小荷包那笔转回来或重新登记',
  spent: '这笔到账的钱已经花掉一部分：余额宝会显示负数，重新登记这笔到账就补齐'
};

// 回退确认弹窗要把「删掉哪几笔」原样念出来，用中文化的类型名。
const KIND_TEXT = {
  bill_repay: '还账单', payday_budget: '放余额宝', payday_save: '存小荷包',
  payday_income: '工资到账', allowance_income: '生活费到账'
};

// 元 → 分只走 domain/money 一处，页面不自己 Math.round(x * 100)。空值按 0，非法返回 null。
function fenOf(value) {
  if (value === undefined || value === null || value === '') return 0;
  try { const fen = yuanToFen(value); return Number.isInteger(fen) && fen >= 0 ? fen : null; } catch (error) { return null; }
}

Page({
  data: {
    period: null, steps: [], periodIndex: 1, canSweep: false, sweepText: '',
    transferDone: false, allDone: false, completed: false, statusText: '', saveError: '',
    periodOptions: ['第 1 期', '第 2 期', '第 3 期', '第 4 期', '第 5 期'],
    canRegisterSalary: false, canRegisterAllowance: false, salaryButtonText: '', allowanceButtonText: '',
    allowancePickerValue: '', allowancePickerEnd: '', allowanceOverdue: false, legacyHint: '',
    splitEditor: null, undo: null, undoText: ''
  },
  // ---- 自选安置的草稿 ----
  // 用户填的三个金额是「草稿」，只在（期次 + 哪一笔到账）变化时才用推荐值重置：
  // store 每次提交都会触发 refresh，若每次都重置，用户正在输入的数字会被冲掉。
  splitKey: '',
  splitSeed: null,
  splitDraft: null,
  recommendDraft(plan) {
    return { billYuan: formatFen(plan ? plan.bill : 0), poolYuan: formatFen(plan ? plan.pool : 0), saveYuan: formatFen(plan ? plan.save : 0) };
  },
  splitSeedFor(item, phase) {
    return phase === 'salary'
      ? { phase, income: item.salary, plan: item.salaryPlan, title: '这笔工资怎么安置' }
      : { phase, income: item.allowance, plan: item.allowancePlan, title: '这笔生活费怎么安置' };
  },
  // 页面的合计校验只为了当场给反馈；钱要落账仍以 store.resolveSplit 的裁决为准。
  buildSplitEditor(seed, item) {
    if (!seed || !seed.plan || !item) return null;
    const draft = this.splitDraft || this.recommendDraft(seed.plan);
    const bill = fenOf(draft.billYuan);
    const pool = fenOf(draft.poolYuan);
    const save = fenOf(draft.saveYuan);
    const invalid = bill === null || pool === null || save === null;
    const total = invalid ? 0 : bill + pool + save;
    const billRoom = Math.max(0, item.billTotal - item.billPlaced);
    const poolRoom = Math.max(0, item.budgetToPool - item.poolPlaced);
    const billOver = !invalid && bill > billRoom;
    const balanced = !invalid && total === seed.income;
    const notes = [];
    // 少还账单是允许的（钱是你的），但第三步会一直不点亮，得先说清楚之后怎么补。
    if (!invalid && bill < billRoom) {
      notes.push(`比应还的 ¥${formatFen(billRoom)} 少还 ¥${formatFen(billRoom - bill)}：第三步「偿还账单」会一直不点亮，之后只能靠「我的 → 余额校准」或手工补一笔。`);
    }
    // 余额宝是每天「早间划额」的唯一来源，少放了要说清后果：
    // 缺口一般由生活费到账时补上（推荐值就是先补池），补不上的话工资卡会透支。
    if (!invalid && pool < poolRoom) {
      notes.push(`比计划少放 ¥${formatFen(poolRoom - pool)} 进余额宝：每天的划额都从池子里出，这笔缺口要靠生活费到账时补上（推荐值会优先补池），补不上工资卡就会透支。`);
    }
    // 多放进余额宝的部分不会丢：它成为余粮，由第六步真实转进小荷包。
    if (!invalid && pool > poolRoom) {
      notes.push(`比计划多放 ¥${formatFen(pool - poolRoom)} 进余额宝：这部分算余粮，可由第六步清进小荷包。`);
    }
    return {
      phase: seed.phase, title: seed.title, incomeText: formatFen(seed.income),
      billYuan: draft.billYuan, poolYuan: draft.poolYuan, saveYuan: draft.saveYuan,
      billText: formatFen(bill || 0), poolText: formatFen(pool || 0), saveText: formatFen(save || 0),
      totalText: formatFen(total), billRoomText: formatFen(billRoom),
      recommendText: `还账单 ¥${formatFen(seed.plan.bill)}　·　放余额宝 ¥${formatFen(seed.plan.pool)}　·　存小荷包 ¥${formatFen(seed.plan.save)}`,
      canSubmit: balanced && !billOver,
      problem: invalid ? '金额要填数字，最多两位小数'
        : billOver ? `还账单最多 ¥${formatFen(billRoom)}`
        : total > seed.income ? `多填了 ¥${formatFen(total - seed.income)}`
        : balanced ? '' : `还差 ¥${formatFen(seed.income - total)} 没安置`,
      notes: notes.join('')
    };
  },
  inputSplit(event) {
    if (!this.splitSeed) return;
    const field = event.currentTarget.dataset.field;
    this.splitDraft = { ...this.recommendDraft(this.splitSeed.plan), ...(this.splitDraft || {}), [field]: event.detail.value };
    const editor = this.buildSplitEditor(this.splitSeed, this.data.period);
    if (editor) this.setData({ splitEditor: editor });
  },
  resetSplit() {
    if (!this.splitSeed) return;
    this.splitDraft = this.recommendDraft(this.splitSeed.plan);
    const editor = this.buildSplitEditor(this.splitSeed, this.data.period);
    if (editor) this.setData({ splitEditor: editor });
  },
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
    const last = periods[periods.length - 1];
    const periodIndex = item ? item.index : (todayKey() < periods[0].payDate ? periods[0].index : last.index);
    this.setData({ periodIndex });
  },
  refresh() {
    const state = store.getState();
    const periodIndex = this.data.periodIndex || 1;
    const today = todayKey();
    const item = state.periods[periodIndex - 1] || derivePeriods()[periodIndex - 1];
    const status = store.paydayStepStatus(state, periodIndex);
    const surplus = store.previewPoolSurplus(today);
    // 两段到账的金额与待办：工资日给「已安置/还差多少」，生活费日给「到账后会自动补多少池、存多少」。
    // 第 3/4/5 步的分母一律用 billTotal / budgetToPool / saveToPocket —— 正是 paydayStepStatus 打勾时
    // 比的同一份目标（done[i] <=> pendingXxx === 0）。早先分母用的是 planBill / planBudget / planSave，
    // 切过情景之后就会出现「勾已经打上、文案却写着还差 ¥55.27」。目标与计划值不同时，把原计划一并写出来，
    // 差额去哪了一目了然（在余额宝里，由第六步清出来）。
    const allowancePlan = item.allowancePlan;
    // 目标与「当前情景的计划值」不同时（只在工资日之后切过情景才会发生）把计划值一并写出来，
    // 差额去哪了一目了然：多出来的躺在余额宝里，由第六步清进小荷包。
    const planNote = (target, plan) => (target === plan ? '' : ` · 本期计划 ¥${formatFen(plan)}`);
    const steps = STEP_NAMES.map((name, index) => {
      const flowText = index === 0
        ? (item.salaryReceived ? `¥${formatFen(item.salaryIn)} · 已到账 ${item.payDate}` : `¥${formatFen(item.salary)} · 到账日 ${item.payDate}`)
        : index === 1
          ? (item.allowanceReceived
            ? `¥${formatFen(item.allowanceIn)} · 已到账 ${item.allowanceDate}`
            : `¥${formatFen(item.allowance)} · 预计 ${item.allowanceExpectedDate}${item.salaryReceived ? '' : '（先登记工资）'}`)
          : index === 2
            ? `${item.pendingBill === 0 ? '已还清' : `已还 ¥${formatFen(item.billPlaced)}`} / ¥${formatFen(item.billTotal)}${item.pendingBill ? ` · 还差 ¥${formatFen(item.pendingBill)}` : ''}${planNote(item.billTotal, item.planBill)}`
            : index === 3
              ? `${item.pendingPool === 0 ? '已补满' : `已入池 ¥${formatFen(item.poolPlaced)}`} / ¥${formatFen(item.budgetToPool)}${item.pendingPool && allowancePlan ? ` · 生活费到账后补 ¥${formatFen(allowancePlan.pool)}` : ''}${planNote(item.budgetToPool, item.planBudget)}`
              : index === 4
                ? `${item.pendingSave === 0 ? '已存够' : `已存 ¥${formatFen(item.savePlaced)}`} / ¥${formatFen(item.saveToPocket)}${item.pendingSave && allowancePlan ? ` · 生活费到账后存 ¥${formatFen(allowancePlan.save)}` : ''}${planNote(item.saveToPocket, item.planSave)}`
                : status.sweptFen ? `本期已转存小荷包 ¥${formatFen(status.sweptFen)}`
                  : surplus.periodIndex === periodIndex && surplus.surplus ? `当前可清理 ¥${formatFen(surplus.surplus)}（超出本期剩余计划开销）`
                    : '省多少转多少：真实转存后自动打勾';
      return { index: index + 1, name, done: status.done[index], flowText };
    });
    const salaryPending = !item.salaryReceived;
    const allowancePending = !item.allowanceReceived;
    // 生活费逾期：本期区间都过完了还没登记。这时「今天」已经不在本期里，
    // 拿今天当到账日只会被 store 挡成 outside_range，主按钮就成了死路（实测过）。
    // 所以默认日期一律夹到 [发薪日, min(今天, 本期结束)]，逾期时就是本期最后一天：
    // 确认弹窗会把这一天念出来，觉得不对可以取消，再用日期选择器挑真实到账日。
    const canSalary = salaryPending && item.payDate <= today && today <= state.config.deadline;
    const canAllow = !salaryPending && allowancePending && today >= item.payDate && today <= state.config.deadline;
    // 自选安置：当前能登记哪一笔，就编辑哪一笔的分配草稿。
    const splitPhase = canSalary ? 'salary' : (canAllow ? 'allowance' : '');
    const splitKey = `${periodIndex}:${splitPhase}`;
    if (!splitPhase) { this.splitKey = ''; this.splitSeed = null; this.splitDraft = null; }
    else if (this.splitKey !== splitKey) {
      this.splitKey = splitKey;
      this.splitSeed = this.splitSeedFor(item, splitPhase);
      this.splitDraft = this.recommendDraft(this.splitSeed.plan);
    } else {
      // 同一笔：保留用户草稿，但收入/推荐值可能因切情景而变，种子要跟着刷新。
      this.splitSeed = this.splitSeedFor(item, splitPhase);
    }
    const splitEditor = splitPhase ? this.buildSplitEditor(this.splitSeed, item) : null;
    // 回退：能撤就显示按钮；不能撤也把原因写出来（尤其旧版合并入账，别让用户以为页面坏了）。
    const undoPreview = store.previewArrivalUndo(periodIndex, today);
    const undoText = undoPreview.canUndo
      ? `回退这笔到账（${undoPreview.kind === 'allowance_income' ? '生活费' : '工资'} ¥${formatFen(undoPreview.amount)} 连同它的 ${undoPreview.placements.length} 笔安置一起删掉）`
      : (BLOCKED_TEXT[undoPreview.blocked] || '');
    const allowanceOverdue = !salaryPending && allowancePending && today > item.rangeEnd;
    const allowanceDefaultDate = today >= item.payDate ? (today <= item.rangeEnd ? today : item.rangeEnd) : item.payDate;
    const overdueNote = allowanceOverdue
      ? `本期区间已在 ${item.rangeEnd} 结束：按钮会按 ${allowanceDefaultDate} 补登，日期不对就取消，用下面的选择器挑真实到账日。`
      : '';
    this.setData({
      period: {
        ...item,
        allowanceHint: allowancePlan
          ? `推荐：生活费到账后先补预算池 ¥${formatFen(allowancePlan.pool)}，再转存 ¥${formatFen(allowancePlan.save)}（下面可以自己改）`
          : '',
        overdueNote
      },
      steps,
      splitEditor,
      undo: undoPreview.canUndo ? undoPreview : null,
      undoText,
      transferDone: status.transferDone,
      allDone: status.allDone,
      completed: status.allDone,
      statusText: status.allDone ? '六步完成，安心进入下一期'
        : !item.salaryReceived ? `工资还没登记：到账后先登记工资（${item.payDate}）`
        : !item.allowanceReceived ? `工资已安置，等生活费到账后登记（预计 ${item.allowanceExpectedDate}）`
        : status.done.slice(2, 5).every(Boolean) ? '两笔收入已安置，第六步余粮还没转进小荷包'
        : `两笔收入已到齐，但${item.pendingBill ? `账单还差 ¥${formatFen(item.pendingBill)} 没还清` : '还有划转没补齐'}（登记时你选的就是这个分配，之后只能用「我的 → 余额校准」或手工补）`,
      
      // 第六步「清理上期结余」＝ 上期没花完的余粮转进小荷包。它要等**这一期两笔到齐**才有意义：
      // 钱没到齐时池子还差 pendingPool 才满，此时算出来的「余粮」里有一部分正是生活费待补的钱，
      // 清走等于提前把生活费花掉（实测 9/26 会清走 ¥110.38，9/28 生活费才到账）。
      // 到齐之后池子满员，清掉的才是真余粮。
      canSweep: item.fullyFunded && surplus.surplus > 0 && !surplus.blocked && surplus.periodIndex === periodIndex,
      sweepText: !item.fullyFunded
        ? '第六步等生活费到账、预算池补满之后再清理'
        : (surplus.surplus ? `清理余额宝余粮 ¥${formatFen(surplus.surplus)} → 小荷包` : '本阶段没有可清理的余粮'),
      // 工资日过了就能登记工资；生活费要等工资登记之后，且到账日落在本期内。
      canRegisterSalary: canSalary,
      canRegisterAllowance: canAllow,
      // 日期选择器只能在「工资日 ~ min(今天, 本期结束)」里选：不允许把还没发生的到账登记成事实。
      allowancePickerValue: allowanceDefaultDate,
      allowancePickerEnd: today < item.rangeEnd ? today : item.rangeEnd,
      allowanceOverdue,
      // v1.3 及更早版本把工资与生活费合并成一笔登记：金额不动，但要说清楚这回事。
      legacyHint: item.legacyMerged
        ? `本期由旧版本合并登记（工资 + 生活费一笔）。历史金额一分未改；若生活费实际还没到账，请在到账后核对一次账户真实余额。`
        : '',
      salaryButtonText: salaryPending ? `登记工资到账 ¥${formatFen(item.salary)}` : '工资已登记',
      allowanceButtonText: salaryPending ? '先登记工资到账'
        : (allowancePending ? `${allowanceOverdue ? '补登' : '登记'}生活费到账 ¥${formatFen(item.allowance)}` : '生活费已登记')
    });
  },
  togglePeriod(event) { this.setData({ periodIndex: Number(event.detail.value) + 1 }, () => this.refresh()); },
  // 两步到账：工资日登记工资；生活费支持选实际到账日（默认今天，不早于工资日、不晚于本期结束）。
  // 工资同样是一笔真实进账，登记即写 3~4 笔划转：和生活费、第六步转账守同一条纪律 —— 先确认再落盘。
  // 弹窗里的金额直接念 period.salaryPlan，与 store.placementFor 同一份算法，页面不自己算。
  registerSalary() {
    const item = this.data.period;
    const editor = this.data.splitEditor;
    if (!item) return;
    if (!editor) { this.applySalary(); return; }        // 不可登记：让 store 说出真实拒绝原因
    // 合计不对就不给提交：store 也会再校验一次，这里只是不让用户白点一趟。
    if (!editor.canSubmit) { wx.showToast({ title: editor.problem || '请先填好安置金额', icon: 'none' }); return; }
    const content = `确认 ¥${editor.incomeText} 工资已于 ${item.payDate} 到账？\n按你填的分配登记：`
      + `还账单 ¥${editor.billText}，放余额宝 ¥${editor.poolText}，存小荷包 ¥${editor.saveText}。`;
    wx.showModal({
      title: '登记工资到账',
      content,
      confirmText: '确认到账', cancelText: '先不改',
      success: result => { if (result.confirm) this.applySalary(); }
    });
  },
  applySalary() {
    const result = store.registerSalaryDay(this.data.periodIndex, todayKey(), { split: this.splitDraft });
    this.setSaveError(result);
    if (result.blocked) { write.notifyBlocked(result, BLOCKED_TEXT, '现在不能登记工资'); return; }
    write.notify(result, result.alreadyReceived ? '本期工资已登记' : '工资已登记，先还账单、补预算池');
  },
  // 生活费是一笔真实的进账，登记即写 5 笔账：先确认再落盘，和第六步转账同样的纪律。
  // 日期有两个来源：日期选择器给 event.detail.value（字符串）；按钮 tap 事件的 detail 是坐标 {x, y}，
  // 取不到 value，就退回 allowancePickerValue —— 它已经夹在 [发薪日, min(今天, 本期结束)] 里。
  // 早先这里退回的是 todayKey()：本期区间过完之后再点按钮，store 一律挡成 outside_range，
  // 用户只看得到「生活费要落在本期区间内」，找不到补登的入口，¥2,000 就这么漏掉。
  registerAllowance(event) {
    const picked = event && event.detail && typeof event.detail.value === 'string' ? event.detail.value : '';
    const date = picked || this.data.allowancePickerValue || todayKey();
    const item = this.data.period;
    const editor = this.data.splitEditor;
    if (!item) return;
    if (!editor) { this.applyAllowance(date); return; }  // 不可登记：让 store 说出真实拒绝原因
    if (!editor.canSubmit) { wx.showToast({ title: editor.problem || '请先填好安置金额', icon: 'none' }); return; }
    const content = `确认 ¥${editor.incomeText} 生活费已于 ${date} 到账？\n按你填的分配登记：`
      + `还账单 ¥${editor.billText}，放余额宝 ¥${editor.poolText}，存小荷包 ¥${editor.saveText}。`;
    wx.showModal({
      title: '登记生活费到账',
      content,
      confirmText: '确认到账', cancelText: '先不改',
      success: result => { if (result.confirm) this.applyAllowance(date); }
    });
  },
  applyAllowance(date) {
    const result = store.registerAllowance(this.data.periodIndex, { date, asOfDate: todayKey(), split: this.splitDraft });
    this.setSaveError(result);
    if (result.blocked) { write.notifyBlocked(result, BLOCKED_TEXT, '现在不能登记生活费'); return; }
    write.notify(result, result.alreadyReceived ? '本期生活费已登记' : '生活费已登记：补足预算池，余下转入小荷包');
  },
  // 回退已登记的到账：整组删（收入 + 安置），撤销后账本恢复成登记前的样子。
  // 必须先确认，而且要把「删掉哪几笔」原样念出来 —— 这是不可逆的删除。
  undoArrival() {
    const undo = this.data.undo;
    const item = this.data.period || {};
    if (!undo) { wx.showToast({ title: this.data.undoText || '没有可以回退的到账', icon: 'none' }); return; }
    const lines = undo.placements.map(item => `　· ${KIND_TEXT[item.kind] || item.kind} ¥${formatFen(item.amount)}`);
    const warnings = (undo.warnings || []).map(key => WARN_TEXT[key]).filter(Boolean);
    // 两笔都登记了时，一次只撤最后一笔（先生活费再工资，顺序反过来余额宝会双倍）。
    const nextStep = item.salaryReceived && undo.kind === 'allowance_income'
      ? '\n撤完这一笔，可以再点一次回退工资那笔。'
      : '';
    const tail = warnings.length
      ? `\n\n注意：\n${warnings.map(text => `　· ${text}`).join('\n')}${nextStep}`
      : `\n\n删完账本回到登记前的样子，之后可以重新登记。${nextStep}`;
    wx.showModal({
      title: `回退第 ${undo.periodIndex} 期${undo.kind === 'allowance_income' ? '生活费' : '工资'}到账`,
      content: `会删掉 ${undo.date} 这笔 ¥${formatFen(undo.amount)} 的到账，连同它当时安置的：\n${lines.join('\n')}${tail}`,
      confirmText: '确认回退', cancelText: '先不动',
      success: result => { if (result.confirm) this.applyUndo(); }
    });
  },
  applyUndo() {
    const result = store.undoArrival(this.data.periodIndex, todayKey());
    this.setSaveError(result);
    if (result.blocked) { write.notifyBlocked(result, BLOCKED_TEXT, '现在回退不了'); return; }
    this.splitKey = '';          // 清掉分配草稿，回退后重新按推荐值预填
    this.splitDraft = null;
    write.notify(result, `已回退：删掉 ${result.removed} 笔流水`);
  },
  // 存储写失败是全局状态：横幅留在页面上，直到下一次写入成功才消失。
  setSaveError(result) { this.setData({ saveError: write.persistFailed(result) ? write.PERSIST_FAILED : '' }); },
  // 步骤行点一下等于「这一步怎么来的 / 怎么取消」。完成状态由真实流水派生，手点改不了，
  // 所以不能只甩一句「不用手勾」——得告诉用户到底该做什么。
  toggleStep(event) {
    const step = Number(event.currentTarget.dataset.step);
    const undo = this.data.undo;
    const text = step <= 2
      ? (undo
        ? '这一步是登记到账时按真实流水打上的，取消请点下面的「回退这笔到账」'
        : (this.data.undoText || '这一步由真实流水派生，不用手勾'))
      : (step === 6
        ? '这一步看本期有没有真实的 carry_over 转账，用下面「清理余粮」按钮完成'
        : '这一步由登记到账时的安置划转派生：还多少账单、入多少池、存多少，都在分配时决定');
    wx.showToast({ title: text, icon: 'none' });
  },
  sweepSurplus() { sweep.sweepWithConfirm(() => this.refresh()); }
});
