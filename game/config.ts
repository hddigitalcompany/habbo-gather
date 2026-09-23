// import default (`import Phaser from "phaser"`) quebra no bundle do
// navegador: o build ESM do pacote ("dist/phaser.esm.js", que o
// webpack/Next.js prefere) só exporta tudo NOMEADO, sem "export
// default" -- dava "phaser does not contain a default export" ao vivo
// no Chrome mesmo com o tsc passando limpo. Import de namespace (* as)
// resolve, já que Phaser.Scene, Phaser.AUTO etc. são todos named exports.
import * as Phaser from "phaser";
import MainScene from "./MainScene";

export function createGameConfig(
  parent: HTMLElement
): Phaser.Types.Core.GameConfig {
  return {
    type: Phaser.AUTO,
    // resolução INTERNA do jogo continua 800x600 -- é nela que a sala
    // (GRID_COLS/GRID_ROWS em grid.ts) e todo o resto da lógica de
    // tile/posição são calculados, então não muda. Quem preenche o
    // navegador é o CANVAS por cima disso (ver `scale` abaixo).
    width: 800,
    height: 600,
    parent,
    // FIT: escala o canvas pra caber no elemento pai (que agora é
    // 100vw/100vh, ver .room-wrapper/.phaser-container em globals.css)
    // mantendo a proporção 800:600 -- preenche a tela toda sem
    // distorcer nem esticar a arte, e reajusta sozinho quando a janela
    // muda de tamanho.
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: 800,
      height: 600,
    },
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
