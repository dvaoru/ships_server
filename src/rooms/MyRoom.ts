import { Room, Client, CloseCode } from "colyseus";
import { MyRoomState, Player, Coin } from "./schema/MyRoomState.js";

export class MyRoom extends Room<MyRoomState> {
  maxClients = 15;
  private totalCoins = 300;

  onCreate (options: any) {

    // Создаем пустое состояние при старте комнаты
    this.setState(new MyRoomState());
    console.log("Морская комната создана и ждет пиратов!");

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
                originX:   data.originX,
                originY:   data.originY,
                dirX:      data.dirX,
                dirY:      data.dirY,
                speed:     data.speed,
                maxRange:  data.maxRange,
                damage:    data.damage,
            });
        });

        // 3. Жертва сообщает о попадании → сервер списывает HP
        this.onMessage("iWasHit", (client, data) => {
            const target = this.state.players.get(client.sessionId);
            if (target && target.hp > 0) {
                target.hp -= data.damage;
                if (target.hp <= 0) {
                    target.hp = 0;
                    // Высыпаем монеты погибшего
                    this.dropGoldOnDeath(target);
                    this.state.players.delete(client.sessionId);
                    client.leave();
                }
            }
        });

        // 3. Принимаем покупку апгрейда (сервер верит на слово)
        this.onMessage("spendGold", (client, data) => {
            const player = this.state.players.get(client.sessionId);
            if (player) {
                player.gold -= data.amount; // Списываем золото в Топе
                if (player.gold < 0) player.gold = 0;
            }
        });

        // 4. Принимаем сбор монеты (кто первый прислал — тот и забрал)
        this.onMessage("collectCoin", (client, data) => {
            if (this.state.coins.has(data.coinId)) {
                // Удаляем монету
                this.state.coins.delete(data.coinId);
                
                // Начисляем золото игроку
                const player = this.state.players.get(client.sessionId);
                if (player) {
                    player.gold += 1;
                }

                // Мгновенно спавним новую монету взамен собранной
                this.spawnCoin(data.coinId);
            }
        });


    // // Handle input messages from clients
    // this.onMessage("input", (client, data) => {
    //   const player = this.state.players.get(client.sessionId);
    //   if (player && data.rotation !== undefined) {
    //     player.targetRotation = data.rotation;
    //   }
    // });

    // // Set simulation interval (e.g., 30 FPS)
    // this.setSimulationInterval((deltaTime) => this.update(deltaTime), 1000 / 30);
  }

  update(deltaTime: number) {
    // const dt = deltaTime / 1000; // convert to seconds

    // this.state.players.forEach((player, sessionId) => {
    //   // 1. Rotate towards target rotation
    //   let diff = player.targetRotation - player.rotation;
      
    //   // Normalize difference to -180 .. +180
    //   while (diff < -180) diff += 360;
    //   while (diff > 180) diff -= 360;

    //   if (Math.abs(diff) > 0.01) {
    //     const step = player.turnSpeed * dt;
    //     if (Math.abs(diff) <= step) {
    //       player.rotation = player.targetRotation;
    //     } else {
    //       player.rotation += Math.sign(diff) * step;
    //     }
    //   }

    //   // Keep rotation in 0..360 range for consistency
    //   while (player.rotation < 0) player.rotation += 360;
    //   while (player.rotation >= 360) player.rotation -= 360;

    //   // 2. Move forward constantly
    //   const rad = player.rotation * (Math.PI / 180);
    //   player.x += Math.sin(rad) * player.speed * dt;
    //   player.z += Math.cos(rad) * player.speed * dt;
    // });
  }

  onJoin (client: Client, options: any) {

    const player = new Player();
        player.id = client.sessionId;
        // Сервер выдает рандомный спавн от -50 до 50
        player.x = Math.floor(Math.random() * 100) - 50;
        player.y = Math.floor(Math.random() * 100) - 50;
        player.hp = 100;
        player.gold = 0;

        this.state.players.set(client.sessionId, player);

    // console.log(client.sessionId, "joined!");
    // const player = new Player();
    
    // // Spawn at random position for now
    // player.x = (Math.random() - 0.5) * 50;
    // player.z = (Math.random() - 0.5) * 50;
    // player.rotation = Math.random() * 360;
    // player.targetRotation = player.rotation;

    // this.state.players.set(client.sessionId, player);
  }

  onLeave (client: Client, code: CloseCode) {
        const player = this.state.players.get(client.sessionId);
        if (player) {
            // Высыпаем монеты (если они были) на месте ухода
            if (player.gold > 0) {
                this.dropGoldOnDeath(player);
            }
            this.state.players.delete(client.sessionId);
        }
  }

  onDispose() {
    console.log("room", this.roomId, "disposing...");
  }

  // Вспомогательный метод для спавна случайной монеты
    private spawnCoin(id: string) {
        const coin = new Coin();
        coin.id = id;
        // Рандомный спавн от -50 до 50
        coin.x = Math.floor(Math.random() * 100) - 50;
        coin.y = Math.floor(Math.random() * 100) - 50;
        this.state.coins.set(id, coin);
    }

  // Высыпает всё золото игрока на его месте (при смерти или дисконнекте)
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
