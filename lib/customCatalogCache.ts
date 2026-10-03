// Cache compartilhado dos catálogos CUSTOM (Editor de Itens) --
// mobília/piso/parede/porta/tom de pele/avatar/avatar padrão (ver
// supabase/migrations/000*_room_items.sql, 0006_avatar_items.sql etc).
//
// Pedido do Douglas (2/out): "o carregamento na pagina que aparece
// minha logo, faca o preupload do que precisa ali, porque quando eu
// entro na sala, 1/2s fica lento". Investigando o efeito de montagem de
// GameRoom.tsx (ver fetchAndRegisterCustomFurniture/Floor/Wall/Door/
// Skins/AvatarItems + fetchDefaultReferences, todas chamadas ali assim
// que a cena Phaser fica pronta): são 7 consultas ao Supabase, e TODAS
// essas tabelas (room_items, room_floor_items, room_wall_items,
// room_door_items, avatar_skins, avatar_default_reference, avatar_items)
// são GLOBAIS/da CONTA -- nenhuma delas filtra por sala (sem
// .eq("room_id", ...) nenhum) -- são o catálogo INTEIRO de itens custom
// já cadastrados, não algo específico da sala que o jogador tá entrando
// agora. Mesmo assim, antes dessa mudança, TODAS as 7 eram refeitas do
// ZERO toda vez que QUALQUER sala montava (inclusive reentrar na MESMA
// sala) -- a parede em especial tem uma segunda busca encadeada
// (room/walls) que só começa DEPOIS dela responder (mesmo esquema do
// piso/mobília, ver comentário grande em GameRoom.tsx), e o LED só
// começa depois da parede + room/walls, então o caminho mais longo da
// fila é 3 idas-e-voltas em série -- exatamente a lentidão de "1 a 2
// segundos" que o Douglas sentiu ao entrar numa sala, mesmo sozinho
// (não tem nada a ver com outros jogadores, bate com o "mac ficou
// lento, apenas um usuario" investigado antes).
//
// Esse módulo é a correção de raiz: UM cache compartilhado (módulo =
// singleton, sobrevive entre montagens de sala -- só é perdido com F5
// de verdade) pras 7 consultas, chamado:
//   1) BEM CEDO, assim que o Lobby aparece (ver Lobby.tsx) -- "preupload"
//      pedido pelo Douglas: o fetch já está em voo (ou já resolvido)
//      MUITO antes do jogador clicar "Entrar" numa sala, então quando
//      GameRoom.tsx monta, essas 7 consultas já não entram mais no
//      caminho crítico de carregamento daquela sala -- só sobra a parte
//      que É de verdade específica da sala (GET /room/furniture, /floor,
//      /walls, /leds, /doors, /shape, ver server/index.js).
//   2) De novo (reentrar numa sala, ou entrar numa segunda) -- reusa o
//      MESMO resultado já em cache, sem bater no Supabase de novo.
//   3) invalidateCustomCatalogCache() -- chamado só depois de editar um
//      item no Editor de Itens (ver onItemsChanged em GameRoom.tsx), pra
//      forçar uma busca fresca na próxima vez (o cache velho ficaria
//      sem o item recém-criado/editado).
//
// getCustomCatalogRows() é a ÚNICA função nova que os 7
// fetchAndRegisterCustom*/fetchDefaultReferences (GameRoom.tsx) passam a
// chamar -- a troca ali é só "de onde vêm data/error", a lógica de
// mapear cada linha pro tipo certo (FurnitureModelDef/FloorCatalogEntry/
// WallCatalogEntry/etc) continua 100% a mesma, no mesmo lugar de sempre
// (pedido do Douglas de sempre: UM engine real, sem implementação
// paralela -- isso NÃO duplica a transformação, só compartilha a
// BUSCA).
"use client";

import { getSupabaseBrowserClient } from "./supabase/client";

export type CustomCatalogRows = {
  roomItems: unknown[] | null;
  roomFloorItems: unknown[] | null;
  roomWallItems: unknown[] | null;
  roomDoorItems: unknown[] | null;
  avatarSkins: unknown[] | null;
  avatarDefaultReference: unknown[] | null;
  avatarItems: unknown[] | null;
};

const EMPTY_ROWS: CustomCatalogRows = {
  roomItems: null,
  roomFloorItems: null,
  roomWallItems: null,
  roomDoorItems: null,
  avatarSkins: null,
  avatarDefaultReference: null,
  avatarItems: null,
};

