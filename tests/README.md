# Tests

Suite de regressão usando o test runner nativo do Node 18+ (`node:test`).
Sem jest, sem mocha, sem zero dependências adicionais.

## Como rodar

```bash
npm test                  # tudo (unit + integration)
npm run test:unit         # só os de lógica pura (rápidos, sem DB)
npm run test:integration  # os que precisam de DB/server (mais lentos)
```

Cada teste é um arquivo `.test.js`. O runner descobre automaticamente.

## Organização

### `unit/`

Testes de lógica pura — sem dependências externas. Rodam em ~1s no total.
Devem PASSAR em qualquer máquina, mesmo sem `.env` configurado.

- **`validate.test.js`** — chainable `Validator` (string/number/enum/boolean/dateYMD,
  optional vs required, multi-error agregação via `.done()`, coerção de tipo).
- **`circuit-breaker.test.js`** — máquina de estados closed→open→half-open→closed,
  threshold, reset timeout, recovery, status snapshot.
- **`cron-guard.test.js`** — wrapper que conta falhas consecutivas, alerta em
  threshold, alerta de recuperação, não re-throw.
- **`access-log-buffer.test.js`** — buffer in-memory, overflow drop, getStats shape.
- **`advbox-pagination.test.js`** — detecção de truncamento (saída por cap com
  página cheia vs natural), `getPaginationStats` shape.

### `integration/`

Testes que precisam de algum recurso externo. Documentam o pré-requisito
no topo do arquivo. Pulam graciosamente se a dependência não estiver disponível.

- **`auth.test.js`** — sobe o dashboard como child process com env vars diferentes
  e exercita os 5 cenários do `AUTH_REQUIRE_BCRYPT` (dev passa plaintext, prod
  com plaintext falha boot, prod com hash funciona, hash tem precedência,
  team-users também valida). Pré-requisito: nenhum (não precisa de DB pra
  testar o boot — usa `DATABASE_URL=""` propositalmente).

## Testes ainda não implementados (próxima iteração)

Estes precisam de Postgres real rodando — escopo separado:

- `auto-workflow-lock.test.js` — wrap do `scripts/verify-advisory-lock.js`
- `asaas-webhook-lock.test.js` — race regression test pra `pg_advisory_xact_lock`
- `mutation-log.test.js` — verifica que `logMutation` insere em `audit_actions`

Pra rodar quando implementados: garantir `DATABASE_URL` setado em `.env` antes
de `npm run test:integration`.

## Convenções

- Use `describe()` pra agrupar testes do mesmo módulo/feature.
- Use `it()` (alias de `test()`) pra cada caso.
- Use `node:assert/strict` — sem deep-equal surpresas.
- Logger das funções testadas: passar `{ info: () => {}, warn: () => {}, error: () => {} }`
  pra não poluir output do test runner.
- Não use `setTimeout` real — use `--test-timeout` ou estruture pra ser síncrono.
