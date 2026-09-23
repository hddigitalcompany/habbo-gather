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
    // a arte nova (gerada, com anti-aliasing suave) fica serrilhada com
    // filtro nearest-neighbor em escala fracionária -- diferente do
    // gerador procedural antigo (blocos de pixel duro), que queria
    // pixelArt:true. Suavizado fica mais fiel ao estilo atual.
    pixelArt: false,
    antialias: true,
    backgroundColor: "#1a1025",
    scene: [MainScene],
  };
}
