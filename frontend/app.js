// Detecta dinamicamente a URL da API Node.js
function getApiUrl() {
  const devPorts = ['5500', '5501', '5502', '8080', '5173', '3001', '4200'];
  // Se estiver abrindo como arquivo local ou via Live Server (portas comuns de desenvolvimento estático)
  if (
    window.location.protocol === 'file:' ||
    devPorts.includes(window.location.port)
  ) {
    return 'http://localhost:3000';
  }
  // Se estiver acessando diretamente pelo Express (:3000) ou em produção na nuvem (ALB / porta 80)
  return window.location.origin;
}

const API_URL = getApiUrl();
console.log(`[Stadium Tickets] Conectado à API em: ${API_URL}`);

const tokenKey = 'stadium_ticket_token';
let currentEvents = [];

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
  if (!userStatus) return;

  if (!token) {
    userStatus.textContent = 'Faça login para comprar';
    return;
  }

  try {
    const payload = JSON.parse(atob(token.split('.')[1] || ''));
    userStatus.textContent = `Torcedor: ${payload.name || payload.email || 'Conectado'}`;
  } catch (e) {
    userStatus.textContent = 'Conectado';
  }
}

// Helper seguro para chamadas à API com tratamento de erros amigável
async function safeFetchJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (netErr) {
    throw new Error(
      `Não foi possível conectar ao backend em ${API_URL}. Certifique-se de que o servidor Node.js está em execução (execute 'npm start' na pasta backend).`
    );
  }

  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : {};
  } catch (jsonErr) {
    throw new Error(
      `O servidor respondeu HTTP ${response.status} (${response.statusText || 'Erro'}), mas não retornou JSON. Verifique se o backend está rodando na porta 3000!`
    );
  }

  if (!response.ok) {
    throw new Error(data.message || `Erro HTTP ${response.status}: ${response.statusText}`);
  }

  return data;
}

// -------------------------------------------------------------------
// 1. MONITORAMENTO DOS 6 SERVIÇOS AWS (/health)
// -------------------------------------------------------------------
async function loadHealthStatus() {
  try {
    const data = await safeFetchJson(`${API_URL}/health`);

    const instanceBadge = document.getElementById('instance-badge');
    if (instanceBadge && data.instance) {
      instanceBadge.textContent = `Host: ${data.instance.hostname} | API: ${API_URL}`;
    }

    const services = data.awsServices || {};

    const setIndicator = (id, active, textOnline, textOffline) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.className = `status-indicator ${active ? 'online' : 'offline'}`;
      el.textContent = active ? textOnline : textOffline;
    };

    setIndicator('status-ec2', true, typeof services.ec2 === 'string' ? services.ec2 : 'EC2 Conectada', 'Local');
    setIndicator('status-rds', services.rds, 'RDS PostgreSQL', 'Store Fallback');
    setIndicator('status-elasticache', services.elasticache, 'Redis Ativo', 'Cache Local');
    setIndicator('status-s3', services.s3, 'S3 Bucket Ativo', 'Uploads Local');
    setIndicator('status-dynamodb', services.dynamodb, 'DynamoDB NoSQL', 'Logs em Memória');
    setIndicator('status-sqs', services.sqsSns, 'SQS / SNS Ativo', 'Worker Fila Local');
  } catch (error) {
    console.warn('Falha ao checar saúde dos serviços:', error.message);
    const instanceBadge = document.getElementById('instance-badge');
    if (instanceBadge) {
      instanceBadge.textContent = `Backend offline em ${API_URL}`;
    }
  }
}

