/**
 * "Gerador de cor" (pedido do Douglas: "cria essa ferramenta por
 * seleção" -- depois de ele recusar tanto máscara fixa por coordenada
 * quanto redesenhar cada peça à mão) -- recolore um item de avatar já
 * pronto (cabelo/acessório/traje) SEM pedir arte nova, marcando zonas
 * com o pincel (ver components/ColorZoneTool.tsx) em vez de mexer em
 * coordenada.
 *
 * A técnica (validada nesta conversa com protótipos em Python antes de
 * portar pra cá, ver histórico de testes enviados ao Douglas):
 *  1) "colorize" preservando luminância -- pega a luminância ORIGINAL de
 *     cada pixel e desenha ela de novo no matiz/saturação da cor alvo
 *     (mesma ideia de um filtro "Hue/Saturation > Colorize" do
 *     Photoshop) -- mantém sombra/luz do desenho original.
 *  2) "shift" de luminância -- sozinho, (1) não escurece/clareia o
 *     tanto que precisa quando a cor alvo é bem mais escura/clara que a
 *     arte original (testado: camisa clara virando "azul escuro" ficava
 *     só um azul pastel) -- por isso desloca a luminância de CADA pixel
 *     da zona pela diferença entre a luminância média da zona e a
 *     luminância da cor alvo, preservando a variação relativa (dobra/
 *     sombra) em vez de achatar tudo numa luminância só.
 *  3) pixel bem escuro (contorno preto do desenho) fica INTOCADO --
 *     sem isso o contorno emburacava servindo de "dark_cutoff" também.
 *
 * Em vez de máscara ESPACIAL (que não generaliza entre poses/direções
 * diferentes do mesmo item -- 15 quadros por folha, ver
 * SKIN_SHEET_SLOT_DIRECTIONS em ItemEditor.tsx), a zona aqui é definida
 * por AMOSTRA DE COR: o Douglas pinta em cima de UM quadro (o de
 * frente/parado, mais fácil de enxergar) marcando "isso é zona X", e
 * cada pixel de QUALQUER quadro da folha entra na zona cuja amostra tem
 * a cor mais parecida (distância euclidiana em RGB) -- pixel longe
 * demais de toda amostra (limiar MAX_ZONE_DISTANCE) fica de fora (não
 * mexe, ex: mão/rosto que ele não pintou). Isso já resolve os dois
 * problemas que o Douglas rejeitou: não é fixo por coordenada (seleciona pela
 * cor de verdade), e não pede desenho novo (só pintar por cima 1 vez).
 */

export type RGB = [number, number, number];
/** h, l, s -- MESMA convenção/ordem do módulo `colorsys` do Python
 * (rgb_to_hls devolve h,l,s -- não h,s,l) -- os protótipos em Python
 * testados com o Douglas usaram essa ordem, mantida aqui de propósito
 * pra não divergir do que já foi validado visualmente com ele. */
export type HLS = [number, number, number];

