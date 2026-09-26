import { ISO_TILE_WIDTH, ISO_TILE_HEIGHT, tileToWorld } from "./grid";
import { Point, tileDiamondCorners } from "./iso";

/**
 * Piso da sala -- textura PLANA por quadrado da grade (sem poses/
 * direção, diferente do cabelo/pele/barba/acessório do avatar), pintada
 * tile a tile no editor de espaço ("Editar espaço" -> aba "Piso", ver
 * MapControls não, EditPanel em GameRoom.tsx). Por padrão o chão vem
 * desenhado DENTRO da arte de fundo da sala (textura "room", ver
 * create() em MainScene.ts) -- pintar um tile aqui cobre só aquele
 * quadrado com o modelo escolhido, o resto continua com o fundo padrão.
 */
export type FloorCategory = "porcelanato" | "laminado" | "natural";

export const FLOOR_CATEGORIES: { id: FloorCategory; label: string }[] = [
  { id: "porcelanato", label: "Porcelanato" },
  { id: "laminado", label: "Laminado" },
  { id: "natural", label: "Natural" },
];

/**
 * Piso "padrão" (pedido do Douglas: "precisamos de algo leve pro piso,
 * pois vai encobrir toda a sala... criamos ali dentro uma forma de
 * preenchimento de linhas... nao precise ser imagem mesmo, faz sentido?
 * ficaria mais leve?") -- SEM arquivo nenhum, desenhado direto por
 * código (Graphics, ver createFloorPatternGraphics em MainScene.ts):
 * ripas/faixas alternando 2 cores, cortadas no formato do losango do
 * tile. Mais leve que imagem (zero download/textura pra carregar) e,
 * por a faixa ser calculada em coordenada ABSOLUTA da tela (não
 * relativa a cada tile), as ripas de tiles VIZINHOS do mesmo estilo
 * continuam perfeitamente uma na outra -- a sala inteira parece um piso
 * corrido de verdade, em vez do "carimbo" repetido que uma imagem
 * batida tile a tile sempre é.
 */
export interface FloorPatternConfig {
  /** Largura de cada ripa (unidade "de tela" do próprio cálculo da
   * faixa, não é 1:1 com px de verdade -- ajusta por olho, ver o
   * preview ao vivo no Editor de Itens, aba "Criar Piso"). Um valor
   * baixo demais (ripa mais fina que ~4) fica ilegível/pichado. */
  plankWidthPx: number;
  /** cor base (hex Phaser, ex: 0xa9835f) */
  colorA: number;
  /** cor da ripa alternada (a "sombra" fixa que dá profundidade, ex:
   * um pouco mais escura que colorA) */
  colorB: number;
  /**
   * Comprimento de cada TÁBUA, em px -- OPCIONAL. Sem isso, a ripa é
   * CONTÍNUA (infinita, atravessa a sala inteira sem emenda nenhuma --
   * comportamento original). Com isso, cada ripa vira uma sequência de
   * tábuas EMENDADAS (com linha de junta visível, ver lineColor), e cada
   * coluna de tábuas fica desalinhada da vizinha por meio comprimento
   * (padrão "amarração"/running bond de assoalho de verdade -- evita
   * que as juntas de todas as colunas caiam alinhadas na mesma linha,
   * o que ficaria com cara de grade/ladrilho em vez de piso de madeira).
   * Pedido do Douglas junto com uma foto de referência de tábua corrida:
   * "vamos criar padroes aqui, e depois subir lá".
   */
  plankLengthPx?: number;
  /** Cor da linha de junta entre tábuas (hex Phaser) -- só desenhada
   * quando plankLengthPx está definido. Se omitida, usa uma variação
   * mais escura de colorA calculada automaticamente. */
  lineColor?: number;
  /**
   * Paleta de cores (hex Phaser) pra pintar cada TÁBUA de uma cor
   * "aleatória" (na verdade determinística -- mesma tábua sempre cai na
   * mesma cor, calculada a partir da posição dela na grade, ver
   * plankColorIndex em MainScene.ts -- sem precisar guardar em lugar
   * nenhum QUAL cor cada tábua usa). OPCIONAL -- quando definida,
   * IGNORA colorA/colorB (que viram só o fallback de quando `colors`
   * não está presente) e sorteia entre essas cores tábua por tábua, em
   * vez de alternar só 2 cores por coluna. Pedido do Douglas junto com
   * uma 3ª foto de referência (piso com várias tonalidades por tábua):
   * "e o mesmo do outro mas opcao de pintar diferente".
   */
  colors?: number[];
}

