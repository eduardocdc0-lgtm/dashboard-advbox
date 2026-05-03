const { Router } = require('express');
const fetch  = require('node-fetch');
const cache  = require('../../../cache');
const { fetchLawsuits } = require('../../../services/data');

const META_TOKEN      = process.env.META_TOKEN      || '';
const META_AD_ACCOUNT = process.env.META_AD_ACCOUNT || '';
const META_BASE       = 'https://graph.facebook.com/v19.0';

const router = Router();

// Origens AdvBox que indicam cliente adverso / não-contrato
const EXCLUDED_ORIGINS = new Set(['PARTE CONTRÁRIA','ADVERSO','INSS','INSTITUTO NACIONAL']);

// Origins que representam tráfego pago (agregado quando não há match por campanha)
const PAID_ORIGINS = ['trafego pago','instagram','google','facebook','meta','ads'];

// Normaliza string: lowercase, sem acento, sem emoji, trim
function normStr(s) {
  return (s || '')
    .trim()
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\\u{1F300}-\u{1FAFF}]/gu, '')   // emojis unicode
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Recife UTC-3
function todayRecife() {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

function periodToRange(period) {
  const today = todayRecife();
  const [y, m] = today.split('-').map(Number);

  if (period === 'this_month') {
    return { since: `${y}-${String(m).padStart(2, '0')}-01`, until: today };
  }
  if (period === 'last_month') {
    const lm = m === 1 ? 12 : m - 1;
    const ly = m === 1 ? y - 1 : y;
    const lastDay = new Date(y, m - 1, 0).getDate();
    return {
      since: `${ly}-${String(lm).padStart(2, '0')}-01`,
      until: `${ly}-${String(lm).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
    };
  }
  if (period === 'last_30d') {
    const d = new Date(Date.now() - 3 * 3600 * 1000 - 30 * 86400000);
    return { since: d.toISOString().slice(0, 10), until: today };
  }
  if (period === 'last_90d') {
    const d = new Date(Date.now() - 3 * 3600 * 1000 - 90 * 86400000);
    return { since: d.toISOString().slice(0, 10), until: today };
  }
  return { since: `${y}-${String(m).padStart(2, '0')}-01`, until: today };
}

// ── GET /api/meta/campaign-roi?period=this_month ───────────────────────────────
// Cruza campanhas Meta (gasto/leads) com contratos AdvBox (origem/receita).
// Matching por nome normalizado: campanha Meta vs campo `origin` do cliente.
// Receita = fees_expec (honorários contratados); fallback fees_money.
// Cache: 15 min por period.
router.get('/meta/campaign-roi', async (req, res, next) => {
  const period = req.query.period || 'this_month';
  const cacheKey = `roi:${period}`;
  cache.define(cacheKey, 15 * 60 * 1000);

  try {
    const data = await cache.getOrFetch(cacheKey, async () => {
      const range = periodToRange(period);

      // ── 1. Meta Ads: campanhas + insights no período ─────────────────────────
      let metaCampaigns = [];
      let metaError     = null;

      if (!META_TOKEN || !META_AD_ACCOUNT || META_TOKEN.length < 20) {
        metaError = 'META_TOKEN ou META_AD_ACCOUNT não configurados. Configure em Secrets.';
      } else {
        try {
          const timeRange = encodeURIComponent(JSON.stringify(range));
          const iFields   = 'campaign_id,campaign_name,spend,impressions,clicks,actions';
          const url = `${META_BASE}/${META_AD_ACCOUNT}/insights?fields=${iFields}&time_range=${timeRange}&level=campaign&limit=100&access_token=${META_TOKEN}`;

          const iRes  = await fetch(url);
          const iJson = await iRes.json();
          if (iJson.error) throw new Error(iJson.error.message);

          metaCampaigns = (iJson.data || []).map(i => {
            const actions = i.actions || [];
            const leads   = actions.find(a => a.action_type === 'lead' || a.action_type === 'onsite_conversion.lead_grouped');
            return {
              id:          i.campaign_id,
              name:        i.campaign_name,
              spend:       Number(i.spend  || 0),
              impressions: Number(i.impressions || 0),
              clicks:      Number(i.clicks || 0),
              leads:       Number(leads ? leads.value : 0),
            };
          });
        } catch (e) {
          metaError = e.message;
        }
      }

      // ── 2. AdvBox: processos no período com origem do cliente + honorários ────
      const allLawsuits = await fetchLawsuits();
      const lawsuitsArr = Array.isArray(allLawsuits) ? allLawsuits : (allLawsuits.data || []);

      // Filtra processos criados no período
      const periodLawsuits = lawsuitsArr.filter(l => {
        const ca = (l.created_at || '').slice(0, 10);
        return ca >= range.since && ca <= range.until;
      });

      // Agrupa por origem normalizada: count de contratos + soma de receita contratada
      const originMap = {}; // normOrigin → { raw, count, revenue }
      let attrLostCount = 0;

      for (const lawsuit of periodLawsuits) {
        const fees = Number(lawsuit.fees_expec || lawsuit.fees_money || 0);

        // Conta clientes sem origem (atribuição perdida)
        const clients = (lawsuit.customers || []);
        attrLostCount += clients.filter(c => !c.origin).length;

        for (const customer of clients) {
          const rawOrigin = (customer.origin || '').trim();
          if (!rawOrigin) continue;
          if (EXCLUDED_ORIGINS.has(rawOrigin.toUpperCase())) continue;

          const normOrigin = normStr(rawOrigin);
          if (!originMap[normOrigin]) {
            originMap[normOrigin] = { raw: rawOrigin, count: 0, revenue: 0 };
          }
          originMap[normOrigin].count++;
          if (fees > 0) originMap[normOrigin].revenue += fees;
        }
      }

      // ── 3. Cruzamento: nome da campanha Meta vs origem AdvBox ─────────────────
      const byCampaign = [];
      const unmatchedNames = [];

      for (const camp of metaCampaigns) {
        const normCamp = normStr(camp.name);

        // Tenta match exato, depois inclusão parcial
        let matched = null;
        for (const [normOrig, data] of Object.entries(originMap)) {
          if (normOrig === normCamp || normOrig.includes(normCamp) || normCamp.includes(normOrig)) {
            matched = data;
            break;
          }
        }

        const contracts = matched ? matched.count   : 0;
        const revenue   = matched ? matched.revenue : 0;
        const roas = camp.spend > 0 && revenue > 0 ? revenue / camp.spend : 0;
        const cpl  = camp.leads > 0 ? camp.spend / camp.leads : 0;
        const cpa  = contracts  > 0 ? camp.spend / contracts  : 0;

        byCampaign.push({
          id:          camp.id,
          name:        camp.name,
          spend:       camp.spend,
          impressions: camp.impressions,
          clicks:      camp.clicks,
          leads:       camp.leads,
          contracts,
          revenue,
          roas:    Number(roas.toFixed(2)),
          cpl:     Number(cpl.toFixed(2)),
          cpa:     Number(cpa.toFixed(2)),
          matched: !!matched,
        });

        if (!matched) unmatchedNames.push(camp.name);
      }

      // Ordena: cruzadas primeiro por ROAS desc; depois não-cruzadas por gasto desc
      byCampaign.sort((a, b) => {
        if (a.matched !== b.matched) return a.matched ? -1 : 1;
        if (a.matched) return b.roas - a.roas;
        return b.spend - a.spend;
      });

      // Agregado tráfego pago (fallback quando não há match por campanha)
      const paidAggregate = Object.entries(originMap)
        .filter(([norm]) => PAID_ORIGINS.some(p => norm.includes(p)))
        .reduce((acc, [, v]) => {
          acc.count   += v.count;
          acc.revenue += v.revenue;
          return acc;
        }, { count: 0, revenue: 0 });

      // ── 4. Totais ──────────────────────────────────────────────────────────────
      const totalSpent     = byCampaign.reduce((s, c) => s + c.spend,     0);
      const totalContracts = byCampaign.reduce((s, c) => s + c.contracts, 0);
      const totalRevenue   = byCampaign.reduce((s, c) => s + c.revenue,   0);

      const effContracts   = totalContracts > 0 ? totalContracts : paidAggregate.count;
      const effRevenue     = totalRevenue   > 0 ? totalRevenue   : paidAggregate.revenue;
      const attrMode       = totalRevenue   > 0 ? 'per_campaign' : 'aggregate_paid';

      const totals = {
        spent:      totalSpent,
        leads:      byCampaign.reduce((s, c) => s + c.leads, 0),
        contracts:  effContracts,
        revenue:    effRevenue,
        roas:       totalSpent > 0 && effRevenue > 0 ? Number((effRevenue / totalSpent).toFixed(2)) : 0,
        cpa:        effContracts > 0 && totalSpent > 0 ? Number((totalSpent / effContracts).toFixed(2)) : 0,
        attribution_mode: attrMode,
        paid_aggregate:   paidAggregate,
      };

      return {
        period,
        range,
        meta_error:                metaError,
        totals,
        by_campaign:               byCampaign,
        unmatched_meta_campaigns:  unmatchedNames,
        origin_breakdown:          Object.fromEntries(
          Object.entries(originMap).map(([k, v]) => [k, v])
        ),
        attribution_lost: attrLostCount,
        fetchedAt: new Date().toISOString(),
      };
    }, req.query.force === '1');

    res.json(data);
  } catch (err) { next(err); }
});

module.exports = router;
