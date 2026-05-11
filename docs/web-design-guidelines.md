# Web Design Guidelines — Dashboard AdvBox

> Manual de referência do design system do dashboard. Use sempre que for criar uma tela nova ou refatorar uma existente. **Build systems, not pages.**

---

## 1. Princípios

1. **Atomic design.** Pensa em átomos → moléculas → organismos → templates → páginas. Sempre componha do menor pro maior.
2. **Curate, don't innovate.** Reutilize classes já existentes antes de criar uma nova. Se precisar de uma variação, adicione **modifier** (`--warn`, `--danger`), não uma classe nova.
3. **Semantic HTML primeiro, CSS depois.** `<section>`, `<header>`, `<article>`, `<nav>`, `<button>` semânticos antes de pensar em estilo.
4. **Acessibilidade não é opcional.** `aria-label`, `aria-pressed`, `role`, `focus-visible` em qualquer elemento interativo.
5. **Sem styles inline em produção.** Se você está escrevendo `style="..."` num elemento que aparece mais de uma vez, vira classe.
6. **No bullshit.** Sem hype, sem efeito desnecessário. Hover sutil, transição curta, sem animação chamativa.

---

## 2. Tipografia

| Uso | Fonte | Tamanho | Peso | Letterspacing |
|---|---|---|---|---|
| **Numerais** (counts, percentuais) | `DM Serif Display` | 24–34px (cards), 64px (KPI principal) | 400 | -0.02em |
| **Títulos de página** | `DM Serif Display` | 26px | 400 | -0.01em |
| **Títulos de seção** | `DM Serif Display` | 17–18px | 400 | normal |
| **Body / texto** | `DM Sans` | 13–14px | 400/500 | normal |
| **Eyebrow / labels** | `DM Sans` | 10.5px | 700 | 0.08em uppercase |
| **Micro-info** | `DM Sans` | 11–11.5px | 400/500 | normal |
| **Code / tabular** | `DM Sans` com `font-variant-numeric: tabular-nums` | 11–13px | 700 | normal |

**Regras de ouro:**
- Use `tabular-nums` em qualquer número que pode ser comparado vertical (valores, dias, contagens em colunas).
- Letterspacing positivo é só pra UPPERCASE pequeno (labels/eyebrows). Em DM Serif use sempre letterspacing **negativo**.

---

## 3. Cores e tokens

### Paleta semântica

```css
/* Sempre via variável, nunca hex hardcoded em componente novo */
--text:    /* preto principal — texto e numerais */
--text-2:  /* cinza médio — secondary */
--border:  /* cinza claro — divisores */
--bg-card: /* fundo de card */
--surface: /* fundo de section */
--hover:   /* hover de linha */
--success: /* verde — positivo, em dia, OK */
--warning: /* amarelo/âmbar — atenção, monitoramento */
--danger:  /* vermelho — crítico, vencido */
```

### Tons aplicados a estados

| Estado | Background | Border | Text |
|---|---|---|---|
| **Crítico** | `#fff5f5` | `#fcd5d5` | `#b02020` |
| **Atenção** | `#fffbea` | `#fde68a` | `#856404` ou `#92400e` |
| **OK** | `#f0faf5` | `#bbf0d0` | `#166534` |
| **Neutro** | `#fff` ou `#fafafa` | `#eee` | `var(--text)` |

**Não invente paletas novas.** Se precisar de "azul" pra um caso específico, abre discussão antes — provavelmente um dos tons acima resolve.

---

## 4. Naming convention (BEM-ish)

```
.block               /* organismo ou molécula */
.block__element      /* parte interna */
.block__element--modifier  /* variação */
```

**Exemplos do projeto:**
- `.audit-mon-row` (molecule)
- `.audit-mon-row__client` (element)
- `.audit-mon-row__days--warn` (modifier)
- `.metric-card.is-warning` (state class — `is-*` quando aplicado via JS)

**Não use:**
- Nomes genéricos (`.box`, `.item`, `.wrapper`)
- Múltiplas classes sem hierarquia clara (`.card.red.big`)
- camelCase em CSS (sempre kebab-case)

---

## 5. Padrões reutilizáveis (atoms + molecules já implementados)

