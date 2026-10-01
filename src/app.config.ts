import {
    defineServer,
    defineRoom,
    monitor,
    playground,
    createRouter,
    createEndpoint,
} from "colyseus";

/**
 * Import your Room files
 */
import { MyRoom } from "./rooms/MyRoom.js";
import { leaderboardService } from "./leaderboard.js";
import express from "express";

const server = defineServer({
    /**
     * Define your room handlers:
     */
    rooms: {
        my_room: defineRoom(MyRoom)
    },

    /**
     * Experimental: Define API routes. Built-in integration with the "playground" and SDK.
     * 
     * Usage from SDK: 
     *   client.http.get("/api/hello").then((response) => {})
     * 
     */
    routes: createRouter({
        api_hello: createEndpoint("/api/hello", { method: "GET", }, async (ctx) => {
            return { message: "Hello World" }
        })
    }),

    /**
     * Bind your custom express routes here:
     * Read more: https://expressjs.com/en/starter/basic-routing.html
     */
    express: (app) => {
        // ─── Инициализация БД лидерборда ─────────────────────────────────────
        leaderboardService.load();

        // ─── Парсинг JSON-тела POST-запросов ─────────────────────────────────
        app.use(express.json());

        // ─── CORS: разрешаем запросы с WebGL-сборки itch.io / Яндекс.Игр ────
        app.use("/api/leaderboard", (req, res, next) => {
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            res.setHeader("Access-Control-Allow-Headers", "Content-Type");
            if (req.method === "OPTIONS") { res.sendStatus(204); return; }
            next();
        });

        // ─── Разрешённые доски ────────────────────────────────────────────────
        const ALLOWED_BOARDS = new Set(["gold", "kills"]);

        // ─── In-memory rate limiter: 10 запросов в минуту с одного IP ────────
        const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

        function checkRateLimit(ip: string): boolean {
            const now   = Date.now();
            const entry = rateLimitMap.get(ip);

            if (!entry || now > entry.resetAt) {
                rateLimitMap.set(ip, { count: 1, resetAt: now + 60_000 });
                return true;
            }
            if (entry.count >= 10) return false;
            entry.count++;
            return true;
        }

        // Чистим старые записи раз в 5 минут, чтобы Map не росла бесконечно
        setInterval(() => {
            const now = Date.now();
            rateLimitMap.forEach((v, k) => { if (now > v.resetAt) rateLimitMap.delete(k); });
        }, 300_000);

        /**
         * POST /api/leaderboard/submit
         * Body: { boardKey: string, playerId: string, playerName: string, score: number }
         * Обновляет рекорд игрока (только если score выше предыдущего).
         */
        app.post("/api/leaderboard/submit", (req, res) => {
            const ip = (req.headers["x-forwarded-for"] as string ?? req.socket.remoteAddress ?? "").split(",")[0].trim();
            if (!checkRateLimit(ip)) {
                res.status(429).json({ error: "Слишком много запросов — попробуй через минуту" });
                return;
            }

            const { boardKey, playerId, playerName, score } = req.body ?? {};

            if (!boardKey || !playerId || typeof score !== "number") {
                res.status(400).json({ error: "Неверные параметры: boardKey, playerId и score обязательны" });
                return;
            }

            if (!ALLOWED_BOARDS.has(boardKey)) {
                res.status(400).json({ error: `Недопустимое имя доски. Разрешены: ${[...ALLOWED_BOARDS].join(", ")}` });
                return;
            }

            const updated = leaderboardService.submit(boardKey, playerId, playerName ?? "Игрок", score);
            res.json({ ok: true, updated });
        });

        /**
         * GET /api/leaderboard?boardKey=gold&top=15&playerId=xxx
         * Возвращает топ N строк и позицию текущего игрока (если передан playerId).
         * playerId НЕ включается в ответ — только флаг isCurrentPlayer на нужной строке.
         */
        app.get("/api/leaderboard", (req, res) => {
            const ip = (req.headers["x-forwarded-for"] as string ?? req.socket.remoteAddress ?? "").split(",")[0].trim();
            if (!checkRateLimit(ip)) {
                res.status(429).json({ error: "Слишком много запросов — попробуй через минуту" });
                return;
            }

            const boardKey = String(req.query.boardKey ?? "");
            const top      = Math.min(Math.max(parseInt(String(req.query.top ?? "15"), 10) || 15, 1), 100);
            const playerId = String(req.query.playerId ?? "");

            if (!boardKey) {
                res.status(400).json({ error: "Параметр boardKey обязателен" });
                return;
            }

            if (!ALLOWED_BOARDS.has(boardKey)) {
                res.status(400).json({ error: `Недопустимое имя доски. Разрешены: ${[...ALLOWED_BOARDS].join(", ")}` });
                return;
            }

            const result = leaderboardService.getLeaderboard(boardKey, top, playerId || undefined);
            res.json(result);
        });

        // ─── Панель администратора лидерборда ────────────────────────────────
        const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "ships-admin-pass";

        const checkAdminAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
            const authKey = req.headers["x-admin-key"] || req.query.adminKey;
            if (authKey !== ADMIN_PASSWORD) {
                res.status(401).json({ error: "Неверный пароль администратора" });
                return;
            }
            next();
        };

        /** GET /api/admin/leaderboard — список всех записей для админки */
        app.get("/api/admin/leaderboard", checkAdminAuth, (req, res) => {
            const boardKey = String(req.query.boardKey || "gold");
            if (!ALLOWED_BOARDS.has(boardKey)) {
                res.status(400).json({ error: "Недопустимая доска" });
                return;
            }
            res.json({ entries: leaderboardService.getAllEntries(boardKey) });
        });

        /** POST /api/admin/leaderboard/delete — удалить запись нарушителя */
        app.post("/api/admin/leaderboard/delete", checkAdminAuth, (req, res) => {
            const { boardKey, playerId } = req.body || {};
            if (!boardKey || !playerId) {
                res.status(400).json({ error: "Необходимы boardKey и playerId" });
                return;
            }
            const deleted = leaderboardService.deleteEntry(boardKey, playerId);
            res.json({ ok: true, deleted });
        });

        /** POST /api/admin/leaderboard/rename — переименовать игрока */
        app.post("/api/admin/leaderboard/rename", checkAdminAuth, (req, res) => {
            const { boardKey, playerId, newName } = req.body || {};
            if (!boardKey || !playerId || !newName) {
                res.status(400).json({ error: "Необходимы boardKey, playerId и newName" });
                return;
            }
            const renamed = leaderboardService.renameEntry(boardKey, playerId, newName);
            res.json({ ok: true, renamed });
        });

        /** GET /admin/leaderboard — HTML интерфейс админки */
        app.get("/admin/leaderboard", (req, res) => {
            res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ships — Админка Лидерборда</title>
  <style>
    :root {
      --bg: #121820;
      --card: #1b2430;
      --text: #e1e7ec;
      --text-muted: #8b9bb4;
      --accent: #3b82f6;
      --danger: #ef4444;
      --success: #10b981;
      --border: #2a3749;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: var(--bg); color: var(--text); padding: 16px; }
    .container { max-width: 900px; margin: 0 auto; }
    header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 10px; }
    h1 { font-size: 22px; color: #fff; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
    .auth-bar { display: flex; gap: 8px; margin-bottom: 16px; align-items: center; }
    input, select, button { padding: 8px 12px; border-radius: 6px; border: 1px solid var(--border); background: #0f151c; color: #fff; font-size: 14px; }
    input:focus, select:focus { outline: none; border-color: var(--accent); }
    button { background: var(--accent); cursor: pointer; border: none; font-weight: 500; transition: opacity 0.2s; }
    button:hover { opacity: 0.9; }
    button.btn-danger { background: var(--danger); }
    button.btn-rename { background: #6366f1; }
    button.btn-secondary { background: #374151; }
    .tabs { display: flex; gap: 8px; margin-bottom: 16px; }
    .tab-btn { background: #1e293b; color: var(--text-muted); }
    .tab-btn.active { background: var(--accent); color: #fff; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 14px; }
    th, td { text-align: left; padding: 10px; border-bottom: 1px solid var(--border); }
    th { color: var(--text-muted); font-size: 12px; text-transform: uppercase; }
    tr:hover { background: rgba(255,255,255,0.02); }
    .player-id { font-family: monospace; font-size: 11px; color: var(--text-muted); }
    .badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 11px; background: #263345; }
    .actions { display: flex; gap: 6px; }
    .status-msg { margin-top: 10px; font-size: 13px; }
    .status-ok { color: var(--success); }
    .status-err { color: var(--danger); }
    @media (max-width: 600px) {
      .hide-mobile { display: none; }
      th, td { padding: 8px 6px; font-size: 13px; }
    }
  </style>
</head>
<body>
<div class="container">
  <header>
    <h1>⚓ Ships — Управление лидебордом</h1>
    <div id="auth-status" class="badge">Не авторизован</div>
  </header>

  <div class="card">
    <div class="auth-bar">
      <input type="password" id="admin-pass" placeholder="Пароль администратора..." style="flex:1;">
      <button onclick="savePassword()">Войти</button>
      <button class="btn-secondary" onclick="logout()">Сброс</button>
    </div>
    <div id="auth-hint" style="font-size:12px; color:var(--text-muted);">Пароль сохраняется локально в браузере.</div>
  </div>

  <div class="card" id="content-card" style="display:none;">
    <div class="tabs">
      <button class="tab-btn active" id="tab-gold" onclick="switchTab('gold')">Золото (gold)</button>
      <button class="tab-btn" id="tab-kills" onclick="switchTab('kills')">Убийства (kills)</button>
      <button class="btn-secondary" style="margin-left:auto;" onclick="loadData()">↻ Обновить</button>
    </div>

    <div id="status" class="status-msg"></div>

    <div style="overflow-x:auto;">
      <table id="table">
        <thead>
          <tr>
            <th style="width:40px;">#</th>
            <th>Имя</th>
            <th>Очки</th>
            <th class="hide-mobile">Player ID</th>
            <th class="hide-mobile">Дата</th>
            <th style="width:140px;">Действия</th>
          </tr>
        </thead>
        <tbody id="table-body">
          <tr><td colspan="6" style="text-align:center; color:var(--text-muted);">Загрузка...</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</div>

<script>
  let currentBoard = "gold";
  let adminPassword = localStorage.getItem("ships_admin_key") || "";

  if (adminPassword) {
    document.getElementById("admin-pass").value = adminPassword;
    checkAuth();
  }

  function savePassword() {
    adminPassword = document.getElementById("admin-pass").value.trim();
    localStorage.setItem("ships_admin_key", adminPassword);
    checkAuth();
  }

  function logout() {
    localStorage.removeItem("ships_admin_key");
    adminPassword = "";
    document.getElementById("admin-pass").value = "";
    document.getElementById("content-card").style.display = "none";
    document.getElementById("auth-status").textContent = "Не авторизован";
    document.getElementById("auth-status").style.color = "var(--danger)";
  }

  async function checkAuth() {
    const res = await fetch(\`./api/admin/leaderboard?boardKey=\${currentBoard}\`, {
      headers: { "x-admin-key": adminPassword }
    });
    if (res.ok) {
      document.getElementById("auth-status").textContent = "Авторизован ✓";
      document.getElementById("auth-status").style.color = "var(--success)";
      document.getElementById("content-card").style.display = "block";
      loadData();
    } else {
      document.getElementById("auth-status").textContent = "Неверный пароль";
      document.getElementById("auth-status").style.color = "var(--danger)";
      document.getElementById("content-card").style.display = "none";
    }
  }

  function switchTab(board) {
    currentBoard = board;
    document.getElementById("tab-gold").classList.toggle("active", board === "gold");
    document.getElementById("tab-kills").classList.toggle("active", board === "kills");
    loadData();
  }

  async function loadData() {
    const tbody = document.getElementById("table-body");
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">Загрузка данных...</td></tr>';
    setStatus("");

    try {
      const res = await fetch(\`./api/admin/leaderboard?boardKey=\${currentBoard}\`, {
        headers: { "x-admin-key": adminPassword }
      });
      const data = await res.json();

      if (!res.ok) {
        setStatus(data.error || "Ошибка загрузки", true);
        return;
      }

      if (!data.entries || data.entries.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">Таблица лидеров пуста</td></tr>';
        return;
      }

      tbody.innerHTML = data.entries.map(e => \`
        <tr>
          <td><strong>\${e.rank}</strong></td>
          <td>\${escapeHtml(e.name)}</td>
          <td><span class="badge" style="color:#fbbf24; font-weight:bold;">\${e.score}</span></td>
          <td class="hide-mobile"><span class="player-id">\${escapeHtml(e.playerId)}</span></td>
          <td class="hide-mobile" style="color:var(--text-muted); font-size:12px;">\${new Date(e.updatedAt * 1000).toLocaleString('ru-RU')}</td>
          <td>
            <div class="actions">
              <button class="btn-rename" onclick="renamePlayer('\${escapeHtml(e.playerId)}', '\${escapeHtml(e.name)}')">Имя</button>
              <button class="btn-danger" onclick="deletePlayer('\${escapeHtml(e.playerId)}', '\${escapeHtml(e.name)}')">Удалить</button>
            </div>
          </td>
        </tr>
      \`).join("");

    } catch (err) {
      setStatus("Ошибка сети: " + err.message, true);
    }
  }

  async function deletePlayer(playerId, name) {
    if (!confirm(\`Удалить игрока "\${name}" (\${playerId}) из доски \${currentBoard}?\`)) return;

    try {
      const res = await fetch("./api/admin/leaderboard/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-key": adminPassword },
        body: JSON.stringify({ boardKey: currentBoard, playerId })
      });
      const data = await res.json();
      if (res.ok && data.deleted) {
        setStatus(\`Запись игрока "\${name}" удалена\`, false);
        loadData();
      } else {
        setStatus(data.error || "Не удалось удалить", true);
      }
    } catch (err) {
      setStatus("Ошибка: " + err.message, true);
    }
  }

  async function renamePlayer(playerId, oldName) {
    const newName = prompt(\`Новое имя для игрока "\${oldName}":\`, "Капитан");
    if (!newName || newName === oldName) return;

    try {
      const res = await fetch("./api/admin/leaderboard/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-key": adminPassword },
        body: JSON.stringify({ boardKey: currentBoard, playerId, newName })
      });
      const data = await res.json();
      if (res.ok && data.renamed) {
        setStatus(\`Имя игрока успешно изменено\`, false);
        loadData();
      } else {
        setStatus(data.error || "Не удалось изменить имя", true);
      }
    } catch (err) {
      setStatus("Ошибка: " + err.message, true);
    }
  }

  function setStatus(msg, isError) {
    const el = document.getElementById("status");
    el.textContent = msg;
    el.className = "status-msg " + (isError ? "status-err" : "status-ok");
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }
</script>
</body>
</html>`);
        });

        app.get("/hi", (req, res) => {
            res.send("It's time to kick ass and chew bubblegum!");
        });

        /**
         * Use @colyseus/monitor
         * It is recommended to protect this route with a password
         * Read more: https://docs.colyseus.io/tools/monitoring/#restrict-access-to-the-panel-using-a-password
         */
        app.use("/monitor", monitor());

        /**
         * Use @colyseus/playground
         * (It is not recommended to expose this route in a production environment)
         */
        if (process.env.NODE_ENV !== "production") {
            app.use("/", playground());
        }
    }

});

export default server;