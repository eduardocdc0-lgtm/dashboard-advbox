// ========================================
// Dashboard AdvBox - Servidor Proxy
// ========================================
// Este servidor faz o "meio-campo" entre seu dashboard (HTML) e a API do AdvBox.
// Ele resolve o problema de CORS e mantém o token seguro no servidor.

const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const cookieSession = require('cookie-session');

const app = express();
const PORT = process.env.PORT || 5000;

const ADVBOX_TOKEN    = process.env.ADVBOX_TOKEN || '';
const ADVBOX_BASE_URL = 'https://app.advbox.com.br/api/v1';

// ── Credenciais ──────────────────────────────────────────────────────────────
const USERS = {
  [process.env.ADMIN_USER || 'eduardo']: {
    password: process.env.ADMIN_PASS || '',
    role: 'admin'
  },
  [process.env.TEAM_USER || 'time']: {
    password: process.env.TEAM_PASS || '',
    role: 'team'
  }
};

// ── Sessão (cookie assinado — funciona em autoscale/Cloud Run) ────────────────
app.use(cookieSession({
  name:   'advsess',
  secret: process.env.SESSION_SECRET || 'advbox-sess-secret-2025',
  maxAge: 12 * 60 * 60 * 1000,   // 12 horas
  httpOnly: true,
  sameSite: 'lax'
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

// ── Auth middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'não autenticado' });
}

// ── Login / Logout / Me ──────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = USERS[username];
  if (!user || user.password === '' || user.password !== password) {
    return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
  }
  req.session.user = { username, role: user.role };
  res.json({ ok: true, role: user.role });
});

app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (req.session && req.session.user) {
    return res.json({ loggedIn: true, role: req.session.user.role, username: req.session.user.username });
  }
  res.json({ loggedIn: false });
});

// Protege todas as demais rotas /api/* — precisa estar logado
app.use('/api', (req, res, next) => {
  const open = ['/api/login', '/api/logout', '/api/me'];
  if (open.includes(req.path)) return next();
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'não autenticado' });
});

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

// ── Cache compartilhado de lawsuits (usado por /api/lawsuits e /api/distribution) ──
let sharedLawsuitsCache = null;
let sharedLawsuitsAt = null;
let sharedLawsuitsPromise = null;
const LAWSUITS_TTL_MS = 20 * 60 * 1000;

async function fetchLawsuits(force = false) {
  const now = Date.now();
  const stale = !sharedLawsuitsAt || (now - sharedLawsuitsAt) > LAWSUITS_TTL_MS;
  if (!force && !stale && sharedLawsuitsCache) return sharedLawsuitsCache;
  if (sharedLawsuitsPromise) return sharedLawsuitsPromise;
  sharedLawsuitsPromise = callAdvBox('/lawsuits?limit=1000').then(data => {
    sharedLawsuitsCache = data;
    sharedLawsuitsAt = Date.now();
    sharedLawsuitsPromise = null;
    return data;
  }).catch(err => {
    sharedLawsuitsPromise = null;
    throw err;
  });
  return sharedLawsuitsPromise;
}

