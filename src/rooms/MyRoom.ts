import { Room, Client, CloseCode } from "colyseus";
import { MyRoomState, Player, Coin, Island } from "./schema/MyRoomState.js";

export class MyRoom extends Room<MyRoomState> {
    maxClients = 15;
    private totalCoins = 1000;
    private mapWidth = 200;
    private mapHeight = 200;

    // ─── Настройки островов ──────────────────────────────────────────────
    private totalIslands = 0;//10;//20;  // Сколько островов генерировать
    private islandMinRadius = 5;   // Минимальный радиус острова (юниты)
    private islandMaxRadius = 8;   // Максимальный радиус острова
    private islandTypes = 3;   // Количество типов префабов на клиенте
    private minIslandSpacing = 5;   // Минимальный зазор между краями островов

    // Настройка фиксированных размеров. Если типа нет в словаре, он будет рандомного размера.
    private fixedIslandRadiuses: { [type: number]: number } = {
        0: 16, // Пример: тип 0 (первый префаб) всегда имеет физический радиус 6
        // 1: 10, // Раскомментируй для фиксации размера других типов
    };

    onCreate(options: any) {

        // Создаем пустое состояние при старте комнаты
        var myState = new MyRoomState();
        myState.mapWidth = this.mapWidth;
        myState.mapHeight = this.mapHeight;
        this.state = myState;
        console.log("Морская комната создана и ждет пиратов!");

        // Генерируем острова ДО монет, чтобы монеты их избегали
        this.generateIslands();

        // Спавним стартовые 300 монет на случайных координатах
        for (let i = 0; i < this.totalCoins; i++) {
            this.spawnCoin(i.toString());
        }

        // 1. Принимаем координаты от Unity (15 раз в секунду)
        this.onMessage("updatePosition", (client, data) => {
            const player = this.state.players.get(client.sessionId);
            if (player) {
                player.x = data.x;
                player.y = data.y;
                player.angle = data.angle;
            }
        });

        // 2. Стрелок сообщает о выстреле → сервер рассылает всем
        this.onMessage("fire", (client, data) => {
            this.broadcast("bulletSpawned", {
                shooterId: client.sessionId,
                originX: data.originX,
                originY: data.originY,
                dirX: data.dirX,
                dirY: data.dirY,
                speed: data.speed,
                maxRange: data.maxRange,
                damage: data.damage,
            });
        });

        // 3. Жертва сообщает о попадании → сервер списывает HP
        this.onMessage("iWasHit", (client, data) => {
            const targetId = data.targetId ?? client.sessionId;

            // Проверка: клиент может сообщить о попадании только по себе или своему боту
            if (targetId !== client.sessionId && !targetId.startsWith(`bot_${client.sessionId}`)) {
                console.warn(`Client ${client.sessionId} tried to report hit for foreign target: ${targetId}`);
                return;
            }

            const target = this.state.players.get(targetId);
            if (target && target.hp > 0) {
                target.hp -= data.damage;
                if (target.hp < 0) target.hp = 0;
                if (target.hp <= 0) {
                    target.hp = 0;
                    // Логируем тип смерти
                    if (data.shooterId === "RAM_SELF") {
                        console.log(`[RAM] Player rammed and sank: ${targetId}`);
                    } else if (data.shooterId === "RAM") {
                        console.log(`[RAM] Player rammed to death: ${targetId} (rammer: ${client.sessionId})`);
                    }
                    // Высыпаем монеты погибшего (если не VOID/ISLAND)
                    if (data.shooterId !== "VOID" && data.shooterId !== "ISLAND") {
                        this.dropGoldOnDeath(target);
                    }
                    target.gold = 0;

                    if (!targetId.startsWith("bot_")) {
                        console.log(`Player destroyed but kept in room: ${targetId}`);
                    } else {
                        this.state.players.delete(targetId);
                        console.log(`Bot destroyed: ${targetId}`);
                    }
                } else {
                    // HP уронен, но цель выжила
                    if (data.shooterId === "RAM") {
                        console.log(`[RAM] Player rammed: ${targetId}, damage: ${data.damage}, hp left: ${target.hp}`);
                    }
                }
            }
        });

        // Обработка возрождения игрока
        this.onMessage("respawn", (client) => {
            const player = this.state.players.get(client.sessionId);
            if (player && player.hp <= 0) {
                // Новые случайные координаты — вне зон островов
                const pos = this.safeSpawnPosition();
                player.x = pos.x;
                player.y = pos.y;
                player.hp = 100;
                console.log(`Player respawned: ${client.sessionId}`);
            }
        });

        // 3. Принимаем покупку апгрейда (сервер верит на слово)
        this.onMessage("spendGold", (client, data) => {
            const player = this.state.players.get(client.sessionId);
            if (player) {
                player.gold -= data.amount;
                if (player.gold < 0) player.gold = 0;
            }
        });

        // 4. Принимаем сбор монеты (кто первый прислал — тот и забрал)
        this.onMessage("collectCoin", (client, data) => {
            if (this.state.coins.has(data.coinId)) {
                this.state.coins.delete(data.coinId);

                const collectorId = data.collectorId ?? client.sessionId;
                const collector = this.state.players.get(collectorId);
                if (collector) {
                    collector.gold += 1;
                }

                // Мгновенно спавним новую монету взамен собранной
                this.spawnCoin(data.coinId);
            }
        });

        // 5. Регистрация бота от клиента-владельца
        this.onMessage("spawnBot", (client, data) => {
            const botId: string = data.botId;
            if (!botId || this.state.players.has(botId)) return;

            if (!botId.startsWith(`bot_${client.sessionId}`)) {
                console.warn(`Client ${client.sessionId} tried to spawn foreign bot: ${botId}`);
                return;
            }

            const pos = this.safeSpawnPosition();
            const bot = new Player();
            bot.id = botId;
            bot.x = pos.x;
            bot.y = pos.y;
            bot.hp = 100;
            bot.gold = 0;
            this.state.players.set(botId, bot);
            console.log(`Bot spawned: ${botId} (owner: ${client.sessionId})`);
        });

        // 6. Обновление позиции бота от его владельца
        this.onMessage("updateBotPosition", (client, data) => {
            const bot = this.state.players.get(data.botId);
            if (!bot) return;

            if (!data.botId.startsWith(`bot_${client.sessionId}`)) return;

            bot.x = data.x;
            bot.y = data.z;   // сервер использует y как z-координату
            bot.angle = data.angle;
        });
    }