// -------------------------------------------------------------------
// 2. LISTAGEM DE JOGOS (READ) COM CACHE NO REDIS E DADOS NO RDS
// -------------------------------------------------------------------
async function loadEvents() {
  const eventList = document.getElementById('event-list');
  const eventSelect = document.getElementById('event-select');
  if (!eventList || !eventSelect) return;

  try {
    const events = await safeFetchJson(`${API_URL}/events`);

    if (!Array.isArray(events)) {
      throw new Error('Formato inválido de resposta dos eventos');
    }

    currentEvents = events;

    if (events.length === 0) {
      eventList.innerHTML = '<div class="empty-state">Nenhum jogo cadastrado no momento. Cadastre um novo jogo abaixo!</div>';
      eventSelect.innerHTML = '<option value="">Nenhum jogo disponível</option>';
      return;
    }

    eventList.innerHTML = events
      .map((event) => {
        let imageSrc = event.thumbnailUrl || event.bannerUrl || 'https://images.unsplash.com/photo-1508098682722-e99c43a406b2?auto=format&fit=crop&w=600&q=80';
        if (imageSrc.startsWith('/')) {
          imageSrc = `${API_URL}${imageSrc}`;
        }

        const isWorkerPending = event.processingStatus === 'pending';
        const isLowStock = Number(event.available) <= 20;

        return `
          <article class="event-card" id="card-${event.id}">
            <div class="event-image-container">
              <img src="${imageSrc}" alt="${event.teamHome} x ${event.teamAway}" class="event-image" onerror="this.src='https://images.unsplash.com/photo-1508098682722-e99c43a406b2?auto=format&fit=crop&w=600&q=80'" />
              ${isWorkerPending ? '<span class="badge-pending">⏳ Worker SQS Processando...</span>' : ''}
              ${event.thumbnailUrl ? '<span class="badge-processed">✨ Thumbnail Otimizado S3</span>' : ''}
            </div>

            <div class="event-content">
              <h3>${event.teamHome} x ${event.teamAway}</h3>
              <p class="event-desc">${event.description || 'Confronto válido pelo campeonato oficial.'}</p>
              
              <div class="event-meta">
                <span>📍 <strong>Estádio:</strong> ${event.stadium}</span>
                <span>📅 <strong>Data:</strong> ${new Date(event.date).toLocaleString('pt-BR')}</span>
                <span>🎫 <strong>Setor:</strong> ${event.category || 'Geral'}</span>
                <span class="event-stock ${isLowStock ? 'low-stock' : ''}">
                  🎟️ <strong>Restantes:</strong> ${event.available} ingressos
                </span>
              </div>

              <div class="event-card-actions">
                <div class="price-tag">R$ ${Number(event.price).toFixed(2)}</div>
                <div class="btn-group">
                  <button class="btn btn-sm btn-primary" onclick="selectEventForBuy('${event.id}')">🛒 Comprar</button>
                  <button class="btn btn-sm btn-outline" onclick="openEditModal('${event.id}')" title="Editar jogo">✏️</button>
                  <button class="btn btn-sm btn-danger" onclick="deleteEvent('${event.id}')" title="Excluir jogo">🗑️</button>
                </div>
              </div>
            </div>
          </article>
        `;
      })
      .join('');

    eventSelect.innerHTML = events
      .map(
        (event) => `<option value="${event.id}" data-price="${event.price}">${event.teamHome} x ${event.teamAway} - R$ ${Number(event.price).toFixed(2)} (${event.available} restantes)</option>`
      )
      .join('');

    updateCheckoutPreview();
  } catch (error) {
    eventList.innerHTML = `<p class="error-text">${error.message}</p>`;
    console.error(error);
  }
}

