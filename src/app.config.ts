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
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

        // ─── Отдельный rate limiter для админских эндпоинтов ─────────────────
        // Щедрее публичного (10/мин): админ листает страницы и ищет — обычный лимит сломал бы UX.
        const adminRateLimitMap = new Map<string, { count: number; resetAt: number }>();

        function checkAdminRateLimit(ip: string): boolean {
            const now   = Date.now();
            const entry = adminRateLimitMap.get(ip);

            if (!entry || now > entry.resetAt) {
                adminRateLimitMap.set(ip, { count: 1, resetAt: now + 60_000 });
                return true;
            }
            if (entry.count >= 120) return false;
            entry.count++;
            return true;
        }

        setInterval(() => {
            const now = Date.now();
            adminRateLimitMap.forEach((v, k) => { if (now > v.resetAt) adminRateLimitMap.delete(k); });
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

        /**
         * GET /api/admin/leaderboard?boardKey=gold&limit=100&offset=0&search=
         * Страница записей доски для админки + общее число строк (для пагинации).
         */
        app.get(
            "/api/admin/leaderboard",
            (req, res, next) => {
                const ip = (req.headers["x-forwarded-for"] as string ?? req.socket.remoteAddress ?? "").split(",")[0].trim();
                if (!checkAdminRateLimit(ip)) {
                    res.status(429).json({ error: "Слишком много запросов — попробуй через минуту" });
                    return;
                }
                next();
            },
            checkAdminAuth,
            (req, res) => {
                const boardKey = String(req.query.boardKey || "gold");
                if (!ALLOWED_BOARDS.has(boardKey)) {
                    res.status(400).json({ error: "Недопустимая доска" });
                    return;
                }

                // limit клампим, чтобы клиент не мог запросить всю таблицу разом
                const limit  = Math.min(Math.max(parseInt(String(req.query.limit ?? "100"), 10) || 100, 1), 500);
                const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);
                const search = String(req.query.search ?? "").slice(0, 32);

                const result = leaderboardService.getAllEntries(boardKey, limit, offset, search);
                res.json({ ...result, limit, offset, boardKey });
            }
        );

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
            const htmlPath = path.resolve(__dirname, "../public/admin.html");
            res.sendFile(htmlPath);
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