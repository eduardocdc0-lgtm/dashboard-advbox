/**
 * Email Notifier — envia digest de mudanças de fase via Resend.
 *
 * Disparado pelo auto-workflow no fim do ciclo horário. Manda 1 email único
 * com TODAS as mudanças detectadas naquele ciclo (evita encher caixa).
 *
 * Env:
 *   RESEND_API_KEY    — obrigatório. Sem isso, pula envio com warning.
 *   NOTIFY_EMAIL_TO   — destinatário (default: eduardorodriguesadv1@gmail.com)
 *   NOTIFY_EMAIL_FROM — remetente (default: sandbox Resend onboarding@resend.dev,
 *                       que só entrega pro email verificado na conta Resend)
 */

'use strict';

const fetchNF = require('node-fetch');

const RESEND_API = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'Auto-Workflow AdvBox <onboarding@resend.dev>';
const DEFAULT_TO = 'eduardorodriguesadv1@gmail.com';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function buildHtml(changes) {
  const rows = changes.map(c => `
    <tr>
      <td style="padding:10px;border-bottom:1px solid #eee;vertical-align:top;">${escapeHtml(c.clientName || '(sem nome)')}</td>
      <td style="padding:10px;border-bottom:1px solid #eee;color:#888;vertical-align:top;">${escapeHtml(c.prevStage || '—')}</td>
      <td style="padding:10px;border-bottom:1px solid #eee;vertical-align:top;"><strong style="color:#1a73e8;">${escapeHtml(c.newStage)}</strong></td>
      <td style="padding:10px;border-bottom:1px solid #eee;vertical-align:top;"><a href="https://app.advbox.com.br/lawsuits/${c.lawId}" style="color:#1a73e8;text-decoration:none;">abrir &rarr;</a></td>
    </tr>`).join('');

  return `<!doctype html>
<html lang="pt-BR">
<body style="font-family:-apple-system,system-ui,Segoe UI,Roboto,sans-serif;background:#f9f9f9;padding:20px;margin:0;">
  <div style="max-width:700px;margin:0 auto;background:#fff;border-radius:8px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
    <h2 style="margin:0 0 4px 0;font-size:18px;color:#222;">${changes.length} processo(s) mudaram de fase</h2>
    <p style="margin:0 0 16px 0;color:#666;font-size:13px;">Detectado no ciclo de auto-workflow.</p>
    <table style="border-collapse:collapse;width:100%;font-size:14px;">
      <thead>
        <tr style="background:#f5f5f5;text-align:left;">
          <th style="padding:10px;font-weight:600;color:#333;">Cliente</th>
          <th style="padding:10px;font-weight:600;color:#333;">De</th>
          <th style="padding:10px;font-weight:600;color:#333;">Pra</th>
          <th style="padding:10px;"></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</body>
</html>`;
}

function buildText(changes) {
  return [
    `${changes.length} processo(s) mudaram de fase:`,
    '',
    ...changes.map(c => (
      `- ${c.clientName || '(sem nome)'}\n  ${c.prevStage || '—'} → ${c.newStage}\n  https://app.advbox.com.br/lawsuits/${c.lawId}`
    )),
  ].join('\n');
}

async function sendStageChangeDigest(changes, { logger = console } = {}) {
  if (!changes || !changes.length) {
    return { skipped: true, reason: 'no_changes' };
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logger.warn('[Email-Notifier] RESEND_API_KEY não configurado — pulando envio');
    return { skipped: true, reason: 'no_api_key' };
  }

  const to = process.env.NOTIFY_EMAIL_TO || DEFAULT_TO;
  const from = process.env.NOTIFY_EMAIL_FROM || DEFAULT_FROM;
  const subject = `[AdvBox] ${changes.length} processo(s) mudaram de fase`;

  try {
    const resp = await fetchNF(RESEND_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        html: buildHtml(changes),
        text: buildText(changes),
      }),
    });
    const raw = await resp.text();
    let body; try { body = JSON.parse(raw); } catch { body = { raw }; }
    if (!resp.ok) {
      const detail = body.message || body.error || body.raw;
      logger.error(`[Email-Notifier] Resend ${resp.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
      return { ok: false, status: resp.status, error: detail };
    }
    logger.info(`[Email-Notifier] Email enviado pra ${to}: ${changes.length} mudança(s), id=${body.id}`);
    return { ok: true, id: body.id, count: changes.length };
  } catch (e) {
    logger.error(`[Email-Notifier] Falha de rede: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

module.exports = { sendStageChangeDigest };
