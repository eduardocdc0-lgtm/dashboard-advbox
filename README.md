# Dashboard AdvBox

Dashboard interno do escritório **Eduardo Rodrigues Advocacia** — integra a API do AdvBox e Meta Ads, com visão executiva (financeiro, processos, distribuição de carga, gargalos, auditoria fase × responsável, conferência INSS, ROI de campanhas, etc.).

> **Para usuários finais (sem programar):** veja [`LEIA-ME.md`](./LEIA-ME.md).

---

## Stack

- **Backend:** Node.js 18+ · Express 4
- **Frontend:** HTML/CSS/JS puro (Chart.js via CDN)
- **Banco:** PostgreSQL (leads, logs de auditoria/aniversário/INSS)
- **Hospedagem:** Replit (porta 5000)
- **Integrações:** AdvBox API · Meta Graph API · ChatGuru (WhatsApp)

## Arquitetura

```
clients/dashboard/        ← app principal (porta 5000)
  index.js                  entry: middleware, auth, routes, boot
  cron/birthday.js          cron de mensagens de aniversário (09:00 Recife)
  public/index.html         frontend (será modularizado na Fase 2)
  routes/                   1 arquivo por aba/recurso (16 rotas)
config/index.js           ← config central + validação de env vars
middleware/
  errorHandler.js           classes de erro + handler global
  logger.js                 pino + request ID
  security.js               helmet, rate-limit, CORS allowlist
  auth.js                   requireAuth, requireAdmin
services/
  advbox-client.js          HTTP client AdvBox (retry, rate limit, timeout)
  data.js                   wrappers com cache (lawsuits, transactions, etc.)
  birthday.js, leads.js,
  chatguru-sender.js, db.js
cache/index.js            ← SmartCache em memória (TTL, dedup, métricas)
utils/safeCompare.js      ← comparação timing-safe (anti-timing attack)
```

## Setup local

```bash
# 1. Clonar
git clone https://github.com/eduardocdc0-lgtm/dashboard-advbox.git
cd dashboard-advbox

# 2. Instalar dependências
npm install

# 3. Configurar env
cp .env.example .env
# editar .env com seus tokens (ou no Replit: aba Secrets)

# 4. Rodar
npm run dev    # com pino-pretty
npm start      # produção (logs JSON)

# 5. Outras
npm run lint     # ESLint
npm run format   # Prettier
```

## Variáveis de ambiente

Veja [`.env.example`](./.env.example). Mínimo obrigatório:

- `SESSION_SECRET` — gere com `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
- `ADMIN_PASS` (e/ou `TEAM_PASS`) — senha de login
- `ADVBOX_TOKEN` — Bearer token da API AdvBox

## Endpoints principais

### Auth
- `POST /api/login` `{username, password}` → cria sessão
- `POST /api/logout`
- `GET  /api/me`

### Dados (cache, todos GET)
- `/api/settings`, `/api/lawsuits`, `/api/customers`, `/api/birthdays`, `/api/transactions`
- `/api/last-movements`, `/api/posts`, `/api/flow`
- `/api/distribution`, `/api/incomplete-registrations`
- `/api/evolucao`, `/api/meta-ads`
- `/api/audit/kanban-financeiro`, `/api/audit-responsible` (admin)
- `/api/cash-flow/upcoming?days=7|15|30` (admin)
- `/api/petitions/by-person?period=today|...`
- `/api/meta/campaign-roi?period=this_month|...` (admin)
- `/api/inss-conference/run` (POST, admin, multipart .docx)

### Cache (admin)
- `GET  /api/cache-status` — estado, métricas
- `POST /api/cache-invalidate` `{ key? }`

### Webhook
- `POST /webhooks/chatguru` (com `x-chatguru-secret`)

### Health
- `GET /healthz`

## Autenticação alternativa

Header `X-Api-Key: <READ_API_KEY>` autentica como **admin** em rotas **GET**. Útil para integrações de leitura (BI, Sheets via script, etc.).

## Roadmap

- ✅ **Fase 1** — Backend hardening (segurança, rate limit, helmet, logger estruturado, config central)
- 🟡 **Fase 2** — Frontend modular (quebrar `public/index.html` 4.5k linhas em módulos)
- 🟢 **Fase 3** — Redesign visual + design system + responsivo

## Licença

Uso interno — Eduardo Rodrigues Advocacia.