### Stat card (`.audit-sum-card`, `.metric-card`)

```html
<article class="metric-card is-success">
  <div class="metric-label">A receber</div>
  <div class="metric-value success">R$ 44.455</div>
  <div class="metric-sub">honorários contratados — excl. arquivados</div>
</article>
```

**Anatomia:**
- Barra colorida lateral de 3px (via `::before`)
- Eyebrow uppercase (10.5px, weight 700, letterspacing 0.08em)
- Numeral em DM Serif (28–34px, weight 400)
- Subtítulo opcional em micro-info

**Variantes:** `is-neutral`, `is-warning`, `is-success`, `is-danger`.

---

### Section header (`.ov-section-head`)

```html
<header class="ov-section-head">
  <div class="ov-section-head__left">
    <span class="ov-section-head__eyebrow">Equipe</span>
    <h2 class="ov-section-head__title">Atividade da equipe</h2>
    <span class="ov-section-head__sub">últimos 7 dias</span>
  </div>
  <!-- actions à direita (botão Atualizar, filtro, etc.) -->
</header>
```

**Sempre** `eyebrow + título serif + subtítulo`. Ações ficam à direita.

---

### Lista em grid alinhado (`.audit-mon-row`)

Quando você tem uma lista com colunas (cliente | dias | valor | responsável | link):

```css
.audit-mon-row {
  display: grid;
  grid-template-columns: 10px minmax(0,1fr) 110px 130px 210px 32px;
  align-items: center;
  gap: 18px;
}
```

**Regras:**
- **Larguras fixas** nas colunas de "metadado" (dias, valor, owner) — `auto` causa **column misalignment** quando alguma célula vem vazia.
- Wrap cada célula num `<div class="audit-mon-row__cell--days">` pra controlar alinhamento interno.
- Placeholder `—` em cinza claro (`.audit-mon-row__placeholder`) quando o dado não existe — **nunca** `<span>` vazio.
- Coluna principal: `minmax(0, 1fr)` pra crescer.

---

### Kanban horizontal (`.audr-kanban-board`)

Pra agrupar items por categoria visualmente lado a lado:

```html
<div class="audr-kanban-board">
  <div class="audr-kanban-col">
    <div class="audr-kanban-col-header">
      <strong>NOME DA FASE</strong>
      <span class="badge">N</span>
    </div>
    <div class="audr-kanban-col-body">
      <!-- cards -->
    </div>
  </div>
</div>
```

- Largura fixa da coluna (`280px`)
- `overflow-x: auto` no board
- Scroll horizontal customizado (6px)
- `max-height: calc(100vh - 300px)` na coluna pra evitar scroll de página

---

### Alert item (`.audit-alert-item`)

Cards de alerta crítico com botões de ação:

```html
<article class="audit-alert-item">
  <div class="audit-alert-top">
    <span class="audit-alert-nome">CLIENTE</span>
  </div>
  <div class="audit-alert-fase">Fase · Responsável</div>
  <div class="audit-alert-details">
    <!-- info estruturada em caixa cinza -->
  </div>
  <div class="audit-alert-actions">
    <button class="audit-btn-cobrar">Ação principal</button>
    <a class="audit-btn-advbox">Ação secundária</a>
  </div>
</article>
```

- Borda esquerda vermelha de 3px
- Caixa cinza interna pra agrupar informações estruturadas
- Botão primário preto, secundário borda cinza

---

## 6. Estados interativos

| Estado | Como aplicar |
|---|---|
| **Hover** | `transition: box-shadow .18s, transform .18s, border-color .18s` — leve elevação (`translateY(-1px)`) + shadow `0 4px 18px rgba(0,0,0,.06)` |
| **Active** | `is-active` ou `aria-pressed="true"` — border-color `#111`, shadow um pouco mais forte |
| **Focus** | `outline: 2px solid var(--text); outline-offset: 1px` (use `:focus-visible`, não `:focus`) |
| **Disabled** | `opacity: .5; cursor: not-allowed` + `pointer-events: none` se for botão |
| **Loading** | `<div class="loading">Carregando...</div>` ou `<div class="empty">Nenhum resultado</div>` |

---

## 7. Acessibilidade (mínimo obrigatório)

