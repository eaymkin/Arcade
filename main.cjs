const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");
const { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, Tray } = require("electron");

app.setName("Arcade");
if (process.platform === "win32") app.setAppUserModelId("com.arcade.browser");

const APP_FILE = path.join(__dirname, "index.html");
const APP_URL = pathToFileURL(APP_FILE).href;
const PRELOAD_FILE = path.join(__dirname, "preload.cjs");
const OAUTH_BUNDLE_FILE = path.join(__dirname, "oauth-login.bundle.js");
const CALLBACK_HOST = "localhost";
const CALLBACK_PORT = 5000;
const WEB_PROTOCOLS = new Set(["http:", "https:"]);
const AD_BLOCKED_HOSTS = new Set([
  "ad.doubleclick.net",
  "adservice.google.com",
  "ads.google.com",
  "adsafeprotected.com",
  "adnxs.com",
  "adroll.com",
  "adsrvr.org",
  "amazon-adsystem.com",
  "bidswitch.net",
  "criteo.com",
  "criteo.net",
  "demdex.net",
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "google-analytics.com",
  "hotjar.com",
  "mathtag.com",
  "openx.net",
  "outbrain.com",
  "pubmatic.com",
  "quantserve.com",
  "rubiconproject.com",
  "scorecardresearch.com",
  "taboola.com",
  "track.adform.net",
  "zedo.com"
]);
const STORE_GAME_LINKS = {
  "steam-cs2": {
    storeUrl: "https://store.steampowered.com/app/730/CounterStrike_2/"
  },
  "steam-dota2": {
    storeUrl: "https://store.steampowered.com/app/570/Dota_2/"
  },
  "epic-fortnite": {
    storeUrl: "https://store.epicgames.com/en-US/p/fortnite"
  },
  "epic-rocket-league": {
    storeUrl: "https://store.epicgames.com/en-US/p/rocket-league"
  }
};
let googleSignInPending = false;
let libraryWriteQueue = Promise.resolve();
let minimizeToTray = false;
let tray;

function getLibraryFile() {
  return path.join(app.getPath("userData"), "game-library.json");
}

function getSettingsFile() {
  return path.join(app.getPath("userData"), "settings.json");
}

async function readAppSettings() {
  try {
    const settings = JSON.parse(await fs.readFile(getSettingsFile(), "utf8"));
    if (typeof settings.minimizeToTray !== "boolean" || typeof settings.runAtStartup !== "boolean") {
      throw new Error("Файл настроек Arcade имеет неверный формат.");
    }
    return {
      ...settings,
      adBlockEnabled: typeof settings.adBlockEnabled === "boolean" ? settings.adBlockEnabled : true
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { minimizeToTray: false, runAtStartup: false, adBlockEnabled: true };
    }
    throw error;
  }
}

function isBlockedAdRequest(requestUrl) {
  let url;
  try {
    url = new URL(requestUrl);
  } catch {
    return false;
  }
  if (!WEB_PROTOCOLS.has(url.protocol)) return false;
  const hostname = url.hostname.toLowerCase();
  for (const blockedHost of AD_BLOCKED_HOSTS) {
    if (hostname === blockedHost || hostname.endsWith(`.${blockedHost}`)) return true;
  }
  return false;
}

function setAdBlockEnabled(enabled) {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    const shouldBlock = enabled && isBlockedAdRequest(details.url);
    callback({ cancel: shouldBlock });
  });
}

async function saveAppSettings(settings) {
  const file = getSettingsFile();
  const temporaryFile = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporaryFile, JSON.stringify(settings, null, 2), "utf8");
  await fs.rename(temporaryFile, file);
}

async function readGameLibrary() {
  try {
    const data = JSON.parse(await fs.readFile(getLibraryFile(), "utf8"));
    if (!data || !Array.isArray(data.games)) throw new Error("Файл библиотеки игр имеет неверный формат.");
    return data;
  } catch (error) {
    if (error.code === "ENOENT") return { games: [] };
    throw error;
  }
}

