const { Router } = require('express');
const fetch = require('node-fetch');
const cache = require('../services/cache');

const META_TOKEN      = process.env.META_TOKEN      || '';
const META_AD_ACCOUNT = process.env.META_AD_ACCOUNT || '';
const META_BASE       = 'https://graph.facebook.com/v19.0';
const META_TTL        = 15 * 60 * 1000;

const router = Router();

router.get('/meta-ads', async (req, res, next) => {
  const preset = req.query.date_preset || 'last_30d';
  const key    = `meta:${preset}`;
  cache.define(key, META_TTL);

  try {
    const data = await cache.getOrFetch(key, async () => {
      if (!META_TOKEN || !META_AD_ACCOUNT) {
        throw Object.assign(new Error('META_TOKEN ou META_AD_ACCOUNT não configurados.'), { status: 500 });
      }

      const fields  = 'id,name,status,objective,daily_budget,lifetime_budget,start_time,stop_time';
      const cRes    = await fetch(`${META_BASE}/${META_AD_ACCOUNT}/campaigns?fields=${fields}&limit=100&access_token=${META_TOKEN}`);
      const cJson   = await cRes.json();
      if (cJson.error) throw new Error('Campaigns: ' + cJson.error.message);
      const campaigns = cJson.data || [];

      const iFields = 'campaign_id,campaign_name,impressions,clicks,spend,reach,cpm,cpc,ctr,actions';
      const iRes    = await fetch(`${META_BASE}/${META_AD_ACCOUNT}/insights?fields=${iFields}&date_preset=${preset}&level=campaign&limit=100&access_token=${META_TOKEN}`);
      const iJson   = await iRes.json();
      if (iJson.error) throw new Error('Insights: ' + iJson.error.message);
      const insights = iJson.data || [];

      const byId   = {};
      const byName = {};
      insights.forEach(i => {
        if (i.campaign_id)   byId[i.campaign_id]     = i;
        if (i.campaign_name) byName[i.campaign_name] = i;
      });

      const result = campaigns.map(c => {
        const ins      = byId[c.id] || byName[c.name] || {};
        const actions  = ins.actions || [];
        const whatsapp = actions.find(a => a.action_type === 'onsite_conversion.total_messaging_connection');
        const leads    = actions.find(a => a.action_type === 'lead' || a.action_type === 'onsite_conversion.lead_grouped');
        return {
          id: c.id, name: c.name, status: c.status, objective: c.objective || '',
          daily_budget: c.daily_budget ? Number(c.daily_budget) / 100 : null,
          start_time: c.start_time || '', stop_time: c.stop_time || '',
          spend: Number(ins.spend || 0), impressions: Number(ins.impressions || 0),
          clicks: Number(ins.clicks || 0), reach: Number(ins.reach || 0),
          cpm: Number(ins.cpm || 0), cpc: Number(ins.cpc || 0), ctr: Number(ins.ctr || 0),
          whatsapp: Number(whatsapp ? whatsapp.value : 0),
          leads:    Number(leads    ? leads.value    : 0),
        };
      });

      console.log(`[Meta] ${campaigns.length} campanhas | ${insights.length} insights | ${preset}`);
      return { campaigns: result, period: preset, fetchedAt: new Date().toISOString() };
    }, req.query.force === '1');

    res.json(data);
  } catch (err) { next(err); }
});

module.exports = router;
