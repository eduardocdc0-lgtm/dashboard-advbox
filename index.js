// ========================================
// Dashboard AdvBox - Servidor Proxy
// ========================================
// Este servidor faz o "meio-campo" entre seu dashboard (HTML) e a API do AdvBox.
// Ele resolve o problema de CORS e mantém o token seguro no servidor.

const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

// O token fica guardado aqui, como variável de ambiente (mais seguro)
const ADVBOX_TOKEN = process.env.ADVBOX_TOKEN || '';
const ADVBOX_BASE_URL = 'https://app.advbox.com.br/api/v1';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // serve o index.html

// Função auxiliar que chama a API do AdvBox
async function callAdvBox(endpoint) {
  if (!ADVBOX_TOKEN) {
    throw new Error('Token nao configurado. Configure a variavel ADVBOX_TOKEN em Secrets.');
  }
  const url = `${ADVBOX_BASE_URL}${endpoint}`;
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${ADVBOX_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || data.message || `Erro ${response.status}`);
  }
  return data;
}

// Rotas do proxy - cada uma chama um endpoint do AdvBox
app.get('/api/settings', async (req, res) => {
  try {
    const data = await callAdvBox('/settings');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/lawsuits', async (req, res) => {
  try {
    const data = await callAdvBox('/lawsuits?limit=1000');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/last-movements', async (req, res) => {
  try {
    const data = await callAdvBox('/last_movements?limit=20');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/transactions', async (req, res) => {
  try {
    const data = await callAdvBox('/transactions?limit=1000');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/customers', async (req, res) => {
  try {
    const data = await callAdvBox('/customers?limit=1000');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/birthdays', async (req, res) => {
  try {
    const data = await callAdvBox('/customers/birthdays');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/posts', async (req, res) => {
  try {
    const data = await callAdvBox('/posts?limit=50');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Dashboard rodando em http://localhost:${PORT}`);
  if (!ADVBOX_TOKEN) {
    console.log('ATENCAO: Configure o token em Secrets (ADVBOX_TOKEN)');
  }
});