function updateGameLibrary(update) {
  const operation = libraryWriteQueue.then(async () => {
    const library = await readGameLibrary();
    const result = await update(library);
    const file = getLibraryFile();
    const temporaryFile = `${file}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporaryFile, JSON.stringify(library, null, 2), "utf8");
    await fs.rename(temporaryFile, file);
    return result;
  });
  libraryWriteQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

function validateGameInput(game) {
  if (!game || typeof game !== "object"
    || typeof game.title !== "string" || !game.title.trim() || game.title.trim().length > 60
    || typeof game.executablePath !== "string" || !path.isAbsolute(game.executablePath)
    || path.extname(game.executablePath).toLowerCase() !== ".exe"
    || typeof game.category !== "string" || game.category.length > 30
    || !Array.isArray(game.args) || game.args.length > 40
    || game.args.some(argument => typeof argument !== "string" || argument.length > 500)) {
    throw new Error("Проверь название игры, путь к .exe, категорию и параметры запуска.");
  }
}

function isWebUrl(value) {
  try {
    return WEB_PROTOCOLS.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

function isAuthenticationUrl(value) {
  try {
    const url = new URL(value);
    if (!WEB_PROTOCOLS.has(url.protocol)) return false;
    const hostname = url.hostname.toLowerCase();
    return hostname === "accounts.google.com"
      || hostname === "login.microsoftonline.com"
      || hostname === "appleid.apple.com"
      || hostname === "auth.openai.com"
      || hostname === "accounts.openai.com"
      || hostname === "auth0.openai.com"
      || (hostname === "github.com" && url.pathname.startsWith("/login"))
      || (hostname === "www.facebook.com" && url.pathname.startsWith("/login"));
  } catch {
    return false;
  }
}

function assertAppWindow(event) {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || window.webContents !== event.sender) throw new Error("Запрос не разрешён.");
}

function showAppWindow() {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window) {
    createAppWindow();
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function createSystemTray() {
  if (tray) return;
  tray = new Tray(path.join(__dirname, "arcade-icon-2k.png"));
  tray.setToolTip("Arcade");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Открыть Arcade", click: showAppWindow },
    { type: "separator" },
    { label: "Выйти", click: () => app.quit() }
  ]));
  tray.on("double-click", showAppWindow);
}

async function signInWithGoogle() {
  if (googleSignInPending) throw new Error("Вход через Google уже выполняется.");
  googleSignInPending = true;

  const state = crypto.randomBytes(32).toString("base64url");
  const localOrigin = `http://${CALLBACK_HOST}:${CALLBACK_PORT}`;
  let callbackServer;
  let timeout;

  try {
    let resolveResult;
    let rejectResult;
    const result = new Promise((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    result.catch(() => {});

    callbackServer = http.createServer(async (request, response) => {
      const requestUrl = new URL(request.url, localOrigin);
      const headers = {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      };
      const sendJson = (status, body) => {
        response.writeHead(status, { ...headers, "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify(body));
      };

      if (request.method === "GET" && requestUrl.pathname === "/") {
        if (requestUrl.searchParams.get("state") !== state) {
          response.writeHead(400, headers).end("Неверный запрос входа. Закрой страницу и попробуй снова.");
          return;
        }
        response.writeHead(200, {
          ...headers,
          "Content-Type": "text/html; charset=utf-8",
          "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
          "Content-Security-Policy": "default-src 'none'; script-src 'self' https://accounts.google.com; connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com https://accounts.google.com; style-src 'unsafe-inline'; frame-src https://accounts.google.com https://*.firebaseapp.com; base-uri 'none'; form-action 'none'; object-src 'none'"
        }).end(`<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Вход в Arcade</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1e1f22;color:#f2f3f5;font:16px system-ui,sans-serif}
main{width:min(360px,calc(100vw - 48px));padding:28px;border:1px solid #45474f;border-radius:12px;background:#232428}
h1{margin:0 0 10px;font-size:21px}p{color:#b5bac1;font-size:14px;line-height:1.5}
button{width:100%;height:44px;margin-top:12px;border:0;border-radius:7px;background:#5865f2;color:white;font-weight:700;cursor:pointer}
button:disabled{opacity:.6;cursor:wait}#login-status{min-height:22px;margin-top:14px;font-size:13px;line-height:1.5;overflow-wrap:anywhere}
#google-login{display:flex;justify-content:center;min-height:44px;margin-top:12px}
</style></head><body><main><h1>Вход в Arcade</h1>
<p>Нажми кнопку и войди через Google во всплывающем окне.</p>
<div id="google-login" aria-label="Продолжить через Google"></div>
<div id="login-status" role="status">Для продолжения потребуется подтвердить вход в Google.</div>
<script defer src="/oauth-login.bundle.js"></script></main></body></html>`);
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/oauth-login.bundle.js") {
        try {
          const bundle = await fs.readFile(OAUTH_BUNDLE_FILE);
          response.writeHead(200, {
            ...headers,
            "Content-Type": "text/javascript; charset=utf-8"
          }).end(bundle);
        } catch (error) {
          console.error("Could not load Google sign-in page bundle:", error);
          response.writeHead(500, headers).end("Не удалось загрузить компонент входа. Перезапусти Arcade.");
        }
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/complete") {
        if (requestUrl.searchParams.get("state") !== state
          || request.headers.origin !== localOrigin
          || request.headers["content-type"]?.split(";")[0] !== "application/json") {
          sendJson(403, { error: "Не удалось проверить возврат в Arcade." });
          return;
        }

        let body = "";
        let tooLarge = false;
        request.on("data", chunk => {
          body += chunk;
          if (body.length > 16384 && !tooLarge) {
            tooLarge = true;
            sendJson(413, { error: "Ответ входа слишком большой." });
          }
        });
        request.on("end", () => {
          if (tooLarge) return;
          try {
            const { idToken } = JSON.parse(body);
            if (typeof idToken !== "string" || !idToken || idToken.length > 12000) {
              sendJson(400, { error: "Google не вернул токен входа." });
              return;
            }
            sendJson(200, { ok: true });
            resolveResult({ idToken });
          } catch (error) {
            if (error instanceof SyntaxError) {
              sendJson(400, { error: "Не удалось прочитать ответ входа." });
              return;
            }
            sendJson(400, { error: "Не удалось завершить вход." });
          }
        });
        return;
      }

      response.writeHead(404, headers).end("Страница не найдена.");
    });

    await new Promise((resolve, reject) => {
      callbackServer.once("error", error => {
        if (error.code === "EADDRINUSE") {
          reject(new Error(`Не удалось запустить вход: порт ${CALLBACK_PORT} уже занят. Закрой другое приложение, использующее этот порт, и повтори попытку.`));
          return;
        }
        reject(error);
      });
      callbackServer.listen(CALLBACK_PORT, CALLBACK_HOST, resolve);
    });
    timeout = setTimeout(() => rejectResult(new Error("Время ожидания входа истекло.")), 5 * 60 * 1000);
    const loginUrl = `http://${CALLBACK_HOST}:${CALLBACK_PORT}/?state=${encodeURIComponent(state)}`;
    await shell.openExternal(loginUrl);
    return await result;
  } finally {
    clearTimeout(timeout);
    if (callbackServer?.listening) callbackServer.close();
    googleSignInPending = false;
  }
}

function createAppWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 760,
    minHeight: 560,
    frame: false,
    icon: path.join(__dirname, "arcade-icon-2k.png"),
    backgroundColor: "#1e1f22",
    webPreferences: {
      preload: PRELOAD_FILE,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true
    }
  });

  window.on("minimize", event => {
    if (!minimizeToTray) return;
    event.preventDefault();
    createSystemTray();
    window.hide();
  });
  window.on("maximize", () => window.webContents.send("arcade:window-state", true));
  window.on("unmaximize", () => window.webContents.send("arcade:window-state", false));
  window.webContents.on("will-attach-webview", (event, webPreferences) => {
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    delete webPreferences.preload;
  });
  window.webContents.on("did-attach-webview", (_event, guest) => {
    let initialPageLoaded = false;
    let authenticationNavigation = false;
    guest.on("did-finish-load", () => {
      initialPageLoaded = true;
    });
    guest.on("did-navigate", (_event, targetUrl) => {
      if (authenticationNavigation && !isAuthenticationUrl(targetUrl)) {
        authenticationNavigation = false;
      }
    });
    guest.on("will-navigate", (event, targetUrl) => {
      if (!isWebUrl(targetUrl)) {
        event.preventDefault();
        return;
      }
      if (isAuthenticationUrl(targetUrl)) {
        authenticationNavigation = true;
        return;
      }
      if (authenticationNavigation) return;
      if (initialPageLoaded && targetUrl !== guest.getURL()) {
        event.preventDefault();
        window.webContents.send("arcade:open-tab", targetUrl);
      }
    });
    guest.setWindowOpenHandler(({ url }) => {
      if (isAuthenticationUrl(url)) {
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            webPreferences: {
              nodeIntegration: false,
              contextIsolation: true,
              sandbox: true,
              webviewTag: false
            }
          }
        };
      }
      if (isWebUrl(url)) window.webContents.send("arcade:open-tab", url);
      return { action: "deny" };
    });
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) window.webContents.send("arcade:open-tab", url);
    return { action: "deny" };
  });
  window.loadFile(APP_FILE).catch(error => {
    console.error("Could not load Arcade:", error);
    app.quit();
  });
}