    update(deltaTime: number) {
        // reserved for simulation interval
    }

    onJoin(client: Client, options: any) {
        const player = new Player();
        player.id = client.sessionId;

        // Спавним вне зон островов
        const pos = this.safeSpawnPosition();
        player.x = pos.x;
        player.y = pos.y;
        player.hp = 100;
        player.gold = 0;

        this.state.players.set(client.sessionId, player);
    }

    onLeave(client: Client, code: CloseCode) {
        const player = this.state.players.get(client.sessionId);
        if (player) {
            if (player.gold > 0) {
                this.dropGoldOnDeath(player);
            }
            this.state.players.delete(client.sessionId);
        }

        // Удаляем всех ботов этого клиента
        const botPrefix = `bot_${client.sessionId}`;
        const botIds: string[] = [];
        this.state.players.forEach((_player: Player, id: string) => {
            if (id.startsWith(botPrefix)) botIds.push(id);
        });
        botIds.forEach(id => {
            this.state.players.delete(id);
            console.log(`Bot removed: ${id} (owner left: ${client.sessionId})`);
        });
    }

    onDispose() {
        console.log("room", this.roomId, "disposing...");
    }

    // ─── Острова ──────────────────────────────────────────────────────────

    /**
     * Генерирует острова с минимальным зазором между ними.
     * Каждый остров получает случайный радиус, тип и угол поворота.
     */
    private generateIslands() {
        const maxAttempts = 100;
        let placed = 0;

        for (let i = 0; i < this.totalIslands; i++) {
            let attempts = 0;
            let ok = false;

            while (attempts < maxAttempts && !ok) {
                attempts++;

                const islandType = Math.floor(Math.random() * this.islandTypes);

                let radius = this.fixedIslandRadiuses[islandType];
                if (radius === undefined) {
                    radius = this.islandMinRadius + Math.random() * (this.islandMaxRadius - this.islandMinRadius);
                }

                const x = Math.random() * (this.mapWidth - radius * 2) - (this.mapWidth / 2 - radius);
                const y = Math.random() * (this.mapHeight - radius * 2) - (this.mapHeight / 2 - radius);

                // Проверяем расстояние до уже размещённых островов
                let tooClose = false;
                this.state.islands.forEach((island: Island) => {
                    const dx = island.x - x;
                    const dy = island.y - y;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist < island.radius + radius + this.minIslandSpacing) {
                        tooClose = true;
                    }
                });

                if (!tooClose) {
                    const island = new Island();
                    island.id = `island_${i}`;
                    island.x = x;
                    island.y = y;
                    island.radius = radius;
                    island.islandType = islandType;
                    island.angle = Math.random() * 360;
                    this.state.islands.set(island.id, island);
                    placed++;
                    ok = true;
                }
            }

            if (!ok) {
                console.warn(`[Islands] Could not place island ${i} after ${maxAttempts} attempts`);
            }
        }

