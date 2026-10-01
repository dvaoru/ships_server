import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";
import filter from "leo-profanity";

// Инициализация словарей фильтра нецензурных выражений (RU + EN)
filter.loadDictionary("ru");
const ruWords = filter.list();
filter.loadDictionary("en");
filter.add(ruWords);

// ─── Пути ────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
/** Файл БД лежит в ships_server/data/leaderboard.db */
const DATA_DIR  = path.resolve(__dirname, "../../data");
const DB_FILE   = path.join(DATA_DIR, "leaderboard.db");

// ─── Типы ────────────────────────────────────────────────────────────────────

export interface LeaderboardEntry {
    rank: number;
    name: string;
    score: number;
    /** true, если эта строка принадлежит запрашивающему игроку (сервер выставляет сам) */
    isCurrentPlayer: boolean;
}

export interface LeaderboardResponse {
    entries: LeaderboardEntry[];
    /** Позиция и счёт текущего игрока (если передан playerId и запись есть) */
    currentPlayer: { rank: number; score: number } | null;
}

// ─── Сервис ───────────────────────────────────────────────────────────────────

export class LeaderboardService {
    private db!: Database.Database;

    /** Инициализирует БД: создаёт папку, открывает файл, применяет миграцию. */
    load(): void {
        // Создаём папку data/, если ещё нет
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
            console.log(`[Leaderboard] Создана папка: ${DATA_DIR}`);
        }

        this.db = new Database(DB_FILE);
        // WAL-режим: параллельные чтения не блокируют запись
        this.db.pragma("journal_mode = WAL");

