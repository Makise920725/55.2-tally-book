const HOLIDAYS = new Set(['2026-09-25', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2027-01-01']);
const MAKEUP_WORKDAYS = new Set(['2026-09-20', '2026-10-10']);

function parseDate(date) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function isWeekday(date) {
  const day = date.getUTCDay();
  return day >= 1 && day <= 5;
}

function isPayableWorkday(date) {
  const key = dateKey(date);
  return (isWeekday(date) && !HOLIDAYS.has(key)) || MAKEUP_WORKDAYS.has(key);
}

function countPayableWorkdays(start, end) {
  let cursor = parseDate(start);
  const last = parseDate(end);
  let count = 0;
  while (cursor <= last) {
    if (isPayableWorkday(cursor)) count += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

function previousWorkday(date) {
  const cursor = new Date(date.getTime());
  do cursor.setUTCDate(cursor.getUTCDate() - 1); while (!isPayableWorkday(cursor));
  return dateKey(cursor);
}

module.exports = { HOLIDAYS, MAKEUP_WORKDAYS, parseDate, dateKey, isPayableWorkday, countPayableWorkdays, previousWorkday };
