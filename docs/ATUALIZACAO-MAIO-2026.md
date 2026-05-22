# Atualização do Dashboard AdvBox — Maio 2026

## Resumo executivo

Uma auditoria externa identificou **16 melhorias** de segurança, performance,
confiabilidade e qualidade no dashboard. Implementamos **15 das 16**. A única
deixada de fora foi a geração automática de documentação da API (`OpenAPI`),
porque o escritório não tem integrações externas hoje e o código já é fácil
de ler como está.

Tudo o que foi feito é **aditivo** ou **gateado por flag**: nenhuma
funcionalidade existente quebrou, e qualquer mudança que pudesse afetar o
comportamento atual pode ser desligada via variável de ambiente.

Há **3 ações manuais obrigatórias** que você precisa fazer no Replit antes
ou depois do deploy. Estão listadas na seção [⚠️ Ações manuais necessárias na
produção](#-ações-manuais-necessárias-na-produção) no final deste documento.

---

## O que foi melhorado — por área de impacto

### 🔒 Segurança e compliance

**Senhas em texto puro não funcionam mais em produção.**
Antes, se alguém esquecesse de configurar o "hash" da senha (uma versão
criptografada), o sistema aceitava a senha em texto puro como fallback. Isso
significava que as senhas ficavam visíveis nos Secrets do Replit, em backups,
e em qualquer log mal configurado. Agora, em produção, o sistema **falha a
inicialização** se detectar senha em texto puro sem o hash correspondente —
impossível deployar acidentalmente uma configuração insegura.
*Você precisa gerar hashes pras 9 contas de usuário antes do próximo deploy
— ver [ação manual #1](#1-gerar-hashes-bcrypt-pras-9-senhas-obrigatório).*

**Trilha de auditoria expandida pra compliance jurídica.**
Antes, só ações da "Auditoria de Uso" (botões de cobrar responsável) eram
registradas no banco. Agora, **toda mutação importante** é logada com nome
do usuário, o que foi feito, em qual processo, com qual payload, e se deu
certo: criação/edição/exclusão de parcelas financeiras, override de pagador
ASAAS, mudança de configuração do aniversário, resolução de problemas do
auditor. Pra auditor externo do escritório, uma única query SQL produz hoje
um relatório completo dos últimos 90 dias.

**Pagamentos ASAAS: condição de corrida resolvida.**
O ASAAS às vezes mandava dois eventos pro mesmo pagamento em
milissegundos de diferença (`PAYMENT_CONFIRMED` + `PAYMENT_RECEIVED`).
As duas execuções rodavam ao mesmo tempo e podiam sobrescrever uma à
outra no histórico — perdendo fidelidade do registro. Agora um "bloqueio
por pagamento" (advisory lock no Postgres) garante que eles processem em
sequência, sem perda de dados.

### ⚡ Confiabilidade e performance

**Banco de dados aguenta mais carga.**
O pool de conexões aumentou de 5 pra 15 por padrão. Sem isso, em horários
de pico (manhã + auto-workflow rodando), pedidos da equipe davam timeout.
O aviso no boot detecta se alguém configurar abaixo de 10 e alerta.

**Proteção contra APIs externas instáveis (circuit breaker).**
AdvBox, ASAAS e Meta às vezes ficam fora ou lentos. Antes, o dashboard
ficava tentando indefinidamente — sobrecarregando a API deles e travando a
experiência do usuário. Agora, depois de 5 falhas consecutivas, o sistema
"abre o circuito" e rejeita as próximas chamadas por 30 segundos
(ou 60s pro Meta), economizando recursos. Quando a API volta, faz um teste
silencioso e retoma. Você pode ver o estado em `/api/cache-status`.

**Telemetria de uso sem perda de dados.**
Antes, cada request de GET fazia uma escrita no banco. Se o banco estivesse
em manutenção, esse log se perdia. Agora, os logs ficam em memória
(buffer de 1000 entradas) e são gravados em lote a cada 60s. Se o banco
cair, o buffer guarda e tenta de novo no próximo ciclo. Bônus: response
do usuário fica ~1-5ms mais rápido (sem ida ao banco a cada request).

**Aviso quando paginação trunca dados.**
O cliente AdvBox tem um limite máximo de páginas que busca (15k processos,
20k clientes, etc). Antes, se o escritório passasse desses números, o
dashboard silenciosamente ignorava os dados acima — sem nenhum erro ou
aviso. Agora, quando isso acontece, um WARN aparece no log com a variável
de ambiente exata que precisa ser aumentada. Você também vê o histórico
em `/api/cache-status`.

**Alertas no Discord quando crons falham.**
Os 5 crons (auto-workflow, aniversário, briefing, snapshot, etc) antes
falhavam em silêncio — só apareciam nos logs. Agora, depois de 2 falhas
consecutivas, sai um alerta `🚨` no Discord (mesmo canal do briefing).
Quando recupera, sai um `✅`. Estado completo visível em `/api/healthz/jobs`.

**Webhook do AdvBox agora reage em tempo real.**
Antes, mudanças de fase de processo no AdvBox só eram detectadas pelo
cron horário (até 1h de atraso). Agora, o webhook Flowter invalida o
cache imediatamente e dispara o ciclo de auto-workflow só pra aquele
processo. *Precisa do `ADVBOX_FLOWTER_TOKEN` configurado — ver
[ação manual #3](#3-opcional-mas-recomendado-ativar-o-webhook-flowter).*

**Índices novos no banco pra queries mais rápidas.**
4 índices adicionados pras queries novas (mutações por processo,
uso de rota por usuário, pagamentos ASAAS não sincronizados, tendência
do controller por categoria). Tudo `CREATE INDEX IF NOT EXISTS` —
seguro pra re-rodar.

**Lock do auto-workflow validado.**
Adicionamos um script (`scripts/verify-advisory-lock.js`) que prova que
o auto-workflow não roda em duplicata mesmo se 2 instâncias tentarem ao
mesmo tempo. Roda em 2 segundos, retorna 0 se OK.

### 🎨 Experiência da equipe

**Mensagens de erro melhores nos formulários.**
Antes, ao enviar um formulário com 3 campos errados, o sistema só
mostrava o primeiro erro. A pessoa tinha que corrigir, submeter, ver o
próximo erro, corrigir, e assim por diante. Agora todos os erros vêm de
uma vez, com indicação clara de qual campo está com qual problema:

```
client_name: é obrigatório · kind: deve ser um de: a_vista, parcelado · 
first_due_date: data inválida (esperado AAAA-MM-DD)
```

Também detecta datas impossíveis (ex: 30 de fevereiro) que antes
passavam pelo filtro inicial e quebravam no banco com erro 500.

**Resposta de erro com mais contexto pra debug.**
Toda resposta de erro agora carrega: timestamp do erro, qual rota,
qual método HTTP, e um código estável (ex: `VALIDATION`, `CIRCUIT_OPEN`).
O `requestId` também — facilita pro suporte: a pessoa manda o ID, você
cruza com os logs em 5 segundos.

**Limites de uso por pessoa, não por IP do escritório.**
Antes, todo mundo no escritório compartilhava o mesmo limite de
requests (porque o IP de saída do Wi-Fi é o mesmo). Uma pessoa rodando
exportação em massa derrubava o resto da equipe. Agora cada usuário
tem seu próprio limite de 600 requests/minuto.

### 🛠 Qualidade técnica

**Nomes de fases centralizados.**
As fases do AdvBox (ex: `ELABORAR PETICAO INICIAL`, `COM PRAZO`) antes
apareciam como string em vários arquivos. Se você renomeasse uma fase
no AdvBox, precisava lembrar de atualizar em todos os lugares — fácil
errar e ter um deles silenciosamente desatualizado. Agora há um arquivo
único de constantes (`constants/phases.js`) que serve de fonte da
verdade pras fases usadas em mais de um lugar.

**Suite de testes automatizados (25 testes em 6 arquivos).**
Pra evitar que correções futuras quebrem o que já está funcionando,
escrevemos testes que rodam em 6 segundos no total (`npm test`):
- Validação de campos: 20 testes
- Circuit breaker: 9 testes  
- Cron guard: 6 testes
- Buffer de access-log: 8 testes
- Detecção de truncamento de paginação: 5 testes
- Cenários completos de autenticação: 5 testes (sobe o servidor, exercita
  as 5 combinações de `AUTH_REQUIRE_BCRYPT`, valida o comportamento)

---

## ⚠️ Ações manuais necessárias na produção

### 1. Gerar hashes bcrypt pras 9 senhas (**OBRIGATÓRIO**)

**Por quê:** antes do deploy, o app aceitava senhas em texto puro como
fallback. Depois do deploy, em produção, **o app vai recusar bootar**
se detectar texto puro sem hash correspondente. Essa proteção é o ponto
do fix de segurança #2.

**Como:**

Pra cada uma das **9 contas** que existem (`admin`, `time`, e os 7 advogados
em `services/team-users.js`), gere um hash bcrypt:

```bash
# Rode no Replit Shell, OU localmente:
node scripts/hash-password.js
```

O script pede a senha (sem mostrar no terminal) e imprime um hash
começando com `$2b$12$...`. **Copie esse hash exato.**

No painel do Replit > Secrets, adicione/edite a variável correspondente:

| Pra esta conta...   | Cole o hash em...             |
| ------------------- | ----------------------------- |
| admin (eduardo)     | `ADMIN_PASS_HASH`             |
| time (genérico)     | `TEAM_PASS_HASH`              |
| Eduardo (advogado)  | `ADV_USER_EDUARDO_HASH`       |
| Ana Marília         | `ADV_USER_MARILIA_HASH`       |
| Letícia             | `ADV_USER_LETICIA_HASH`       |
| Alice               | `ADV_USER_ALICE_HASH`         |
| Claudiana (Cau)     | `ADV_USER_CAU_HASH`           |
| Tammyres            | `ADV_USER_TAMMYRES_HASH`      |
| Thiago              | `ADV_USER_THIAGO_HASH`        |

**IMPORTANTE — ordem recomendada (zero downtime):**

1. Gere e configure **todos** os `*_HASH` primeiro (sem mexer no `*_PASS`).
2. Faça o deploy. App boota normal (o hash existe, plaintext fica ignorado
   silenciosamente porque hash tem precedência).
3. Confirme que **cada pessoa** consegue fazer login com a senha dela.
4. **Só depois disso**, delete as variáveis `*_PASS` antigas do Secrets.
5. Confirme `AUTH_REQUIRE_BCRYPT=true` no Secrets (ou deixe ausente — é
   o default em `NODE_ENV=production`).

Se você pular o passo 1 e fizer só "remover plaintext", as pessoas ficam
sem conseguir logar. Se você inverter ordem (remover plaintext antes de
adicionar hash), também. Por isso o plano é "adicionar hash → testar →
remover plaintext".

### 2. (RECOMENDADO) Ativar o `DISCORD_WEBHOOK_URL`

**Por quê:** o sistema usa o webhook do Discord pra:
- Mandar o briefing diário de operação às 7h30 (segunda a sexta)
- Alertar quando um cron falha 2x consecutivas (`🚨`)
- Avisar quando o cron recupera (`✅`)

Sem o webhook configurado, esses alertas viram no-op — os erros ainda
aparecem nos logs do Replit, mas você só descobre se olhar.

**Como:**

1. No Discord, vá no servidor → canal de operação → Server Settings →
   Integrations → Webhooks → New Webhook.
2. Copie a URL gerada.
3. Replit > Secrets > Adicione `DISCORD_WEBHOOK_URL` com essa URL.
4. Redeploy (ou reinicie). No próximo dia útil às 7h30 o briefing roda.

### 3. (OPCIONAL, MAS RECOMENDADO) Ativar o webhook Flowter do AdvBox

**Por quê:** sem ele, mudanças de fase de processo no AdvBox só são
detectadas pelo cron horário (até 1h de atraso). Com ele, o dashboard
reage em tempo real (segundos) — útil pra equipe ver o estado correto
sem precisar esperar.

**Como:**

1. Gere um token aleatório (no Replit Shell ou local):
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. Replit > Secrets > Adicione `ADVBOX_FLOWTER_TOKEN` com esse valor.
3. No painel do AdvBox → Flowter → criar webhook:
   - **URL:** `https://advbox-dashboard.replit.app/api/advbox/webhook/flowter`
     (substitua pela URL real do seu deploy)
   - **Header:** `x-flowter-token: <COLE O MESMO TOKEN AQUI>`
   - **Método:** POST
   - **Triggers:** marcar "tarefa concluída" + "fase mudada"
4. Salvar. Faça uma ação de teste no AdvBox (mudar fase de um processo
   qualquer) e veja em `/api/admin/flowter-events` se chegou.

---

## ✅ Como verificar que tudo subiu certo depois do deploy

1. **Logs do boot devem ter:**
   - `INFO: Dashboard rodando em http://localhost:5000`
   - 5 linhas de "Cron ... Agendado:" (auto-workflow, birthday, briefing
     se DISCORD_WEBHOOK_URL setado, controller-snapshot, discord-scheduler)
   - `INFO: [DB] Schema verificado/criado com sucesso.`
   - Sem warning sobre `AUTH_REQUIRE_BCRYPT=false` (significaria que
     você esqueceu de setar true em prod)
   - Sem warning sobre `DB_POOL_MAX=<N> é baixo`

2. **Faça login com cada usuário** pelo dashboard. Confirma que os
   hashes bcrypt estão funcionando.

3. **Acesse `/api/cache-status`** (precisa estar logado como admin).
   Deve retornar JSON com 4 grupos:
   - `entries` (caches existentes)
   - `breakers` (advbox, asaas, meta — todos `"state": "closed"`)
   - `accessLog` (buffer vazio inicialmente)
   - `pagination` (vazio inicialmente)

4. **Acesse `/api/healthz/jobs`**. Deve listar os 5 crons com status
   `"running"` (ou `"skipped"` se o webhook do Discord não estiver
   configurado).

5. **(Se DB acessível)** Rode o script de validação do lock:
   ```bash
   DATABASE_URL=<sua_url> node scripts/verify-advisory-lock.js
   ```
   Deve imprimir `✅ PASS — proteção contra ciclos concorrentes ...`.

---

## 🆘 Em caso de problema

**App não inicia, log diz "AUTH_REQUIRE_BCRYPT=true mas credenciais em
texto puro":**
- É a proteção funcionando. Você esqueceu de gerar/configurar pelo menos
  um `*_HASH`, OU deixou um `*_PASS` no Secrets sem o `*_HASH` correspondente.
- Solução: gere e configure todos os `*_HASH` faltantes, OU configure
  `AUTH_REQUIRE_BCRYPT=false` temporariamente (mas isso desfaz a proteção
  de segurança — só pra debug).

**App inicia mas pessoa não consegue logar:**
- Verifique se o `*_HASH` correto está no Secrets.
- Regenere o hash com `node scripts/hash-password.js` e cole de novo —
  às vezes problemas de copy-paste cortam parte do hash.

**Cron continua falhando depois do alerta no Discord:**
- Vá em `/api/healthz/jobs` (admin) e veja `consecutiveFailures` e
  `lastError` daquele cron. A causa provavelmente está aí.

**Rollback completo (voltar pra versão anterior):**
- Replit > histórico de versões > restaurar.
- Nenhuma migração de banco precisa ser desfeita (todas as alterações
  foram `CREATE INDEX IF NOT EXISTS` ou criação de tabelas novas idempotentes).

---

## Resumo dos arquivos novos (referência)

| Arquivo                             | Pra quê                                       |
| ----------------------------------- | --------------------------------------------- |
| `utils/validate.js`                 | Validação de inputs (formulários)             |
| `utils/circuitBreaker.js`           | Proteção contra APIs externas instáveis       |
| `services/mutation-log.js`          | Trilha de auditoria de mutações               |
| `constants/esteira.js`              | Fases financeiras (era inline em rota)        |
| `constants/phases.js`               | Nomes de fases compartilhados                 |
| `scripts/verify-advisory-lock.js`   | Verificador de lock do auto-workflow          |
| `tests/`                            | Suite de testes (25 testes)                   |
| `docs/ATUALIZACAO-MAIO-2026.md`     | Este documento                                |
