const express = require('express');
const cors = require('cors');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const AWS = require('aws-sdk');
const { Client } = require('pg');
const Redis = require('redis');
const sharp = require('sharp');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'stadium-ticket-secret';
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
const awsRegion = process.env.AWS_REGION || 'us-east-1';
const s3 = process.env.AWS_ACCESS_KEY_ID ? new AWS.S3({ region: awsRegion }) : null;
const sqs = process.env.AWS_ACCESS_KEY_ID ? new AWS.SQS({ region: awsRegion }) : null;
const sns = process.env.AWS_ACCESS_KEY_ID ? new AWS.SNS({ region: awsRegion }) : null;
const dynamodb = process.env.AWS_ACCESS_KEY_ID ? new AWS.DynamoDB.DocumentClient({ region: awsRegion }) : null;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const localQueue = [];
let redisClient = null;
let testStateInitialized = false;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(FRONTEND_DIR));

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const initialData = {
    users: [],
    orders: [],
    events: [
      {
        id: 'match-1',
        teamHome: 'São Paulo FC',
        teamAway: 'Palmeiras',
        stadium: 'Estádio do Morumbi',
        date: '2026-10-15T18:30:00',
        price: 120,
        available: 320,
        category: 'Arquibancada'
      },
      {
        id: 'match-2',
        teamHome: 'Flamengo',
        teamAway: 'Vasco',
        stadium: 'Maracanã',
        date: '2026-10-22T20:00:00',
        price: 180,
        available: 210,
        category: 'Cadeiras laterais'
      },
      {
        id: 'match-3',
        teamHome: 'Grêmio',
        teamAway: 'Internacional',
        stadium: 'Arena do Grêmio',
        date: '2026-10-29T19:45:00',
        price: 150,
        available: 260,
        category: 'Superior'
      }
    ],
    products: []
  };

  const shouldResetTestState = String(PORT) === '3100' && !testStateInitialized;

  if (!fs.existsSync(DATA_FILE) || shouldResetTestState) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(initialData, null, 2), 'utf8');
    testStateInitialized = true;
  }
}

function loadStore() {
  ensureDataFile();
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  return JSON.parse(raw);
}

function saveStore(store) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(`${password}:${JWT_SECRET}`).digest('hex');
}

function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email, name: user.name }, JWT_SECRET, {
    expiresIn: '7d'
  });
}

function getAuthToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