// -------------------------------------------------------------------
// 3. CRUD: CREATE (Cadastrar Novo Evento com Upload S3 e Fila SQS)
// -------------------------------------------------------------------
const eventCreateForm = document.getElementById('event-create-form');
if (eventCreateForm) {
  eventCreateForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const resultNode = document.getElementById('create-result');
    resultNode.className = 'result-message';
    resultNode.textContent = 'Enviando dados para o RDS e imagem para o S3...';

    const formData = new FormData();
    formData.append('teamHome', document.getElementById('create-team-home').value.trim());
    formData.append('teamAway', document.getElementById('create-team-away').value.trim());
    formData.append('stadium', document.getElementById('create-stadium').value.trim());
    formData.append('date', document.getElementById('create-date').value);
    formData.append('price', document.getElementById('create-price').value);
    formData.append('available', document.getElementById('create-available').value);
    formData.append('category', document.getElementById('create-category').value.trim());
    formData.append('description', document.getElementById('create-description').value.trim());

    const bannerFile = document.getElementById('create-banner').files[0];
    if (bannerFile) {
      formData.append('banner', bannerFile);
    }

    try {
      const data = await safeFetchJson(`${API_URL}/events`, {
        method: 'POST',
        body: formData
      });

      resultNode.classList.add('success');
      resultNode.textContent = `✅ ${data.message} ${data.decoupledProcessing ? '(Banner enfileirado para o Worker via ' + data.decoupledProcessing.provider + ')' : ''}`;
      eventCreateForm.reset();

      await loadEvents();
      await loadAuditLogs();
    } catch (error) {
      resultNode.classList.add('error');
      resultNode.textContent = `❌ ${error.message}`;
    }
  });
}

// -------------------------------------------------------------------
// 4. CRUD: UPDATE (Editar Evento via Modal)
// -------------------------------------------------------------------
const editModal = document.getElementById('edit-modal');
const eventEditForm = document.getElementById('event-edit-form');

window.openEditModal = function (eventId) {
  const event = currentEvents.find((e) => e.id === eventId);
  if (!event) return;

  document.getElementById('edit-event-id').value = event.id;
  document.getElementById('edit-team-home').value = event.teamHome;
  document.getElementById('edit-team-away').value = event.teamAway;
  document.getElementById('edit-stadium').value = event.stadium;
  
  if (event.date) {
    const d = new Date(event.date);
    const localIso = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    document.getElementById('edit-date').value = localIso;
  }

  document.getElementById('edit-price').value = event.price;
  document.getElementById('edit-available').value = event.available;
  document.getElementById('edit-category').value = event.category || 'Geral';
  document.getElementById('edit-description').value = event.description || '';
  document.getElementById('edit-result').textContent = '';

  editModal.style.display = 'flex';
};

window.closeEditModal = function () {
  editModal.style.display = 'none';
};

document.getElementById('btn-close-modal')?.addEventListener('click', closeEditModal);
document.getElementById('btn-cancel-edit')?.addEventListener('click', closeEditModal);

if (eventEditForm) {
  eventEditForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const eventId = document.getElementById('edit-event-id').value;
    const resultNode = document.getElementById('edit-result');
    resultNode.className = 'result-message';
    resultNode.textContent = 'Atualizando evento no RDS...';

    const formData = new FormData();
    formData.append('teamHome', document.getElementById('edit-team-home').value.trim());
    formData.append('teamAway', document.getElementById('edit-team-away').value.trim());
    formData.append('stadium', document.getElementById('edit-stadium').value.trim());
    formData.append('date', document.getElementById('edit-date').value);
    formData.append('price', document.getElementById('edit-price').value);
    formData.append('available', document.getElementById('edit-available').value);
    formData.append('category', document.getElementById('edit-category').value.trim());
    formData.append('description', document.getElementById('edit-description').value.trim());

    const bannerFile = document.getElementById('edit-banner').files[0];
    if (bannerFile) {
      formData.append('banner', bannerFile);
    }

    try {
      const data = await safeFetchJson(`${API_URL}/events/${eventId}`, {
        method: 'PUT',
        body: formData
      });

      resultNode.classList.add('success');
      resultNode.textContent = '✅ Evento atualizado com sucesso!';
      setTimeout(() => {
        closeEditModal();
      }, 1000);

      await loadEvents();
      await loadAuditLogs();
    } catch (error) {
      resultNode.classList.add('error');
      resultNode.textContent = `❌ ${error.message}`;
    }
  });
}