export interface FloorCatalogEntry {
  /** "<categoria>-<slug-do-arquivo>" pro piso DE FÁBRICA (ver
   * scripts/syncFloorAssets.mjs) -- pro piso CUSTOM (ver
   * registerCustomFloorModels abaixo) é o uuid da linha em
   * room_floor_items direto, só precisa ser único, o formato não
   * importa pra mais nada (é usado como chave de textura via
   * floorTextureKey e como chave de mapa, nunca parseado de volta). */
  id: string;
  category: FloorCategory;
  label: string;
  /** De fábrica: só o NOME do arquivo dentro de public/assets/ (precisa
   * do prefixo "/assets/" pra virar um caminho de verdade, ver preload()
   * em MainScene.ts). Custom (tipo "imagem"): a URL PÚBLICA COMPLETA do
   * Storage (cadastrado pelo Editor de Itens, aba "Criar Piso") -- já
   * pronta pra usar direto, sem prefixo nenhum (ver furnitureAssetUrl em
   * GameRoom.tsx, mesmo helper que já resolve os dois casos pro móvel,
   * reaproveitado aqui). Vazio ("") quando `pattern` está preenchido
   * (tipo "padrão", sem imagem nenhuma, ver abaixo). */
  file: string;
  /** Presente = esse modelo é "padrão" (sem imagem, ver
   * FloorPatternConfig acima) -- ausente/undefined = modelo de IMAGEM,
   * comportamento de sempre (`file` é o que manda). Nunca os dois ao
   * mesmo tempo. */
  pattern?: FloorPatternConfig;
  /** true só pros modelos CUSTOM (ver registerCustomFloorModels abaixo)
   * -- mesma ideia de FurnitureModelDef.custom em game/furniture.ts,
   * hoje sem nenhum uso real (piso não tem teto de resolução por
   * categoria feito diferença nenhuma como móvel), guardado só por
   * completude/futuro. */
  custom?: boolean;
}

// itens gerados automaticamente a partir da pasta de origem (ver
// scripts/avatarAssetsConfig.mjs/syncFloorAssets.mjs, roda sozinho junto
// com `npm run dev`). NÃO editar esse import nem o arquivo dele à mão.
import { GENERATED_FLOOR_CATALOG } from "./floorCatalog.generated";

// Os pisos "padrão" (tábua corrida/mesclada) NÃO ficam mais fixos no
// código -- correção do Douglas depois que eu cadastrei 2 de fábrica
// com cores que eu mesmo chutei a partir das fotos de referência: "eu
// nao defini as cores, so mandei exemplo, quero criar eles el criar
// piso" -- as fotos eram só EXEMPLO do estilo/padrão da tábua, não uma
// especificação de cor. Quem cria (e escolhe as cores de verdade) é o
// Douglas, pela aba "Criar Piso" -> "Padrão" (ver
// registerCustomFloorModels abaixo, e o formulário completo em
// components/ItemEditor.tsx, que agora também tem comprimento de
// tábua/linha de junta/paleta de várias cores, os mesmos recursos que
// antes só existiam aqui hard-coded).
export const FLOOR_CATALOG: FloorCatalogEntry[] = [...GENERATED_FLOOR_CATALOG];

