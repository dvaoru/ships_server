import { Client } from "@colyseus/sdk";
import { MyRoomState } from "../src/rooms/schema/MyRoomState.js";

async function main() {
    try {
        console.log("Connecting to wss://dvrgames.ru/a/ ...");
        const client = new Client("wss://dvrgames.ru/a/");
        const room = await client.joinOrCreate<MyRoomState>("my_room", { name: "TestChecker" });
        console.log("Connected! SessionId:", room.sessionId);

        await new Promise<void>((resolve) => {
            room.onStateChange.once((state) => {
                console.log("Got state change!");
                resolve();
            });
        });

        console.log("State:", {
            mapWidth: room.state.mapWidth,
            mapHeight: room.state.mapHeight,
            players: room.state.players?.size,
            coins: room.state.coins?.size,
            pickups: room.state.pickups?.size,
            islands: room.state.islands?.size
        });

        if (room.state.coins) {
            let count = 0;
            for (let [id, c] of room.state.coins) {
                console.log("Sample coin:", id, c.x, c.y);
                if (++count > 2) break;
            }
        }

        if (room.state.pickups) {
            let count = 0;
            for (let [id, p] of room.state.pickups) {
                console.log("Sample pickup:", id, p.type, p.x, p.y);
                if (++count > 2) break;
            }
        }

        // Test collect coin
        let coinId = null;
        for (let [id] of room.state.coins) { coinId = id; break; }
        console.log("Collecting coin:", coinId);
        room.send("collectCoin", { coinId: coinId, collectorId: room.sessionId });

        // Test collect pickup
        let pickupId = null;
        let pType = null;
        for (let [id, p] of room.state.pickups) { pickupId = id; pType = p.type; break; }
        console.log("Collecting pickup:", pickupId, pType);
        room.send("collectPickup", { pickupId: pickupId, collectorId: room.sessionId, pickupType: pType });

        await new Promise(res => setTimeout(res, 2000));

        const me = room.state.players.get(room.sessionId);
        console.log("My player after 2s:", {
            gold: me?.gold,
            tier: me?.tier,
            hp: me?.hp
        });

        await room.leave();
        console.log("Done successfully!");
        process.exit(0);
    } catch (e) {
        console.error("FAILED with error:", e);
        process.exit(1);
    }
}

main();
