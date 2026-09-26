import { FloorPatternConfig, floorPatternPolygons, JOINT_LINE_WIDTH } from "@/game/floor";
import { ISO_TILE_WIDTH, ISO_TILE_HEIGHT } from "@/game/grid";

/**
 * Desenho EXATO de um piso "padrão" (sem imagem, ver FloorPatternConfig
 * em game/floor.ts) -- os MESMOS polígonos que createFloorPatternGraphics
 * desenha de verdade na cena (ver floorPatternPolygons, mesma
 * matemática, só que sem Phaser), num <svg> que ocupa 100% do elemento
 * pai. Usado tanto no losango clicável da paleta de pintura da sala
 * (GameRoom.tsx, .floor-swatch) quanto no preview ao vivo/miniatura da
 * lista do formulário "Criar Piso" -> "Padrão" (ItemEditor.tsx) -- os
 * dois lugares sempre mostram a MESMA coisa, e agora de verdade FIEL ao
 * jogo (substituiu uma aproximação em CSS gradient que rendeu 2
 * rodadas de "não é fiel"/ângulo errado do Douglas antes de virar isso
 * aqui -- em vez de tentar ACERTAR o ângulo por fora, reusa o cálculo
 * ponto a ponto do jogo, então não tem ângulo nenhum pra errar).
 *
 * O recorte no formato de losango continua por conta do `clip-path`
 * CSS do CONTAINER (.floor-swatch/.floor-pattern-preview-tile em
 * globals.css, aplicado ao elemento pai que envolve este componente) --
 * aqui só desenha o conteúdo (as tábuas/ripas), sem duplicar esse
 * recorte em SVG.
 */
export function FloorPatternSwatch({ pattern }: { pattern: FloorPatternConfig }) {
  const polys = floorPatternPolygons(pattern);
  const halfWidth = ISO_TILE_WIDTH / 2;
  const halfHeight = ISO_TILE_HEIGHT / 2;
  return (
    <svg
      viewBox={`${-halfWidth} ${-halfHeight} ${ISO_TILE_WIDTH} ${ISO_TILE_HEIGHT}`}
      style={{ width: "100%", height: "100%", display: "block" }}
      aria-hidden="true"
    >
      {polys.map((poly, idx) => (
        <polygon
          key={idx}
          points={poly.points.map((p) => `${p.x},${p.y}`).join(" ")}
          fill={poly.fill}
          fillOpacity={poly.opacity}
          stroke={poly.stroke}
          strokeOpacity={poly.strokeOpacity}
          strokeWidth={poly.stroke ? JOINT_LINE_WIDTH : undefined}
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}
