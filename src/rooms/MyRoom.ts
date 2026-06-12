import { Room, Client, CloseCode } from "colyseus";
import { MyRoomState, Player } from "./schema/MyRoomState.js";

export class MyRoom extends Room<MyRoomState> {
  maxClients = 15;

  onCreate (options: any) {
    this.setState(new MyRoomState());

    // Handle input messages from clients
    this.onMessage("input", (client, data) => {
      const player = this.state.players.get(client.sessionId);
      if (player && data.rotation !== undefined) {
        player.targetRotation = data.rotation;
      }
    });

    // Set simulation interval (e.g., 30 FPS)
    this.setSimulationInterval((deltaTime) => this.update(deltaTime), 1000 / 30);
  }

  update(deltaTime: number) {
    const dt = deltaTime / 1000; // convert to seconds

    this.state.players.forEach((player, sessionId) => {
      // 1. Rotate towards target rotation
      let diff = player.targetRotation - player.rotation;
      
      // Normalize difference to -180 .. +180
      while (diff < -180) diff += 360;
      while (diff > 180) diff -= 360;

      if (Math.abs(diff) > 0.01) {
        const step = player.turnSpeed * dt;
        if (Math.abs(diff) <= step) {
          player.rotation = player.targetRotation;
        } else {
          player.rotation += Math.sign(diff) * step;
        }
      }

      // Keep rotation in 0..360 range for consistency
      while (player.rotation < 0) player.rotation += 360;
      while (player.rotation >= 360) player.rotation -= 360;

      // 2. Move forward constantly
      const rad = player.rotation * (Math.PI / 180);
      player.x += Math.sin(rad) * player.speed * dt;
      player.z += Math.cos(rad) * player.speed * dt;
    });
  }

  onJoin (client: Client, options: any) {
    console.log(client.sessionId, "joined!");
    const player = new Player();
    
    // Spawn at random position for now
    player.x = (Math.random() - 0.5) * 50;
    player.z = (Math.random() - 0.5) * 50;
    player.rotation = Math.random() * 360;
    player.targetRotation = player.rotation;

    this.state.players.set(client.sessionId, player);
  }

  onLeave (client: Client, code: CloseCode) {
    console.log(client.sessionId, "left!");
    this.state.players.delete(client.sessionId);
  }

  onDispose() {
    console.log("room", this.roomId, "disposing...");
  }
}
