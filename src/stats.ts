import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const DATA_DIR   = path.resolve(__dirname, "../../data");
const DB_FILE    = path.join(DATA_DIR, "leaderboard.db");

export interface OnlineStatsPoint {
    timestamp: number;
    humans: number;
    bots: number;
    rooms: number;
}

export interface StatsSummary {
    current: {
        humans: number;
        bots: number;
        rooms: number;
    };
    peakWeek: {
        humans: number;
        bots: number;
    };
    history: OnlineStatsPoint[];
}

export class StatsService {
    private db!: Database.Database;
    private timer: NodeJS.Timeout | null = null;
    private getterFn: (() => { humans: number; bots: number; rooms: number }) | null = null;

    load(getter: () => { humans: number; bots: number; rooms: number }): void {
        this.getterFn = getter;

        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }

        this.db = new Database(DB_FILE);
        this.db.pragma("journal_mode = WAL");

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS online_stats (
                timestamp    INTEGER NOT NULL,
                humans_count INTEGER NOT NULL DEFAULT 0,
                bots_count   INTEGER NOT NULL DEFAULT 0,
                rooms_count  INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_online_stats_ts
                ON online_stats (timestamp);
        `);

        console.log(`[StatsService] Таблица online_stats готова в ${DB_FILE}`);

        // Делаем первый замер сразу
        this.recordSnapshot();

        // Запускаем периодический замер каждые 5 минут (300 000 мс)
        if (this.timer) clearInterval(this.timer);
        this.timer = setInterval(() => {
            this.recordSnapshot();
        }, 5 * 60 * 1000);
    }

    recordSnapshot(): void {
        if (!this.getterFn || !this.db) return;

        try {
            const now = Math.floor(Date.now() / 1000);
            const current = this.getterFn();

            this.db.prepare(`
                INSERT INTO online_stats (timestamp, humans_count, bots_count, rooms_count)
                VALUES (?, ?, ?, ?)
            `).run(now, current.humans, current.bots, current.rooms);

            // Очищаем записи старше 7 дней (7 * 86400 = 604800 сек)
            const cutoff = now - 7 * 86400;
            this.db.prepare(`
                DELETE FROM online_stats WHERE timestamp < ?
            `).run(cutoff);
        } catch (e: any) {
            console.error(`[StatsService] Ошибка записи статистики: ${e?.message}`);
        }
    }

    getStats(): StatsSummary {
        const current = this.getterFn ? this.getterFn() : { humans: 0, bots: 0, rooms: 0 };
        const now = Math.floor(Date.now() / 1000);
        const weekAgo = now - 7 * 86400;

        const rows = this.db.prepare(`
            SELECT timestamp, humans_count, bots_count, rooms_count
            FROM online_stats
            WHERE timestamp >= ?
            ORDER BY timestamp ASC
        `).all(weekAgo) as Array<{
            timestamp: number;
            humans_count: number;
            bots_count: number;
            rooms_count: number;
        }>;

        const history: OnlineStatsPoint[] = rows.map(r => ({
            timestamp: r.timestamp,
            humans: r.humans_count,
            bots: r.bots_count,
            rooms: r.rooms_count
        }));

        let peakHumans = current.humans;
        let peakBots = current.bots;

        for (const pt of history) {
            if (pt.humans > peakHumans) peakHumans = pt.humans;
            if (pt.bots > peakBots) peakBots = pt.bots;
        }

        return {
            current,
            peakWeek: {
                humans: peakHumans,
                bots: peakBots
            },
            history
        };
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}

export const statsService = new StatsService();
