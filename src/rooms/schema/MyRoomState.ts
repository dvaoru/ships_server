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
    
}

// Класс монетки
export class Coin extends Schema {
    @type("float32") x: number;
    @type("float32") y: number;
}

// Класс острова
export class Island extends Schema {
    @type("string")  id: string;
    @type("number")  x: number = 0;
    @type("number")  y: number = 0;
    @type("number")  radius: number = 5;
    @type("int8")    islandType: number = 0; // индекс префаба на клиенте
    @type("number")  angle: number = 0;      // угол поворота по Y
}

export class MyRoomState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
  @type({ map: Coin })   coins   = new MapSchema<Coin>();   // Список монет на воде
  @type({ map: Island }) islands = new MapSchema<Island>(); // Статичные острова-препятствия

  @type("number") mapWidth  = 10;
  @type("number") mapHeight = 10;
}

