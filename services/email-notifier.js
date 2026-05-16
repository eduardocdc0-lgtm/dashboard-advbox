/**
 * Email Notifier — envia digest de mudanças de fase via Gmail SMTP (Workspace).
 *
 * Disparado pelo auto-workflow no fim do ciclo horário. Manda 1 email único
 * com TODAS as mudanças detectadas naquele ciclo (evita encher caixa).
 *
 * Env:
 *   GMAIL_USER         — obrigatório. Email completo do Workspace (ex: eduardo@dominio.com)
 *   GMAIL_APP_PASSWORD — obrigatório. Senha de app gerada no Google Account
 *                        (2FA precisa estar ativo). 16 chars sem espaço.
 *   NOTIFY_EMAIL_TO    — destinatário. Default = GMAIL_USER (manda pra si mesmo)
 *
 * Sem GMAIL_USER ou GMAIL_APP_PASSWORD, pula envio com warning (não quebra ciclo).
 */

'use strict';

const nodemailer = require('nodemailer');

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  _transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
  return _transporter;
}

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

  const transporter = getTransporter();
  if (!transporter) {
    logger.warn('[Email-Notifier] GMAIL_USER ou GMAIL_APP_PASSWORD ausente — pulando envio');
    return { skipped: true, reason: 'no_credentials' };
  }

  const from = process.env.GMAIL_USER;
  const to = process.env.NOTIFY_EMAIL_TO || from;
  const subject = `[AdvBox] ${changes.length} processo(s) mudaram de fase`;

  try {
    const info = await transporter.sendMail({
      from: `"Auto-Workflow AdvBox" <${from}>`,
      to,
      subject,
      text: buildText(changes),
      html: buildHtml(changes),
    });
    logger.info(`[Email-Notifier] Email enviado pra ${to}: ${changes.length} mudança(s), id=${info.messageId}`);
    return { ok: true, id: info.messageId, count: changes.length };
  } catch (e) {
    logger.error(`[Email-Notifier] Falha SMTP: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

module.exports = { sendStageChangeDigest };