export function floorEntryById(id: string): FloorCatalogEntry | undefined {
  return FLOOR_CATALOG.find((e) => e.id === id);
}

/**
 * Registra modelo(s) de PISO CUSTOMIZADO(s), cadastrado(s) pelo dono da
 * sala pelo Editor de Itens (aba "Criar Piso", upload direto, guardado
 * na tabela room_floor_items/Storage do Supabase -- ver
 * components/ItemEditor.tsx e app/api/floor-items) -- mesma ideia de
 * registerCustomFurnitureModels em game/furniture.ts, bem mais simples
 * (piso não tem cor/direção/footprint/assento, só uma entrada de
 * catálogo por modelo, sempre). Empurra direto pra dentro de
 * FLOOR_CATALOG (array é tipo referência, então a paleta "Piso" no
 * editor de espaço, que já importa FLOOR_CATALOG direto, enxerga os
 * itens novos sem precisar mudar nada -- só precisa forçar uma
 * re-renderização depois de chamar isso, ver fetchAndRegisterCustomFloor
 * em GameRoom.tsx).
 *
 * UPSERT: chamar de novo com o mesmo id (reconexão, refetch depois de
 * cadastrar/EDITAR um piso) SUBSTITUI a entrada -- não duplica. Devolve
 * os ids que já EXISTIAM antes dessa chamada (ou seja, que acabaram de
 * ser atualizados), pra quem chama saber quando precisa limpar a
 * textura antiga da cena e redesenhar os tiles já pintados desse estilo
 * (ver refreshFloorModel em MainScene.ts).
 */
export function registerCustomFloorModels(entries: FloorCatalogEntry[]): string[] {
  const updatedIds: string[] = [];
  for (const entry of entries) {
    const existingIndex = FLOOR_CATALOG.findIndex((e) => e.id === entry.id);
    const withFlag: FloorCatalogEntry = { ...entry, custom: true };
    if (existingIndex !== -1) {
      updatedIds.push(entry.id);
      FLOOR_CATALOG[existingIndex] = withFlag;
    } else {
      FLOOR_CATALOG.push(withFlag);
    }
  }
  return updatedIds;
}

/** Chave da textura no Phaser pra um modelo de piso (ex: "porcelanato-branco-fosco" -> "floor-porcelanato-branco-fosco"). */
export function floorTextureKey(styleId: string): string {
  return `floor-${styleId}`;
}

/** Um quadrado da grade pintado com um modelo -- posição em TILE (col/row), igual aos móveis (ver game/furniture.ts). */
export interface FloorTileDef {
  col: number;
  row: number;
  styleId: string;
}

export function floorWorldPos(f: FloorTileDef) {
  // piso fica DEITADO no meio do tile (sem âncora embaixo como o
  // móvel/boneco -- não tem "pé", é o próprio chão), por isso usa direto
  // o centro do tile.
  return tileToWorld(f.col, f.row);
}

// Diferente de ROOM_FURNITURE (furniture.ts, ainda copiado à mão), o piso
// pintado no editor de espaço ("Editar espaço" -> aba "Piso") salva
// sozinho no servidor (ver GET/POST /room/floor em server/index.js +
// server/roomStore.js) -- por isso não tem mais um ROOM_FLOOR fixo aqui.
// MainScene.loadSavedFloor(items) é quem recebe a lista salva (buscada
// pelo React em GameRoom.tsx assim que a cena fica pronta) e desenha.

function hexToCss(hex: number): string {
  return `#${hex.toString(16).padStart(6, "0")}`;
}

/**
 * Escurece uma cor hex (multiplicando cada canal RGB) -- versão em
 * espaço de número (não Phaser) da mesma conta de MainScene.darkenColor,
 * usada aqui só pra ter um fallback de linha de junta na PRÉVIA em CSS
 * quando lineColor não foi definido (mesma regra do desenho de
 * verdade). Duplicada de propósito -- esse arquivo não importa nada do
 * Phaser (é usado também fora da cena, ver ItemEditor.tsx), e é só uma
 * conta de 3 linhas, não vale a pena quebrar esse isolamento por isso. */
