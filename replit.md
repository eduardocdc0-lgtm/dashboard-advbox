# Dashboard AdvBox

Dashboard interno para escritório de advocacia conectado à API do AdvBox.

## Stack
- **Backend**: Node.js + Express — ponto de entrada: `index.js`
- **Frontend**: HTML/CSS/JS puro (`public/index.html`)
- **Dependências**: `express`, `node-fetch`, `cookie-session`
- **Porta**: 5000

## Arquitetura (Monorepo)

```
index.js                         ← entry point raiz (1 linha: require clients/dashboard)
middleware/                      ← compartilhado entre clientes
  auth.js                        ← requireAuth, requireAdmin
  errorHandler.js                ← handler centralizado de erros
cache/
  index.js                       ← SmartCache: TTL por chave, deduplicação, invalidação manual
services/                        ← compartilhado entre clientes
  advbox-client.js               ← HTTP client com retry exponencial, rate limiting, timeout
  advbox-instance.js             ← singleton do AdvBoxClient
  data.js                        ← fetchLawsuits, fetchTransactions, fetchAllPosts (com cache)
clients/
  dashboard/                     ← app do dashboard (Express, porta 5000)
    index.js                     ← auth, sessão, boot do servidor
    public/
      index.html                 ← frontend completo (~4500 linhas)
    routes/
      index.js                   ← combina todos os routers
      settings.js                ← GET /api/settings
      lawsuits.js                ← GET /api/lawsuits
      customers.js               ← GET /api/customers, /api/birthdays
      transactions.js            ← GET /api/transactions
      flow.js                    ← GET /api/flow, /api/last-movements, /api/posts
      distribution.js            ← GET /api/distribution
      evolucao.js                ← GET /api/evolucao
      meta.js                    ← GET /api/meta-ads
      registrations.js           ← GET /api/incomplete-registrations
      audit.js                   ← GET /api/audit/*, /api/audit-responsible, /api/audit-debug-stages
  crm/
    index.js                     ← placeholder CRM (porta 5001)
```

## Endpoints de administração do cache (admin only)
- `GET /api/cache-status` — estado de todos os caches (stale, TTL, pendente)
- `POST /api/cache-invalidate` `{ key?: string }` — invalida chave específica ou todos

## Configuração
- `ADVBOX_TOKEN` — token Bearer da API do AdvBox (Secrets)
- `ADVBOX_BASE_URL` — `https://app.advbox.com.br/api/v1`
- `META_TOKEN` — token de acesso da API do Meta Ads (Secrets)
- `META_AD_ACCOUNT` — `act_654132083965752` (variável de ambiente)
- `ADMIN_PASS`, `TEAM_PASS`, `SESSION_SECRET` — autenticação (Secrets)

## Abas do Dashboard (12 abas)
1. **Visão Geral** — processos, tarefas, financeiro + evolução mensal de honorários e faturamento + atividade da equipe (últimos 7 dias)
2. **Processos** — lista de processos
3. **Movimentações** — histórico de movimentações
4. **Financeiro** — transações/vencimentos
5. **Clientes** — lista de clientes e aniversariantes
6. **Cadastros Pendentes** — processos com problemas (Sem fechado por, sem laudo, sem canal)
7. **Canais** — Kanban por canal de origem (Parceiros, Orgânicos, Campanhas, Com Laudo, Sem Laudo)
8. **Distribuição** — carga de trabalho por responsável, com lista detalhada filtrável e exportação CSV
9. **🚧 Gargalos** (ex-Fluxo) — 3 cards (Crítico +90d / Atenção 30-90d / Espera Externa), tabela principal ordenável por dias/cliente/responsável com cores de severidade, "Carregar mais" (50/página), filtro por responsável, chips de severidade, seção "Gargalos por Etapa" recolhível com barra proporcional e média de dias calculada de verdade. Exportar CSV (admin). Bug de "?d" corrigido: String keys + fallback updated_at.
10. **Meta Ads** *(admin only)* — campanhas Meta Ads em tempo real: investimento, impressões, alcance, WhatsApp, CTR, CPM, custo/conversa. Filtros por período, status e objetivo. Cache 15 min.
11. **Evolução** *(admin only)* — evolução mensal jan/2025 → hoje. Sub-abas: Contratos (novos processos/mês) e Faturamento (fees_money/mês). Cards de resumo + gráfico de barras + tabela com var% e acumulado. Cache 30 min.
12. **🚨 Auditoria** — cruza fases de cobrança (COBRANCA_ATIVA / MONITORAMENTO) com transações do mês. Classifica em Críticos (fase parcelada sem lançamento), Monitoramento (outras fases ativas), OK. Badge pulsante no header quando há alertas. Filtros por responsável, navegação de mês, exportação CSV (admin). Cache 30 min. Endpoint: `/api/audit/kanban-financeiro`.

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