// null = ainda não tem nenhuma busca em voo/resolvida (nunca pedida, ou
// invalidada por invalidateCustomCatalogCache()). Guardar a PROMISE (não
// só o resultado) é o que garante que, se 6 chamadores pedirem ao mesmo
// tempo (exatamente o caso de GameRoom.tsx, que dispara as 6
// fetchAndRegisterCustom*() uma atrás da outra sem await entre elas),
// só UMA leva de 7 consultas sai pro Supabase -- todo mundo espera a
// MESMA promise.
let cachedRows: Promise<CustomCatalogRows> | null = null;

async function fetchAllRows(): Promise<CustomCatalogRows> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return EMPTY_ROWS;
  // allSettled (não all) -- uma tabela com erro (ex: RLS/migration
  // faltando numa conta mais nova) não pode derrubar as outras 6; cada
  // fetchAndRegisterCustom* já tratava isso sozinho antes (seu próprio
  // if (error || !data...) return), aqui é a MESMA tolerância, só que
  // compartilhada.
  const [roomItems, roomFloorItems, roomWallItems, roomDoorItems, avatarSkins, avatarDefaultReference, avatarItems] =
    await Promise.allSettled([
      supabase
        .from("room_items")
        .select(
          "id, label, category, art, display_width, icon_url, near_image_url, offset_x, offset_y, direction_offsets, direction_display_width, sittable, seat_offset_x, seat_offset_y, seat_direction_offsets, colors, footprint_cols, footprint_rows, footprint_by_direction, stackable, stack_surface_offset_y, extra_seats"
        ),
      supabase
        .from("room_floor_items")
        .select(
          "id, label, category, kind, file_url, plank_width_px, color_a, color_b, plank_length_px, line_color, colors, wood_grain, marble, tile_aligned"
        ),
      supabase
        .from("room_wall_items")
        .select(
          "id, label, height_px, thickness_px, brick_width_px, brick_height_px, brick_color, mortar_color, mortar_width_px, top_color, texture_kind, wood_grain, texture_image_url"
        ),
      supabase
        .from("room_door_items")
        .select("id, label, kind, art_left_closed, art_left_open, art_right_closed, art_right_open, display_width_px"),
      supabase.from("avatar_skins").select("id, label, gender, sheet_url, hex, colors"),
      supabase.from("avatar_default_reference").select("gender, head_sheet_url, body_sheet_url"),
      supabase.from("avatar_items").select("id, category, gender, label, skin_ids, sheet_url, colors"),
    ]);
  const rowsOf = (r: PromiseSettledResult<{ data: unknown[] | null; error: unknown }>): unknown[] | null =>
    r.status === "fulfilled" && !r.value.error ? r.value.data : null;
  return {
    roomItems: rowsOf(roomItems),
    roomFloorItems: rowsOf(roomFloorItems),
    roomWallItems: rowsOf(roomWallItems),
    roomDoorItems: rowsOf(roomDoorItems),
    avatarSkins: rowsOf(avatarSkins),
    avatarDefaultReference: rowsOf(avatarDefaultReference),
    avatarItems: rowsOf(avatarItems),
  };
}

/**
 * Busca (ou devolve a já em voo/resolvida) -- ponto de entrada pros 7
 * fetchAndRegisterCustom* e fetchDefaultReferences (GameRoom.tsx) E pro
 * preupload cedo do Lobby (ver prefetchCustomCatalogs logo abaixo).
 */
export function getCustomCatalogRows(): Promise<CustomCatalogRows> {
  if (!cachedRows) cachedRows = fetchAllRows();
  return cachedRows;
}

/**
 * "Preupload" pedido pelo Douglas -- chamado assim que o Lobby aparece
 * (bem antes de qualquer sala existir), só pra deixar a busca em voo
 * com antecedência. Resultado idêntico a getCustomCatalogRows(), o nome
 * diferente é só pra deixar a INTENÇÃO clara no call site (Lobby.tsx
 * não usa o resultado, só dispara a busca cedo -- GameRoom.tsx que usa
 * de verdade, via getCustomCatalogRows()).
 */
export function prefetchCustomCatalogs(): void {
  void getCustomCatalogRows();
}

/**
 * Chamado só depois de editar/criar/remover um item no Editor de Itens
 * (ver onItemsChanged, GameRoom.tsx) -- o cache antigo não tem o item
 * novo, então a PRÓXIMA chamada a getCustomCatalogRows() precisa ir ao
 * Supabase de novo. Só limpa (não busca na hora) -- quem chama em
 * seguida uma leva de fetchAndRegisterCustom*() já aciona a busca
 * fresca sozinho, e todas elas (chamadas juntas, sem await entre si)
 * continuam caindo na MESMA promise nova.
 */
export function invalidateCustomCatalogCache(): void {
  cachedRows = null;
}
