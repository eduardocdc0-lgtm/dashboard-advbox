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

// Busca todos os posts via paginação
async function fetchAllPosts() {
  const PAGE_SIZE = 50;
  const first = await callAdvBox(`/posts?limit=${PAGE_SIZE}&offset=0`);
  const total = first.totalCount || 0;
  const allItems = [...(first.data || [])];

  const pages = [];
  for (let offset = PAGE_SIZE; offset < total; offset += PAGE_SIZE) {
    pages.push(offset);
  }

  const results = await Promise.allSettled(
    pages.map(offset => callAdvBox(`/posts?limit=${PAGE_SIZE}&offset=${offset}`))
  );
  results.forEach(r => {
    if (r.status === 'fulfilled') allItems.push(...(r.value.data || []));
  });

  return allItems;
}

// Consolida prazos a partir dos posts (agenda do AdvBox)
app.get('/api/deadlines', async (req, res) => {
  try {
    const allPosts = await fetchAllPosts();

    // Filtra tarefas com prazo E que ainda têm ao menos um usuário pendente
    const pending = allPosts.filter(p => {
      if (!p.date_deadline) return false;
      const users = p.users || [];
      // se não há usuários, considera pendente
      if (users.length === 0) return true;
      // pendente se pelo menos um usuário não completou
      return users.some(u => !u.completed);
    });

    const parseDeadline = (str) => {
      if (!str) return null;
      if (/^\d{4}-\d{2}-\d{2}/.test(str)) return new Date(str.substring(0, 10) + 'T00:00:00');
      if (/^\d{2}\/\d{2}\/\d{4}/.test(str)) {
        const [d, m, y] = str.split('/');
        return new Date(`${y}-${m}-${d}T00:00:00`);
      }
      return new Date(str);
    };

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const nextWeek = new Date(today);
    nextWeek.setDate(nextWeek.getDate() + 7);

    const classified = pending.map(p => {
      const dl = parseDeadline(p.date_deadline);
      if (!dl || isNaN(dl)) return null;
      const dlTime = dl.getTime();

      let status;
      if (dlTime < today.getTime()) status = 'overdue';
      else if (dlTime === today.getTime()) status = 'today';
      else if (dlTime === tomorrow.getTime()) status = 'tomorrow';
      else if (dl <= nextWeek) status = 'this_week';
      else status = 'future';

      const daysOverdue = status === 'overdue'
        ? Math.floor((today.getTime() - dlTime) / 86400000)
        : 0;

      // nome do cliente principal (primeiro da lista, excluindo INSS/órgãos públicos se houver)
      const customers = (p.lawsuit && p.lawsuit.customers) || [];
      const clientName = customers.length > 0
        ? customers.find(c => !c.customers_origins_id)?.name || customers[0].name
        : '';

      // responsáveis pendentes
      const responsibles = (p.users || [])
        .filter(u => !u.completed)
        .map(u => u.name)
        .join(', ');

      const process = p.lawsuit
        ? (p.lawsuit.process_number || p.lawsuit.protocol_number || `#${p.lawsuits_id}`)
        : (p.lawsuits_id ? `#${p.lawsuits_id}` : '—');

      return {
        id: p.id,
        date_deadline: p.date_deadline,
        type: p.task || '',
        client: clientName,
        responsible: responsibles,
        process,
        lawsuit_id: p.lawsuits_id,
        status,
        daysOverdue
      };
    }).filter(Boolean);

    const typeMatch = (type, keyword) =>
      (type || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(keyword);

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

    res.json({
      summary,
      next7,
      overdue,
      total: classified.length,
      totalFetched: allPosts.length,
      pendingWithDeadline: pending.length
    });
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