app.get('/api/lawsuits', async (req, res) => {
  try {
    const force = req.query.force === '1';
    const data = await fetchLawsuits(force);
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

// Debug: inspeciona formato dos campos de posts
app.get('/api/debug-posts', async (req, res) => {
  try {
    const data = await callAdvBox('/posts?limit=20');
    const posts = Array.isArray(data) ? data : (data.data || []);
    const sample = posts.slice(0, 5).map(p => ({
      task: p.task,
      lawsuits_id: p.lawsuits_id,
      users: (p.users || []).slice(0, 3).map(u => ({
        name: u.name,
        completed: u.completed,
        completed_type: typeof u.completed
      }))
    }));
    res.json({ total: posts.length, today: new Date().toISOString(), sample });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cache para dados do Fluxo (movimentos + posts)
let flowCache = null;
let flowCacheAt = null;
const FLOW_TTL_MS = 20 * 60 * 1000;

// Busca todas as páginas de posts até esgotar ou atingir maxPages
async function fetchAllPosts(limitPerPage = 500, maxPages = 4, delayMs = 800) {
  const all = [];
  for (let page = 0; page < maxPages; page++) {
    const offset = page * limitPerPage;
    const endpoint = `/posts?limit=${limitPerPage}&offset=${offset}`;
    let data;
    try {
      data = await callAdvBox(endpoint);
    } catch (e) {
      if (e.message === 'RATE_LIMIT' && page > 0) break; // temos dados parciais
      throw e;
    }
    const items = Array.isArray(data) ? data : (data.data || []);
    all.push(...items);
    console.log(`[Posts] página ${page + 1}: ${items.length} posts (total acumulado: ${all.length})`);
    if (items.length < limitPerPage) break; // última página
    if (page < maxPages - 1) await new Promise(r => setTimeout(r, delayMs));
  }
  return all;
}

app.get('/api/flow', async (req, res) => {
  try {
    const now = Date.now();
    if (flowCache && flowCacheAt && (now - flowCacheAt) < FLOW_TTL_MS) {
      return res.json(flowCache);
    }
    const [movData, posts] = await Promise.all([
      callAdvBox('/last_movements?limit=500'),
      fetchAllPosts()
    ]);
    flowCache = {
      movements: Array.isArray(movData) ? movData : (movData.data || []),
      posts
    };
    flowCacheAt = now;
    res.json(flowCache);
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
const ORIGEM_ORGANICA = ['ORGANICO', 'PARCERIA', 'PARCEIRO', 'PARCEIRA', 'ESCRITORIO', 'INDICACAO', 'INDICAÇÃO', 'ORGÂNICO', 'ESCRITÓRIO'];
const CAMPANHAS_CONHECIDAS = ['LAUDO DO SUS'];

async function buildRegistrationsCache() {
  if (registrationsFetching) return;
  registrationsFetching = true;
  console.log('[Cadastros] Buscando processos para validação...');
  try {
    const data = await fetchLawsuits();
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
      const hasFechadoPor = RESPONSAVEIS_VALIDOS.some(r => {
        if (notes.includes(`FECHADO POR ${r}`)) return true;
        if (notes.includes(`FECHADO POR: ${r}`)) return true;
        if (notes.includes(`FECHADO ${r}`)) return true;
        // ex: "FECHADO POR ANA MARILIA" — responsável após outra palavra
        const i = notes.indexOf('FECHADO POR ');
        if (i >= 0 && notes.slice(i + 12, i + 40).includes(r)) return true;
        return false;
      });
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
        const temCampanha = notes.includes('CAMPANHA') || CAMPANHAS_CONHECIDAS.some(c => notes.includes(c));
        if (!temOrigemOrganica && !temCampanha) {
          problemas.push({ code: 'SEM_CAMPANHA', label: 'Canal não identificado', severity: 'mild' });
        }
      }

      // ── Classifica origem do processo ────────────────────────────────────
      let origem = 'DESCONHECIDO';
      if (['PARCERIA', 'PARCEIRO', 'PARCEIRA'].some(k => notes.includes(k))) {
        origem = 'PARCEIRO';
      } else if (['ORGANICO', 'ORGÂNICO', 'ESCRITORIO', 'ESCRITÓRIO', 'INDICACAO', 'INDICAÇÃO'].some(k => notes.includes(k))) {
        origem = 'ORGANICO';
      } else if (notes.includes('CAMPANHA') || CAMPANHAS_CONHECIDAS.some(c => notes.includes(c))) {
        origem = 'CAMPANHA';
      }

      // ── Extrai nome da campanha ───────────────────────────────────────────
      let campanhaNome = '';
      if (origem === 'CAMPANHA') {
        const ci = notes.indexOf('CAMPANHA ');
        if (ci >= 0) {
          const after = notes.slice(ci + 9);
          const end = after.search(/[,.|;]/);
          campanhaNome = (end >= 0 ? after.slice(0, end) : after.slice(0, 50)).trim();
        } else {
          campanhaNome = CAMPANHAS_CONHECIDAS.find(c => notes.includes(c)) || '';
        }
      }

      // ── Classifica status do laudo (só BPC / Aux) ────────────────────────
      let laudoStatus = 'N/A';
      if (isBpcAux) {
        laudoStatus = LAUDO_OPCOES.find(k => notes.includes(k)) || 'PENDENTE';
      }

      // Extrai quem fechou das notas ("FECHADO POR ANA MARILIA, ..." → "ANA MARILIA")
      let fechadoPorNome = '';
      const fpIdx = notes.indexOf('FECHADO POR ');
      if (fpIdx >= 0) {
        const after = notes.slice(fpIdx + 12);
        const end = after.search(/[,.|;]/);
        fechadoPorNome = (end >= 0 ? after.slice(0, end) : after.slice(0, 35)).trim();
      } else {
        const fpIdx2 = notes.indexOf('FECHADO POR: ');
        if (fpIdx2 >= 0) {
          const after = notes.slice(fpIdx2 + 13);
          const end = after.search(/[,.|;]/);
          fechadoPorNome = (end >= 0 ? after.slice(0, end) : after.slice(0, 35)).trim();
        }
      }

      const id = l.id || l.lawsuits_id;
      const processNum = l.process_number || l.protocol_number || `#${id}`;
      const severity = problemas.some(p => p.severity === 'critical')
        ? 'critical' : problemas.length > 0 ? 'mild' : 'ok';

      // ── Campos financeiros ────────────────────────────────────────────────
      const rawCauseValue  = getField(l, 'fees_expec');
      const rawFees        = getField(l, 'fees_money');
      const rawFeesPercent = getField(l, 'contingency');

      const causeValue  = parseFloat(String(rawCauseValue  || '0').replace(/[^0-9.,]/g, '').replace(',', '.')) || 0;
      const feesValue   = parseFloat(String(rawFees        || '0').replace(/[^0-9.,]/g, '').replace(',', '.')) || 0;
      const feesPercent = parseFloat(String(rawFeesPercent || '0').replace(/[^0-9.,]/g, '').replace(',', '.')) || 0;

      results.push({
        id,
        processo: processNum,
        cliente: clientName,
        tipo: rawTipo,
        data: dateStr,
        responsavel: responsible,
        fechadoPor: fechadoPorNome,
        origem,
        campanha: campanhaNome,
        laudoStatus,
        problemas,
        severity,
        causeValue,
        feesValue,
        feesPercent
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
  const force = req.query.force === '1';
  const now = Date.now();
  const isStale = !registrationsFetchedAt || (now - registrationsFetchedAt) > REG_CACHE_TTL_MS;

  if ((force || isStale) && !registrationsFetching) {
    if (force) {
      registrationsCache = null;
      registrationsFetchedAt = null;
    }
    buildRegistrationsCache();
  }

  if (registrationsCache) {
    res.json({ ...registrationsCache, loading: false, cachedAt: new Date(registrationsFetchedAt).toISOString() });
  } else {
    res.json({ loading: true, results: [] });
  }
});


// ── Distribuição por Responsável ─────────────────────────────────────────────
let distCache = null;
let distFetchedAt = null;
const DIST_TTL_MS = 20 * 60 * 1000;

app.get('/api/distribution', async (req, res) => {
  const force = req.query.force === '1';
  const now = Date.now();
  const stale = !distFetchedAt || (now - distFetchedAt) > DIST_TTL_MS;

  if (!force && !stale && distCache) {
    return res.json(distCache);
  }

  try {
    const data = await fetchLawsuits(force);
    const all = data.data || [];

    // Stages de arquivamento — mesmo critério do card "A RECEBER"
    const STAGES_ARQUIVAMENTO = ['IGNORAR','ARQUIV','CANCELADO','AGUARDAR DATA','NÃO DISTRIBUÍDO'];

    // Agrupa por responsável — inclui todos os processos com classificação
    // ativo     = sem exit_production E sem exit_execution E stage não é de arquivamento
    // encerrado = tem exit_production OU exit_execution OU stage é de arquivamento
    const grouped = {};
    for (const l of all) {
      const resp = (l.responsible || 'SEM RESPONSÁVEL').trim();
      if (!grouped[resp]) grouped[resp] = { responsible: resp, processes: [] };

      const stageUp = (l.stage || '').toUpperCase();
      const isArquivamento = STAGES_ARQUIVAMENTO.some(k => stageUp.includes(k));
      const grupo = (l.exit_production || l.exit_execution || isArquivamento) ? 'encerrado' : 'ativo';

      const clientsArr = Array.isArray(l.customers) ? l.customers : [];
      const personal = clientsArr.find(c =>
        c.name && !/INSS|INSTITUTO NACIONAL|PREVIDENCIA|ESTADO|MUNICIPIO|UNIAO FEDERAL/i.test(norm(c.name))
      );
      const clientName = (personal || clientsArr[0] || {}).name || '';

      grouped[resp].processes.push({
        id:         l.id,
        processo:   l.process_number || l.protocol_number || `#${l.id}`,
        cliente:    clientName,
        tipo:       l.type || '',
        fase:       l.stage || '',
        etapa:      l.step  || '',
        created_at: l.created_at || '',
        grupo:      grupo
      });
    }

    // Ordena processos: mais antigo primeiro
    Object.values(grouped).forEach(g =>
      g.processes.sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    );

    // Ordena responsáveis: mais ativos primeiro
    const responsaveis = Object.values(grouped)
      .sort((a, b) => {
        const aAtivos = a.processes.filter(p => p.grupo === 'ativo').length;
        const bAtivos = b.processes.filter(p => p.grupo === 'ativo').length;
        return bAtivos - aAtivos;
      });

    const totalAtivos = responsaveis.reduce((s, r) =>
      s + r.processes.filter(p => p.grupo === 'ativo').length, 0);

    distCache = { responsaveis, total: totalAtivos, cachedAt: new Date().toISOString() };
    distFetchedAt = Date.now();
    res.json(distCache);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Meta Ads ──────────────────────────────────────────────────────────────────
const META_TOKEN      = process.env.META_TOKEN || '';
const META_AD_ACCOUNT = process.env.META_AD_ACCOUNT || '';
const META_BASE       = 'https://graph.facebook.com/v19.0';

let metaCache    = {};
const META_TTL   = 15 * 60 * 1000;

app.get('/api/meta-ads', async (req, res) => {
  const preset = req.query.date_preset || 'last_30d';
  const force  = req.query.force === '1';
  const now    = Date.now();

  if (!force && metaCache[preset] && (now - metaCache[preset].at) < META_TTL) {
    return res.json(metaCache[preset].data);
  }
  if (!META_TOKEN || !META_AD_ACCOUNT) {
    return res.status(500).json({ error: 'META_TOKEN ou META_AD_ACCOUNT não configurados.' });
  }

  try {
    const fields = 'id,name,status,objective,daily_budget,lifetime_budget,start_time,stop_time';
    const campsUrl = `${META_BASE}/${META_AD_ACCOUNT}/campaigns?fields=${fields}&limit=100&access_token=${META_TOKEN}`;
    const campsRes = await fetch(campsUrl);
    const campsJson = await campsRes.json();
    if (campsJson.error) throw new Error('Campaigns: ' + campsJson.error.message);
    const campaigns = campsJson.data || [];
    console.log(`[Meta] Campanhas: ${campaigns.length} | preset: ${preset}`);

    const insightFields = 'campaign_id,campaign_name,impressions,clicks,spend,reach,cpm,cpc,ctr,actions';
    const insUrl = `${META_BASE}/${META_AD_ACCOUNT}/insights?fields=${insightFields}&date_preset=${preset}&level=campaign&limit=100&access_token=${META_TOKEN}`;
    const insRes = await fetch(insUrl);
    const insJson = await insRes.json();
    if (insJson.error) throw new Error('Insights: ' + insJson.error.message);
    const insights = insJson.data || [];
    console.log(`[Meta] Insights: ${insights.length} registros | Ex: ${insights[0] ? JSON.stringify(Object.keys(insights[0])) : 'nenhum'}`);
    if (insights[0]) console.log(`[Meta] Amostra insight:`, JSON.stringify(insights[0]).slice(0, 200));

    // Mapeia por id e por nome para garantir o match
    const insMapById   = {};
    const insMapByName = {};
    insights.forEach(i => {
      if (i.campaign_id)   insMapById[i.campaign_id]     = i;
      if (i.campaign_name) insMapByName[i.campaign_name] = i;
    });

    const result = campaigns.map(c => {
      const ins = insMapById[c.id] || insMapByName[c.name] || {};
      const actions = ins.actions || [];
      const whatsapp = actions.find(a => a.action_type === 'onsite_conversion.total_messaging_connection');
      const leads    = actions.find(a => a.action_type === 'lead' || a.action_type === 'onsite_conversion.lead_grouped');
      return {
        id:           c.id,
        name:         c.name,
        status:       c.status,
        objective:    c.objective || '',
        daily_budget: c.daily_budget ? (Number(c.daily_budget) / 100) : null,
        start_time:   c.start_time || '',
        stop_time:    c.stop_time  || '',
        spend:        Number(ins.spend  || 0),
        impressions:  Number(ins.impressions || 0),
        clicks:       Number(ins.clicks || 0),
        reach:        Number(ins.reach  || 0),
        cpm:          Number(ins.cpm    || 0),
        cpc:          Number(ins.cpc    || 0),
        ctr:          Number(ins.ctr    || 0),
        whatsapp:     Number(whatsapp ? whatsapp.value : 0),
        leads:        Number(leads    ? leads.value    : 0),
      };
    });

    const payload = { campaigns: result, period: preset, fetchedAt: new Date().toISOString() };
    metaCache[preset] = { data: payload, at: now };
    res.json(payload);
  } catch (err) {
    console.error('meta-ads:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── EVOLUÇÃO: Contratos e Faturamento por mês ───────────────────────────────
let evolucaoCache = null;
let evolucaoCacheAt = 0;
const EVOLUCAO_TTL = 30 * 60 * 1000; // 30 min

app.get('/api/evolucao', async (req, res) => {
  try {
    const now = Date.now();
    if (evolucaoCache && (now - evolucaoCacheAt) < EVOLUCAO_TTL) {
      return res.json(evolucaoCache);
    }

    const byMonth    = {};
    const faturMonth = {};
    const expecMonth = {};
    let page = 0;

    while (page < 20) {
      const data = await callAdvBox(`/lawsuits?limit=500&offset=${page * 500}`);
      const arr  = Array.isArray(data) ? data : (data.data || []);
      if (!arr.length) break;

      arr.forEach(l => {
        const dt = (l.created_at || l.process_date || '').slice(0, 7);
        if (!dt || dt < '2025-01' || dt > '2030-12') return;
        byMonth[dt]    = (byMonth[dt]    || 0) + 1;
        if (l.fees_money)  faturMonth[dt] = (faturMonth[dt] || 0) + parseFloat(l.fees_money);
        if (l.fees_expec)  expecMonth[dt] = (expecMonth[dt] || 0) + parseFloat(l.fees_expec);
      });

      page++;
      if (arr.length < 500) break;
      await new Promise(r => setTimeout(r, 200));
    }

    // Gera série completa desde 2025-01 até mês corrente
    const curYM = new Date().toISOString().slice(0, 7);
    const months = [];
    let ym = '2025-01';
    while (ym <= curYM) {
      months.push(ym);
      const [y, m] = ym.split('-').map(Number);
      const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
      ym = next;
    }

    const payload = {
      months,
      contratos: months.map(m => byMonth[m] || 0),
      faturamento: months.map(m => Math.round(faturMonth[m] || 0)),
      expec:       months.map(m => Math.round(expecMonth[m] || 0)),
      fetchedAt: new Date().toISOString()
    };

    evolucaoCache   = payload;
    evolucaoCacheAt = now;
    res.json(payload);
  } catch (err) {
    console.error('evolucao:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Cache compartilhado de transações ────────────────────────────────────────
let transCache = null;
let transCacheAt = null;
const TRANS_TTL_MS = 30 * 60 * 1000;

async function fetchTransactions() {
  const now = Date.now();
  if (transCache && transCacheAt && (now - transCacheAt) < TRANS_TTL_MS) return transCache;
  const data = await callAdvBox('/transactions?limit=1000');
  transCache = data;
  transCacheAt = now;
  return data;
}

// ── Fases do Kanban Financeiro (Auditoria) ────────────────────────────────────
const FASES_COBRANCA_ATIVA = [
  'Salario Maternidade Parcelado',
  'Judicial Parcelado',
  'Adm Parcelado',
  'Rpv do Mês'
];
const FASES_MONITORAMENTO_AUDIT = [
  'Rpv do Proximo Mês',
  'Judicial Implantado a Receber',
  'Adm Implantado a Receber',
  'Salario Maternidade Concedido'
];

function normFase(s) {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
}

function matchFaseList(stage, faseList) {
  const st = normFase(stage);
  return faseList.some(f => {
    const fn = normFase(f);
    return st === fn || st.includes(fn) || fn.includes(st);
  });
}

let auditCache = {};
const AUDIT_TTL = 30 * 60 * 1000;

app.get('/api/audit/kanban-financeiro', async (req, res) => {
  const now = Date.now();
  const today = new Date();
  const defaultMes = String(today.getMonth() + 1).padStart(2, '0') + '/' + today.getFullYear();
  const mes = req.query.mes || defaultMes;

  if (auditCache[mes] && (now - auditCache[mes].at) < AUDIT_TTL) {
    return res.json(auditCache[mes].data);
  }

  try {
    const [lawData, txData] = await Promise.all([fetchLawsuits(), fetchTransactions()]);
    const lawsuits     = Array.isArray(lawData) ? lawData : (lawData.data || []);
    const transactions = Array.isArray(txData)  ? txData  : (txData.data  || []);

    // Transações de receita do mês auditado
    const txDoMes = transactions.filter(t => t.entry_type === 'income' && t.competence === mes);

    // Índice: lawsuitId (string) → transações do mês
    const txByLawsuit = {};
    txDoMes.forEach(t => {
      const lid = String(t.lawsuits_id || t.lawsuit_id || '');
      if (!lid) return;
      if (!txByLawsuit[lid]) txByLawsuit[lid] = [];
      txByLawsuit[lid].push(t);
    });

    // Último lançamento de receita por processo (qualquer mês)
    const lastTxByLawsuit = {};
    transactions.filter(t => t.entry_type === 'income').forEach(t => {
      const lid = String(t.lawsuits_id || t.lawsuit_id || '');
      if (!lid) return;
      const existing = lastTxByLawsuit[lid];
      const tDate = t.date_payment || t.date_due || '';
      if (!existing || tDate > (existing.date_payment || existing.date_due || '')) {
        lastTxByLawsuit[lid] = t;
      }
    });

    const criticos = [], monitoramento = [], ok = [];

    for (const l of lawsuits) {
      const stage = l.stage || l.step || '';
      const isCobranca = matchFaseList(stage, FASES_COBRANCA_ATIVA);
      const isMonitor  = matchFaseList(stage, FASES_MONITORAMENTO_AUDIT);
      if (!isCobranca && !isMonitor) continue;

      const clientsArr = Array.isArray(l.customers) ? l.customers : [];
      const personal = clientsArr.find(c =>
        c.name && !/INSS|INSTITUTO NACIONAL|PREVIDENCIA|ESTADO|MUNICIPIO|UNIAO FEDERAL/i.test((c.name || '').toUpperCase())
      );
      const cliente = (personal || clientsArr[0] || {}).name || l.customer_name || `#${l.id}`;

      const stageAt = l.stage_date || l.stage_at || l.updated_at || l.created_at || '';
      const diasNaFase = stageAt
        ? Math.max(0, Math.floor((now - new Date(stageAt).getTime()) / 86400000))
        : null;

      const feesValue = parseFloat(String(l.fees_money || '0').replace(/[^0-9.,]/g, '').replace(',', '.')) || 0;
      const lawId     = String(l.id || l.lawsuits_id || '');
      const processNum = l.process_number || l.protocol_number || `#${lawId}`;

      const entry = {
        lawsuitId:  lawId,
        cliente,
        processo:   processNum,
        fase:       stage,
        diasNaFase,
        valorFees:  feesValue,
        responsavel: l.responsible || '',
        linkAdvBox: `https://app.advbox.com.br/lawsuits/${lawId}`
      };

      if (isCobranca) {
        const txMes  = txByLawsuit[lawId] || [];
        const lastTx = lastTxByLawsuit[lawId];
        if (txMes.length === 0) {
          criticos.push({
            ...entry,
            ultimoLancamento: lastTx ? (lastTx.date_payment || lastTx.date_due || null) : null,
            ultimoValor: lastTx ? Number(lastTx.amount || 0) : null,
            motivo: `Em fase parcelada, sem lançamento em ${mes}`
          });
        } else {
          ok.push({
            ...entry,
            lancamentosDoMes: txMes.length,
            totalDoMes: txMes.reduce((s, t) => s + Number(t.amount || 0), 0)
          });
        }
      } else {
        monitoramento.push(entry);
      }
    }

    criticos.sort((a, b) => (b.diasNaFase || 0) - (a.diasNaFase || 0));
    monitoramento.sort((a, b) => (b.diasNaFase || 0) - (a.diasNaFase || 0));

    const result = {
      mes,
      criticos,
      monitoramento,
      ok,
      resumo: {
        totalProcessosAuditados: criticos.length + monitoramento.length + ok.length,
        criticosCount:           criticos.length,
        monitoramentoCount:      monitoramento.length,
        okCount:                 ok.length,
        valorTotalCriticos:      criticos.reduce((s, c) => s + (c.ultimoValor || 0), 0),
        valorTotalMonitoramento: monitoramento.reduce((s, c) => s + (c.valorFees || 0), 0)
      },
      cachedAt: new Date().toISOString()
    };

    auditCache[mes] = { data: result, at: now };
    console.log(`[Auditoria] ${mes}: ${criticos.length} críticos | ${monitoramento.length} monitoramento | ${ok.length} ok`);
    res.json(result);
  } catch (err) {
    console.error('[Auditoria] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Auditoria de Responsável ──────────────────────────────────────────────────
let _audrCache = null;
let _audrCacheAt = null;
const AUDR_TTL_MS = 20 * 60 * 1000;

const AUDR_ZONES = {
  MARILIA: [
    'PROCESSOS SEM LAUDOS','PERICIA MARCADA SEM DATA DE AUDIENCIA',
    'PARA DAR ENTRADA','PROTOCOLADO ADM','AUXILIO INCAPACIDADE',
    'PROCESSO COM GUARDA BPC','PERICIAS MARCADAS','EM ANALISE PERICIAS FEITAS'
  ],
  LETICIA_OU_ALICE: [
    'ELABORAR PETICAO INICIAL','PERICIA MEDICA MARCADA',
    'SENTENCA PROCEDENTE VERIFICAR IMPLANTACAO','PERICIA SOCIAL MARCADA',
    'COM PRAZO','SENTENCA IMPROCEDENTE','PROTOCOLADO JUDICIAL',
    'AGUARDANDO EXPEDICAO DE RPV','FAZER ACAO DE GUARDA',
    'PROCEDENTE EM PARTE FAZER RECURSO','IMPROCEDENTE CABE RECURSO',
    'DESENVOLVENDO RECURSO AOS TRIBUNAIS','RECURSO PROTOCOLADO INICIADO',
    'APRESENTADA RESPOSTA A RECURSO','AGUARDANDO JULGAMENTO DO RECURSO',
    'RECURSO JULGADO ENTRE EM CONTATO','TRANSITO EM JULGADO NAO CABE RECURSO'
  ],
  CAU: [
    'SALARIO MATERNIDADE PARCELADO','JUDICIAL PARCELADO','ADM PARCELADO',
    'RPV DO MES','RPV DO PROXIMO MES','JUDICIAL IMPLANTADO A RECEBER',
    'ADM IMPLANTADO A RECEBER','SALARIO MATERNIDADE CONCEDIDO',
    'ARQUIVADO IMPROCEDENTE','ARQUIVADO PROCEDENTE',
    'ARQUIVADO POR DETERMINACAO JUDICIAL','IGNORAR ESSA ETAPA',
    'CANCELADO REQUERIMENTO','BENEFICIO CONCEDIDO AGUARDAR'
  ]
};

const AUDR_ZONE_LABEL = {
  MARILIA:          'Ana Marília',
  LETICIA_OU_ALICE: 'Letícia ou Alice',
  CAU:              'Claudiana (Cau)'
};

function audrNorm(s) {
  return (s || '').toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

const AUDR_STAGE_MAP = {};
for (const [zone, stages] of Object.entries(AUDR_ZONES)) {
  stages.forEach(s => { AUDR_STAGE_MAP[audrNorm(s)] = zone; });
}

function audrZoneForStage(stage) {
  const n = audrNorm(stage);
  if (AUDR_STAGE_MAP[n]) return AUDR_STAGE_MAP[n];
  // Tolerant: try first 4 words match
  const nWords4 = n.split(' ').slice(0, 4).join(' ');
  for (const [mapped, zone] of Object.entries(AUDR_STAGE_MAP)) {
    const mWords4 = mapped.split(' ').slice(0, 4).join(' ');
    if (nWords4 === mWords4 && nWords4.length > 5) return zone;
    if (n.startsWith(mapped) || mapped.startsWith(n)) return zone;
  }
  return null;
}

function audrZoneForResp(responsible) {
  const n = audrNorm(responsible);
  if (n.includes('MARILIA')) return 'MARILIA';
  if (n.includes('LETICIA') || n.includes('ALICE')) return 'LETICIA_OU_ALICE';
  if (n.includes('CLAUDIANA') || n.includes('CAU')) return 'CAU';
  return null;
}

app.get('/api/audit-responsible', async (req, res) => {
  if (!req.session?.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acesso restrito a administradores.' });
  }
  const now = Date.now();
  const force = req.query.force === '1';
  if (!force && _audrCache && _audrCacheAt && (now - _audrCacheAt) < AUDR_TTL_MS) {
    return res.json(_audrCache);
  }
  try {
    const rawData = await fetchLawsuits(force);
    const lawsuits = Array.isArray(rawData) ? rawData : (rawData.data || []);

    const items = [];
    const byPerson = {};
    const byStage  = {};
    let totalAuditados = 0, totalCorretos = 0, totalErrados = 0, totalNaoMapeados = 0;

    for (const l of lawsuits) {
      if (l.status_closure) continue;
      const stage = l.stage || l.step || '';
      const responsible = l.responsible || '';
      const expectedZone = audrZoneForStage(stage);
      const actualZone   = audrZoneForResp(responsible);

      let clienteNome = '—';
      if (Array.isArray(l.customers) && l.customers.length) {
        clienteNome = l.customers[0].name || '—';
      }

      let status;
      if (!expectedZone) {
        status = 'NAO_MAPEADO';
        totalNaoMapeados++;
      } else {
        totalAuditados++;
        const isCorrect = expectedZone === 'LETICIA_OU_ALICE'
          ? actualZone === 'LETICIA_OU_ALICE'
          : actualZone === expectedZone;
        status = isCorrect ? 'CORRETO' : 'ERRADO';
        if (isCorrect) totalCorretos++;
        else {
          totalErrados++;
          const respKey = responsible || '(sem responsável)';
          if (!byPerson[respKey]) byPerson[respKey] = { responsible: respKey, total: 0, correto: 0, errado: 0, errosPorZona: {} };
          byPerson[respKey].total++;
          byPerson[respKey].errado++;
          byPerson[respKey].errosPorZona[expectedZone] = (byPerson[respKey].errosPorZona[expectedZone] || 0) + 1;

          const stageKey = audrNorm(stage);
          if (!byStage[stageKey]) byStage[stageKey] = { stage, expectedZone, total: 0, errado: 0, respAtualMap: {} };
          byStage[stageKey].total++;
          byStage[stageKey].errado++;
          byStage[stageKey].respAtualMap[responsible] = (byStage[stageKey].respAtualMap[responsible] || 0) + 1;
        }
      }

      items.push({
        id: l.id,
        cliente: clienteNome,
        numero: l.code || l.number || l.process_number || '',
        tipo: l.type || '',
        stage,
        responsible,
        expectedZone: expectedZone || null,
        expectedRespLabel: expectedZone ? AUDR_ZONE_LABEL[expectedZone] : null,
        actualZone: actualZone || null,
        status,
        link: `https://app.advbox.com.br/lawsuit/${l.id}`
      });
    }

    const byPersonArr = Object.values(byPerson).sort((a, b) => b.errado - a.errado);
    const byStageArr  = Object.values(byStage)
      .map(s => ({
        stage: s.stage,
        expectedZone: s.expectedZone,
        errado: s.errado,
        respMaisComum: Object.entries(s.respAtualMap).sort((a,b)=>b[1]-a[1])[0]?.[0] || '—',
        responsavelEsperado: AUDR_ZONE_LABEL[s.expectedZone] || s.expectedZone
      }))
      .sort((a, b) => b.errado - a.errado);

    const taxaAcerto = totalAuditados > 0
      ? Math.round(totalCorretos / totalAuditados * 100) : 100;

    const top5 = byPersonArr.slice(0, 5).map(p => `${p.responsible}: ${p.errado} erros`);
    console.log(`[Audit-Resp] ${totalAuditados} auditados | ${totalErrados} erros | ${taxaAcerto}% conformidade`);
    console.log('[Audit-Resp] Top5 com mais erros:', top5.join(', '));

    _audrCache = {
      items, summary: { totalAuditados, totalCorretos, totalErrados, totalNaoMapeados, taxaAcerto },
      byPerson: byPersonArr, byStage: byStageArr,
      computedAt: new Date().toISOString()
    };
    _audrCacheAt = now;
    res.json(_audrCache);
  } catch (err) {
    console.error('[Audit-Resp] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Debug: fases distintas nos processos ativos ──────────────────────────────
app.get('/api/audit-debug-stages', async (req, res) => {
  if (!req.session?.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acesso restrito.' });
  }
  try {
    const rawData = await fetchLawsuits();
    const lawsuits = Array.isArray(rawData) ? rawData : (rawData.data || []);
    const counts = {};
    for (const l of lawsuits) {
      if (l.status_closure) continue;
      const stage = (l.stage || l.step || '').trim();
      counts[stage] = (counts[stage] || 0) + 1;
    }
    const result = Object.entries(counts)
      .map(([stage, count]) => ({ stage, count }))
      .sort((a, b) => b.count - a.count);
    res.json({ total: lawsuits.filter(l => !l.status_closure).length, stages: result });
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
