import Phaser from "phaser";
import MainScene from "./MainScene";

export function createGameConfig(
  parent: HTMLElement
): Phaser.Types.Core.GameConfig {
  return {
    type: Phaser.AUTO,
    width: 800,
    height: 600,
    parent,
    pixelArt: true,
    backgroundColor: "#1a1025",
    scene: [MainScene],
  };
}
