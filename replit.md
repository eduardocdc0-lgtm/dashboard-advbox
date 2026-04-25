# Dashboard AdvBox

Dashboard interno para escritório de advocacia conectado à API do AdvBox.

## Stack
- **Backend**: Node.js + Express (arquivo: `index.js`)
- **Frontend**: HTML/CSS/JS puro (`public/index.html`)
- **Dependências**: `express`, `node-fetch`
- **Porta**: 5000

## Configuração
- `ADVBOX_TOKEN` — token Bearer da API do AdvBox (Secrets)
- `ADVBOX_BASE_URL` — `https://app.advbox.com.br/api/v1`
- `META_TOKEN` — token de acesso da API do Meta Ads (Secrets)
- `META_AD_ACCOUNT` — `act_654132083965752` (variável de ambiente)
- `ADMIN_PASS`, `TEAM_PASS`, `SESSION_SECRET` — autenticação (Secrets)

## Abas do Dashboard (11 abas)
1. **Visão Geral** — processos, tarefas, financeiro + evolução mensal de honorários e faturamento + atividade da equipe (últimos 7 dias)
2. **Processos** — lista de processos
3. **Movimentações** — histórico de movimentações
4. **Financeiro** — transações/vencimentos
5. **Clientes** — lista de clientes e aniversariantes
6. **Cadastros Pendentes** — processos com problemas (Sem fechado por, sem laudo, sem canal)
7. **Canais** — Kanban por canal de origem (Parceiros, Orgânicos, Campanhas, Com Laudo, Sem Laudo)
8. **Distribuição** — carga de trabalho por responsável, com lista detalhada filtrável e exportação CSV
9. **Fluxo** — fluxo operacional (cards parados, gargalos por etapa, top 20 parados), produtividade por responsável, tarefas realizadas
10. **Meta Ads** *(admin only)* — campanhas Meta Ads em tempo real: investimento, impressões, alcance, WhatsApp, CTR, CPM, custo/conversa. Filtros por período, status e objetivo. Cache 15 min.
11. **Evolução** *(admin only)* — evolução mensal jan/2025 → hoje. Sub-abas: Contratos (novos processos/mês) e Faturamento (fees_money/mês). Cards de resumo + gráfico de barras + tabela com var% e acumulado. Cache 30 min.

## Aba Cadastros Pendentes
- Valida anotações gerais dos processos
- Regras: FECHADO POR (responsável válido), LAUDO (BPC/Aux Doença), canal de origem
- RESPONSAVEIS_VALIDOS: THIAGO, MARILIA, LETICIA, EDUARDO, TAMMYRES
- Cache: 20 min TTL, suporta `?force=1` para invalidar

## Aba Canais (Kanban)
- Classifica cada processo por origem: PARCEIRO, ORGANICO, CAMPANHA, DESCONHECIDO
- ORIGEM_ORGANICA inclui: PARCEIRO, PARCEIRA, PARCERIA, ORGANICO, ESCRITORIO, INDICACAO etc.
- Filtro de período (este mês, mês passado, últimos 7/30 dias, todos, personalizado)
- Card de "Valor total das causas" somando `fees_expec` de Parceiros + Orgânicos + Campanhas

## Aba Distribuição
- Endpoint: `GET /api/distribution` — cache 20 min
- Dados: todos os processos ativos (sem status_closure de encerramento), agrupados por responsible
- Cards por responsável: inicial, nome, contagem, barra colorida (verde ≤60 / amarelo 61-100 / vermelho >100)
- Clicar no card abre tabela detalhada com: cliente, tipo, fase, etapa, dias desde cadastro, link AdvBox
- Filtros: por fase (dropdown dinâmico) + por idade do processo
- Ordenação padrão: mais antigo primeiro
- Exportação CSV: todos ou selecionados (checkbox por linha)

## Endpoints da API Proxy
- `GET /api/settings` — configurações do escritório
- `GET /api/lawsuits` — processos (limit=1000)
- `GET /api/last-movements` — movimentações recentes
- `GET /api/transactions` — transações
- `GET /api/customers` — clientes
- `GET /api/birthdays` — aniversariantes
- `GET /api/posts` — posts recentes (para contagem de tarefas)
- `GET /api/incomplete-registrations` — cadastros pendentes (cache 20 min)
- `GET /api/distribution` — distribuição por responsável (cache 20 min)

## Campos financeiros do AdvBox (lawsuits)
- `fees_expec` → Expectativa/Valor da causa
- `fees_money` → Valor dos honorários
- `contingency` → Percentual de honorários (%)

## Rate Limiting da API AdvBox
- Limite agressivo: 5-10 req/s
- Distribuição carrega 2 segundos após o restante para evitar race com /api/lawsuits
- Evitar: chamar `/history/{id}` para todos os processos (lento + rate limited)

## Identidade Visual
- Preto/branco minimalista premium
- Tipografia: DM Serif Display (títulos/números) + DM Sans (corpo)
- Sem Alice/prazos (removido a pedido do usuário)
