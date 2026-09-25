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
    if (item.allowanceReceived === false && item.allowanceExpectedDate) {
      body.push(
        'BEGIN:VEVENT',
        `UID:55kuai2-allowance-${item.index}@tally-book`,
        `DTSTAMP:${compactDate(item.allowanceExpectedDate)}T000000Z`,
        `DTSTART;VALUE=DATE:${compactDate(item.allowanceExpectedDate)}`,
        `DTEND;VALUE=DATE:${compactDate(nextDay(item.allowanceExpectedDate))}`,
        `SUMMARY:55块2 · 预计生活费到账 ¥${(item.allowance / 100).toFixed(2)}（到账后登记）`,
        'END:VEVENT'
      );
    }
    // 转存事件：两笔到齐后念**真实**转存额（自选安置可能一分没存，那就不用提醒了）；
    // 还没到齐时才念计划值，并在文案里写明「计划」，不把计划当成已经发生的事。
    const funded = item.fullyFunded === true;
    const savedFen = funded ? (item.savePlaced || 0) : item.saveToPocket;
    if (!(funded && !savedFen)) {
      body.push(
        'BEGIN:VEVENT',
        `UID:55kuai2-period-${item.index}@tally-book`,
        `DTSTAMP:${compactDate(item.payDate)}T000000Z`,
        `DTSTART;VALUE=DATE:${compactDate(item.payDate)}`,
        `DTEND;VALUE=DATE:${compactDate(nextDay(item.payDate))}`,
        `SUMMARY:55块2 · ${funded ? '已转存' : '计划转存'} ¥${(savedFen / 100).toFixed(2)}`,
        'END:VEVENT'
      );
    }
  });
  body.push('END:VCALENDAR', '');
  return body.join(EOL);
}
module.exports = { exportPaydayIcs };
