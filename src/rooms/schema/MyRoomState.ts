import { Schema, type, MapSchema } from "@colyseus/schema";

// export class Player extends Schema {
//   @type("number") x: number = 0;
//   @type("number") z: number = 0;
//   @type("number") rotation: number = 0; // in degrees
  
//   // Non-synced properties used for server-side calculation
//   targetRotation: number = 0; 
//   speed: number = 15; // units per second
//   turnSpeed: number = 180; // degrees per second
// }

// Класс, описывающий один корабль
export class Player extends Schema {
    @type("string") id: string;
    @type("number") x: number = 0;
    @type("number") y: number = 0;
    @type("number") angle: number = 0; // Направление носа в градусах
    @type("number") hp: number = 100;
    @type("number") gold: number = 0;
    
    // Server-side only (not synced to clients)
    invulnerableUntil: number = 0;
}

// Класс монетки
export class Coin extends Schema {
    @type("string") id: string;
    @type("number") x: number;
    @type("number") y: number;
}

export class MyRoomState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
  @type({ map: Coin }) coins = new MapSchema<Coin>(); // Список монет на воде

  @type("number") mapWidth = 10;

  @type("number") mapHeight = 10;
}