function authenticate(req, res, next) {
  const token = getAuthToken(req);

  if (!token) {
    return res.status(401).json({ message: 'Token de autenticação ausente.' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    return next();
  } catch (error) {
    return res.status(401).json({ message: 'Token inválido ou expirado.' });
  }
}

async function connectRedis() {
  if (redisClient) {
    return redisClient;
  }

  const redisUrl = process.env.REDIS_URL || (process.env.REDIS_HOST ? `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT || 6379}` : null);

  if (!redisUrl) {
    return null;
  }

  try {
    redisClient = Redis.createClient({ url: redisUrl });
    redisClient.on('error', (error) => console.warn('Redis indisponível:', error.message));
    await redisClient.connect();
    return redisClient;
  } catch (error) {
    console.warn('Redis não inicializado:', error.message);
    return null;
  }
}

async function getCachedData(key, fetcher, ttlSeconds = 180) {
  const client = await connectRedis();

  if (!client) {
    return fetcher();
  }

  try {
    const cachedValue = await client.get(key);

    if (cachedValue) {
      return JSON.parse(cachedValue);
    }

    const freshValue = await fetcher();
    await client.set(key, JSON.stringify(freshValue), { EX: ttlSeconds });
    return freshValue;
  } catch (error) {
    console.warn(`Erro ao usar cache Redis para ${key}:`, error.message);
    return fetcher();
  }
}

async function ensureRelationalSchema() {
  if (!process.env.DATABASE_URL && !process.env.DB_HOST) {
    return null;
  }

  try {
    const client = new Client({
      connectionString: process.env.DATABASE_URL || `postgresql://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || 'postgres'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'appdb'}`
    });

    await client.connect();
    await client.query(`
      CREATE TABLE IF NOT EXISTS products (
        id VARCHAR(100) PRIMARY KEY,
        name VARCHAR(200) NOT NULL,
        description TEXT,
        price NUMERIC(10, 2) DEFAULT 0,
        category VARCHAR(100),
        image_url TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.end();
    return client;
  } catch (error) {
    console.warn('RDS PostgreSQL indisponível:', error.message);
    return null;
  }
}

async function readProductsFromRds() {
  if (!process.env.DATABASE_URL && !process.env.DB_HOST) {
    return null;
  }

  try {
    const client = new Client({
      connectionString: process.env.DATABASE_URL || `postgresql://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || 'postgres'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'appdb'}`
    });

    await client.connect();
    const result = await client.query('SELECT * FROM products ORDER BY created_at DESC');
    await client.end();
    return result.rows;
  } catch (error) {
    console.warn('Não foi possível ler produtos no RDS:', error.message);
    return null;
  }
}

async function writeProductToRds(product) {
  if (!process.env.DATABASE_URL && !process.env.DB_HOST) {
    return null;
  }

  try {
    const client = new Client({
      connectionString: process.env.DATABASE_URL || `postgresql://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || 'postgres'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'appdb'}`
    });

    await client.connect();
    await client.query(
      `INSERT INTO products (id, name, description, price, category, image_url, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, price = EXCLUDED.price, category = EXCLUDED.category, image_url = EXCLUDED.image_url, updated_at = NOW()`,
      [product.id, product.name, product.description || '', Number(product.price), product.category || 'geral', product.imageUrl || null]
    );
    await client.end();
    return product;
  } catch (error) {
    console.warn('Não foi possível gravar produto no RDS:', error.message);
    return null;
  }
}

async function deleteProductFromRds(productId) {
  if (!process.env.DATABASE_URL && !process.env.DB_HOST) {
    return null;
  }

  try {
    const client = new Client({
      connectionString: process.env.DATABASE_URL || `postgresql://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || 'postgres'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'appdb'}`
    });

    await client.connect();
    await client.query('DELETE FROM products WHERE id = $1', [productId]);
    await client.end();
    return true;
  } catch (error) {
    console.warn('Não foi possível remover produto no RDS:', error.message);
    return null;
  }
}

async function logCrudAction(action, payload) {
  if (!dynamodb || !process.env.DYNAMODB_TABLE_NAME) {
    return null;
  }

  try {
    const item = {
      id: crypto.randomUUID(),
      action,
      payload: JSON.stringify(payload),
      timestamp: new Date().toISOString()
    };

    await dynamodb.put({
      TableName: process.env.DYNAMODB_TABLE_NAME,
      Item: item
    }).promise();

    return item;
  } catch (error) {
    console.warn('DynamoDB indisponível para auditoria:', error.message);
    return null;
  }
}

async function processUploadedFile(file) {
  if (!file) {
    return { processed: false, message: 'Nenhum arquivo enviado.' };
  }

  if (file.mimetype.startsWith('image/')) {
    const processedBuffer = await sharp(file.buffer)
      .resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();

    return {
      processed: true,
      buffer: processedBuffer,
      contentType: 'image/jpeg',
      fileName: `processed-${Date.now()}.jpg`,
      summary: 'Imagem redimensionada com sucesso.'
    };
  }

  const text = file.buffer.toString('utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);

  return {
    processed: true,
    buffer: Buffer.from(`Arquivo processado. Linhas: ${lines.length}.`, 'utf8'),
    contentType: 'text/plain',
    fileName: `processed-${Date.now()}.txt`,
    summary: `Arquivo processado: ${lines.length} linhas validas.`
  };
}

async function uploadBinaryToS3(fileBuffer, fileName, contentType) {
  if (!s3 || !process.env.S3_BUCKET_NAME) {
    return null;
  }

  const key = `products/${Date.now()}-${fileName}`;

  await s3.putObject({
    Bucket: process.env.S3_BUCKET_NAME,
    Key: key,
    Body: fileBuffer,
    ContentType: contentType,
    ACL: 'public-read'
  }).promise();

  return `https://${process.env.S3_BUCKET_NAME}.s3.${awsRegion}.amazonaws.com/${key}`;
}

async function enqueueProcessingMessage(payload) {
  const message = {
    ...payload,
    processedAt: new Date().toISOString()
  };

  if (process.env.SQS_QUEUE_URL && sqs) {
    await sqs.sendMessage({
      QueueUrl: process.env.SQS_QUEUE_URL,
      MessageBody: JSON.stringify(message)
    }).promise();
    return { provider: 'sqs', message };
  }

  if (process.env.SNS_TOPIC_ARN && sns) {
    await sns.publish({
      TopicArn: process.env.SNS_TOPIC_ARN,
      Subject: 'Product processing notification',
      Message: JSON.stringify(message)
    }).promise();
    return { provider: 'sns', message };
  }

  localQueue.push(message);
  return { provider: 'local-queue', message };
}

async function processQueueMessage(message) {
  console.log('[queue] processando mensagem:', message);

  if (message.imageUrl) {
    console.log(`[queue] arquivo processado para produto ${message.productId}: ${message.imageUrl}`);
  }

  return true;
}

async function drainLocalQueue() {
  if (localQueue.length === 0) {
    return;
  }

  const pendingMessages = [...localQueue];
  localQueue.length = 0;

  for (const message of pendingMessages) {
    await processQueueMessage(message);
  }
}

function getProductListFromStore() {
  const store = loadStore();
  return Array.isArray(store.products) ? store.products : [];
}

async function listProducts() {
  const rdsProducts = await readProductsFromRds();
  if (rdsProducts && Array.isArray(rdsProducts)) {
    return rdsProducts.map((product) => ({
      id: product.id,
      name: product.name,
      description: product.description,
      price: Number(product.price),
      category: product.category,
      imageUrl: product.image_url,
      createdAt: product.created_at,
      updatedAt: product.updated_at
    }));
  }

  return getProductListFromStore();
}

async function saveProductsToStore(products) {
  const store = loadStore();
  store.products = products;
  saveStore(store);
}

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'stadium-ticket-store-api',
    awsServices: {
      ec2: 'configured-on-instance',
      s3: !!process.env.S3_BUCKET_NAME,
      rds: !!(process.env.DATABASE_URL || process.env.DB_HOST),
      elasticache: !!(process.env.REDIS_HOST || process.env.REDIS_URL),
      dynamodb: !!process.env.DYNAMODB_TABLE_NAME,
      snsSqs: !!(process.env.SNS_TOPIC_ARN || process.env.SQS_QUEUE_URL)
    }
  });
});

