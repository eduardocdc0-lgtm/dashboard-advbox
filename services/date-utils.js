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

/**
 * Parser robusto pra datas do AdvBox. Aceita ISO (YYYY-MM-DD[ T]HH:MM:SS)
 * E formato BR (DD/MM/YYYY). Retorna Date ou null.
 *
 * IMPORTANTE: Use SEMPRE essa função pra parsear datas que vêm da API
 * AdvBox. Date.parse() puro FALHA silenciosamente em formato BR
 * (retorna NaN), causando bugs sérios como "todo cliente vira inadimplente"
 * em comparações de string.
 */
function parseAdvboxDate(s) {
  if (!s) return null;
  const m1 = /^(\d{4})-(\d{2})-(\d{2})[ T]?(\d{2})?:?(\d{2})?:?(\d{2})?/.exec(String(s));
  if (m1) return new Date(Number(m1[1]), Number(m1[2]) - 1, Number(m1[3]),
                          Number(m1[4] || 0), Number(m1[5] || 0), Number(m1[6] || 0));
  const m2 = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(String(s));
  if (m2) return new Date(Number(m2[3]), Number(m2[2]) - 1, Number(m2[1]));
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

/**
 * Retorna true se `dateStr` (ISO ou BR) é anterior a `todayISO` (YYYY-MM-DD).
 * Substitui comparação de string `t.date_due < hojeISO` que quebra em BR.
 */
function isBeforeISO(dateStr, todayISO) {
  const d = parseAdvboxDate(dateStr);
  if (!d) return false;
  return d.toISOString().slice(0, 10) < todayISO;
}

/**
 * Retorna data como ISO YYYY-MM-DD aceitando qualquer formato de entrada.
 */
function toISODate(s) {
  const d = parseAdvboxDate(s);
  return d ? d.toISOString().slice(0, 10) : null;
}

module.exports = { dateInMes, parseMesAno, parseAdvboxDate, isBeforeISO, toISODate };