function darkenHex(hex: number, factor = 0.55): number {
  const r = Math.round(((hex >> 16) & 0xff) * factor);
  const g = Math.round(((hex >> 8) & 0xff) * factor);
  const b = Math.round((hex & 0xff) * factor);
  return (r << 16) | (g << 8) | b;
}

/** Índice determinístico (0..len-1) pra escolher a cor de uma tábua
 * (coluna `i`, posição `j`) dentro de FloorPatternConfig.colors -- cópia
 * EXATA (mesmo hash) de MainScene.plankColorIndex, em número puro (sem
 * Phaser), usada só por floorPatternPolygons abaixo. Duplicada de
 * propósito, mesmo motivo de darkenHex acima -- e precisa ser IDÊNTICA
 * bit a bit ao original pra sortear a mesma cor pra mesma tábua nos dois
 * lugares. */
function plankColorIndexPure(i: number, j: number, len: number): number {
  let h = (i * 374761393 + j * 668265263) ^ (i << 13);
  h = Math.imul(h ^ (h >>> 15), 1274126177);
  h = h ^ (h >>> 16);
  return Math.abs(h) % len;
}

/** Cópia pura de MainScene.pickPlankColor (ver plankColorIndexPure
 * acima). */
function pickPlankColorPure(pattern: FloorPatternConfig, i: number, j: number): number {
  if (pattern.colors && pattern.colors.length > 0) {
    return pattern.colors[plankColorIndexPure(i, j, pattern.colors.length)];
  }
  return ((i % 2) + 2) % 2 === 0 ? pattern.colorA : pattern.colorB;
}

/** Um polígono (tábua/ripa) já pronto pra virar um `<polygon>` de SVG. */
export interface FloorPatternPolygon {
  points: Point[];
  /** cor de preenchimento, CSS hex ("#rrggbb") */
  fill: string;
  /** cor do contorno, CSS hex -- só presente nas tábuas EMENDADAS
   * (plankLengthPx definido, ver FloorPatternConfig). Ausente na ripa
   * contínua (o jogo de verdade também não traça contorno nesse caso,
   * ver createFloorPatternGraphics em MainScene.ts). */
  stroke?: string;
}

/**
 * Calcula os polígonos de como um FloorPatternConfig fica desenhado
 * dentro de UM tile ISOLADO, centrado na origem (0,0) -- é a MESMA
 * matemática de createFloorPatternGraphics em MainScene.ts (mesmos
 * across/along/dirWid/dirLen/plankColorIndex), só que em TypeScript
 * puro (sem Phaser.Graphics), devolvendo os pontos já prontos pra
 * desenhar num `<svg><polygon>`.
 *
 * Usada pelo preview ao vivo do formulário "Criar Piso" -> "Padrão"
 * (ItemEditor.tsx) e pelo losango da paleta de pintura da sala
 * (GameRoom.tsx, floor-swatch), pelo componente compartilhado
 * <FloorPatternSwatch> (components/FloorPatternSwatch.tsx) -- os dois
 * lugares sempre mostram a MESMA coisa, e agora de verdade FIEL ao que
 * o jogo desenha (não mais uma aproximação em CSS gradient, chutando
 * ângulo -- 2 tentativas de aproximação por CSS já renderam "a exibicao
 * no criar nao e fiel ao que vai pro jogo", "a linha ta no sentido
 * contrario" e "seu corretor fez foi piorar o angulo" do Douglas; a
 * forma de nunca mais errar o ângulo é não ter ângulo nenhum pra
 * chutar -- reusar o MESMO cálculo ponto a ponto do jogo).
 */
