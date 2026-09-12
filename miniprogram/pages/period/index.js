const { derivePeriods } = require('../../domain/plan');
const { formatFen } = require('../../domain/money');
Page({ data: { periods: [] }, onLoad() { this.setData({ periods: derivePeriods().map(item => ({ ...item, save: formatFen(item.saveToPocket), pocket: formatFen(item.pocketAfter) })) }); } });