app.get('/events', (req, res) => {
  const store = loadStore();
  res.json(store.events);
});

app.get('/products', async (req, res) => {
  try {
    const products = await getCachedData('products-cache', async () => listProducts(), 180);
    return res.json(products);
  } catch (error) {
    return res.status(500).json({ message: 'Não foi possível listar os produtos.', error: error.message });
  }
});

app.get('/products/:id', async (req, res) => {
  try {
    const products = await listProducts();
    const product = products.find((item) => item.id === req.params.id);

    if (!product) {
      return res.status(404).json({ message: 'Produto não encontrado.' });
    }

    await logCrudAction('READ', { productId: product.id, productName: product.name });
    return res.json(product);
  } catch (error) {
    return res.status(500).json({ message: 'Erro ao consultar produto.', error: error.message });
  }
});

app.post('/products', upload.single('image'), async (req, res) => {
  const { name, description, price, category } = req.body || {};

  if (!name || !price) {
    return res.status(400).json({ message: 'Nome e preço do produto são obrigatórios.' });
  }

  try {
    const productId = `product-${Date.now()}`;
    const processed = await processUploadedFile(req.file);
    let imageUrl = req.body.imageUrl || null;

    if (processed.processed && req.file) {
      const uploadedUrl = await uploadBinaryToS3(processed.buffer, processed.fileName, processed.contentType);
      imageUrl = uploadedUrl || `data:${processed.contentType};base64,${processed.buffer.toString('base64')}`;
    }

    const product = {
      id: productId,
      name,
      description: description || '',
      price: Number(price),
      category: category || 'geral',
      imageUrl,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const products = await listProducts();
    products.unshift(product);
    await saveProductsToStore(products);
    await writeProductToRds(product);
    await logCrudAction('CREATE', product);
    await enqueueProcessingMessage({ action: 'CREATE', productId: product.id, productName: product.name, imageUrl: product.imageUrl });

    return res.status(201).json({
      message: 'Produto criado com sucesso.',
      product,
      processed: processed.summary || 'Arquivo recebido.'
    });
  } catch (error) {
    return res.status(500).json({ message: 'Erro ao criar produto.', error: error.message });
  }
});

app.put('/products/:id', upload.single('image'), async (req, res) => {
  const { name, description, price, category } = req.body || {};

  try {
    const products = await listProducts();
    const index = products.findIndex((item) => item.id === req.params.id);

    if (index === -1) {
      return res.status(404).json({ message: 'Produto não encontrado.' });
    }

    const existing = products[index];
    const processed = req.file ? await processUploadedFile(req.file) : null;
    let imageUrl = existing.imageUrl;

    if (processed && req.file) {
      const uploadedUrl = await uploadBinaryToS3(processed.buffer, processed.fileName, processed.contentType);
      imageUrl = uploadedUrl || `data:${processed.contentType};base64,${processed.buffer.toString('base64')}`;
    }

    const updatedProduct = {
      ...existing,
      name: name || existing.name,
      description: description ?? existing.description,
      price: Number(price ?? existing.price),
      category: category || existing.category,
      imageUrl: imageUrl || existing.imageUrl,
      updatedAt: new Date().toISOString()
    };

    products[index] = updatedProduct;
    await saveProductsToStore(products);
    await writeProductToRds(updatedProduct);
    await logCrudAction('UPDATE', updatedProduct);
    await enqueueProcessingMessage({ action: 'UPDATE', productId: updatedProduct.id, productName: updatedProduct.name, imageUrl: updatedProduct.imageUrl });

    return res.json({
      message: 'Produto atualizado com sucesso.',
      product: updatedProduct,
      processed: processed ? processed.summary : 'Sem alteração de arquivo.'
    });
  } catch (error) {
    return res.status(500).json({ message: 'Erro ao atualizar produto.', error: error.message });
  }
});

app.delete('/products/:id', async (req, res) => {
  try {
    const products = await listProducts();
    const index = products.findIndex((item) => item.id === req.params.id);

    if (index === -1) {
      return res.status(404).json({ message: 'Produto não encontrado.' });
    }

    const removed = products.splice(index, 1)[0];
    await saveProductsToStore(products);
    await deleteProductFromRds(req.params.id);
    await logCrudAction('DELETE', removed);
    await enqueueProcessingMessage({ action: 'DELETE', productId: removed.id, productName: removed.name });

    return res.json({ message: 'Produto removido com sucesso.', product: removed });
  } catch (error) {
    return res.status(500).json({ message: 'Erro ao remover produto.', error: error.message });
  }
});

app.post('/auth/register', (req, res) => {
  const { name, email, password } = req.body || {};

  if (!name || !email || !password) {
    return res.status(400).json({ message: 'Nome, e-mail e senha são obrigatórios.' });
  }

  const store = loadStore();
  const alreadyExists = store.users.some((user) => user.email.toLowerCase() === email.toLowerCase());

  if (alreadyExists) {
    return res.status(409).json({ message: 'Este e-mail já está cadastrado.' });
  }

  const user = {
    id: `user-${Date.now()}`,
    name,
    email: email.toLowerCase(),
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString()
  };

  store.users.push(user);
  saveStore(store);

  const token = signToken(user);

  return res.status(201).json({
    message: 'Usuário cadastrado com sucesso!',
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email
    }
  });
});

