// ========================================
// AdvBox CRM — Entry Point (placeholder)
// ========================================

const express = require('express');
const app  = express();
const PORT = process.env.CRM_PORT || 5001;

app.get('/health', (req, res) => res.json({ ok: true, service: 'crm' }));

app.listen(PORT, () => console.log(`CRM rodando em http://localhost:${PORT}`));
