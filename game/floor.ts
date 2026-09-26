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
   * em MainScene.ts). Custom: a URL PÚBLICA COMPLETA do Storage
   * (cadastrado pelo Editor de Itens, aba "Criar Piso") -- já pronta pra
   * usar direto, sem prefixo nenhum (ver furnitureAssetUrl em
   * GameRoom.tsx, mesmo helper que já resolve os dois casos pro móvel,
   * reaproveitado aqui). */
  file: string;
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