app.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ message: 'E-mail e senha são obrigatórios.' });
  }

  const store = loadStore();
  const user = store.users.find((item) => item.email.toLowerCase() === String(email).toLowerCase());

  if (!user || user.passwordHash !== hashPassword(password)) {
    return res.status(401).json({ message: 'Credenciais inválidas.' });
  }

  const token = signToken(user);

  return res.json({
    message: 'Login realizado com sucesso!',
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email
    }
  });
});

app.get('/auth/me', authenticate, (req, res) => {
  const store = loadStore();
  const user = store.users.find((item) => item.id === req.user.sub);

  if (!user) {
    return res.status(404).json({ message: 'Usuário não encontrado.' });
  }

  return res.json({
    id: user.id,
    name: user.name,
    email: user.email
  });
});

app.post('/orders', (req, res) => {
  const { eventId, quantity, customerName, customerEmail } = req.body || {};
  const token = getAuthToken(req);
  const authenticatedUser = token ? jwt.decode(token, { complete: false }) : null;

  const finalCustomerName = customerName || authenticatedUser?.name || 'Cliente';
  const finalCustomerEmail = customerEmail || authenticatedUser?.email || 'cliente@local';

  if (!eventId || !quantity || !finalCustomerName || !finalCustomerEmail) {
    return res.status(400).json({ message: 'Dados incompletos para o pedido.' });
  }

  const store = loadStore();
  const event = store.events.find((item) => item.id === eventId);

  if (!event) {
    return res.status(404).json({ message: 'Jogo não encontrado.' });
  }

  if (quantity <= 0 || quantity > 10) {
    return res.status(400).json({ message: 'Quantidade de ingressos inválida.' });
  }

  if (quantity > event.available) {
    return res.status(409).json({ message: 'Quantidade indisponível para o evento selecionado.' });
  }

  const total = event.price * quantity;
  const order = {
    id: `order-${Date.now()}`,
    eventId,
    eventName: `${event.teamHome} x ${event.teamAway}`,
    quantity,
    total,
    customerName: finalCustomerName,
    customerEmail: finalCustomerEmail,
    status: 'confirmed',
    createdAt: new Date().toISOString(),
    userId: authenticatedUser ? authenticatedUser.sub : null
  };

  store.orders.push(order);
  event.available -= quantity;
  saveStore(store);

  return res.status(201).json({
    message: 'Pedido confirmado com sucesso!',
    order
  });
});

async function bootstrap() {
  await connectRedis();
  await ensureRelationalSchema();
  setInterval(drainLocalQueue, 5000);
}

bootstrap().catch((error) => {
  console.warn('Bootstrap do backend falhou:', error.message);
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`API em execução na porta ${PORT}`);
  });
}

module.exports = app;
