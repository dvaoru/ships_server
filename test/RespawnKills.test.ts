import assert from "node:assert/strict";
import { MyRoom } from "../src/rooms/MyRoom.js";

describe("respawn kill counter", () => {
  let room: MyRoom;
  let handlers: Map<string, Function>;
  const client: any = { sessionId: "respawn_test", send() {} };
  const victim: any = { sessionId: "victim_test", send() {} };

  beforeEach(() => {
    room = new MyRoom();
    handlers = new Map();
    // Изолируем транспорт: выполняем настоящие обработчики без порта и БД.
    (room as any).onMessage = (name: string, handler: Function) => handlers.set(name, handler);
    (room as any).broadcast = () => {};
    room.onCreate({});
    room.onJoin(client, { name: "Test" });
    room.onJoin(victim, { name: "Victim" });
  });

  afterEach(() => {
    room.clock.clear();
    room.onDispose();
  });

  it("starts ordinary respawn at zero and counts the first new kill as one", () => {
    const player = room.state.players.get(client.sessionId)!;
    player.kills = 3;
    handlers.get("iWasHit")!(client, { damage: 100, shooterId: "VOID" });
    handlers.get("respawn")!(client, { keepProgress: false });
    assert.equal(player.kills, 0);
    handlers.get("iWasHit")!(victim, { damage: 100, shooterId: client.sessionId });
    assert.equal(player.kills, 1);
  });

  it("keeps kills when reviving with saved progress", () => {
    const player = room.state.players.get(client.sessionId)!;
    player.kills = 3;
    player.gold = 35;
    player.tier = 3;
    handlers.get("iWasHit")!(client, { damage: 100, shooterId: "VOID" });
    handlers.get("respawn")!(client, { keepProgress: true });
    assert.equal(player.kills, 3);
    assert.equal(player.gold, 35);
    assert.equal(player.tier, 3);
  });
});
