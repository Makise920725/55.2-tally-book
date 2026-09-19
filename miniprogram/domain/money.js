function assertInteger(value, name) {
  if (!Number.isInteger(value)) throw new TypeError(`${name} must be an integer`);
}

// 输入多来自键盘字符串，先按字符串定位小数点，避免 value * 100 的浮点误差（1.005 -> 100）。
function yuanToFen(yuan) {
  const value = typeof yuan === 'number' ? yuan : Number(yuan);
  if (!Number.isFinite(value)) throw new TypeError('yuan must be a finite number');
  if (Number.isInteger(value)) return value * 100;
  const text = String(value);
  if (text.indexOf('e') < 0 && text.indexOf('E') < 0) {
    const [whole, fraction = ''] = text.split('.');
    const padded = (fraction + '000').slice(0, 3);
    const sign = whole === '-0' || whole.startsWith('-') ? -1 : 1;
    const units = Math.abs(Number(whole || 0)) * 100 + Number(padded.slice(0, 2)) + (Number(padded[2]) >= 5 ? 1 : 0);
    return sign * units;
  }
  return Math.round(Number((value * 100).toFixed(2)));
}

function fenToYuan(fen) {
  assertInteger(fen, 'fen');
  return fen / 100;
}

function formatFen(fen) {
  return fenToYuan(fen).toFixed(2);
}

module.exports = { yuanToFen, fenToYuan, formatFen };