export function hexToRgb(hex: string): RGB {
  const clean = hex.replace(/^#/, "");
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return [r, g, b];
}

/** Porta direta de colorsys.rgb_to_hls (Python) -- r,g,b em 0..1. */
export function rgbToHls(r: number, g: number, b: number): HLS {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, l, 0];
  const d = max - min;
  const s = l <= 0.5 ? d / (max + min) : d / (2 - max - min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h /= 6;
  return [h, l, s];
}

function hueToRgbChannel(p: number, q: number, tIn: number): number {
  let t = tIn;
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

/** Porta direta de colorsys.hls_to_rgb (Python) -- devolve r,g,b em 0..1. */
export function hlsToRgb(h: number, l: number, s: number): RGB {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hueToRgbChannel(p, q, h + 1 / 3), hueToRgbChannel(p, q, h), hueToRgbChannel(p, q, h - 1 / 3)];
}

export function luminance(r: number, g: number, b: number): number {
  // 0..1 (r,g,b em 0..255) -- mesma fórmula (perceptual, BT.601) usada
  // nos protótipos Python testados com o Douglas.
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** Pixel bem escuro (contorno do desenho) -- fica sempre intocado, em
 * qualquer zona, mesmo limiar usado nos testes em Python (0.10). */
export const OUTLINE_LUMINANCE_CUTOFF = 0.1;

/** Pixel mais longe que isso (distância euclidiana em RGB 0..255) de
 * TODA amostra de TODA zona não entra em zona nenhuma -- fica intocado.
 * Evita "vazar" cor pra pele/contorno/fundo que o Douglas não pintou. */
export const MAX_ZONE_DISTANCE = 60;

export interface ZoneDef {
  /** Cor de cada pixel amostrado pelo pincel nessa zona (ver
   * ColorZoneTool.tsx -- cada ponto pintado grava a cor ORIGINAL do
   * pixel embaixo, não a cor do pincel). */
  samples: RGB /* 0..255 */[];
  /** Hex alvo escolhido pelo Douglas pra essa zona (ex: "#16284a"). */
  targetHex: string;
}

type CompiledZone = {
  samplesRgb255: RGB[];
  targetH: number;
  targetL: number;
  targetS: number;
  avgSourceL: number;
};

/** Pré-calcula o que cada zona precisa pra classificar/colorir pixel a
 * pixel (ver applyZoneTint abaixo) -- roda 1x antes do loop de pixels,
 * não a cada pixel. */
export function compileZones(zones: ZoneDef[]): CompiledZone[] {
  return zones.map((z) => {
    const [tr, tg, tb] = hexToRgb(z.targetHex);
    const [th, tl, ts] = rgbToHls(tr, tg, tb);
    const ls = z.samples.map(([r, g, b]) => luminance(r, g, b));
    const avgSourceL = ls.length > 0 ? ls.reduce((a, b) => a + b, 0) / ls.length : tl;
    return { samplesRgb255: z.samples, targetH: th, targetL: tl, targetS: ts, avgSourceL };
  });
}

/** Zona mais próxima (por cor) de um pixel, ou -1 se nenhuma amostra
 * estiver perto o bastante (MAX_ZONE_DISTANCE) -- distância euclidiana
 * simples em RGB, contra CADA amostra pintada (não só a média da zona,
 * pra não errar zona com sombra/luz bem diferente da média). */
function nearestZone(r: number, g: number, b: number, zones: CompiledZone[]): number {
  let bestZone = -1;
  let bestDist = Infinity;
  for (let zi = 0; zi < zones.length; zi++) {
    for (const [sr, sg, sb] of zones[zi].samplesRgb255) {
      const dr = r - sr;
      const dg = g - sg;
      const db = b - sb;
      const dist = Math.sqrt(dr * dr + dg * dg + db * db);
      if (dist < bestDist) {
        bestDist = dist;
        bestZone = zi;
      }
    }
  }
  return bestDist <= MAX_ZONE_DISTANCE ? bestZone : -1;
}

/**
 * Aplica o recolorimento zona-a-zona em cima de um ImageData (mutado em
 * lugar -- chama com uma CÓPIA se precisar manter o original). Roda
 * sobre a folha INTEIRA (todos os quadros de uma vez, ver comentário no
 * topo do arquivo -- não precisa recorte por quadro, a classificação é
 * por cor, não por posição).
 */
export function applyZoneTint(imageData: ImageData, zones: ZoneDef[]): { zonePixelCounts: number[] } {
  const compiled = compileZones(zones);
  const counts = new Array(zones.length).fill(0);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 0) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const l = luminance(r, g, b);
    if (l < OUTLINE_LUMINANCE_CUTOFF) continue; // contorno -- intocado
    const zi = nearestZone(r, g, b, compiled);
    if (zi === -1) continue; // fora de toda zona pintada -- intocado
    counts[zi]++;
    const zone = compiled[zi];
    const shift = zone.targetL - zone.avgSourceL;
    const nl = Math.max(0.02, Math.min(0.97, l + shift));
    const [nr, ng, nb] = hlsToRgb(zone.targetH, nl, zone.targetS);
    data[i] = Math.round(nr * 255);
    data[i + 1] = Math.round(ng * 255);
    data[i + 2] = Math.round(nb * 255);
  }
  return { zonePixelCounts: counts };
}
