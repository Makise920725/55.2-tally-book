function exportPaydayIcs(periods) {
  const events = periods.map(item => `BEGIN:VEVENT\nUID:55kuai2-${item.index}@tally-book\nDTSTART;VALUE=DATE:${item.payDate.replaceAll('-', '')}\nSUMMARY:55块2 · 发薪日转存 ¥${(item.saveToPocket / 100).toFixed(2)}\nEND:VEVENT`).join('\n');
  return `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//55块2//Tally Book//CN\n${events}\nEND:VCALENDAR`;
}
module.exports = { exportPaydayIcs };
