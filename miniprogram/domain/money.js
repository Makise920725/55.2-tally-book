function assertInteger(value, name) {
  if (!Number.isInteger(value)) throw new TypeError(`${name} must be an integer`);
}

function yuanToFen(yuan) {
  const value = typeof yuan === 'number' ? yuan : Number(yuan);
  if (!Number.isFinite(value)) throw new TypeError('yuan must be finite');
  return Math.round(value * 100);
}

function fenToYuan(fen) {
  assertInteger(fen, 'fen');
  return fen / 100;
}

function formatFen(fen) {
  return fenToYuan(fen).toFixed(2);
}

module.exports = { yuanToFen, fenToYuan, formatFen };
