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
  if (response.status === 429) {
    throw new Error('RATE_LIMIT');
  }
  const ct = response.headers.get('content-type') || '';
  if (!ct.includes('json')) {
    throw new Error(`RATE_LIMIT`); // HTML = redirecionamento por rate limit / auth
  }
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

// Parseia string de data (YYYY-MM-DD ou DD/MM/YYYY)
function parseDeadline(str) {
  if (!str) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return new Date(str.substring(0, 10) + 'T00:00:00');
  if (/^\d{2}\/\d{2}\/\d{4}/.test(str)) {
    const [d, m, y] = str.split('/');
    return new Date(`${y}-${m}-${d}T00:00:00`);
  }
  return new Date(str);
}

// Extrai o cliente principal de uma string "CLIENTE, RESPONSÁVEL, PARTE2"
// Remove nomes que estão no campo responsible
function extractClientName(customersStr, responsibleStr) {
  if (!customersStr) return '';
  const responsibles = (responsibleStr || '')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const names = customersStr.split(',').map(s => s.trim()).filter(Boolean);
  const clients = names.filter(n => !responsibles.includes(n.toUpperCase()));
  return clients.length > 0 ? clients[0] : names[0] || '';
}

// Busca TODOS os posts via /posts paginado
async function fetchAllPosts() {
  const first = await callAdvBox('/posts?limit=200&offset=0');
  const total = first.totalCount || (first.data || []).length;
  const all = [...(first.data || [])];
  console.log(`[Alice] Posts: ${all.length} de ${total} total`);

  // Paginar para pegar o restante
  for (let offset = 200; offset < total; offset += 200) {
    await new Promise(r => setTimeout(r, 500)); // pausa gentil entre páginas
    const page = await callAdvBox(`/posts?limit=200&offset=${offset}`);
    const pageData = page.data || [];
    all.push(...pageData);
    console.log(`[Alice] Posts: ${all.length} de ${total}`);
    if (pageData.length < 200) break;
  }
  return all;
}

// ── Cache de prazos ──────────────────────────────────────────────
let deadlinesCache = null;
let deadlinesFetchedAt = null;
let deadlinesFetching = false;
let deadlinesLastError = 0;
const CACHE_TTL_MS = 30 * 60 * 1000;   // 30 minutos entre refreshes
const ERROR_BACKOFF_MS = 5 * 60 * 1000; // 5 minutos após erro

