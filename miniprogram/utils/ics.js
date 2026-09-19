// RFC 5545 要求 CRLF 换行、每个 VEVENT 有 UID 与 DTSTART/DTEND，否则系统日历可能直接忽略导入。
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
      `DTSTAMP:${item.payDate.replaceAll('-', '')}T000000Z`,
      `DTSTART;VALUE=DATE:${item.payDate.replaceAll('-', '')}`,
      `DTEND;VALUE=DATE:${nextDay(item.payDate).replaceAll('-', '')}`,
      `SUMMARY:55块2 · 发薪日转存 ¥${(item.saveToPocket / 100).toFixed(2)}`,
      'END:VEVENT'
    );
  });
  body.push('END:VCALENDAR', '');
  return body.join(EOL);
}
module.exports = { exportPaydayIcs };
