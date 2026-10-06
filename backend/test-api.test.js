const test = require('node:test');
const assert = require('node:assert/strict');

const { spawn } = require('node:child_process');
const path = require('node:path');

function startServer() {
  return new Promise((resolve, reject) => {
    const server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      env: { ...process.env, PORT: '3100' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    server.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes('API em execução na porta 3100')) {
        resolve(server);
      }
    });

    server.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    server.on('error', reject);

    setTimeout(() => {
      if (!stdout.includes('API em execução na porta 3100')) {
        reject(new Error(`Servidor não iniciou corretamente. stderr=${stderr}`));
      }
    }, 3000);
  });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null
  };
}

test('health endpoint responde ok', async () => {
  const server = await startServer();

  try {
    const result = await fetchJson('http://localhost:3100/health');
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'ok');
  } finally {
    server.kill('SIGTERM');
  }
});

test('POST /orders confirma compra com dados válidos', async () => {
  const server = await startServer();

  try {
    const result = await fetchJson('http://localhost:3100/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId: 'match-1',
        quantity: 2,
        customerName: 'João da Silva',
        customerEmail: 'joao@email.com'
      })
    });

    assert.equal(result.status, 201);
    assert.equal(result.body.message, 'Pedido confirmado com sucesso!');
    assert.equal(result.body.order.quantity, 2);
    assert.equal(result.body.order.status, 'confirmed');
  } finally {
    server.kill('SIGTERM');
  }
});

test('POST /auth/register e /auth/login geram token válido', async () => {
  const server = await startServer();

  try {
    const register = await fetchJson('http://localhost:3100/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Maria Souza',
        email: 'maria@email.com',
        password: 'senha123'
      })
    });

    assert.equal(register.status, 201);
    assert.equal(register.body.user.email, 'maria@email.com');
    assert.ok(register.body.token);

    const login = await fetchJson('http://localhost:3100/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'maria@email.com',
        password: 'senha123'
      })
    });

    assert.equal(login.status, 200);
    assert.ok(login.body.token);
    assert.equal(login.body.user.email, 'maria@email.com');
  } finally {
    server.kill('SIGTERM');
  }
});