async function buildDeadlinesCache() {
  if (deadlinesFetching) return;
  // Backoff após erro: não tentar por 5 minutos
  if (deadlinesLastError && (Date.now() - deadlinesLastError) < ERROR_BACKOFF_MS) return;

  deadlinesFetching = true;
  console.log('[Alice] Iniciando busca de prazos via posts...');
  try {
    // Buscar todos os posts paginados (max ~3 chamadas no total)
    const allPosts = await fetchAllPosts();
    console.log(`[Alice] ${allPosts.length} posts encontrados. Filtrando prazos...`);

    // Extrair nome do cliente do objeto lawsuit dentro do post
    function clientFromPost(post) {
      const customers = (post.lawsuit && post.lawsuit.customers) || [];
      if (customers.length === 0) return '';
      // Retorna o primeiro cliente que não seja INSS/órgão público
      const personal = customers.find(c =>
        c.name && !/INSS|INSTITUTO NACIONAL|PREVIDÊNCIA|ESTADO|MUNICÍPIO|UNIÃO FEDERAL/i.test(c.name)
      );
      return (personal || customers[0]).name || '';
    }

    // Converter posts em prazos — 1 entrada por usuário por tarefa (igual ao AdvBox)
    // Inclui usuários pendentes (completed=null)
    const allDeadlines = [];
    for (const p of allPosts) {
      if (!p.date_deadline) continue;
      const allUsers = p.users || [];
      const pendingUsers = allUsers.filter(u => !u.completed);
      if (pendingUsers.length === 0) continue; // todos completaram — ignorar

      const processNum = (p.lawsuit && (p.lawsuit.process_number || p.lawsuit.protocol_number)) || '';
      const processLabel = processNum || `#${p.lawsuits_id || p.id}`;
      const client = clientFromPost(p);

      for (const user of pendingUsers) {
        allDeadlines.push({
          key: `post|${p.id}|user|${user.user_id}`,
          date_deadline: p.date_deadline,
          type: p.task || '',
          client,
          responsible: user.name,
          process: processLabel,
          lawsuit_id: p.lawsuits_id || null,
          post_id: p.id,
          source: 'post'
        });
      }
    }

    console.log(`[Alice] ${allDeadlines.length} entradas prazo-usuário pendentes.`);

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const nextWeek = new Date(today); nextWeek.setDate(nextWeek.getDate() + 7);

    const classified = allDeadlines.map(d => {
      const dl = parseDeadline(d.date_deadline);
      if (!dl || isNaN(dl)) return null;
      const dlTime = dl.getTime();
      let status;
      if (dlTime < today.getTime()) status = 'overdue';
      else if (dlTime === today.getTime()) status = 'today';
      else if (dlTime === tomorrow.getTime()) status = 'tomorrow';
      else if (dl <= nextWeek) status = 'this_week';
      else status = 'future';
      const daysOverdue = status === 'overdue'
        ? Math.floor((today.getTime() - dlTime) / 86400000) : 0;
      return { ...d, status, daysOverdue };
    }).filter(Boolean);

    const typeMatch = (type, kw) =>
      (type || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(kw);

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

    const overdue = classified.filter(d => d.status === 'overdue')
      .sort((a, b) => b.daysOverdue - a.daysOverdue);
    const upcoming = classified.filter(d => d.status !== 'overdue')
      .sort((a, b) => new Date(a.date_deadline) - new Date(b.date_deadline));

    deadlinesCache = {
      summary,
      next7: classified.filter(d => ['today', 'tomorrow', 'this_week'].includes(d.status))
        .sort((a, b) => new Date(a.date_deadline) - new Date(b.date_deadline)),
      upcoming,
      overdue,
      total: classified.length,
      debug: {
        totalPosts: allPosts.length,
        postsWithDeadline: allPosts.filter(p => p.date_deadline).length,
        prazoEntries: allDeadlines.length,
        classified: classified.length
      }
    };
    deadlinesFetchedAt = Date.now();
    deadlinesLastError = 0;
    console.log(`[Alice] Cache pronto: ${classified.length} prazos | ${deadlinesCache.overdue.length} atrasados`);
  } catch (err) {
    console.error('[Alice] Erro ao construir cache:', err.message);
    deadlinesLastError = Date.now();
  } finally {
    deadlinesFetching = false;
  }
}

// Inicia o cache logo após o servidor subir (pouquíssimas chamadas agora)
setTimeout(() => buildDeadlinesCache(), 5000);

// Rota de prazos — responde do cache instantaneamente
app.get('/api/deadlines', (req, res) => {
  const now = Date.now();
  const isStale = !deadlinesFetchedAt || (now - deadlinesFetchedAt) > CACHE_TTL_MS;

  if (isStale && !deadlinesFetching) {
    buildDeadlinesCache(); // refresh em background
  }

  if (deadlinesCache) {
    res.json({ ...deadlinesCache, cachedAt: new Date(deadlinesFetchedAt).toISOString() });
  } else {
    // Ainda carregando pela primeira vez
    res.json({
      loading: true,
      summary: { today: 0, tomorrow: 0, audiencias_week: 0, pericias_week: 0 },
      next7: [], overdue: [], total: 0
    });
  }
});

// ── Helpers de campo e normalização ──────────────────────────────────────────
function norm(str) {
  return (str || '').toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function getField(obj, ...keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return null;
}

// ── Cache de cadastros pendentes ──────────────────────────────────────────────
let registrationsCache = null;
let registrationsFetchedAt = null;
let registrationsFetching = false;
const REG_CACHE_TTL_MS = 20 * 60 * 1000; // 20 min

const RESPONSAVEIS_VALIDOS = ['THIAGO', 'MARILIA', 'LETICIA', 'EDUARDO', 'TAMMYRES'];
const BPC_TRIGGERS = ['BPC', 'BENEFICIO ASSISTENCIAL', 'AUXILIO DOENCA', 'AUXÍLIO DOENÇA', 'BENEFÍCIO ASSISTENCIAL'];
const LAUDO_OPCOES = ['COM LAUDO', 'SEM LAUDO', 'LAUDO OK', 'FAZER LAUDO', 'AGUARDANDO LAUDO'];
const ORIGEM_ORGANICA = ['ORGANICO', 'PARCERIA', 'ESCRITORIO', 'INDICACAO', 'INDICAÇÃO', 'ORGÂNICO', 'ESCRITÓRIO'];

async function buildRegistrationsCache() {
  if (registrationsFetching) return;
  registrationsFetching = true;
  console.log('[Cadastros] Buscando processos para validação...');
  try {
    const data = await callAdvBox('/lawsuits?limit=1000');
    const all = data.data || [];

    const results = [];

    for (const l of all) {
      // Detecta campo de data de cadastro
      const dateStr = getField(l,
        'created_at', 'date_cadastro', 'dt_cadastro',
        'date_registration', 'registration_date', 'date', 'created'
      );
      if (!dateStr) continue;

      const dateObj = parseDeadline(String(dateStr));
      if (!dateObj || isNaN(dateObj)) continue;

      // Anotações gerais (normalizado)
      const rawNotes = getField(l,
        'general_notes', 'annotations', 'notes',
        'general_annotation', 'anotacoes', 'note', 'observation'
      ) || '';
      const notes = norm(rawNotes);

      // Tipo de ação
      const rawTipo = getField(l,
        'type_of_action', 'action_type', 'tipo_acao',
        'lawsuit_type', 'type', 'kind', 'action'
      ) || '';
      const tipoNorm = norm(rawTipo);

      // Nome do cliente
      const clientsArr = Array.isArray(l.customers) ? l.customers : [];
      let clientName = '';
      if (clientsArr.length > 0) {
        const personal = clientsArr.find(c =>
          c.name && !/INSS|INSTITUTO NACIONAL|PREVIDENCIA|ESTADO|MUNICIPIO|UNIAO FEDERAL/i.test(norm(c.name))
        );
        clientName = (personal || clientsArr[0]).name || '';
      } else {
        clientName = getField(l, 'customer_name', 'client_name', 'customers_name') || '';
      }

      // Responsável
      const responsible = getField(l,
        'responsible', 'responsible_name', 'user_name', 'lawyer', 'attorney'
      ) || '';

      const problemas = [];

      // ── Regra 1: FECHADO POR ──────────────────────────────────────────────
      const hasFechadoPor = RESPONSAVEIS_VALIDOS.some(r =>
        notes.includes(`FECHADO POR ${r}`) ||
        notes.includes(`FECHADO POR: ${r}`) ||
        notes.includes(`FECHADO ${r}`)
      );
      if (!hasFechadoPor) {
        problemas.push({ code: 'SEM_FECHADO_POR', label: 'Sem fechado por', severity: 'critical' });
      }

      // ── Regra 2: LAUDO (só BPC / Aux Doença) ─────────────────────────────
      const isBpcAux = BPC_TRIGGERS.some(k => tipoNorm.includes(k));
      if (isBpcAux) {
        const hasLaudo = LAUDO_OPCOES.some(k => notes.includes(k));
        if (!hasLaudo) {
          problemas.push({ code: 'SEM_LAUDO', label: 'Sem laudo', severity: 'critical' });
        }
      }

      // ── Regra 3: CAMPANHA (heurística) ───────────────────────────────────
      // Só aplica se o processo já foi fechado (tem "FECHADO POR")
      if (hasFechadoPor) {
        const temOrigemOrganica = ORIGEM_ORGANICA.some(k => notes.includes(k));
        const temCampanha = notes.includes('CAMPANHA');
        if (!temOrigemOrganica && !temCampanha) {
          problemas.push({ code: 'SEM_CAMPANHA', label: 'Sem campanha', severity: 'mild' });
        }
      }

      const id = l.id || l.lawsuits_id;
      const processNum = l.process_number || l.protocol_number || `#${id}`;
      const severity = problemas.some(p => p.severity === 'critical')
        ? 'critical' : problemas.length > 0 ? 'mild' : 'ok';

      results.push({
        id,
        processo: processNum,
        cliente: clientName,
        tipo: rawTipo,
        data: dateStr,
        responsavel: responsible,
        problemas,
        severity
      });
    }

    // Ordena: críticos > leves > ok, depois por data desc dentro de cada grupo
    const order = { critical: 0, mild: 1, ok: 2 };
    results.sort((a, b) => {
      const d = order[a.severity] - order[b.severity];
      if (d !== 0) return d;
      return new Date(b.data) - new Date(a.data);
    });

    registrationsCache = { results };
    registrationsFetchedAt = Date.now();
    const crit = results.filter(r => r.severity === 'critical').length;
    const mild = results.filter(r => r.severity === 'mild').length;
    const ok   = results.filter(r => r.severity === 'ok').length;
    console.log(`[Cadastros] Pronto: ${results.length} processos com data | ${crit} críticos | ${mild} leves | ${ok} ok`);
  } catch (err) {
    console.error('[Cadastros] Erro:', err.message);
  } finally {
    registrationsFetching = false;
  }
}

app.get('/api/incomplete-registrations', (req, res) => {
  const now = Date.now();
  const isStale = !registrationsFetchedAt || (now - registrationsFetchedAt) > REG_CACHE_TTL_MS;
  if (isStale && !registrationsFetching) buildRegistrationsCache();

  if (registrationsCache) {
    res.json({ ...registrationsCache, loading: false, cachedAt: new Date(registrationsFetchedAt).toISOString() });
  } else {
    res.json({ loading: true, results: [] });
  }
});

app.listen(PORT, () => {
  console.log(`Dashboard rodando em http://localhost:${PORT}`);
  if (!ADVBOX_TOKEN) {
    console.log('ATENCAO: Configure o token em Secrets (ADVBOX_TOKEN)');
  }
});
