const { CONFIG, derivePeriods } = require('../../domain/plan');
const { formatFen } = require('../../domain/money');
Page({ data: { current: '', target: '', goal: '' }, onLoad() { const periods = derivePeriods(); this.setData({ current: formatFen(periods.at(-1).pocketAfter), target: formatFen(CONFIG.targetSavings), goal: formatFen(CONFIG.goalMinimum) }); } });
