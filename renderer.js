// renderer.js - Сармат Пульт СВЯЗИ
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

// Адрес воркера
const PROXY_URL = "https://firebase-auth-proxy.boldinoverofej.workers.dev";

// URL базы данных RTDB (Бельгия, europe-west1)
const DATABASE_URL = "https://authentication-cf670-default-rtdb.europe-west1.firebasedatabase.app";

let currentUser = null;
let currentUserId = null;
let currentFaction = 'sarmat';
let currentCallsign = 'Боец';
let currentFrequency = null;
let isPTTActive = false;
let idToken = null;

// Статусы
let pttBehavior = localStorage.getItem('electron_ptt_behavior') || 'hold';
let isPulserActive = true; // Активность самого пульта
let isVoiceActiveOnSite = false; // Активна ли рация на сайте
let pttReleaseTimer = null;
let isRecording = false; // Режим записи хоткея
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

// Проверка активности рации на сайте (Раз в 3 секунды)
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
      
      // ИСПРАВЛЕНИЕ: Обновляем экран, если изменился либо статус активности, либо сама частота!
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
    } catch(e) {
      console.warn("Сбой синхронизации с сайтом", e);
    }
  }, 3000);
}

// Запрос к прокси-воркеру 3
async function authRequest(endpoint, body) {
  const response = await fetch(`${PROXY_URL}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Ошибка аутентификации');
  return data;
}

// Вход
async function handleLogin(email, password) {
  try {
    loginBtn.disabled = true;
    loginBtn.textContent = 'Вход...';
    
    const data = await authRequest('signInWithPassword', {
      email, password, returnSecureToken: true
    });
    
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
    
    // После успешного входа инициализируем хоткеи
    await initPttHotkey();
    startStatusChecking();
    
  } catch (error) {
    console.error(error);
    loginErrorDiv.textContent = 'Ошибка: ' + (error.message || 'Неверный email или пароль');
    addLog(`Ошибка входа: ${error.message}`, 'error');
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = 'ПОДКЛЮЧИТЬСЯ';
  }
}

async function handleLogout() {
  try {
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
  } catch (e) {
    addLog(`Ошибка выхода: ${e.message}`, 'error');
  }
}

// Запросы к RTDB через REST API
async function rtdbSet(path, value) {
  if (!idToken) throw new Error('Не авторизован');
  const url = `${DATABASE_URL}/${path}.json?auth=${idToken}`;
  const response = await fetch(url, { method: 'PUT', body: JSON.stringify(value) });
  if (!response.ok) throw new Error(`RTDB error: ${response.status}`);
  return response.json();
}

async function rtdbDelete(path) {
  if (!idToken) throw new Error('Не авторизован');
  const url = `${DATABASE_URL}/${path}.json?auth=${idToken}`;
  const response = await fetch(url, { method: 'DELETE' });
  if (!response.ok) throw new Error(`RTDB delete error: ${response.status}`);
}

// Запись статуса PTT
async function setPTT(active) {
  if (!currentUserId || !idToken) return;
  try {
    const pttPath = `ptt/${currentUserId}`;
    if (active) {
      await rtdbSet(pttPath, { active: true, timestamp: Date.now() });
    } else {
      await rtdbDelete(pttPath);
    }
  } catch (e) {
    addLog(`Ошибка отправки PTT: ${e.message}`, 'error');
  }
}

// Отправка команды переключения на Слот быстрых каналов сайта
async function sendFreqSlot(slotNum) {
  if (!currentUserId || !idToken) return;
  try {
    const freqCommandPath = `freq_commands/${currentUserId}`;
    await rtdbSet(freqCommandPath, { slot: slotNum, timestamp: Date.now() });
    addLog(`Запрос смены канала: Слот ${slotNum}`, 'success');
    
    setTimeout(async () => {
      try { await rtdbDelete(freqCommandPath); } catch(e) {}
    }, 3000);
  } catch (e) {
    addLog(`Ошибка переключения слота: ${e.message}`, 'error');
  }
}

// Инициализация и привязка сохраненного хоткея PTT
async function initPttHotkey() {
  if (!api) return;
  const savedKey = localStorage.getItem('electron_ptt_key') || 'Ctrl+Space';
  currentHotkeyLabel.textContent = savedKey;
  if (pttModeSelect) pttModeSelect.value = pttBehavior;
  
  const success = await api.registerPttKey(savedKey);
  if (success) {
    addLog(`PTT хоткей инициализирован: ${savedKey}`, 'info');
  } else {
    addLog(`Ошибка инициализации хоткея: ${savedKey}`, 'error');
  }
}

// Настройка горячих клавиш
function setupHotkeys() {
  if (!api) {
    addLog('Горячие клавиши недоступны', 'error');
    return;
  }
  
  api.onPttPress(() => {
    if (!currentUserId || !isPulserActive || !isVoiceActiveOnSite) return;
    
    if (pttBehavior === 'toggle') {
      isPTTActive = !isPTTActive;
      pttModeSpan.textContent = isPTTActive ? '🔴 ПЕРЕДАЧА' : '🟢 Ожидание';
      setPTT(isPTTActive);
      addLog(`Микрофон переключен: ${isPTTActive ? 'ВКЛ' : 'ВЫКЛ'}`, isPTTActive ? 'success' : 'info');
    } else {
      if (!isPTTActive) {
        isPTTActive = true;
        pttModeSpan.textContent = '🔴 ПЕРЕДАЧА';
        setPTT(true);
        addLog('Микрофон зажат (Передача)', 'success');
      }
      
      if (pttReleaseTimer) {
        clearTimeout(pttReleaseTimer);
      }
      
      pttReleaseTimer = setTimeout(() => {
        isPTTActive = false;
        pttModeSpan.textContent = '🟢 Ожидание';
        setPTT(false);
        addLog('Микрофон отпущен (Ожидание)', 'info');
        pttReleaseTimer = null;
      }, 650);
    }
  });
  
  api.onFreqShortcut((num) => {
    if (!currentUserId || !isPulserActive || !isVoiceActiveOnSite) return;
    sendFreqSlot(num);
  });

  // Логика записи ЛЮБОГО личного хоткея
  recordHotkeyBtn.addEventListener('click', () => {
    isRecording = true;
    recordHotkeyBtn.textContent = 'НАЖМИТЕ КНОПКИ...';
    recordHotkeyBtn.style.borderColor = '#ffaa00';
    recordHotkeyBtn.style.color = '#ffaa00';
    
    // Временно отключаем бинды в ОС на время записи
    api.toggleShortcuts(false);
  });

  document.addEventListener('keydown', async (e) => {
    if (!isRecording) return;
    e.preventDefault();
    e.stopPropagation();

    // Собираем модификаторы
    const modifiers = [];
    if (e.ctrlKey) modifiers.push('Ctrl');
    if (e.shiftKey) modifiers.push('Shift');
    if (e.altKey) modifiers.push('Alt');

    const key = e.key;
    const code = e.code;

    // Ждем конечную клавишу (игнорируем одиночные модификаторы)
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return;

    // Преобразуем клавиши под стандарты Electron Accelerator
    let finalKey = key.toUpperCase();
    if (key === ' ') finalKey = 'Space';
    if (code.startsWith('Key')) finalKey = code.replace('Key', '');
    if (code.startsWith('Digit')) finalKey = code.replace('Digit', '');

    const hotkeyStr = [...modifiers, finalKey].join('+');
    
    // Снимаем режим записи
    isRecording = false;
    recordHotkeyBtn.textContent = 'ЗАПИСАТЬ ХОТКЕЙ';
    recordHotkeyBtn.style.borderColor = '#ff5555';
    recordHotkeyBtn.style.color = '#ff5555';

    // Регистрируем в системе
    const success = await api.registerPttKey(hotkeyStr);
    if (success) {
      localStorage.setItem('electron_ptt_key', hotkeyStr);
      currentHotkeyLabel.textContent = hotkeyStr;
      addLog(`PTT хоткей успешно изменен на: ${hotkeyStr}`, 'success');
    } else {
      addLog(`Не удалось забиндить на: ${hotkeyStr} (сочетание занято или не поддерживается)`, 'error');
    }

    // Возвращаем бинды обратно
    if (isPulserActive) {
      await api.toggleShortcuts(true);
    }
  });

  // Изменение режима PTT
  if (pttModeSelect) {
    pttModeSelect.addEventListener('change', (e) => {
      pttBehavior = e.target.value;
      localStorage.setItem('electron_ptt_behavior', pttBehavior);
      addLog(`Режим работы PTT изменен на: ${pttBehavior === 'hold' ? 'Удержание' : 'Переключатель'}`, 'info');
    });
  }

  // == КНОПКА ПОЛНОЙ ДЕАКТИВАЦИИ (ВЫКЛ БИНДОВ) ==
  toggleShortcutsBtn.addEventListener('click', async () => {
    isPulserActive = !isPulserActive;
    
    if (isPulserActive) {
      toggleShortcutsBtn.className = 'toggle-btn active-mode';
      toggleShortcutsBtn.innerHTML = '<i class="fas fa-toggle-on"></i> ПУЛЬТ АКТИВЕН (БИНДЫ ВКЛ)';
      const savedKey = localStorage.getItem('electron_ptt_key') || 'Ctrl+Space';
      await api.toggleShortcuts(true); // Регистрируем все бинды обратно в ОС
      addLog('Пульт активирован. Хоткеи включены.', 'success');
      startStatusChecking();
    } else {
      toggleShortcutsBtn.className = 'toggle-btn inactive-mode';
      toggleShortcutsBtn.innerHTML = '<i class="fas fa-toggle-off"></i> ПУЛЬТ ДЕАКТИВИРОВАН (БИНДЫ ВЫКЛ)';
      await api.toggleShortcuts(false); // Полностью удаляем бинды из ОС!
      if (isPTTActive) {
        isPTTActive = false;
        setPTT(false);
      }
      currentFreqSpan.textContent = '---';
      pttModeSpan.textContent = '🔒 Пульт отключен пользователем';
      pttModeSpan.style.color = '#666';
      addLog('Пульт отключен. Кнопки освобождены для набора текста.', 'warning');
      if (statusCheckInterval) clearInterval(statusCheckInterval);
    }
  });
}

// Инициализация интерфейса
loginBtn.addEventListener('click', () => {
  const email = emailInput.value.trim();
  const password = passwordInput.value;
  if (email && password) handleLogin(email, password);
  else loginErrorDiv.textContent = 'Заполните email и пароль';
});

if (logoutBtn) logoutBtn.addEventListener('click', handleLogout);

setupHotkeys();
addLog('Приложение готово. Войдите для начала работы.', 'info');