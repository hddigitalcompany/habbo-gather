import { WallPatternConfig, wallFaceRects } from "@/game/wall";

/**
 * Desenho EXATO da face da FRENTE de uma parede "padrão" (sem imagem,
 * ver WallPatternConfig em game/wall.ts) -- os MESMOS retângulos de
 * tijolo que createWallPatternGraphics desenha de verdade na cena (ver
 * wallBrickRects, mesma matemática, só que sem Phaser), num <svg>
 * RETANGULAR (painel de parede é uma face plana/vertical -- ao contrário
 * do piso, que fica DEITADO no losango do tile, ver FloorPatternSwatch
 * pro caso com losango). Uma tira fininha no topo, escurecendo
 * pattern.brickColor (efeito "sombra"), representa a face de CIMA
 * (espessura) que o jogo desenha de verdade -- esquemática aqui (não
 * tenta imitar o ângulo isométrico, só dar a ideia de "a parede tem
 * volume"). Usado no preview ao vivo do formulário "Criar Parede" e no
 * botão de amostra da paleta de pintura da sala (GameRoom.tsx, mesma
 * ideia de FloorPatternSwatch).
 *
 * A cor da tira de cima teve idas e voltas (ver comentário grande de
 * WallPatternConfig em game/wall.ts): já foi campo próprio (topColor),
 * virou calculada (escurecendo brickColor) depois do Douglas testar ao
 * vivo com uma cor destoando do tijolo, e voltou a ser campo próprio
 * quando ele separou os 2 casos -- "a cor encima da parede eu quero
 * escolher" (esta tira, pattern.topColor) + "a cor da face na
 * espessura vertical é a cor que segue da parede" (as faces de PONTA
 * do jogo de verdade, que este swatch nem desenha -- é só a face da
 * FRENTE mais essa tira esquemática de cima, ver abaixo).
 *
 * `edgeLengthPx` é o comprimento de UMA aresta da grade (ver
 * wallEdgeLengthPx em game/wall.ts) -- sempre o mesmo hoje (grade
 * uniforme), passado explícito só por clareza.
 */
export function WallPatternSwatch({ pattern, edgeLengthPx }: { pattern: WallPatternConfig; edgeLengthPx: number }) {
  const rects = wallFaceRects(pattern, edgeLengthPx);
  // altura da tira de cima (espessura) -- proporcional à espessura de
  // verdade, com um mínimo pra nunca sumir numa parede bem fina.
  const capH = Math.max(4, Math.min(pattern.thicknessPx, pattern.heightPx * 0.25));
  const totalH = pattern.heightPx + capH;
  return (
    <svg
      viewBox={`0 0 ${edgeLengthPx} ${totalH}`}
      style={{ width: "100%", height: "100%", display: "block", background: hexToCss(pattern.mortarColor) }}
      aria-hidden="true"
    >
      {/* face de cima (espessura) -- pattern.topColor, campo próprio
          (ver comentário grande acima). */}
      <rect x={0} y={0} width={edgeLengthPx} height={capH} fill={hexToCss(pattern.topColor)} />
      {/* face da frente -- os tijolos de verdade, deslocados pra baixo
          da tira de cima. */}
      {rects.map((r, idx) => (
        <rect
          key={idx}
          x={r.u0}
          y={capH + (pattern.heightPx - r.v1)}
          width={r.u1 - r.u0}
          height={r.v1 - r.v0}
          fill={hexToCss(pattern.brickColor)}
        />
      ))}
    </svg>
  );
}

export function hexToCss(hex: number): string {
  return `#${hex.toString(16).padStart(6, "0")}`;
}

/** Escurece uma cor hex -- cópia pequena da MESMA conta de
 * MainScene.darkenColor (não dá pra importar Phaser aqui, esse
 * componente roda fora da cena), pra combinar com a faixa de cima que o
 * jogo desenha de verdade (efeito "sombra", ver comentário grande
 * acima). */
export function darkenHex(hex: number, factor = 0.8): number {
  const r = Math.round(((hex >> 16) & 0xff) * factor);
  const g = Math.round(((hex >> 8) & 0xff) * factor);
  const b = Math.round((hex & 0xff) * factor);
  return (r << 16) | (g << 8) | b;
}