ipcMain.on("arcade:window-control", (event, action) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || !["minimize", "maximize", "close"].includes(action)) return;

  if (action === "minimize") window.minimize();
  if (action === "maximize") {
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  }
  if (action === "close") window.close();
});

ipcMain.handle("arcade:google-sign-in", async event => {
  assertAppWindow(event);
  return signInWithGoogle();
});

ipcMain.handle("arcade:library-read", async event => {
  assertAppWindow(event);
  return readGameLibrary();
});

ipcMain.handle("arcade:library-select-executable", async event => {
  assertAppWindow(event);
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title: "Выбери исполняемый файл игры",
    properties: ["openFile"],
    filters: [{ name: "Игры Windows", extensions: ["exe"] }]
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("arcade:library-add", async (event, gameInput) => {
  assertAppWindow(event);
  validateGameInput(gameInput);
  const executablePath = path.normalize(gameInput.executablePath);
  const stat = await fs.stat(executablePath);
  if (!stat.isFile()) throw new Error("Выбранный файл игры не найден.");

  const game = {
    id: crypto.randomUUID(),
    title: gameInput.title.trim(),
    executablePath,
    args: gameInput.args,
    category: gameInput.category.trim() || "Без категории",
    addedAt: Date.now(),
    lastPlayedAt: null,
    totalPlayTimeMs: 0,
    launchCount: 0
  };
  return updateGameLibrary(library => {
    library.games.push(game);
    return game;
  });
});

ipcMain.handle("arcade:library-remove", async (event, gameId) => {
  assertAppWindow(event);
  if (typeof gameId !== "string") throw new Error("Не удалось определить игру для удаления.");
  return updateGameLibrary(library => {
    const nextGames = library.games.filter(game => game.id !== gameId);
    if (nextGames.length === library.games.length) throw new Error("Игра не найдена в библиотеке.");
    library.games = nextGames;
    return true;
  });
});

ipcMain.handle("arcade:library-launch", async (event, gameId) => {
  assertAppWindow(event);
  if (typeof gameId !== "string") throw new Error("Не удалось определить игру для запуска.");
  const library = await readGameLibrary();
  const game = library.games.find(item => item.id === gameId);
  if (!game) throw new Error("Игра не найдена в библиотеке.");

  const stat = await fs.stat(game.executablePath);
  if (!stat.isFile() || path.extname(game.executablePath).toLowerCase() !== ".exe") {
    throw new Error("Файл игры не найден. Удали запись и добавь игру заново.");
  }

  const window = BrowserWindow.fromWebContents(event.sender);
  const child = spawn(game.executablePath, game.args, {
    cwd: path.dirname(game.executablePath),
    detached: true,
    stdio: "ignore",
    windowsHide: false
  });
  const startedAt = Date.now();
  let didLaunch = false;
  const launched = new Promise((resolve, reject) => {
    child.once("spawn", () => {
      didLaunch = true;
      resolve();
    });
    child.once("error", reject);
  });

  child.once("close", async () => {
    if (!didLaunch) return;
    try {
      const currentLibrary = await updateGameLibrary(library => {
        const currentGame = library.games.find(item => item.id === gameId);
        if (currentGame) currentGame.totalPlayTimeMs += Date.now() - startedAt;
        return library;
      });
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send("arcade:library-updated", currentLibrary);
    } catch (error) {
      console.error("Could not save game playtime:", error);
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send("arcade:library-error", "Не удалось сохранить время игры.");
    }
  });

  try {
    await launched;
  } catch (error) {
    throw new Error(`Не удалось запустить игру: ${error.message}`);
  }

  try {
    await updateGameLibrary(library => {
      const currentGame = library.games.find(item => item.id === gameId);
      if (currentGame) {
        currentGame.lastPlayedAt = startedAt;
        currentGame.launchCount += 1;
      }
    });
  } catch (error) {
    console.error("Could not save game launch:", error);
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send("arcade:library-error", "Игра запущена, но не удалось сохранить статистику.");
    }
  }
  child.unref();
  return true;
});

ipcMain.handle("arcade:settings-read", async event => {
  assertAppWindow(event);
  return readAppSettings();
});

ipcMain.handle("arcade:settings-save", async (event, settings) => {
  assertAppWindow(event);
  if (!settings
    || typeof settings.minimizeToTray !== "boolean"
    || typeof settings.runAtStartup !== "boolean"
    || typeof settings.adBlockEnabled !== "boolean") {
    throw new Error("Не удалось сохранить настройки Arcade.");
  }
  if (settings.runAtStartup && process.platform !== "win32") {
    throw new Error("Автозапуск поддерживается в этой версии только на Windows.");
  }
  await saveAppSettings(settings);
  setAdBlockEnabled(settings.adBlockEnabled);
  if (process.platform === "win32") app.setLoginItemSettings({ openAtLogin: settings.runAtStartup });
  minimizeToTray = settings.minimizeToTray;
  if (minimizeToTray) createSystemTray();
  else if (tray) {
    tray.destroy();
    tray = undefined;
  }
  return settings;
});

ipcMain.handle("arcade:open-store-game", async (event, gameId) => {
  assertAppWindow(event);
  if (typeof gameId !== "string" || !Object.hasOwn(STORE_GAME_LINKS, gameId)) {
    throw new Error("Этой игры нет в каталоге официальных магазинов.");
  }
  const game = STORE_GAME_LINKS[gameId];
  event.sender.send("arcade:open-tab", game.storeUrl);
  return "arcade-tab";
});

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const audioOnlyRequest = permission === "media"
      && details.isMainFrame
      && Array.isArray(details.mediaTypes)
      && details.mediaTypes.length === 1
      && details.mediaTypes[0] === "audio"
      && details.requestingUrl === APP_URL
      && webContents.getURL() === APP_URL;
    callback(audioOnlyRequest);
  });
  const settings = await readAppSettings();
  setAdBlockEnabled(settings.adBlockEnabled);
  minimizeToTray = settings.minimizeToTray;
  if (process.platform === "win32") app.setLoginItemSettings({ openAtLogin: settings.runAtStartup });
  if (minimizeToTray) createSystemTray();
  createAppWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createAppWindow();
  });
}).catch(error => {
  console.error("Could not initialize Arcade:", error);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