// -------------------------------------------------------------------
// 5. CRUD: DELETE (Excluir Evento com log no DynamoDB)
// -------------------------------------------------------------------
window.deleteEvent = async function (eventId) {
  const event = currentEvents.find((e) => e.id === eventId);
  const name = event ? `${event.teamHome} x ${event.teamAway}` : eventId;

  if (!confirm(`Deseja realmente excluir o jogo "${name}"? Essa ação será registrada na auditoria do DynamoDB.`)) {
    return;
  }

  try {
    const data = await safeFetchJson(`${API_URL}/events/${eventId}`, {
      method: 'DELETE'
    });

    alert('Jogo excluído com sucesso!');
    await loadEvents();
    await loadAuditLogs();
  } catch (error) {
    alert(`Erro ao excluir: ${error.message}`);
  }
};

// -------------------------------------------------------------------
// 6. CHECKOUT / COMPRA DE INGRESSOS (Transação Atômica no RDS)
// -------------------------------------------------------------------
function updateCheckoutPreview() {
  const select = document.getElementById('event-select');
  const quantityInput = document.getElementById('quantity');
  const totalPreview = document.getElementById('checkout-total-preview');
  if (!select || !quantityInput || !totalPreview) return;

  const selectedOpt = select.options[select.selectedIndex];
  if (!selectedOpt || !selectedOpt.dataset.price) {
    totalPreview.textContent = 'R$ 0,00';
    return;
  }

  const price = Number(selectedOpt.dataset.price);
  const qty = Number(quantityInput.value) || 0;
  totalPreview.textContent = `R$ ${(price * qty).toFixed(2)}`;
}

document.getElementById('event-select')?.addEventListener('change', updateCheckoutPreview);
document.getElementById('quantity')?.addEventListener('input', updateCheckoutPreview);

window.selectEventForBuy = function (eventId) {
  const select = document.getElementById('event-select');
  if (select) {
    select.value = eventId;
    updateCheckoutPreview();
    window.location.hash = '#checkout';
  }
};

const checkoutForm = document.getElementById('checkout-form');
if (checkoutForm) {
  checkoutForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const resultNode = document.getElementById('order-result');
    resultNode.className = 'result-message';
    resultNode.textContent = 'Processando compra com controle atômico no RDS...';

    const payload = {
      eventId: document.getElementById('event-select').value,
      quantity: Number(document.getElementById('quantity').value),
      customerName: document.getElementById('customer-name').value.trim(),
      customerEmail: document.getElementById('customer-email').value.trim()
    };

    try {
      const data = await safeFetchJson(`${API_URL}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      resultNode.classList.add('success');
      resultNode.textContent = `🎉 ${data.message} Pedido #${data.order.id} confirmado no valor de R$ ${data.order.total.toFixed(2)}. Ingressos atualizados no RDS e no cache Redis!`;
      checkoutForm.reset();
      updateCheckoutPreview();

      await loadEvents();
      await loadAuditLogs();
    } catch (error) {
      resultNode.classList.add('error');
      resultNode.textContent = `❌ ${error.message}`;
    }
  });
}

// -------------------------------------------------------------------
// 7. TESTE DE CARGA DE CPU (Parte 2 - Auto Scaling)
// -------------------------------------------------------------------
const btnStartStress = document.getElementById('btn-start-stress');
if (btnStartStress) {
  btnStartStress.addEventListener('click', async () => {
    const duration = document.getElementById('stress-duration').value;
    const stressStatus = document.getElementById('stress-status');
    const stressMessage = document.getElementById('stress-message');

    stressStatus.style.display = 'flex';
    btnStartStress.disabled = true;
    const seconds = Math.round(Number(duration) / 1000);
    stressMessage.textContent = `Gerando 100% de carga de CPU por ${seconds}s para demonstrar o Auto Scaling no CloudWatch...`;

    try {
      const data = await safeFetchJson(`${API_URL}/stress?duration=${duration}`);
      stressMessage.textContent = `✅ Carga finalizada na instância ${data.instance}. Verifique o gráfico de CPU no CloudWatch!`;
      setTimeout(() => {
        stressStatus.style.display = 'none';
        btnStartStress.disabled = false;
      }, 5000);
    } catch (error) {
      stressMessage.textContent = `Erro ao disparar estresse: ${error.message}`;
      btnStartStress.disabled = false;
    }
  });
}

