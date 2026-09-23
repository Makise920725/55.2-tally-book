// RFC 5545 要求 CRLF 换行、每个 VEVENT 有 UID 与 DTSTART/DTEND，否则系统日历可能直接忽略导入。
// 微信基础库/宿主环境不能按 Node 版本想当然具备 ES2021 的 String.prototype.replaceAll，
// 因此日期压缩用 split/join 实现（日期是 YYYY-MM-DD 纯数字加连字符，不涉及正则转义）。
function compactDate(dateKey) {
  return String(dateKey).split('-').join('');
}

function nextDay(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

function exportPaydayIcs(periods) {
  const EOL = '\r\n';
  const body = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//55块2//Tally Book//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH'
  ];
  periods.forEach(item => {
    body.push(
      'BEGIN:VEVENT',
      `UID:55kuai2-period-${item.index}@tally-book`,
      `DTSTAMP:${compactDate(item.payDate)}T000000Z`,
      `DTSTART;VALUE=DATE:${compactDate(item.payDate)}`,
      `DTEND;VALUE=DATE:${compactDate(nextDay(item.payDate))}`,
      `SUMMARY:55块2 · 发薪日转存 ¥${(item.saveToPocket / 100).toFixed(2)}`,
      'END:VEVENT'
    );
  });
  body.push('END:VCALENDAR', '');
  return body.join(EOL);
}
module.exports = { exportPaydayIcs };
