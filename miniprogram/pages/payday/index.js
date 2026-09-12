const { derivePeriods } = require('../../domain/plan');
const { formatFen } = require('../../domain/money');
Page({ data: { period: null }, onLoad() { const item = derivePeriods()[0]; this.setData({ period: { ...item, total: formatFen(item.totalIn), bill: formatFen(item.billTotal), budget: formatFen(item.budgetToPool), save: formatFen(item.saveToPocket) } }); } });
