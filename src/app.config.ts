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

        // ─── CORS: разрешаем запросы с WebGL-сборки itch.io / Яндекс.Игр ────
        app.use("/api/leaderboard", (req, res, next) => {
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            res.setHeader("Access-Control-Allow-Headers", "Content-Type");
            if (req.method === "OPTIONS") { res.sendStatus(204); return; }
            next();
        });

        /**
         * POST /api/leaderboard/submit
         * Body: { boardKey: string, playerId: string, playerName: string, score: number }
         * Обновляет рекорд игрока (только если score выше предыдущего).
         */
        app.post("/api/leaderboard/submit", (req, res) => {
            const { boardKey, playerId, playerName, score } = req.body ?? {};

            if (!boardKey || !playerId || typeof score !== "number") {
                res.status(400).json({ error: "Неверные параметры: boardKey, playerId и score обязательны" });
                return;
            }

            const updated = leaderboardService.submit(boardKey, playerId, playerName ?? "Игрок", score);
            res.json({ ok: true, updated });
        });

        /**
         * GET /api/leaderboard?boardKey=gold&top=15&playerId=xxx
         * Возвращает топ N строк и позицию текущего игрока (если передан playerId).
         */
        app.get("/api/leaderboard", (req, res) => {
            const boardKey = String(req.query.boardKey ?? "");
            const top      = Math.min(Math.max(parseInt(String(req.query.top ?? "15"), 10) || 15, 1), 100);
            const playerId = String(req.query.playerId ?? "");

            if (!boardKey) {
                res.status(400).json({ error: "Параметр boardKey обязателен" });
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