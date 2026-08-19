# Dashboard AdvBox

Dashboard interno do escritório **Eduardo Rodrigues Advocacia** — integra a API do AdvBox e Meta Ads, com visão executiva (financeiro, processos, distribuição de carga, gargalos, auditoria fase × responsável, ROI de campanhas, etc.).

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
- `ADMIN_PASS_HASH` (e/ou `TEAM_PASS_HASH`) em prod — gere com `node scripts/hash-password.js`
- `ADVBOX_TOKEN` — Bearer token da API AdvBox

## Senhas / autenticação

Login aceita **duas formas** de credencial por usuário: hash bcrypt (`*_PASS_HASH` / `ADV_USER_<NOME>_HASH`) e texto puro (`*_PASS` / `ADV_USER_<NOME>`). A flag `AUTH_REQUIRE_BCRYPT` controla qual está em uso.

- `AUTH_REQUIRE_BCRYPT=true` (default em prod): só hash funciona. Plaintext é ignorado e o boot **falha** se uma var em texto puro estiver setada sem o `*_HASH` correspondente — impede deploy acidental com `.env` legado.
- `AUTH_REQUIRE_BCRYPT=false` (default em dev): plaintext aceito, com warning no boot. Útil pra rodar local sem gerar hash. **Nunca** deploye assim.

Para migrar uma senha de plaintext pra hash:

```bash
node scripts/hash-password.js          # digite a senha (não aparece no terminal)
# copia o hash $2b$12$... que ele imprime
```

Depois, no Replit Secrets (ou `.env`):

1. Cole o hash em `<NOME>_PASS_HASH` (ex: `ADMIN_PASS_HASH`, `ADV_USER_MARILIA_HASH`).
2. Confirme que o login funciona.
3. **Remova** a var em texto puro (`ADMIN_PASS`, `ADV_USER_MARILIA`, etc).
4. Quando todas as contas estiverem migradas, `AUTH_REQUIRE_BCRYPT=true`.

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
