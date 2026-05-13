'use strict';

/**
 * Verifica se uma string de data pertence ao mês/ano informados.
 * Aceita formatos: 'YYYY-MM-DD...' ou 'DD/MM/YYYY...'.
 */
function dateInMes(dateStr, mm, yyyy) {
  if (!dateStr) return false;
  const s = String(dateStr);
  let m, y;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    y = +s.slice(0, 4); m = +s.slice(5, 7);
  } else if (/^\d{2}\/\d{2}\/\d{4}/.test(s)) {
    const p = s.split('/'); m = +p[1]; y = +p[2];
  } else {
    return false;
  }
  return m === mm && y === yyyy;
}

/**
 * Parseia string 'MM/YYYY' e retorna { mm, yyyy } como Numbers.
 */
function parseMesAno(mesStr) {
  const [mm, yyyy] = String(mesStr).split('/').map(Number);
  return { mm, yyyy };
}

module.exports = { dateInMes, parseMesAno };
