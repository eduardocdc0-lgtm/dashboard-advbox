# 🚧 PROMPT PRO REPLIT AGENT — Reformular Aba Fluxo (corrigir bugs + simplificar)

> Cole esse prompt INTEIRO no Replit Agent.
> Estimativa: 3-4h de execução.
> **Importante:** este sprint NÃO inclui a Auditoria Kanban × Financeiro (sprint anterior). Faz só Fluxo.

---

## CONTEXTO

A aba **Fluxo** do dashboard hoje tem 2 problemas:

### Problema 1: BUGS DE DADOS
- Coluna "Dias parado" mostra "?d" em todos os processos (cálculo quebrado)
- Cards "Movimentados esta semana/mês" mostram 0 (provavelmente quebrado também)
- Cards "+30 dias" e "+90 dias" mostram o mesmo número (29 e 29) — redundante
- Etiqueta "média 180d" aparece em TODAS as etapas (placeholder não substituído)

### Problema 2: DESORGANIZAÇÃO
A aba quer responder 5 perguntas ao mesmo tempo:
1. Onde tá o gargalo?
2. Quem tá produzindo?
3. Que processo tá parado?
4. Quem fez o quê?
5. Como anda o fluxo?

A pergunta REAL que o Eduardo quer responder ao abrir essa aba é UMA: **"o que tá parado e precisa de ação minha?"**

Então vamos: (1) corrigir os bugs, (2) cortar tudo que não responde essa pergunta, (3) deixar a aba focada.

---

## OBJETIVO

Reformular a aba **Fluxo** (renomear pra **🚧 Gargalos**) pra ser uma tela única que responde:

> "Quais processos do escritório estão parados aguardando ação minha, ordenados por urgência?"

Tudo que não responde isso, sai da aba.

---

## TAREFAS

### 1️⃣ CORRIGIR BUGS DO BACKEND

#### 1.1 — Cálculo de "Dias Parado"

Hoje, o frontend mostra "?d" em todos os processos. Isso indica que o backend ou não tá retornando o campo, ou tá retornando null/undefined.

**Investigar:**
- Endpoint `/api/flow` (ou onde fica a lógica)
- Verificar se existe campo equivalente a `dias_parado` ou `days_in_stage`
- Lógica esperada: `dias_parado = hoje - data_da_ultima_movimentacao_da_fase_atual`

**Fontes possíveis no AdvBox:**
- `lawsuits[].updated_at` (última atualização)
- `lawsuits[].stage_updated_at` (mudança de fase)
- Última `posts[]` (tarefa/movimentação) vinculada ao processo

**Estratégia:**
1. Se o AdvBox retorna `stage_updated_at` ou similar, usar isso
2. Se não, calcular pela última `posts[].created_at` do processo (mais recente)
3. Se nem isso, usar `lawsuits[].updated_at`

Garantir que o campo `dias_parado` chega no frontend como número, não null.

#### 1.2 — Remover "média 180d"

Hoje aparece "média 180d" em todas as etapas. Isso é placeholder ou cálculo errado.

**Solução simples:** remover a coluna de média de cada etapa por enquanto. Não vale a pena calcular agora — focar em fazer o resto funcionar.

Se quiser manter, calcular DE VERDADE: média dos `dias_parado` de todos os processos da etapa. Mas é opcional.

#### 1.3 — Cards "Movimentados esta semana/mês" mostram 0

Verificar se a lógica de "movimentação" tá certa. Provavelmente tá tentando contar `posts[]` da última semana/mês com `users[].completed != null`.

**Decisão:** se a cobertura de tarefas marcadas como concluídas é só 13% (sabido), esses cards mentem mesmo se funcionarem. **Remover esses 2 cards.**

#### 1.4 — Cards duplicados "+30 dias" e "+90 dias"

Hoje mostram o mesmo número (29 e 29). Possíveis razões:
- Lógica de filtro errada (filtrando do mesmo jeito)
- Realmente todos os parados estão há +90 dias

Investigar. Se for o segundo caso (todos +90 dias), manter só o card "+90 dias" e mostrar como "🔴 CRÍTICO".

---

