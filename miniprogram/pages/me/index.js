const { CONFIG } = require('../../domain/plan');
const { formatFen } = require('../../domain/money');
Page({ data: { config: null }, onLoad() { this.setData({ config: { ...CONFIG, dailyBudget: formatFen(CONFIG.dailyBudget), goalMinimum: formatFen(CONFIG.goalMinimum), targetSavings: formatFen(CONFIG.targetSavings) } }); } });
