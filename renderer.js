// renderer.js - Сармат Пульт (полная версия с поддержкой мыши и мгновенным откликом)
console.log('Renderer запущен');

const api = window.electronAPI;

// DOM элементы
const loginPanel = document.getElementById('loginPanel');
const mainPanel = document.getElementById('mainPanel');
const connectionStatusSpan = document.getElementById('connectionStatus');
const userCallsignSpan = document.getElementById('userCallsign');
const currentFreqSpan = document.getElementById('currentFreq');
const pttModeSpan = document.getElementById('pttMode');
const logList = document.getElementById('logList');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const loginBtn = document.getElementById('loginBtn');
const loginErrorDiv = document.getElementById('loginError');
const logoutBtn = document.getElementById('logoutBtn');
const recordHotkeyBtn = document.getElementById('recordHotkeyBtn');
const currentHotkeyLabel = document.getElementById('currentHotkeyLabel');
const pttModeSelect = document.getElementById('pttModeSelect');
const toggleShortcutsBtn = document.getElementById('toggleShortcutsBtn');

// Firebase настройки
const PROXY_URL = "https://firebase-auth-proxy.boldinoverofej.workers.dev";
const DATABASE_URL = "https://authentication-cf670-default-rtdb.europe-west1.firebasedatabase.app";

let currentUser = null;
let currentUserId = null;
let currentFaction = 'sarmat';
let currentCallsign = 'Боец';
let currentFrequency = null;
let isPTTActive = false;
let idToken = null;

let pttBehavior = localStorage.getItem('electron_ptt_behavior') || 'hold';
let isPulserActive = true;
let isVoiceActiveOnSite = false;
let statusCheckInterval = null;

function addLog(message, type = 'info') {
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  const timestamp = new Date().toLocaleTimeString();
  entry.textContent = `[${timestamp}] ${message}`;
  if (type === 'error') entry.style.color = '#ff5555';
  else if (type === 'success') entry.style.color = '#4CAF50';
  logList.prepend(entry);
  while (logList.children.length > 100) logList.removeChild(logList.lastChild);
}

function updateConnectionStatus(connected) {
  connectionStatusSpan.textContent = connected ? 'СИСТЕМА ОНЛАЙН' : 'СИСТЕМА ОФФЛАЙН';
  connectionStatusSpan.className = `status ${connected ? 'online' : 'offline'}`;
}

// --- Работа с Firebase ---
async function authRequest(endpoint, body) {
  const response = await fetch(`${PROXY_URL}/${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Ошибка аутентификации');
  return data;
}

async function rtdbSet(path, value) {
  if (!idToken) throw new Error('Не авторизован');
  const url = `${DATABASE_URL}/${path}.json?auth=${idToken}`;
  // Опция keepalive: true повторно использует открытое TCP-соединение, исключая повторные задержки
  const res = await fetch(url, { method: 'PUT', body: JSON.stringify(value), keepalive: true });
  if (!res.ok) throw new Error(`RTDB error: ${res.status}`);
  return res.json();
}

async function rtdbDelete(path) {
  if (!idToken) throw new Error('Не авторизован');
  const url = `${DATABASE_URL}/${path}.json?auth=${idToken}`;
  const res = await fetch(url, { method: 'DELETE', keepalive: true });
  if (!res.ok) throw new Error(`RTDB delete error: ${res.status}`);
}

async function setPTT(active) {
  if (!currentUserId || !idToken) return;
  try {
    const pttPath = `ptt/${currentUserId}`;
    if (active) await rtdbSet(pttPath, { active: true, timestamp: Date.now() });
    else await rtdbDelete(pttPath);
  } catch (e) {
    addLog(`Ошибка отправки PTT: ${e.message}`, 'error');
  }
}

async function sendFreqSlot(slotNum) {
  if (!currentUserId || !idToken) return;
  try {
    const freqCommandPath = `freq_commands/${currentUserId}`;
    await rtdbSet(freqCommandPath, { slot: slotNum, timestamp: Date.now() });
    addLog(`Запрос смены канала: Слот ${slotNum}`, 'success');
    setTimeout(async () => { try { await rtdbDelete(freqCommandPath); } catch(e) {} }, 3000);
  } catch (e) {
    addLog(`Ошибка переключения слота: ${e.message}`, 'error');
  }
}

// --- Синхронизация с сайтом ---
async function startStatusChecking() {
  if (statusCheckInterval) clearInterval(statusCheckInterval);
  statusCheckInterval = setInterval(async () => {
    if (!currentUserId || !idToken || !isPulserActive) return;
    try {
      const url = `${DATABASE_URL}/radio_active/${currentUserId}.json?auth=${idToken}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      const nowActive = data && data.active === true;
      const newFreq = data ? (data.freq || '---') : '---';
      if (nowActive !== isVoiceActiveOnSite || newFreq !== currentFrequency) {
        isVoiceActiveOnSite = nowActive;
        currentFrequency = isVoiceActiveOnSite ? newFreq : null;
        if (isVoiceActiveOnSite) {
          currentFreqSpan.textContent = currentFrequency;
          pttModeSpan.textContent = '🟢 ОЖИДАНИЕ';
          pttModeSpan.style.color = '#4CAF50';
          addLog(`Связь синхронизирована. Канал: ${currentFrequency}`, 'success');
        } else {
          currentFreqSpan.textContent = '---';
          pttModeSpan.textContent = '🔒 РАЦИЯ ВЫКЛ. НА САЙТЕ';
          pttModeSpan.style.color = '#888';
          if (isPTTActive) {
            isPTTActive = false;
            setPTT(false);
          }
          addLog('Рация выключена на сайте (Команды заблокированы)', 'info');
        }
      }
    } catch(e) { console.warn("Сбой синхронизации", e); }
  }, 3000);
}