### 2️⃣ NOVA ESTRUTURA DA ABA (renomear pra "🚧 Gargalos")

Substituir layout atual por essa estrutura:

#### 2.1 — Header

```
🚧 Gargalos — Processos com Ação Pendente

Filtro: Responsável [Todos ▼]   |   [🔄 Atualizar]
Última atualização: há X minutos
```

#### 2.2 — 3 Cards de resumo (substituem os 4 atuais)

```
┌──────────────────┬──────────────────┬──────────────────┐
│ 🔴 CRÍTICO       │ 🟡 ATENÇÃO       │ 🟢 ESPERA EXTERNA│
│ +90 dias parado  │ 30-90 dias       │ Aguarda INSS/Juiz│
│       29         │       N          │       67         │
└──────────────────┴──────────────────┴──────────────────┘
```

Cards clicáveis → filtram a lista abaixo.

**Importante:**
- "Crítico" e "Atenção" = só processos com etapa marcada como **"Ação do escritório"**
- "Espera Externa" = processos em etapas como Protocolado, Pericia Marcada (aguardando), SM aguardando concessão, etc.
- Encerrados são excluídos (já existe lógica)

#### 2.3 — Filtros embaixo dos cards

```
[Todos] [🔴 Críticos] [🟡 Atenção] [🟢 Espera Externa]
```

Mais um dropdown:
```
Responsável: [Todos os responsáveis ▼]
```

Lista de responsáveis: Eduardo, Maria Alice, Letícia, Ana Marília, Claudiana, Thiago, Tammyres.

#### 2.4 — Tabela principal (CORE da aba)

Substitui as 2 tabelas atuais por UMA só:

| Cliente | Tipo | Etapa | Dias Parado | Responsável | Severidade | Ação |
|---|---|---|---|---|---|---|
| Theo Rodrigues Mavignier | Benefício Assistencial | Pericias Marcadas | 127d | Ana Marília | 🔴 | [↗ AdvBox] |
| Vicente Henrique Queiroz | Reclamatória Trabalhista | Elaborar Petição Inicial | 115d | Eduardo | 🔴 | [↗ AdvBox] |
| Deyvidi Manoel | Benefício Assistencial | Adm Parcelado | 98d | Claudiana | 🔴 | [↗ AdvBox] |

**Regras da tabela:**
- **Ordenação default:** dias parado, descendente (mais antigos primeiro)
- **Cor da linha:** vermelha clara se +90d, amarela clara se 30-90d, neutra se <30d
- **Severidade visual:** 🔴 (+90d) | 🟡 (30-90d) | 🟢 (<30d ou espera externa)
- **Coluna "Dias Parado":** se nulo/desconhecido, mostrar "—" (NÃO "?d")
- **Limite:** mostrar 50 linhas. Botão "Carregar mais" pra ver os outros
- **Linha clicável:** clica abre o processo no AdvBox em nova aba
- **Coluna ordenável:** clicar no cabeçalho da coluna ordena (Dias Parado, Cliente, Responsável)

#### 2.5 — Seção "Etapas com Gargalo" (recolhível, abaixo da tabela)

Lista compacta agrupando por etapa, **só etapas marcadas "Ação do escritório"**:

```
📍 GARGALOS POR ETAPA (ação do escritório)

FALTA LAUDO – FAZER PREVDOC ........ 13 processos
PERICIAS MARCADAS .................. 3 processos
ELABORAR PETIÇÃO INICIAL ........... 2 processos
EM ANALISE PERICIAS FEITAS ......... 2 processos
ADM PARCELADO ...................... 1 processo
... (resto)
```

Clicar em cada linha filtra a tabela acima por aquela etapa.

**NÃO incluir:**
- "Salário Maternidade Guia Paga" (espera externa, não é ação do escritório)
- "Protocolado" (espera tribunal)
- "Salário Maternidade 1-3 meses / 3-5 / 5-7" (esperando o INSS pagar)
- Qualquer outra etapa de "Espera Externa"

#### 2.6 — Botão "Exportar CSV"

Mantém o botão atual, mas agora exporta a tabela filtrada (respeitando filtros aplicados).

---

### 3️⃣ REMOVER DA ABA FLUXO