        console.log(`[Islands] Placed ${placed}/${this.totalIslands} islands`);
    }

    /**
     * Проверяет, попадает ли точка (x, y) в зону острова.
     * @param margin   Дополнительный отступ (например, +5 для спавна игроков)
     */
    private isInsideIsland(x: number, y: number, margin: number = 0): boolean {
        let inside = false;
        this.state.islands.forEach((island: Island) => {
            if (inside) return; // early exit
            const dx = island.x - x;
            const dy = island.y - y;
            if (Math.sqrt(dx * dx + dy * dy) < island.radius + margin) {
                inside = true;
            }
        });
        return inside;
    }

    /**
     * Возвращает безопасную позицию спавна вне зон всех островов.
     * Гарантирован отступ +5 юнитов от края острова.
     */
    private safeSpawnPosition(): { x: number; y: number } {
        const spawnMargin = 5;
        const maxAttempts = 200;

        for (let i = 0; i < maxAttempts; i++) {
            const x = Math.floor(Math.random() * this.mapWidth) - this.mapWidth / 2;
            const y = Math.floor(Math.random() * this.mapHeight) - this.mapHeight / 2;

            if (!this.isInsideIsland(x, y, spawnMargin)) {
                return { x, y };
            }
        }

        // Фолбэк: центр карты
        console.warn("[Islands] safeSpawnPosition: could not find free spot, using center");
        return { x: 0, y: 0 };
    }

    // ─── Монеты ───────────────────────────────────────────────────────────

    /** Спавнит монету в случайном месте, избегая зон островов */
    private spawnCoin(id: string) {
        const maxAttempts = 50;

        for (let i = 0; i < maxAttempts; i++) {
            const x = Math.floor(Math.random() * this.mapWidth) - this.mapWidth / 2;
            const y = Math.floor(Math.random() * this.mapHeight) - this.mapHeight / 2;

            if (!this.isInsideIsland(x, y)) {
                const coin = new Coin();
                coin.id = id;
                coin.x = x;
                coin.y = y;
                this.state.coins.set(id, coin);
                return;
            }
        }

        // Фолбэк: спавним в центре
        const coin = new Coin();
        coin.id = id;
        coin.x = 0;
        coin.y = 0;
        this.state.coins.set(id, coin);
    }

    /** Высыпает всё золото игрока на его месте (при смерти или дисконнекте) */
    private dropGoldOnDeath(player: Player) {
        for (let i = 0; i < player.gold; i++) {
            const dropId = `dropped_${player.id}_${i}_${Date.now()}`;
            const coin = new Coin();
            coin.id = dropId;
            coin.x = player.x + (Math.random() * 4 - 2);
            coin.y = player.y + (Math.random() * 4 - 2);
            this.state.coins.set(dropId, coin);
        }
    }
}