        // Таблица рекордов
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS leaderboard (
                board_key  TEXT    NOT NULL,
                player_id  TEXT    NOT NULL,
                player_name TEXT   NOT NULL DEFAULT 'Игрок',
                score      INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                PRIMARY KEY (board_key, player_id)
            );
            CREATE INDEX IF NOT EXISTS idx_lb_board_score
                ON leaderboard (board_key, score DESC);
        `);

        console.log(`[Leaderboard] SQLite готова: ${DB_FILE}`);
    }

    // ─── Санитайзер и фильтр имени ───────────────────────────────────────────
    private sanitizePlayerName(rawName: string): string {
        if (!rawName) return "Капитан";

        // 1. Убираем лишние пробелы, переносы строк и непечатные символы
        let clean = rawName
            .replace(/[\r\n\t]/g, " ")
            .replace(/\s+/g, " ")
            .trim();

        // 2. Блокируем ссылки и рекламу (http://, https://, t.me/, www., .com, .ru)
        const linkPattern = /(https?:\/\/|www\.|t\.me\/|[a-z0-9-]+\.(com|ru|net|org|io|gg|xyz))/i;
        if (linkPattern.test(clean)) {
            return "Капитан";
        }

        // 3. Ограничение длины: от 1 до 16 символов
        if (clean.length === 0) return "Капитан";
        if (clean.length > 16) {
            clean = clean.substring(0, 16).trim();
        }

        // 4. Цензурируем словарный мат через leo-profanity (заменяет буквы на звёздочки *)
        if (filter.check(clean)) {
            const before = clean;
            clean = filter.clean(clean);
            console.log(`[Leaderboard] Отцензурирован мат в нике: "${before}" -> "${clean}"`);
        }

        // 5. Дополнительная замена типичных матерных корней и замаскированных слов на звёздочки
        const obscenePatterns = [
            /[хx][уy][йеяиюe][а-яa-z0-9]*/gi,
            /п[иеё1i][зz3][дd][а-яa-z0-9]*/gi,
            /[еeё][бb][аaлляттьу][а-яa-z0-9]*/gi,
            /[бb][лl][яa][дdтt]?[а-яa-z0-9]*/gi,
            /[сc][уy][кk][аa][а-яa-z0-9]*/gi,
            /[мm][уy][дd][аa][кk][а-яa-z0-9]*/gi
        ];

        for (const pattern of obscenePatterns) {
            clean = clean.replace(pattern, (match) => "*".repeat(match.length));
        }

        // Если ник состоял только из мата и стал "***", либо одни знаки пунктуации:
        if (!clean.replace(/[*_\s-]/g, "")) {
            return "***";
        }

        return clean || "Капитан";
    }

    // ─── Публичный API ───────────────────────────────────────────────────────

    /**
     * Обновляет рекорд игрока на доске.
     * Запись обновляется только если score > текущего лучшего.
     * @returns true — рекорд обновлён/установлен впервые
     */
    submit(boardKey: string, playerId: string, playerName: string, score: number): boolean {
        if (!boardKey || !playerId || score <= 0) return false;

        const name = this.sanitizePlayerName(playerName);

        // UPSERT: вставляем новую запись или обновляем, только если счёт выше
        const result = this.db.prepare(`
            INSERT INTO leaderboard (board_key, player_id, player_name, score, updated_at)
            VALUES (?, ?, ?, ?, strftime('%s', 'now'))
            ON CONFLICT (board_key, player_id) DO UPDATE SET
                player_name = excluded.player_name,
                score       = excluded.score,
                updated_at  = strftime('%s', 'now')
            WHERE excluded.score > leaderboard.score
        `).run(boardKey, playerId, name, score);

        const updated = result.changes > 0;
        if (updated) {
            console.log(`[Leaderboard] Рекорд: доска="${boardKey}", "${name}" (${playerId}), счёт=${score}`);
        }
        return updated;
    }

    /**
     * Возвращает топ N записей и (опционально) позицию текущего игрока.
     */
    getLeaderboard(boardKey: string, topCount: number, playerId?: string): LeaderboardResponse {
        // Топ N
        const rows = this.db.prepare(`
            SELECT player_id, player_name, score
            FROM leaderboard
            WHERE board_key = ?
            ORDER BY score DESC
            LIMIT ?
        `).all(boardKey, topCount) as Array<{ player_id: string; player_name: string; score: number }>;

        const entries: LeaderboardEntry[] = rows.map((row, index) => ({
            rank:            index + 1,
            name:            row.player_name,
            score:           row.score,
            // playerId не возвращаем наружу — только помечаем строку текущего игрока
            isCurrentPlayer: !!playerId && row.player_id === playerId,
        }));

        // Позиция текущего игрока (считаем через COUNT среди тех, кто имеет score >= его)
        let currentPlayer: { rank: number; score: number } | null = null;
        if (playerId) {
            const playerRow = this.db.prepare(`
                SELECT score FROM leaderboard
                WHERE board_key = ? AND player_id = ?
            `).get(boardKey, playerId) as { score: number } | undefined;

            if (playerRow) {
                const rankRow = this.db.prepare(`
                    SELECT COUNT(*) AS cnt FROM leaderboard
                    WHERE board_key = ? AND score > ?
                `).get(boardKey, playerRow.score) as { cnt: number };

                currentPlayer = {
                    rank:  rankRow.cnt + 1,
                    score: playerRow.score,
                };
            }
        }

        return { entries, currentPlayer };
    }

    // ─── Методы для панели администратора ─────────────────────────────────────

    /** Возвращает все записи доски для админки (включая player_id и дату) */
    getAllEntries(boardKey: string): Array<{ rank: number; playerId: string; name: string; score: number; updatedAt: number }> {
        const rows = this.db.prepare(`
            SELECT player_id, player_name, score, updated_at
            FROM leaderboard
            WHERE board_key = ?
            ORDER BY score DESC
        `).all(boardKey) as Array<{ player_id: string; player_name: string; score: number; updated_at: number }>;

        return rows.map((row, index) => ({
            rank: index + 1,
            playerId: row.player_id,
            name: row.player_name,
            score: row.score,
            updatedAt: row.updated_at
        }));
    }

    /** Удаляет запись конкретного игрока с доски */
    deleteEntry(boardKey: string, playerId: string): boolean {
        if (!boardKey || !playerId) return false;
        const res = this.db.prepare(`
            DELETE FROM leaderboard
            WHERE board_key = ? AND player_id = ?
        `).run(boardKey, playerId);
        return res.changes > 0;
    }

    /** Переименовывает ник игрока (например, если рекорд честный, а ник неприемлемый) */
    renameEntry(boardKey: string, playerId: string, newName: string): boolean {
        if (!boardKey || !playerId) return false;
        const sanitized = this.sanitizePlayerName(newName);
        const res = this.db.prepare(`
            UPDATE leaderboard
            SET player_name = ?
            WHERE board_key = ? AND player_id = ?
        `).run(sanitized, boardKey, playerId);
        return res.changes > 0;
    }
}

// ─── Синглтон ────────────────────────────────────────────────────────────────

export const leaderboardService = new LeaderboardService();
