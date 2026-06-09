const { app, BrowserWindow, Tray, Menu, ipcMain } = require('electron');
const path = require('path');
const log = require('electron-log');
const { uIOhook, UiohookKey } = require('uiohook-napi');

let mainWindow = null;
let tray = null;
let isQuiting = false;

// Активны ли глобальные хуки (когда пульт включён)
let isHooksActive = true;

// Флаг для блокировки автоповтора кнопок (Auto-Repeat) операционной системы
let isPttKeyPressed = false;

// Текущая назначенная комбинация для PTT
let currentPttCombination = { type: 'keyboard', code: UiohookKey.Space, modifiers: ['Ctrl'], display: 'Ctrl+Space' };

// Функция проверки, подходит ли событие под текущую комбинацию
function matchesPtt(event, eventType) {
  if (!currentPttCombination) return false;
  const { type, code, modifiers, button } = currentPttCombination;

  if (type === 'keyboard') {
    if (eventType !== 'keydown' && eventType !== 'keyup') return false;
    let keyMatch = false;
    if (typeof code === 'number') {
      keyMatch = event.keycode === code;
    } else {
      keyMatch = event.keycode === UiohookKey[code] || event.key === code;
    }
    if (!keyMatch) return false;

    // Для отжатия (keyup) мы не проверяем строго модификаторы.
    // Если пользователь отпустил Ctrl на долю секунды раньше пробела, микрофон всё равно должен выключиться.
    if (eventType === 'keyup') return true;

    // Для нажатия (keydown) проверяем требуемые модификаторы (лояльно - другие зажатые клавиши не мешают)
    const requiredMods = modifiers || [];
    if (requiredMods.includes('Ctrl') && !event.ctrlKey) return false;
    if (requiredMods.includes('Alt') && !event.altKey) return false;
    if (requiredMods.includes('Shift') && !event.shiftKey) return false;
    if (requiredMods.includes('Meta') && !event.metaKey) return false;
    
    return true;
  }
  else if (type === 'mouse') {
    if (eventType !== 'mousedown' && eventType !== 'mouseup') return false;
    return event.button === button;
  }
  return false;
}

// --- Глобальные слушатели ---
function startHooks() {
  if (uIOhook.isRunning) return;

  uIOhook.on('keydown', (e) => {
    if (!isHooksActive || !mainWindow) return;
    if (matchesPtt(e, 'keydown')) {
      // Игнорируем автоповторы зажатой клавиши
      if (!isPttKeyPressed) {
        isPttKeyPressed = true;
        mainWindow.webContents.send('ptt-down');
      }
    }
  });
  
  uIOhook.on('keyup', (e) => {
    if (!isHooksActive || !mainWindow) return;
    if (matchesPtt(e, 'keyup')) {
      isPttKeyPressed = false;
      mainWindow.webContents.send('ptt-up');
    }
  });
  
  uIOhook.on('mousedown', (e) => {
    if (!isHooksActive || !mainWindow) return;
    if (matchesPtt(e, 'mousedown')) {
      if (!isPttKeyPressed) {
        isPttKeyPressed = true;
        mainWindow.webContents.send('ptt-down');
      }
    }
  });
  
  uIOhook.on('mouseup', (e) => {
    if (!isHooksActive || !mainWindow) return;
    if (matchesPtt(e, 'mouseup')) {
      isPttKeyPressed = false;
      mainWindow.webContents.send('ptt-up');
    }
  });

  // --- Быстрые слоты (Ctrl+1..5) ---
  uIOhook.on('keydown', (e) => {
    if (!isHooksActive || !mainWindow) return;
    if (e.ctrlKey) {
      // Поддерживаем как скан-коды libuiohook (2-6), так и виртуальные коды JS (49-53)
      let slot = 0;
      if (e.keycode >= 2 && e.keycode <= 6) {
        slot = e.keycode - 1;
      } else if (e.keycode >= 49 && e.keycode <= 53) {
        slot = e.keycode - 48;
      }
      
      if (slot >= 1 && slot <= 5) {
        mainWindow.webContents.send('freq-shortcut', slot);
      }
    }
  });

  uIOhook.start();
}

