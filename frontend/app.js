const API_URL = 'http://localhost:3000';

const tokenKey = 'stadium_ticket_token';

function getToken() {
  return localStorage.getItem(tokenKey);
}

function setToken(token) {
  if (token) {
    localStorage.setItem(tokenKey, token);
  } else {
    localStorage.removeItem(tokenKey);
  }
}

function updateUserStatus() {
  const token = getToken();
  const userStatus = document.getElementById('user-status');

  if (!token) {
    userStatus.textContent = 'Faça login para comprar';
    return;
  }

  const payload = JSON.parse(atob(token.split('.')[1] || ''));
  userStatus.textContent = `Logado como: ${payload.name || 'Cliente'}`;
}

async function loadEvents() {
  const eventList = document.getElementById('event-list');
  const eventSelect = document.getElementById('event-select');

  try {
    const response = await fetch(`${API_URL}/events`);
    const events = await response.json();

    if (!Array.isArray(events)) {
      throw new Error('Resposta inválida da API');
    }

    eventList.innerHTML = events
      .map(
        (event) => `
          <article class="event-card">
            <h3>${event.teamHome} x ${event.teamAway}</h3>
            <div class="event-meta">
              <span>${event.stadium}</span>
              <span>${new Date(event.date).toLocaleString('pt-BR')}</span>
              <span>Disponíveis: ${event.available}</span>
              <span>Categoria: ${event.category}</span>
            </div>
            <div class="event-price">R$ ${event.price.toFixed(2)}</div>
          </article>
        `
      )
      .join('');

    eventSelect.innerHTML = events
      .map(
        (event) => `<option value="${event.id}">${event.teamHome} x ${event.teamAway}</option>`
      )
      .join('');
  } catch (error) {
    eventList.innerHTML = '<p>Não foi possível carregar os jogos no momento.</p>';
    console.error(error);
  }
}

async function loadProducts() {
  const target = document.getElementById('product-list');
  if (!target) return;

  try {
    const response = await fetch(`${API_URL}/products`);
    const products = await response.json();

    if (!Array.isArray(products)) {
      throw new Error('Resposta inválida dos produtos');
    }

    target.innerHTML = products.length
      ? products
          .map(
            (product) => `
              <article class="event-card product-card">
                <img src="${product.imageUrl || 'https://placehold.co/320x240'}" alt="${product.name}" class="product-image" />
                <h3>${product.name}</h3>
                <p>${product.description || 'Sem descrição'}</p>
                <div class="event-meta">
                  <span>Categoria: ${product.category || 'geral'}</span>
                  <span>Preço: R$ ${Number(product.price || 0).toFixed(2)}</span>
                </div>
              </article>
            `
          )
          .join('')
      : '<p>Nenhum produto cadastrado ainda.</p>';
  } catch (error) {
    target.innerHTML = '<p>Não foi possível carregar os produtos.</p>';
    console.error(error);
  }
}

async function handleAuth(event, type) {
  event.preventDefault();

  const authResult = document.getElementById('auth-result');
  authResult.className = 'auth-result';

  const payload = {
    name: document.getElementById('register-name')?.value,
    email: document.getElementById(type === 'register' ? 'register-email' : 'login-email').value,
    password: document.getElementById(type === 'register' ? 'register-password' : 'login-password').value
  };

  if (type === 'register') {
    payload.name = document.getElementById('register-name').value;
  }

  try {
    const response = await fetch(`${API_URL}/auth/${type}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || 'Erro de autenticação.');
    }

    setToken(data.token);
    authResult.classList.add('success');
    authResult.textContent = data.message;
    updateUserStatus();

    if (type === 'register') {
      document.getElementById('register-form').reset();
    } else {
      document.getElementById('login-form').reset();
    }
  } catch (error) {
    authResult.classList.add('error');
    authResult.textContent = error.message;
  }
}

async function handleProductSubmit(event) {
  event.preventDefault();

  const resultNode = document.getElementById('product-result');
  resultNode.className = 'product-result';
  resultNode.textContent = 'Salvando produto...';

  const formData = new FormData();
  const fileInput = document.getElementById('product-image');

  formData.append('name', document.getElementById('product-name').value);
  formData.append('description', document.getElementById('product-description').value);
  formData.append('price', document.getElementById('product-price').value);
  formData.append('category', document.getElementById('product-category').value);

  if (fileInput.files[0]) {
    formData.append('image', fileInput.files[0]);
  }

  try {
    const response = await fetch(`${API_URL}/products`, {
      method: 'POST',
      body: formData
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || 'Erro ao salvar produto.');
    }

    resultNode.classList.add('success');
    resultNode.textContent = `${data.message} Arquivo: ${data.processed}`;
    document.getElementById('product-form').reset();
    await loadProducts();
  } catch (error) {
    resultNode.classList.add('error');
    resultNode.textContent = error.message;
  }
}

document.getElementById('register-form').addEventListener('submit', (event) => handleAuth(event, 'register'));
document.getElementById('login-form').addEventListener('submit', (event) => handleAuth(event, 'login'));
document.getElementById('product-form').addEventListener('submit', handleProductSubmit);

document.getElementById('checkout-form').addEventListener('submit', async (event) => {
  event.preventDefault();

  const resultNode = document.getElementById('order-result');
  const token = getToken();

  const payload = {
    eventId: document.getElementById('event-select').value,
    quantity: Number(document.getElementById('quantity').value),
    customerName: document.getElementById('customer-name').value || '',
    customerEmail: document.getElementById('customer-email').value || ''
  };

  resultNode.className = 'order-result';
  resultNode.textContent = 'Processando compra...';

  try {
    const response = await fetch(`${API_URL}/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || 'Erro ao finalizar compra.');
    }

    resultNode.classList.add('success');
    resultNode.textContent = `${data.message} Total: R$ ${data.order.total.toFixed(2)}.`;
    document.getElementById('checkout-form').reset();
    await loadEvents();
  } catch (error) {
    resultNode.classList.add('error');
    resultNode.textContent = error.message;
  }
});

updateUserStatus();
loadEvents();
loadProducts();
