const { formatFen } = require('../domain/money');

function escapeCell(value) {
  const text = String(value == null ? '' : value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportLedgerCsv(state) {
  const names = {};
  (state.categories || []).forEach(item => { names[item.id] = item.name; });
  const rows = [['日期', '类型', '分类/说明', '金额', '从账户', '到账户', '备注']];
  (state.ledger.expenses || []).forEach(item => rows.push([item.date, '支出', names[item.category] || item.category, formatFen(item.amount), item.account || 'BANK1', 'OUT', item.note || '']));
  (state.ledger.transfers || []).forEach(item => rows.push([item.date, '划转', item.kind, formatFen(item.amount), item.from, item.to, '']));
  (state.ledger.adjusts || []).forEach(item => rows.push([item.date, '校准', item.acct, formatFen(item.diff || 0), '', '', item.note || '']));
  return `\ufeff${rows.map(row => row.map(escapeCell).join(',')).join('\n')}`;
}

module.exports = { escapeCell, exportLedgerCsv };
