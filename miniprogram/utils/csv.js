const { buildLedgerEvents, accountName, accountLabel } = require('../domain/ledger-view');

const LEDGER_CSV_HEADER = ['流水ID', '业务日期', '创建时间', '时间是否精确', '类型', '明细', '金额', '方向', '从账户', '到账户', '关联账户', '备注'];

function escapeCell(value) {
  const text = String(value == null ? '' : value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// CSV 直接导出统一流水投影的结果，页面看到的和导出的必然是同一份口径。
// 划转/支出/专项导出绝对值（方向列表达语义），校准导出带符号差额，方便逐笔重算余额。
function ledgerCsvRows(state) {
  return buildLedgerEvents(state).map(event => [
    event.id,
    event.eventDate,
    event.createdAtText || '',
    event.exactTime ? '是' : '否',
    event.typeLabel,
    event.title,
    event.plainAmountText,
    event.direction,
    event.type === 'adjust' ? '' : accountLabel(event.from, 'from'),
    event.type === 'adjust' ? '' : accountLabel(event.to, 'to'),
    event.type === 'transfer' ? '' : accountName(event.account),
    [event.note, event.type === 'adjust' ? event.subtitle : ''].filter(Boolean).join('　')
  ]);
}

function exportLedgerCsv(state) {
  const rows = [LEDGER_CSV_HEADER, ...ledgerCsvRows(state)];
  return `\ufeff${rows.map(row => row.map(escapeCell).join(',')).join('\n')}`;
}

module.exports = { escapeCell, LEDGER_CSV_HEADER, ledgerCsvRows, exportLedgerCsv };