function stopHooks() {
  if (uIOhook.isRunning) {
    uIOhook.stop();
    uIOhook.removeAllListeners();
  }
}

// --- Запись новой комбинации ---
let isRecording = false;
let recordResolve = null;

async function waitForCombination() {
  const startTime = Date.now();
  return new Promise((resolve) => {
    isRecording = true;
    recordResolve = resolve;

    const keydownHandler = (e) => {
      handleEvent(e, 'keydown');
    };
    
    const mousedownHandler = (e) => {
      handleEvent(e, 'mousedown');
    };

    const handleEvent = (e, eventType) => {
      if (!isRecording) return;

      // Игнорируем клик мыши в первые 300 мс, чтобы не записать клик по кнопке в интерфейсе
      if (eventType === 'mousedown' && (Date.now() - startTime < 300)) return;
      // Игнорируем левый клик мыши (кнопка 1), чтобы не заблокировать интерфейс программы
      if (eventType === 'mousedown' && e.button === 1) return;

      let combination = null;

      if (eventType === 'keydown') {
        let keycode = e.keycode;
        let keyName = Object.keys(UiohookKey).find(key => UiohookKey[key] === keycode) || 'Unknown';
        if (keyName === 'Space') keyName = 'Space';
        
        const modifiers = [];
        if (e.ctrlKey) modifiers.push('Ctrl');
        if (e.altKey) modifiers.push('Alt');
        if (e.shiftKey) modifiers.push('Shift');
        if (e.metaKey) modifiers.push('Meta');
        
        // Убираем клавишу-модификатор из списка зажатых, если она сама является кнопкой бинда
        const cleanKeyName = keyName.replace(/Left|Right/, '');
        const filteredModifiers = modifiers.filter(m => m !== cleanKeyName);

        combination = { 
          type: 'keyboard', 
          code: keycode, 
          modifiers: filteredModifiers, 
          display: [...filteredModifiers, keyName].join('+') 
        };
      }
      else if (eventType === 'mousedown') {
        const buttonMap = { 1: 'Left', 2: 'Right', 3: 'Middle', 4: 'X1', 5: 'X2' };
        const btnName = buttonMap[e.button] || `Button${e.button}`;
        combination = { type: 'mouse', button: e.button, display: `Mouse ${btnName}` };
      }

      if (combination) {
        isRecording = false;
        // Чистим за собой обработчики, чтобы не было дубликатов и утечек памяти
        uIOhook.off('keydown', keydownHandler);
        uIOhook.off('mousedown', mousedownHandler);
        resolve(combination);
      }
    };

    uIOhook.on('keydown', keydownHandler);
    uIOhook.on('mousedown', mousedownHandler);
  });
}

ipcMain.handle('start-recording', async () => {
  return await waitForCombination();
});

// --- Включение/выключение прослушки ---
ipcMain.handle('toggle-hooks', (event, enable) => {
  isHooksActive = enable;
  isPttKeyPressed = false; // Сбрасываем статус нажатия
  if (enable) startHooks();
  else stopHooks();
  return true;
});

// --- Регистрация новой PTT комбинации ---
ipcMain.handle('register-ptt-combination', (event, combo) => {
  currentPttCombination = combo;
  isPttKeyPressed = false; // Сбрасываем статус нажатия
  return true;
});

// --- Защита от второго экземпляра ---
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    createTray();
    startHooks();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 650,
    height: 550,
    minWidth: 500,
    minHeight: 450,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    show: false,
    title: 'Сармат Пульт'
  });
  mainWindow.loadFile('index.html');
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12') mainWindow.webContents.openDevTools();
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', (event) => {
    if (!isQuiting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'icon.png'));
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Показать', click: () => mainWindow.show() },
    { label: 'Выйти', click: () => { isQuiting = true; app.quit(); } }
  ]);
  tray.setToolTip('Сармат Пульт - Рация');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });
}

app.on('will-quit', () => {
  stopHooks();
});