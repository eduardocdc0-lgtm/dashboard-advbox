/**
 * Integration tests pra autenticação — exercita o boot do dashboard
 * em diferentes configs de AUTH_REQUIRE_BCRYPT e verifica os 5 cenários
 * documentados (dev passa plaintext, prod com plaintext falha, prod com
 * hash funciona, hash tem precedência, ADV_USER_* também valida).
 *
 * NÃO precisa de Postgres real — pode rodar com DATABASE_URL vazio.
 * Boot vai logar erro de DB e continuar (comportamento esperado em dev).
 *
 * Cada teste pega uma porta livre dinamicamente, sobe o server num child
 * process com env vars específicas, espera o "Dashboard rodando" log
 * (ou crash), exercita o endpoint, mata.
 *
 * Em caso de falha de assertion: stderr/stdout do server são logados pra
 * facilitar o debug — assim você não precisa adivinhar por que o boot
 * crashou ou por que o login deu 401.
 */

'use strict';

require('../_test-env');

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const net  = require('node:net');

const ROOT       = path.resolve(__dirname, '..', '..');
const ENTRY      = path.join(ROOT, 'clients', 'dashboard', 'index.js');
const BOOT_TIMEOUT_MS = 10000;

// Hash bcrypt real de "test123" (gerado via bcryptjs@3 cost 12). NÃO é um
// segredo — é fixture de teste. Se bcryptjs mudar formato no futuro e este
// hash deixar de verificar, regenerar com:
//   node -e "console.log(require('bcryptjs').hashSync('test123', 12))"
const TEST_HASH = '$2b$12$o0fnv2HFO0.32E9AsnQYw.W2ZrHHQ/kifp3oUzTYrYkLDNXvF2JUu';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Pede uma porta livre pro kernel (listen 0 → kernel atribui → captura → fecha). */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function bootServer(port, env) {
  return new Promise((resolve) => {
    const proc = spawn('node', [ENTRY], {
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: 'development',
        SESSION_SECRET: 'test-session-secret-32-bytes-minimum-here',
        DATABASE_URL: '',
        CORS_ORIGINS: 'http://localhost:' + port,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let booted = false;
    let resolved = false;

    function done(value) {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(value);
    }

    const timer = setTimeout(() => {
      if (!booted) {
        try { proc.kill('SIGKILL'); } catch (_) {}
        done({ proc: null, stdout, stderr, exitCode: 'TIMEOUT', timeout: true });
      }
    }, BOOT_TIMEOUT_MS);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (!booted && stdout.includes('Dashboard rodando')) {
        booted = true;
        done({ proc, stdout, stderr, getOutput: () => ({ stdout, stderr }) });
      }
    });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('exit', (code) => {
      if (!booted) {
        done({ proc: null, stdout, stderr, exitCode: code });
      }
    });
    proc.on('error', (err) => {
      if (!booted) {
        done({ proc: null, stdout, stderr, exitCode: 'SPAWN_ERROR', spawnError: err.message });
      }
    });
  });
}

function killServer(proc) {
  if (!proc || proc.killed || proc.exitCode != null) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    proc.once('exit', finish);
    try { proc.kill('SIGTERM'); } catch (_) { finish(); return; }
    setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) {}
      finish();
    }, 2000);
  });
}

function httpPost(port, p, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('http timeout')); });
    req.write(JSON.stringify(body));
    req.end();
  });
}

/** Loga stdout+stderr capturados pra facilitar debug quando uma assertion falha. */
function dumpServerOutput(label, captured) {
  console.error(`\n──── ${label} ────`);
  console.error('exitCode: ' + (captured.exitCode ?? 'still running'));
  if (captured.timeout) console.error('(boot timeout)');
  if (captured.spawnError) console.error('spawn error: ' + captured.spawnError);
  console.error('--- STDOUT ---');
  console.error(captured.stdout || '(vazio)');
  console.error('--- STDERR ---');
  console.error(captured.stderr || '(vazio)');
  console.error('────────────────\n');
}

/** Wrapper que assertEqual com mensagem rica em falha de teste de servidor. */
function assertWithContext(actualFn, expected, label, captured) {
  let actual;
  try { actual = actualFn(); } catch (e) {
    dumpServerOutput(label, captured);
    throw e;
  }
  try {
    if (typeof expected === 'function') expected(actual);
    else assert.equal(actual, expected);
  } catch (e) {
    dumpServerOutput(label, captured);
    throw e;
  }
}

// ── Testes ───────────────────────────────────────────────────────────────────

