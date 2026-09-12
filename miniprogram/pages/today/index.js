const { CONFIG } = require('../../domain/plan');
const { formatFen } = require('../../domain/money');

Page({
  data: { title: '今日', dailyBudget: formatFen(CONFIG.dailyBudget), remaining: formatFen(CONFIG.dailyBudget) },
  onLoad() { this.setData({ dailyBudget: formatFen(CONFIG.dailyBudget), remaining: formatFen(CONFIG.dailyBudget) }); }
});
