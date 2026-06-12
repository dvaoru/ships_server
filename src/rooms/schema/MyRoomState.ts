import { Schema, type, MapSchema } from "@colyseus/schema";

export class Player extends Schema {
  @type("number") x: number = 0;
  @type("number") z: number = 0;
  @type("number") rotation: number = 0; // in degrees
  
  // Non-synced properties used for server-side calculation
  targetRotation: number = 0; 
  speed: number = 15; // units per second
  turnSpeed: number = 180; // degrees per second
}

export class MyRoomState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
}
