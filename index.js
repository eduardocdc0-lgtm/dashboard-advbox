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
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

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
    const data = await callAdvBox('/lawsuits?limit=1000');
    const all = data.data || [];

    // Processos ativos: sem status de encerramento
    const FECHADOS = ['TRANSITADO', 'TRANSITO', 'ARQUIVADO', 'ENCERRADO', 'CANCELADO', 'EXTINTO'];
    const active = all.filter(l => {
      if (!l.status_closure) return true;
      const sc = norm(String(l.status_closure));
      return !FECHADOS.some(k => sc.includes(k));
    });

    // Agrupa por responsável
    const grouped = {};
    for (const l of active) {
      const resp = (l.responsible || 'SEM RESPONSÁVEL').trim();
      if (!grouped[resp]) grouped[resp] = { responsible: resp, processes: [] };

      const clientsArr = Array.isArray(l.customers) ? l.customers : [];
      const personal = clientsArr.find(c =>
        c.name && !/INSS|INSTITUTO NACIONAL|PREVIDENCIA|ESTADO|MUNICIPIO|UNIAO FEDERAL/i.test(norm(c.name))
      );
      const clientName = (personal || clientsArr[0] || {}).name || '';

      grouped[resp].processes.push({
        id:        l.id,
        processo:  l.process_number || l.protocol_number || `#${l.id}`,
        cliente:   clientName,
        tipo:      l.type || '',
        fase:      l.stage || '',
        etapa:     l.step  || '',
        created_at: l.created_at || ''
      });
    }

    // Ordena processos: mais antigo primeiro
    Object.values(grouped).forEach(g =>
      g.processes.sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    );

    // Ordena responsáveis: mais carregado primeiro
    const responsaveis = Object.values(grouped)
      .sort((a, b) => b.processes.length - a.processes.length);

    distCache = { responsaveis, total: active.length, cachedAt: new Date().toISOString() };
    distFetchedAt = Date.now();
    res.json(distCache);
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