export function floorPatternPolygons(pattern: FloorPatternConfig): FloorPatternPolygon[] {
  const pos = { x: 0, y: 0 }; // tile isolado, centrado na origem -- ver comentário da função
  const step = Math.max(4, pattern.plankWidthPx);
  const sqrt5 = Math.sqrt(5);
  const dirLen = { x: -2 / sqrt5, y: 1 / sqrt5 };
  const dirWid = { x: 1 / sqrt5, y: 2 / sqrt5 };
  const p0 = pos.x + 2 * pos.y; // = 0 (tile na origem)
  const reach = ISO_TILE_WIDTH / 2 + ISO_TILE_HEIGHT;
  const minIndex = Math.floor((p0 - reach) / step) - 1;
  const maxIndex = Math.ceil((p0 + reach) / step) + 1;
  const polys: FloorPatternPolygon[] = [];

  if (pattern.plankLengthPx) {
    const lenStep = Math.max(4, pattern.plankLengthPx);
    const q0 = -2 * pos.x + pos.y; // = 0
    const lineColor = hexToCss(pattern.lineColor ?? darkenHex(pattern.colorA));
    for (let i = minIndex; i <= maxIndex; i++) {
      const colOffset = ((i % 2) + 2) % 2 === 0 ? 0 : lenStep / 2;
      const minJ = Math.floor((q0 - reach - colOffset) / lenStep) - 1;
      const maxJ = Math.ceil((q0 + reach - colOffset) / lenStep) + 1;
      for (let j = minJ; j <= maxJ; j++) {
        const pTarget = (i + 0.5) * step;
        const qTarget = j * lenStep + colOffset + lenStep / 2;
        const across = pTarget / sqrt5;
        const along = qTarget / sqrt5;
        const cx = across * dirWid.x + along * dirLen.x;
        const cy = across * dirWid.y + along * dirLen.y;
        const halfWidth = step / (2 * sqrt5);
        const halfLength = lenStep / (2 * sqrt5);
        const lx = dirLen.x * halfLength;
        const ly = dirLen.y * halfLength;
        const wx = dirWid.x * halfWidth;
        const wy = dirWid.y * halfWidth;
        polys.push({
          points: [
            { x: cx - lx - wx, y: cy - ly - wy },
            { x: cx + lx - wx, y: cy + ly - wy },
            { x: cx + lx + wx, y: cy + ly + wy },
            { x: cx - lx + wx, y: cy - ly + wy },
          ],
          fill: hexToCss(pickPlankColorPure(pattern, i, j)),
          stroke: lineColor,
        });
      }
    }
  } else {
    const halfLength = ISO_TILE_WIDTH; // mesmo exagero de MainScene.ts -- sobra de propósito, cobre o tile inteiro
    for (let i = minIndex; i <= maxIndex; i++) {
      const pTarget = (i + 0.5) * step;
      const dist = (pTarget - p0) / sqrt5;
      const cx = pos.x + dirWid.x * dist;
      const cy = pos.y + dirWid.y * dist;
      const halfWidth = step / (2 * sqrt5);
      const lx = dirLen.x * halfLength;
      const ly = dirLen.y * halfLength;
      const wx = dirWid.x * halfWidth;
      const wy = dirWid.y * halfWidth;
      polys.push({
        points: [
          { x: cx - lx - wx, y: cy - ly - wy },
          { x: cx + lx - wx, y: cy + ly - wy },
          { x: cx + lx + wx, y: cy + ly + wy },
          { x: cx - lx + wx, y: cy - ly + wy },
        ],
        fill: hexToCss(pickPlankColorPure(pattern, i, 0)),
      });
    }
  }
  return polys;
}

/** Cantos do losango de UM tile, centrado na origem -- reexportado aqui
 * (mesmos pontos de tileDiamondCorners(0,0) em game/iso.ts) só pra quem
 * usa floorPatternPolygons (o preview em SVG) não precisar de mais um
 * import separado pra recortar o resultado no formato do tile. */
export function floorPatternDiamondCorners(): Point[] {
  return tileDiamondCorners(0, 0);
}
