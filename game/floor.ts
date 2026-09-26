import { tileToWorld } from "./grid";

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

/**
 * Pisos "padrão" DE FÁBRICA -- ao contrário dos pisos de IMAGEM (que
 * vêm sozinhos do scanner da pasta de assets, ver GENERATED_FLOOR_CATALOG
 * acima) e dos pisos "padrão" CUSTOM (cadastrados pelo dono na aba
 * "Criar Piso" -> "Padrão", guardados no Supabase, ver
 * registerCustomFloorModels abaixo), um piso "padrão" não tem arquivo
 * nenhum pra escanear -- por isso essa lista é escrita À MÃO aqui, e
 * não pelo scanner. Pedido do Douglas (mandou fotos de referência de
 * pisos de tábua/parquet): "vamos criar padroes aqui, e depois subir
 * lá" -- cada entrada abaixo é um desses padrões, prontos de fábrica
 * pra qualquer sala, sem precisar cadastrar nada no editor.
 */
const FACTORY_FLOOR_PATTERNS: FloorCatalogEntry[] = [
  {
    id: "laminado-tabua-corrida-castanho",
    category: "laminado",
    label: "Tábua Corrida Castanho",
    file: "",
    pattern: {
      plankWidthPx: 24,
      plankLengthPx: 108,
      // uma cor só (colorA === colorB) -- a textura de "tábuas" vem
      // inteira da linha de junta (lineColor), igual na foto de
      // referência que o Douglas mandou (tábuas de tom uniforme,
      // separadas só por uma linha escura, sem ripa "zebrada").
      colorA: 0x6f5a42,
      colorB: 0x6f5a42,
      lineColor: 0x2c2115,
    },
  },
  {
    // 3ª foto de referência do Douglas: "e o mesmo do outro mas opcao
    // de pintar diferente" -- mesma mecânica de tábua emendada/
    // desalinhada da entrada acima, só que cada tábua sorteia (de
    // forma determinística, ver plankColorIndex em MainScene.ts) uma
    // cor de uma PALETA em vez de alternar só 2 cores por coluna --
    // fica com tábuas de tonalidades variadas, tipo piso de madeira de
    // reaproveitamento/demolição.
    id: "laminado-tabua-mesclada",
    category: "laminado",
    label: "Tábua Mesclada",
    file: "",
    pattern: {
      plankWidthPx: 24,
      plankLengthPx: 108,
      colorA: 0x6f5a42,
      colorB: 0x6f5a42,
      lineColor: 0x211a12,
      colors: [0x8a8079, 0xcda274, 0x6b5842, 0x7d7268],
    },
  },
];

export const FLOOR_CATALOG: FloorCatalogEntry[] = [...GENERATED_FLOOR_CATALOG, ...FACTORY_FLOOR_PATTERNS];

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