// -------------------------------------------------------------------
// 8. LOGS DE AUDITORIA NoSQL (DynamoDB)
// -------------------------------------------------------------------
async function loadAuditLogs() {
  const tbody = document.getElementById('audit-list');
  if (!tbody) return;

  try {
    const logs = await safeFetchJson(`${API_URL}/audit-logs`);

    if (!Array.isArray(logs) || logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">Nenhum log registrado ainda.</td></tr>';
      return;
    }

    tbody.innerHTML = logs.slice(0, 20).map((log) => {
      let payloadPreview = '';
      try {
        const parsed = typeof log.payload === 'string' ? JSON.parse(log.payload) : log.payload;
        payloadPreview = JSON.stringify(parsed, null, 1);
      } catch (e) {
        payloadPreview = String(log.payload || '');
      }

      const actionClass = log.action === 'CREATE' ? 'badge-create' :
                          log.action === 'DELETE' ? 'badge-delete' :
                          log.action === 'UPDATE' ? 'badge-update' :
                          log.action === 'READ' ? 'badge-read' : 'badge-worker';

      return `
        <tr>
          <td><small>${new Date(log.timestamp).toLocaleTimeString('pt-BR')} <br/><span class="date-muted">${new Date(log.timestamp).toLocaleDateString('pt-BR')}</span></small></td>
          <td><span class="badge-action ${actionClass}">${log.action}</span></td>
          <td><strong>${log.resource || 'item'}</strong></td>
          <td><pre class="log-payload">${payloadPreview}</pre></td>
        </tr>
      `;
    }).join('');
  } catch (error) {
    tbody.innerHTML = `<tr ><td colspan="4" class="error-text">${error.message}</td></tr>`;
  }
}

// -------------------------------------------------------------------
// 9. AUTENTICAÇÃO SIMPLES
// -------------------------------------------------------------------
async function handleAuth(event, type) {
  event.preventDefault();
  const authResult = document.getElementById('auth-result');
  authResult.className = 'auth-result';

  const payload = {
    email: document.getElementById(type === 'register' ? 'register-email' : 'login-email').value,
    password: document.getElementById(type === 'register' ? 'register-password' : 'login-password').value
  };

  if (type === 'register') {
    payload.name = document.getElementById('register-name').value;
  }

  try {
    const data = await safeFetchJson(`${API_URL}/auth/${type}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    setToken(data.token);
    authResult.classList.add('success');
    authResult.textContent = `✅ ${data.message}`;
    updateUserStatus();

    if (type === 'register') document.getElementById('register-form').reset();
    else document.getElementById('login-form').reset();
  } catch (error) {
    authResult.classList.add('error');
    authResult.textContent = `❌ ${error.message}`;
  }
}

document.getElementById('register-form')?.addEventListener('submit', (e) => handleAuth(e, 'register'));
document.getElementById('login-form')?.addEventListener('submit', (e) => handleAuth(e, 'login'));
document.getElementById('btn-refresh-events')?.addEventListener('click', loadEvents);
document.getElementById('btn-refresh-audit')?.addEventListener('click', loadAuditLogs);
document.getElementById('btn-refresh-health')?.addEventListener('click', loadHealthStatus);

// Inicialização
updateUserStatus();
loadHealthStatus();
loadEvents();
loadAuditLogs();
setInterval(loadHealthStatus, 15000);