describe('AUTH_REQUIRE_BCRYPT — boot scenarios', () => {
  let running = null;

  after(async () => { await killServer(running?.proc); });

  it('Cenário 1: dev com plaintext — boot OK + login passa', async () => {
    const port = await getFreePort();
    running = await bootServer(port, {
      AUTH_REQUIRE_BCRYPT: 'false',
      ADMIN_USER: 'eduardo', ADMIN_PASS: 'admin123',
    });
    if (!running.proc) {
      dumpServerOutput('Cenário 1 — boot falhou', running);
      assert.fail('server deveria ter bootado');
    }

    let resp;
    try {
      resp = await httpPost(port, '/api/login', { username: 'eduardo', password: 'admin123' });
    } catch (err) {
      dumpServerOutput('Cenário 1 — httpPost erro', running);
      throw err;
    }
    if (resp.status !== 200) dumpServerOutput('Cenário 1 — login não retornou 200', running);
    assert.equal(resp.status, 200, `esperado 200, recebeu ${resp.status} — body: ${JSON.stringify(resp.body)}`);
    assert.equal(resp.body.role, 'admin');
    await killServer(running.proc);
    running = null;
  });

  it('Cenário 2: prod-mode com plaintext sem hash — boot FALHA', async () => {
    const port = await getFreePort();
    running = await bootServer(port, {
      AUTH_REQUIRE_BCRYPT: 'true',
      ADMIN_USER: 'eduardo', ADMIN_PASS: 'admin123',
    });
    if (running.proc) dumpServerOutput('Cenário 2 — server NÃO devia ter bootado', running);
    assert.equal(running.proc, null, 'server NÃO devia ter bootado');
    assert.ok(running.exitCode !== 0, 'exit code deveria ser não-zero');
    assert.match(
      running.stderr + running.stdout,
      /AUTH_REQUIRE_BCRYPT=true mas/,
      'mensagem de erro deve mencionar a flag'
    );
  });

  it('Cenário 3: prod-mode com HASH — boot OK + login com senha correta funciona', async () => {
    const port = await getFreePort();
    running = await bootServer(port, {
      AUTH_REQUIRE_BCRYPT: 'true',
      ADMIN_USER: 'eduardo',
      ADMIN_PASS_HASH: TEST_HASH,
    });
    if (!running.proc) {
      dumpServerOutput('Cenário 3 — boot falhou', running);
      assert.fail('server devia ter bootado');
    }

    const ok = await httpPost(port, '/api/login', { username: 'eduardo', password: 'test123' });
    if (ok.status !== 200) dumpServerOutput('Cenário 3 — login com senha correta retornou ' + ok.status, running);
    assert.equal(ok.status, 200, `esperado 200, recebeu ${ok.status} — body: ${JSON.stringify(ok.body)}`);

    const bad = await httpPost(port, '/api/login', { username: 'eduardo', password: 'wrong' });
    if (bad.status !== 401) dumpServerOutput('Cenário 3 — login com senha errada retornou ' + bad.status, running);
    assert.equal(bad.status, 401);
    await killServer(running.proc);
    running = null;
  });

  it('Cenário 4: hash + plaintext setados — hash vence, plaintext é ignorado', async () => {
    const port = await getFreePort();
    running = await bootServer(port, {
      AUTH_REQUIRE_BCRYPT: 'true',
      ADMIN_USER: 'eduardo',
      ADMIN_PASS_HASH: TEST_HASH,
      ADMIN_PASS: 'admin123',
    });
    if (!running.proc) {
      dumpServerOutput('Cenário 4 — boot falhou', running);
      assert.fail('server devia ter bootado');
    }

    const ok = await httpPost(port, '/api/login', { username: 'eduardo', password: 'test123' });
    if (ok.status !== 200) dumpServerOutput('Cenário 4 — login pelo hash retornou ' + ok.status, running);
    assert.equal(ok.status, 200, `login pelo hash deve funcionar — body: ${JSON.stringify(ok.body)}`);

    const bad = await httpPost(port, '/api/login', { username: 'eduardo', password: 'admin123' });
    if (bad.status !== 401) dumpServerOutput('Cenário 4 — plaintext NÃO devia autenticar', running);
    assert.equal(bad.status, 401, 'plaintext NÃO pode autenticar quando require=true');
    await killServer(running.proc);
    running = null;
  });

  it('Cenário 5: ADV_USER_<NOME> em plaintext sem hash — boot FALHA também', async () => {
    const port = await getFreePort();
    running = await bootServer(port, {
      AUTH_REQUIRE_BCRYPT: 'true',
      ADMIN_USER: 'eduardo', ADMIN_PASS_HASH: TEST_HASH,
      ADV_USER_EDUARDO: 'somepassword',
    });
    if (running.proc) dumpServerOutput('Cenário 5 — server NÃO devia ter bootado', running);
    assert.equal(running.proc, null, 'server NÃO devia ter bootado');
    assert.match(
      running.stderr + running.stdout,
      /(team-users|ADV_USER_EDUARDO|texto puro)/i,
      'mensagem de erro deve mencionar credencial individual em texto puro'
    );
  });
});
