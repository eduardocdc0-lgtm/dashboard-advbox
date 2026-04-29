const { Router } = require('express');
const { fetchCustomers } = require('../../../services/data');
const {
  getAniversariantesHoje,
  getAniversariantesMes,
  enviarMensagem,
  processarAniversariantesHoje,
  getHistorico,
  getConfig,
  setConfig,
  VARIACOES,
  primeiroNome,
} = require('../../../services/birthday');

const router = Router();

router.get('/birthday/hoje', async (req, res, next) => {
  try {
    const customers = await fetchCustomers();
    const lista = await getAniversariantesHoje(customers);
    res.json({ data: lista, total: lista.length });
  } catch (err) { next(err); }
});

router.get('/birthday/mes', async (req, res, next) => {
  try {
    const customers = await fetchCustomers();
    const lista = await getAniversariantesMes(customers);
    res.json({ data: lista, total: lista.length });
  } catch (err) { next(err); }
});

router.post('/birthday/send/:clientId', async (req, res, next) => {
  try {
    const customers = await fetchCustomers();
    const cliente = customers.find(c => String(c.id) === String(req.params.clientId));
    if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado.' });
    const variacaoIdx = req.body.variacao != null ? Number(req.body.variacao) - 1 : null;
    const result = await enviarMensagem(cliente, variacaoIdx);
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/birthday/send-all', async (req, res, next) => {
  try {
    const customers = await fetchCustomers();
    const resultados = await processarAniversariantesHoje(customers);
    res.json({ total: resultados.length, results: resultados });
  } catch (err) { next(err); }
});

router.get('/birthday/historico', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const rows = await getHistorico(limit);
    res.json({ data: rows, total: rows.length });
  } catch (err) { next(err); }
});

router.get('/birthday/config', async (req, res, next) => {
  try {
    const enabled = await getConfig();
    res.json({ auto_enabled: enabled });
  } catch (err) { next(err); }
});

router.post('/birthday/config', async (req, res, next) => {
  try {
    await setConfig(!!req.body.auto_enabled);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/birthday/preview', (req, res) => {
  const previews = VARIACOES.map((fn, i) => ({
    variacao: i + 1,
    texto: fn('[Primeiro Nome]'),
  }));
  res.json({ data: previews });
});

module.exports = router;