// Принудительное обновление статуса радио и частоты
async function refreshRadioStatus() {
  if (!currentUserId || !idToken) return;
  try {
    const url = `${DATABASE_URL}/radio_active/${currentUserId}.json?auth=${idToken}`;
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();
    const nowActive = data && data.active === true;
    const newFreq = data ? (data.freq || '---') : '---';
    isVoiceActiveOnSite = nowActive;
    currentFrequency = isVoiceActiveOnSite ? newFreq : null;
    if (isVoiceActiveOnSite) {
      currentFreqSpan.textContent = currentFrequency;
      pttModeSpan.textContent = '🟢 ОЖИДАНИЕ';
      pttModeSpan.style.color = '#4CAF50';
      addLog(`Связь восстановлена. Канал: ${currentFrequency}`, 'success');
    } else {
      currentFreqSpan.textContent = '---';
      pttModeSpan.textContent = '🔒 РАЦИЯ ВЫКЛ. НА САЙТЕ';
      pttModeSpan.style.color = '#888';
      addLog('Рация не активна на сайте', 'info');
    }
  } catch(e) {
    console.warn("Ошибка обновления статуса радио", e);
  }
}

// --- Обработчик PTT через down/up ---
function setupPttEvents() {
  if (!api) return;
  api.onPttDown(() => {
    if (!currentUserId || !isPulserActive || !isVoiceActiveOnSite) return;
    if (pttBehavior === 'toggle') {
      isPTTActive = !isPTTActive;
      pttModeSpan.textContent = isPTTActive ? '🔴 ПЕРЕДАЧА' : '🟢 ОЖИДАНИЕ';
      setPTT(isPTTActive);
      addLog(`Микрофон переключен: ${isPTTActive ? 'ВКЛ' : 'ВЫКЛ'}`, isPTTActive ? 'success' : 'info');
    } else {
      if (!isPTTActive) {
        isPTTActive = true;
        pttModeSpan.textContent = '🔴 ПЕРЕДАЧА';
        setPTT(true);
        addLog('Микрофон зажат (передача)', 'success');
      }
    }
  });
  api.onPttUp(() => {
    if (!currentUserId || !isPulserActive || !isVoiceActiveOnSite) return;
    if (pttBehavior === 'hold') {
      if (isPTTActive) {
        isPTTActive = false;
        pttModeSpan.textContent = '🟢 ОЖИДАНИЕ';
        setPTT(false);
        addLog('Микрофон отпущен (ожидание)', 'info');
      }
    }
  });
}

// --- Быстрые слоты частот ---
function setupFreqShortcuts() {
  if (!api) return;
  api.onFreqShortcut((num) => {
    if (!currentUserId || !isPulserActive || !isVoiceActiveOnSite) return;
    sendFreqSlot(num);
  });
}

// --- Запись новой комбинации ---
async function startRecording() {
  try {
    recordHotkeyBtn.textContent = 'НАЖМИТЕ КНОПКУ...';
    recordHotkeyBtn.disabled = true;
    await api.toggleHooks(false);
    const combo = await api.startRecordingCombination();
    if (combo) {
      localStorage.setItem('electron_ptt_combo', JSON.stringify(combo));
      currentHotkeyLabel.textContent = combo.display;
      await api.registerPttCombination(combo);
      addLog(`PTT хоткей изменён на: ${combo.display}`, 'success');
    } else {
      addLog(`Не удалось записать комбинацию`, 'error');
    }
  } catch (err) {
    addLog(`Ошибка записи: ${err.message}`, 'error');
  } finally {
    recordHotkeyBtn.textContent = 'ЗАПИСАТЬ ХОТКЕЙ';
    recordHotkeyBtn.disabled = false;
    if (isPulserActive) await api.toggleHooks(true);
  }
}

