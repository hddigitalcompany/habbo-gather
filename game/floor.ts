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

/**
 * Gradiente CSS (repeating-linear-gradient) que dá uma prévia razoável
 * de como um FloorPatternConfig vai ficar quando desenhado de verdade
 * (ver createFloorPatternGraphics em MainScene.ts) -- usado tanto no
 * preview ao vivo do formulário "Criar Piso" -> "Padrão"
 * (ItemEditor.tsx) quanto no losango da paleta de pintura da sala
 * (GameRoom.tsx, floor-swatch) -- MESMA função pros dois lugares, pra
 * nunca ficar um mostrando uma coisa e o outro mostrando outra.
 *
 * Não é (e não precisa ser) a matemática exata da tábua -- só CSS
 * simples o bastante pra rodar num <div>, sem reimplementar
 * across/along/plankColorIndex aqui.
 */
export function floorPatternCssGradient(pattern: {
  colorA: number;
  colorB: number;
  plankLengthPx?: number;
  lineColor?: number;
  colors?: number[];
}): string {
  if (pattern.colors && pattern.colors.length > 0) {
    // várias tábuas de tons diferentes (ver FloorPatternConfig.colors)
    // -- gradiente cíclico com TODAS as cores da paleta, uma prévia da
    // mescla sem sortear tábua por tábua feito o jogo faz de verdade.
    const stepPct = 100 / pattern.colors.length;
    const stops = pattern.colors
      .map((c, i) => {
        const css = hexToCss(c);
        return `${css} ${(i * stepPct).toFixed(2)}%, ${css} ${((i + 1) * stepPct).toFixed(2)}%`;
      })
      .join(", ");
    return `repeating-linear-gradient(63deg, ${stops})`;
  }
  if (pattern.plankLengthPx) {
    // tábua emendada de tom só (colorA === colorB no caso mais comum,
    // ex: "tábua corrida") -- um gradiente colorA/colorB sólido não
    // mostraria NENHUMA linha de junta quando as duas cores são iguais,
    // por isso aqui usa listras finas de lineColor por cima do tom
    // base, só pra indicar visualmente que tem tábua ali.
    const base = hexToCss(pattern.colorA);
    const line = hexToCss(pattern.lineColor ?? darkenHex(pattern.colorA));
    return `repeating-linear-gradient(63deg, ${line} 0, ${line} 2px, ${base} 2px, ${base} 16px)`;
  }
  // ripa contínua de 2 cores (comportamento original) -- alterna
  // colorA/colorB em faixas iguais.
  const a = hexToCss(pattern.colorA);
  const b = hexToCss(pattern.colorB);
  return `repeating-linear-gradient(63deg, ${a} 0, ${a} 6px, ${b} 6px, ${b} 12px)`;
}
