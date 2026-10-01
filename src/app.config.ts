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