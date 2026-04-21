# Dashboard AdvBox - Guia de uso

## O que é isso

Um painel que mostra os dados do seu AdvBox de um jeito visual e personalizado:
- Processos por fase (gráfico)
- Últimas movimentações
- Resumo financeiro (a receber, a pagar)
- Clientes e aniversariantes do mês
- Tarefas pendentes

---

## Como colocar no ar (passo a passo, sem saber programar)

### 1. Criar conta grátis no Replit

1. Vai em https://replit.com
2. Cria uma conta (pode usar sua conta do Google)
3. Clica em **"+ Create Repl"** no canto

### 2. Subir os arquivos

1. Na tela de criar, escolhe o template **"Node.js"**
2. Dá um nome tipo "dashboard-advbox"
3. Clica em **Create Repl**
4. Do lado esquerdo vai ter uma lista de arquivos. **Apaga o `index.js`** que vem pronto.
5. Arrasta todos os arquivos desta pasta (index.js, package.json, e a pasta public/) pra dentro do Replit

### 3. Configurar seu token (PARTE IMPORTANTE)

1. No Replit, clica no ícone de **cadeado** (🔒 "Secrets") no menu da esquerda
2. Clica em **"+ New Secret"**
3. Em **Key**, digita exatamente: `ADVBOX_TOKEN`
4. Em **Value**, cola o seu token do AdvBox
5. Clica em **Add Secret**

⚠️ O token fica guardado de forma segura nos Secrets do Replit, não aparece no código.

### 4. Rodar

1. Clica no botão grande verde **"Run"** no topo
2. Na primeira vez, o Replit vai instalar as coisas necessárias (demora uns 30 segundos)
3. Vai abrir uma janelinha do lado com seu dashboard!
4. Clica no ícone de tela cheia pra abrir em uma aba inteira

### 5. Usar no dia a dia

- O Replit te dá um link tipo `https://dashboard-advbox.seu-usuario.repl.co`
- Você pode salvar esse link nos favoritos e acessar quando quiser
- Pra atualizar os dados, clica em "Atualizar dados" no dashboard

---

## Problemas comuns

**"Token nao configurado"** → Voltar no passo 3 e verificar se criou o Secret com o nome exato `ADVBOX_TOKEN`

**Aparece erro 401** → Seu token expirou ou tá errado. Gera um novo no AdvBox e atualiza o Secret.

**Aparece erro 429** → Você fez muitas requisições rápidas. Espera 1 minuto e tenta de novo.

**Algum dado não aparece** → Pode ser que seu escritório não tenha aquele dado cadastrado (ex: sem aniversariantes no mês). Normal.

---

## Pra evoluir depois

Esse é só o começo! Dá pra adicionar:
- Notificações no WhatsApp quando sair nova publicação
- Kanban de processos (arrastar pra mudar fase)
- Filtros por cliente, tipo de processo, etc.
- Relatórios em PDF

É só me chamar que a gente continua 🚀
