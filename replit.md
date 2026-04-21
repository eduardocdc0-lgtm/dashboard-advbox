# Dashboard AdvBox

Dashboard interno para escritório de advocacia conectado à API do AdvBox.

## Stack
- **Backend**: Node.js + Express (arquivo: `index.js`)
- **Frontend**: HTML/CSS/JS puro (`public/index.html`)
- **Dependências**: `express`, `node-fetch`
- **Porta**: 5000

## Configuração
- `ADVBOX_TOKEN` — token Bearer da API do AdvBox (configurado em Secrets)
- `ADVBOX_BASE_URL` — `https://app.advbox.com.br/api/v1`

## Abas do Dashboard
1. **Visão Geral** — processos, tarefas, financeiro
2. **Processos** — lista de 640 processos
3. **Movimentações** — histórico de movimentações
4. **Financeiro** — transações/vencimentos
5. **Clientes** — lista de clientes e aniversariantes
6. **⚖️ Alice** — controle de prazos judiciais

## Aba Alice — Lógica de Prazos
- **Fonte de dados**: `/posts?limit=200&offset=0` paginado (223 de 243 posts totais)
- **Estrutura**: cada post tem `date_deadline`, `task`, `lawsuits_id`, `users[]` (com campo `completed`)
- **Filtro**: posts com `date_deadline` preenchido E pelo menos 1 usuário com `completed=null`
- **Granularidade**: 1 entrada por usuário pendente por post (igual ao AdvBox)
- **Cache**: 30 min TTL, backoff de 5 min após erro, constrói em ~20 segundos
- **Total encontrado**: ~190 prazos pendentes (user-task pairs)
  - 37 atrasados (data_deadline < hoje)
  - 153 próximos (datas futuras)
- **Nota sobre os 83 do AdvBox**: o AdvBox conta também tarefas JÁ COMPLETADAS e pode incluir 20 posts inacessíveis via API (totalCount=243 vs 223 obtidos)

## Endpoints da API Proxy
- `GET /api/settings` — configurações do escritório
- `GET /api/lawsuits` — processos (`?limit=50`)
- `GET /api/movements` — movimentações
- `GET /api/transactions` — transações
- `GET /api/customers` — clientes
- `GET /api/birthdays` — aniversariantes
- `GET /api/posts` — posts recentes
- `GET /api/deadlines` — prazos com cache server-side

## Rate Limiting da API AdvBox
- Limite agressivo: 5-10 req/s
- Solução: `/posts` com limit=200 (apenas 2-3 chamadas para todos os prazos)
- Evitar: chamar `/history/{id}` para todos os 640 processos (lento + rate limited)
