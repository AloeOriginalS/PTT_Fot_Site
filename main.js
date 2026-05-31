// main.js
const { app, BrowserWindow, globalShortcut, Tray, Menu, ipcMain } = require('electron');
const path = require('path');
const log = require('electron-log');

let mainWindow = null;
let tray = null;
let isQuiting = false;
let currentPttShortcut = 'Ctrl+Space'; // Хоткей по умолчанию

// == БЛОКИРОВКА ВТОРОГО ЗАПУСКА (Защита от дубликатов процессов в Диспетчере) ==
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  log.info("Обнаружена запущенная копия приложения. Этот инстанс закрывается.");
  app.quit(); // Если пульт уже запущен, этот новый процесс мгновенно завершает работу!
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    // Если кто-то пытается запустить пульт второй раз — просто разворачиваем и показываем уже открытый
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // Инициализация приложения (запускается только если получен монопольный доступ)
  app.whenReady().then(() => {
    createWindow();
    createTray();
    registerFreqShortcuts();
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
    if (input.key === 'F12') {
      mainWindow.webContents.openDevTools();
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // При закрытии окна крестиком прячем в трей, а не закрываем совсем (чтобы бинды продолжали работать в игре)
  mainWindow.on('close', (event) => {
    if (!isQuiting) {
      event.preventDefault();
      mainWindow.hide();
    }
    return false;
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'icon.png'));
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Показать', click: () => { mainWindow.show(); } },
    { label: 'Выйти', click: () => { isQuiting = true; app.quit(); } }
  ]);
  tray.setToolTip('Сармат Пульт - Рация');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });
}

// Регистрация хоткея PTT
function registerPttShortcut(shortcutStr) {
  try {
    if (globalShortcut.isRegistered(currentPttShortcut)) {
      globalShortcut.unregister(currentPttShortcut);
    }
    
    currentPttShortcut = shortcutStr;
    
    const success = globalShortcut.register(shortcutStr, () => {
      if (mainWindow) mainWindow.webContents.send('ptt-press');
    });
    
    return success;
  } catch (e) {
    log.error(`Ошибка при смене хоткея: ${e.message}`);
    return false;
  }
}

// Регистрация хоткеев быстрых слотов частот
function registerFreqShortcuts() {
  for (let i = 1; i <= 5; i++) {
    globalShortcut.register(`Ctrl+${i}`, () => {
      if (mainWindow) mainWindow.webContents.send('freq-shortcut', i);
    });
  }
}

// Слушатель для ПОЛНОЙ деактивации/активации биндов
ipcMain.handle('toggle-shortcuts', (event, enable) => {
  if (enable) {
    const success = registerPttShortcut(currentPttShortcut);
    registerFreqShortcuts();
    log.info("Глобальные бинды включены");
    return success;
  } else {
    globalShortcut.unregisterAll();
    log.info("Глобальные бинды полностью выгружены (Освобождение клавиш)");
    return true;
  }
});

ipcMain.handle('register-ptt-key', (event, keyStr) => {
  return registerPttShortcut(keyStr);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});