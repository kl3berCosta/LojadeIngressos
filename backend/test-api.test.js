const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('./server.js');
const worker = require('./worker.js');

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://localhost:${port}`;
      console.log(`[Test] Servidor de teste ouvindo em ${baseUrl}`);
      resolve();
    });
  });
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

async function fetchJson(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null
  };
}

test('GET /health responde status ok e informa os serviços AWS', async () => {
  const res = await fetchJson('/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  assert.ok(res.body.awsServices);
  assert.ok('ec2' in res.body.awsServices);
  assert.ok('rds' in res.body.awsServices);
  assert.ok('elasticache' in res.body.awsServices);
  assert.ok('s3' in res.body.awsServices);
  assert.ok('dynamodb' in res.body.awsServices);
  assert.ok('sqsSns' in res.body.awsServices);
});

test('GET /events lista eventos disponíveis', async () => {
  const res = await fetchJson('/events');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length > 0);
  const first = res.body[0];
  assert.ok(first.teamHome);
  assert.ok(first.teamAway);
  assert.ok(first.price);
  assert.ok(first.available > 0);
});

test('POST /events cadastra novo evento e enfileira tarefa de banner', async () => {
  const res = await fetchJson('/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      teamHome: 'Ceará SC',
      teamAway: 'Fortaleza EC',
      stadium: 'Arena Castelão',
      date: '2026-11-10T16:00:00',
      price: 80.00,
      available: 500,
      category: 'Cadeira Especial',
      description: 'Clássico-Rei cearense'
    })
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.message, 'Evento cadastrado com sucesso!');
  assert.equal(res.body.event.teamHome, 'Ceará SC');
  assert.equal(res.body.event.available, 500);
});

test('POST /orders realiza compra e decrementa disponibilidade', async () => {
  const eventsBefore = await fetchJson('/events');
  const targetEvent = eventsBefore.body[0];
  const initialAvailable = targetEvent.available;

  const buyRes = await fetchJson('/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventId: targetEvent.id,
      quantity: 2,
      customerName: 'Torcedor Fiel',
      customerEmail: 'torcedor@email.com'
    })
  });

  assert.equal(buyRes.status, 201);
  assert.equal(buyRes.body.message, 'Compra realizada com sucesso!');
  assert.equal(buyRes.body.order.quantity, 2);
  assert.equal(buyRes.body.order.total, targetEvent.price * 2);

  // Valida que o estoque diminuiu
  const eventsAfter = await fetchJson('/events');
  const updatedEvent = eventsAfter.body.find((e) => e.id === targetEvent.id);
  assert.equal(updatedEvent.available, initialAvailable - 2);
});

test('GET /audit-logs retorna histórico de ações do CRUD (NoSQL DynamoDB)', async () => {
  const res = await fetchJson('/audit-logs');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length > 0);
  const hasCreate = res.body.some((log) => log.action === 'CREATE');
  assert.ok(hasCreate, 'Deveria conter ação CREATE registrada nos logs');
});

test('GET /stress executa carga de CPU com sucesso', async () => {
  const res = await fetchJson('/stress?duration=200');
  assert.equal(res.status, 200);
  assert.ok(res.body.message.includes('Carga de CPU executada'));
});

test('Worker desacoplado processa tarefas da fila assíncrona', async () => {
  // Cria uma tarefa de redimensionamento na fila
  const testImageBuffer = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );

  const task = {
    eventId: 'match-1',
    fileName: 'pixel.png',
    imageBase64: testImageBuffer.toString('base64'),
    bannerUrl: 'local/pixel.png'
  };

  const processed = await worker.processMessage(task);
  assert.equal(processed, true);

  // Verifica se o evento teve seu thumbnail_url atualizado
  const eventRes = await fetchJson('/events/match-1');
  assert.equal(eventRes.status, 200);
  assert.ok(eventRes.body.thumbnailUrl, 'Thumbnail deve ter sido preenchido pelo worker');
  assert.equal(eventRes.body.processingStatus, 'completed');
});