- **Toda imagem decorativa** → `aria-hidden="true"`
- **Toda imagem informativa** → `alt="descrição"`
- **Todo botão sem texto** → `aria-label="ação"`
- **Toggle button** → `aria-pressed="true|false"`
- **`<div onclick>`** → SEMPRE substitua por `<button>` ou adicione `role="button" tabindex="0"`
- **Modal** → `role="dialog" aria-modal="true" aria-labelledby="titleId"`
- **Lista** → `role="list"` + filhos `role="listitem"` quando não usa `<ul>/<li>`
- **Form input** → `<label for="id">` ou `aria-label`

**Contraste mínimo:** 4.5:1 pra body, 3:1 pra texto grande (24px+). Cinza claro (#999) em fundo branco passa só pra texto grande — não use em parágrafo.

---

## 8. Padrões anti-rotos (anti-patterns) do projeto

❌ **NÃO:**
- `<div onclick="...">` → use `<button>`
- `<span style="font-size:11px;color:#888;">...</span>` repetido → vira classe
- `<table>` pra layout → use grid/flex
- `style="margin-top:14px;"` solto → marginar via classe ou usar `gap` no parent
- `getElementsByClassName('audit-mon-row')[0]` no JS → use `data-*` attributes ou IDs
- Emoji no meio de texto pra fazer veces de ícone → use SVG ou ponto colorido CSS
- Cor hardcoded (`color: #b02020`) em componente novo → use variável CSS
- `JSON.stringify(...)` em `data-attribute` que vai ser parseado de volta no onclick → use Map global (já queima quando o dado tem caractere especial)

✅ **SIM:**
- `<button type="button" onclick="...">` ou ainda melhor: `addEventListener` no JS
- Classes com escopo claro (`.audit-mon-row__client`, não `.client-name`)
- `<section aria-labelledby="X">` envolvendo cada bloco
- Variables CSS semânticas (`var(--danger)`)
- Modifiers BEM (`.btn--primary`, `.btn--danger`)
- `tabular-nums` em qualquer coluna numérica
- Placeholder `—` cinza claro quando dado falta

---

## 9. Performance / robustez

- **Cache de fetch:** use `cache.getOrFetch(key, fn, force)` — TTL adequado (30 min pra dados pesados)
- **Falha resiliente:** se a fonte de dados externa falhar, mostre **mensagem real do erro** + botão "Tentar de novo". Não esconda o erro com mensagem genérica.
- **Loading state explícito:** sempre `<div class="loading">` durante fetch, nunca tela em branco.
- **Empty state explícito:** `<div class="empty">` com dashed border e mensagem clara — não deixa o usuário pensando que o dashboard quebrou.
- **Debounce** em filtros que disparam fetch — 250–500ms.

---

## 10. Checklist antes de fazer push

- [ ] Usei semantic HTML (`<section>`, `<header>`, `<button>`, etc.)?
- [ ] Adicionei `aria-label` em todo botão sem texto?
- [ ] Removi `<div onclick>` ou adicionei `role="button" tabindex="0"`?
- [ ] As colunas do grid têm largura fixa onde necessário (sem `auto auto auto` colapsando)?
- [ ] Placeholder `—` no lugar de span vazio?
- [ ] Cor via variável CSS, não hex hardcoded?
- [ ] Hover state existe e é sutil?
- [ ] Estado de erro mostra a mensagem real + opção de retry?
- [ ] Testei em < 760px (responsive)?
- [ ] Não inventei classe nova quando já existia uma similar?
- [ ] `tabular-nums` em colunas numéricas comparáveis?

---

## 11. Quem é referência

- **Brad Frost** — Atomic Design ([atomicdesign.bradfrost.com](https://atomicdesign.bradfrost.com))
- **Dan Mall** — design systems collaborativos
- **Heydon Pickering** — Inclusive Components (acessibilidade)
- **Refactoring UI** (Adam Wathan + Steve Schoger) — hierarquia visual prática

---

**Última atualização:** maio/2026 — refatoração das abas Visão Geral, Auditoria e Auditoria de Uso.
**Mantenedor:** Eduardo Rodrigues + Claude.

> Build systems, not pages. — Brad Frost