## Autenticação por API Key (X-Api-Key)
- Header: `X-Api-Key: <READ_API_KEY>`
- Só funciona em requisições GET — nunca em POST/PUT/DELETE
- Autentica como role `admin` sem precisar de sessão/cookie
- Log em console a cada uso: `[API Key] timestamp | IP | rota`
- CORS configurado: `Access-Control-Allow-Headers` inclui `X-Api-Key`
- Chave armazenada na env var `READ_API_KEY` (shared, nunca no código)
- Implementação em `clients/dashboard/index.js` — middleware `/api`

## Seção "💸 ROI por Campanha" (aba Meta Ads, admin-only)
- Fica abaixo da tabela de campanhas existente — sem remover nada
- Período: Este mês / Mês passado / Últimos 30 dias / Últimos 90 dias
- Fonte Meta: endpoint `/insights` da Graph API (reusa META_TOKEN + META_AD_ACCOUNT)
- Fonte AdvBox: `fetchLawsuits` (cache 20 min) — filtra por `created_at` no período, extrai `customers[].origin` + `fees_expec`/`fees_money`
- Matching: normStr(campanha Meta) vs normStr(cliente.origin) — exato e parcial
- Fallback: se 0 matches por campanha → ROAS agregado usando origens "TRAFEGO PAGO/INSTAGRAM/GOOGLE"
- KPIs: Investido / Receita Contratada / ROAS (verde ≥3, amarelo 1-3, vermelho <1) / CPA
- Tabela: Campanha | Gasto | Leads | Contratos | Receita | ROAS | CPL | CPA | Cruzamento badge
- Bloco "⚠️ Campanhas sem cruzamento" com lista e instrução para preencher Origem no AdvBox
- Dropdown colapsável com breakdown de todas as origens AdvBox do período
- Aviso de clientes sem origem preenchida (atribuição perdida)
- Rota: `clients/dashboard/routes/campaign-roi.js` · GET `/api/meta/campaign-roi?period=this_month|last_month|last_30d|last_90d`

## Bloco "💰 Caixa — Próximos Dias" (topo da aba Financeiro, admin-only)
- Toggle: 7 / 15 / 30 dias
- Fonte: reutiliza `fetchTransactions` (cache 30 min) — filtra `entry_type=income`, `date_payment=null`, `date_due <= hoje+N`
- Inclui inadimplentes (date_due < hoje mas não pagos)
- KPI total (52px DM Serif), gráfico de barras por dia (Chart.js — vermelho=atrasado, amarelo=hoje, preto=futuro)
- Tabela: Vence | Cliente | Tipo (+parcela) | Valor | Responsável | Status | Processo ↗
- Linhas hoje → fundo amarelo + badge HOJE; atrasado → fundo vermelho + badge ATRASADO
- Exportar CSV + ↺ Atualizar
- Rota: `clients/dashboard/routes/cash-flow.js` · GET `/api/cash-flow/upcoming?days=7|15|30`

## Aba Petições ("🧾 Petições") — visível a todos os perfis
- Filtro de período: Hoje / Ontem / Esta semana / Este mês
- Fonte: endpoint `/posts` do AdvBox, identificação por heurística de palavras-chave no campo `task`
- Palavras-chave: PETIÇÃO, RECURSO, AJUIZAR, PROTOCOLAR, CUMPRIMENTO DE SENTENÇA, INICIAL, CONTESTAÇÃO, MANIFESTAÇÃO, IMPUGNAÇÃO
- KPI total grande (64px), cards por pessoa (inicial + nome + contagem + badges de tipo), gráfico de barras horizontal (Chart.js), tabela detalhada colapsível
- Filtro por responsável (admin-only visível) + clicar no card filtra a tabela
- Exportar CSV (admin-only)
- Rota: `clients/dashboard/routes/petitions.js` · GET `/api/petitions/by-person?period=today|yesterday|this_week|this_month`

## Conferência INSS × AdvBox (aba admin "🔍 Conf. INSS")
- Upload de até 3 arquivos .docx (EM ANÁLISE, EM EXIGÊNCIA, CONCLUÍDOS)
- Leitura com `mammoth`; extração de nomes via padrão CPF (linha anterior ao CPF é o nome)
- Cruzamento por nome normalizado (sem acento, uppercase, sem espaço duplo); match parcial visual
- Regras: EM ANÁLISE e EM EXIGÊNCIA → 7 fases ADM válidas; CONCLUÍDO → grupos Judicial/Financeiro/Arquivamento
- Relatório: resumo, divergentes (com fase atual + fases sugeridas + link AdvBox), não encontrados, coerentes
- Filtros: por status INSS e por responsável; copiar divergentes; exportar CSV
- Histórico de conferências em `inss_conference_log` (totais, sem arquivo .docx)
- Pacotes: `mammoth` (parse .docx), `multer` (upload em memória)
- Rota: `clients/dashboard/routes/inss-conference.js` · POST `/api/inss-conference/run` · GET `/api/inss-conference/history`

## Identidade Visual
- Preto/branco minimalista premium
- Tipografia: DM Serif Display (títulos/números) + DM Sans (corpo)
- Sem Alice/prazos (removido a pedido do usuário)