// --- Загрузка сохранённой комбинации ---
async function initPttCombination() {
  const saved = localStorage.getItem('electron_ptt_combo');
  let combo = null;
  if (saved) {
    try { combo = JSON.parse(saved); } catch(e) {}
  }
  if (!combo) {
    combo = { type: 'keyboard', code: 57, modifiers: ['Ctrl'], display: 'Ctrl+Space' };
  }
  currentHotkeyLabel.textContent = combo.display;
  await api.registerPttCombination(combo);
  addLog(`PTT хоткей загружен: ${combo.display}`, 'info');
}

// --- Включение/отключение всего пульта ---
async function setupTogglePulser() {
  toggleShortcutsBtn.addEventListener('click', async () => {
    isPulserActive = !isPulserActive;
    if (isPulserActive) {
      toggleShortcutsBtn.className = 'toggle-btn active-mode';
      toggleShortcutsBtn.innerHTML = '<i class="fas fa-toggle-on"></i> ПУЛЬТ АКТИВЕН (БИНДЫ ВКЛ)';
      await api.toggleHooks(true);
      addLog('Пульт активирован. Горячие клавиши работают.', 'success');
      await refreshRadioStatus();
      startStatusChecking();
    } else {
      toggleShortcutsBtn.className = 'toggle-btn inactive-mode';
      toggleShortcutsBtn.innerHTML = '<i class="fas fa-toggle-off"></i> ПУЛЬТ ДЕАКТИВИРОВАН (БИНДЫ ВЫКЛ)';
      await api.toggleHooks(false);
      if (isPTTActive) {
        isPTTActive = false;
        setPTT(false);
        pttModeSpan.textContent = '🟢 ОЖИДАНИЕ';
      }
      currentFreqSpan.textContent = '---';
      pttModeSpan.textContent = '🔒 Пульт отключен пользователем';
      pttModeSpan.style.color = '#666';
      addLog('Пульт отключен. Кнопки освобождены для набора текста.', 'warning');
      if (statusCheckInterval) clearInterval(statusCheckInterval);
    }
  });
}

// --- Логин и логаут ---
async function handleLogin(email, password) {
  try {
    loginBtn.disabled = true;
    loginBtn.textContent = 'Вход...';
    const data = await authRequest('signInWithPassword', { email, password, returnSecureToken: true });
    currentUser = { uid: data.localId, email: data.email };
    currentUserId = data.localId;
    idToken = data.idToken;
    addLog(`Успешный вход: ${currentUser.email}`, 'success');
    loginErrorDiv.textContent = '';
    loginPanel.style.display = 'none';
    mainPanel.style.display = 'block';
    updateConnectionStatus(true);
    const callsign = email.split('@')[0];
    userCallsignSpan.textContent = callsign;
    currentCallsign = callsign;
    await initPttCombination();
    startStatusChecking();
  } catch (error) {
    loginErrorDiv.textContent = 'Ошибка: ' + (error.message || 'Неверный email или пароль');
    addLog(`Ошибка входа: ${error.message}`, 'error');
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = 'ПОДКЛЮЧИТЬСЯ';
  }
}

async function handleLogout() {
  if (statusCheckInterval) clearInterval(statusCheckInterval);
  currentUser = null;
  currentUserId = null;
  idToken = null;
  isPTTActive = false;
  currentFrequency = null;
  loginPanel.style.display = 'block';
  mainPanel.style.display = 'none';
  updateConnectionStatus(false);
  addLog('Выход выполнен', 'info');
}

// --- Настройка элементов интерфейса ---
loginBtn.addEventListener('click', () => {
  const email = emailInput.value.trim();
  const password = passwordInput.value;
  if (email && password) handleLogin(email, password);
  else loginErrorDiv.textContent = 'Заполните email и пароль';
});
if (logoutBtn) logoutBtn.addEventListener('click', handleLogout);
if (pttModeSelect) {
  pttModeSelect.value = pttBehavior;
  pttModeSelect.addEventListener('change', (e) => {
    pttBehavior = e.target.value;
    localStorage.setItem('electron_ptt_behavior', pttBehavior);
    addLog(`Режим работы PTT изменён на: ${pttBehavior === 'hold' ? 'Удержание' : 'Переключатель'}`, 'info');
  });
}
recordHotkeyBtn.addEventListener('click', startRecording);

// --- Инициализация ---
setupPttEvents();
setupFreqShortcuts();
setupTogglePulser();
addLog('Приложение готово. Войдите для начала работы.', 'info');