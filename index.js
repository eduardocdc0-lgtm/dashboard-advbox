// ========================================
// Dashboard AdvBox - Servidor Proxy
// ========================================
// Este servidor faz o "meio-campo" entre seu dashboard (HTML) e a API do AdvBox.
// Ele resolve o problema de CORS e mantém o token seguro no servidor.

const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

// O token fica guardado aqui, como variável de ambiente (mais seguro)
const ADVBOX_TOKEN = process.env.ADVBOX_TOKEN || '';
const ADVBOX_BASE_URL = 'https://app.advbox.com.br/api/v1';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // serve o index.html

// Função auxiliar que chama a API do AdvBox
async function callAdvBox(endpoint) {
  if (!ADVBOX_TOKEN) {
    throw new Error('Token nao configurado. Configure a variavel ADVBOX_TOKEN em Secrets.');
  }
  const url = `${ADVBOX_BASE_URL}${endpoint}`;
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${ADVBOX_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || data.message || `Erro ${response.status}`);
  }
  return data;
}

// Rotas do proxy - cada uma chama um endpoint do AdvBox
app.get('/api/settings', async (req, res) => {
  try {
    const data = await callAdvBox('/settings');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/lawsuits', async (req, res) => {
  try {
    const data = await callAdvBox('/lawsuits?limit=1000');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/last-movements', async (req, res) => {
  try {
    const data = await callAdvBox('/last_movements?limit=20');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/transactions', async (req, res) => {
  try {
    const data = await callAdvBox('/transactions?limit=1000');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/customers', async (req, res) => {
  try {
    const data = await callAdvBox('/customers?limit=1000');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/birthdays', async (req, res) => {
  try {
    const data = await callAdvBox('/customers/birthdays');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/posts', async (req, res) => {
  try {
    const data = await callAdvBox('/posts?limit=50');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Consolida prazos de todos os processos
app.get('/api/deadlines', async (req, res) => {
  try {
    const lawsuitsData = await callAdvBox('/lawsuits?limit=1000');
    const lawsuits = lawsuitsData.data || [];

    const BATCH_SIZE = 5;
    const allDeadlines = [];

    for (let i = 0; i < lawsuits.length; i += BATCH_SIZE) {
      const batch = lawsuits.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (lawsuit) => {
          const histData = await callAdvBox(`/history/${lawsuit.id}?status=pending`);
          const tasks = histData.data || histData || [];
          if (!Array.isArray(tasks)) return [];
          return tasks
            .filter(t => t.date_deadline)
            .map(t => ({
              id: t.id,
              date_deadline: t.date_deadline,
              type: t.type || t.task_type || t.title || '',
              client: lawsuit.customer_name || lawsuit.client_name || lawsuit.name || '',
              responsible: t.responsible_name || t.user_name || t.responsible || '',
              process: lawsuit.process_number || lawsuit.protocol_number || `#${lawsuit.id}`,
              lawsuit_id: lawsuit.id,
              title: t.title || t.description || ''
            }));
        })
      );
      results.forEach(r => {
        if (r.status === 'fulfilled') allDeadlines.push(...r.value);
      });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const nextWeek = new Date(today);
    nextWeek.setDate(nextWeek.getDate() + 7);

    const parseDeadline = (str) => {
      if (!str) return null;
      // suporta YYYY-MM-DD e DD/MM/YYYY
      if (/^\d{4}-\d{2}-\d{2}/.test(str)) return new Date(str.substring(0, 10) + 'T00:00:00');
      if (/^\d{2}\/\d{2}\/\d{4}/.test(str)) {
        const [d, m, y] = str.split('/');
        return new Date(`${y}-${m}-${d}T00:00:00`);
      }
      return new Date(str);
    };

    const classified = allDeadlines.map(d => {
      const dl = parseDeadline(d.date_deadline);
      if (!dl || isNaN(dl)) return { ...d, status: 'unknown', daysOverdue: 0 };
      const dlTime = dl.getTime();
      let status;
      if (dlTime < today.getTime()) status = 'overdue';
      else if (dlTime === today.getTime()) status = 'today';
      else if (dlTime === tomorrow.getTime()) status = 'tomorrow';
      else if (dl <= nextWeek) status = 'this_week';
      else status = 'future';
      const daysOverdue = status === 'overdue' ? Math.floor((today.getTime() - dlTime) / 86400000) : 0;
      return { ...d, status, daysOverdue };
    });

    const typeMatch = (type, keyword) => (type || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(keyword);

    const summary = {
      today: classified.filter(d => d.status === 'today').length,
      tomorrow: classified.filter(d => d.status === 'tomorrow').length,
      audiencias_week: classified.filter(d =>
        ['today', 'tomorrow', 'this_week'].includes(d.status) && typeMatch(d.type, 'audi')
      ).length,
      pericias_week: classified.filter(d =>
        ['today', 'tomorrow', 'this_week'].includes(d.status) && typeMatch(d.type, 'peri')
      ).length
    };

    const next7 = classified
      .filter(d => ['today', 'tomorrow', 'this_week'].includes(d.status))
      .sort((a, b) => new Date(a.date_deadline) - new Date(b.date_deadline));

    const overdue = classified
      .filter(d => d.status === 'overdue')
      .sort((a, b) => b.daysOverdue - a.daysOverdue);

    res.json({ summary, next7, overdue, total: classified.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Dashboard rodando em http://localhost:${PORT}`);
  if (!ADVBOX_TOKEN) {
    console.log('ATENCAO: Configure o token em Secrets (ADVBOX_TOKEN)');
  }
});