Tirar definitivamente:

❌ **Cards "Movimentados esta semana / Movimentados este mês"** — dado quebrado, baseado em cobertura de tarefas (só 13%)

❌ **Seção "PRODUTIVIDADE POR RESPONSÁVEL"** — mover pra aba **Equipe** (que já existe). Se a aba Equipe já tem produtividade, conferir e consolidar.

❌ **Seção "TAREFAS REALIZADAS"** — mover pra aba **Equipe** ou criar aba separada se preferir. Cobertura de 13% torna esse dado quase inútil — considerar esconder até resolver disciplina de marcação.

❌ **Coluna "média 180d"** em cada etapa — placeholder errado.

❌ **Cards duplicados "+30 dias" e "+90 dias" mostrando o mesmo número** — virar um card só.

---

### 4️⃣ MOVER "PRODUTIVIDADE" PRA ABA EQUIPE

Na aba **Equipe** (que já existe), adicionar uma nova seção: **"Atividade dos últimos 30 dias"**.

Conteúdo idêntico ao que tava na Fluxo, com os 6 cards de cada responsável:
- Tarefas concluídas na semana
- Tarefas concluídas no mês
- Andamentos de tribunal
- Sob responsabilidade +60d
- Total com ação pendente

Manter o aviso visual:

> ⚠️ Cobertura de tarefas marcadas como concluídas é baixa (~13%). Esses números podem subestimar produtividade real.

E também a tabela de "Tarefas Realizadas" (com filtros por responsável e período) pode ir pra essa mesma aba Equipe, numa seção embaixo.

---

### 5️⃣ ATUALIZAR MENU/NAVEGAÇÃO

No menu superior:

**Antes:**
```
... Auditoria · Clientes · Cadastros Pendentes · Canais · Distribuição · Fluxo
```

**Depois:**
```
... Auditoria · Clientes · Cadastros Pendentes · Canais · Distribuição · 🚧 Gargalos
```

Trocar texto e ícone.

---

## REGRAS IMPORTANTES

1. ❌ **NÃO QUEBRAR** outras abas (Visão Geral, Auditoria, Distribuição, Financeiro). Especialmente se elas usam o mesmo endpoint `/api/flow`.
2. ❌ **NÃO modificar dados via API do AdvBox.** Apenas LEITURA.
3. ✅ **MANTER** filtro de período se existir.
4. ✅ **NÃO tentar consertar tudo de bug.** Se o cálculo de "dias_parado" não der pra fazer 100% certo no tempo desse sprint, faça best-effort: usar `updated_at` do processo como fallback, com um aviso "aproximado".
5. ✅ **Layout responsivo** — Eduardo acessa muito do iPhone.
6. ✅ **Permissões:** admin (eduardorodrigues14) vê tudo. Team (colaboradores) vê tabela mas sem botão "Exportar CSV".

---

## TESTE FINAL

Quando terminar, validar:

1. Abrir aba **🚧 Gargalos** → ver 3 cards (Crítico / Atenção / Espera Externa)
2. Tabela mostra processos com **dias parado em número** (não "?d")
3. Tabela ordenada por dias parado descendente (mais antigos primeiro)
4. Filtrar por responsável "Maria Alice" → ver só os dela
5. Clicar no card "🔴 Crítico" → tabela filtra pra +90d
6. Clicar numa linha → abre processo no AdvBox em nova aba
7. Seção "Gargalos por Etapa" não mostra mais "Salário Maternidade Guia Paga"
8. Aba Equipe agora mostra Produtividade (movida de Fluxo)
9. Aba Visão Geral, Auditoria, Distribuição continuam funcionando
10. Mobile: testar no iPhone, tabela rola horizontal sem quebrar

**Quando terminar, me avise pra eu testar.**

---

## DEPOIS DESSE SPRINT

Próximas frentes (NÃO fazer agora):
- Resolver disciplina de marcação de tarefa concluída no AdvBox (problema humano, não técnico)
- Calcular "média de dias por etapa" certo (precisa de histórico de fases, mais complexo)
- Notificações automáticas pros responsáveis quando processo passa de 30/60/90 dias

**Pode executar!** 🚀
