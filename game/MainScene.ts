// ver comentário em game/config.ts -- import default do phaser quebra
// no bundle do navegador, precisa ser namespace import
import * as Phaser from "phaser";
import {
  ROOM_FURNITURE,
  FurnitureDef,
  FurnitureType,
  FurnitureCatalogEntry,
  FURNITURE_ART,
  FURNITURE_MODELS,
  FURNITURE_TYPE_CATEGORY,
  CUSTOM_ITEM_TARGET_WIDTH,
  FurnitureSeatOffsetsMap,
  SeatTuningInfo,
  furnitureWorldPos,
  furnitureTextureKey,
  furnitureVariantTextureKey,
  furnitureTextureKeyFor,
  furnitureBlocksMovement,
  furnitureModelById,
  isFurnitureSittable,
  blockingFurnitureAt,
  resolveSeatOffset,
  seatOffsetGroupKey,
  seatOffsetGroupLabel,
} from "./furniture";
import {
  clampTile,
  tileToWorld,
  worldToTile,
  Direction,
  ISO_TILE_WIDTH,
  ISO_TILE_HEIGHT,
  GRID_COLS,
  GRID_ROWS,
  GAME_WIDTH,
  GAME_HEIGHT,
} from "./grid";
import { tileDiamondCorners, tileRangeCorners } from "./iso";
import {
  HAIR_CATALOG,
  DEFAULT_HAIR_ID,
  SKIN_CATALOG,
  DEFAULT_SKIN_ID,
  BEARD_CATALOG,
  DEFAULT_BEARD_ID,
  resolveBeardSkinId,
  ACCESSORY_CATALOG,
  DEFAULT_ACCESSORY_ID,
  OUTFIT_CATALOG,
  DEFAULT_OUTFIT_ID,
  resolveOutfitSkinId,
} from "./customization";
import { FLOOR_CATALOG, FloorCatalogEntry, FloorTileDef, floorTextureKey, floorWorldPos, floorEntryById } from "./floor";
import {
  AreaDef,
  AreaTileDef,
  areaTypeMeta,
  areaWorldPos,
  areaIdAtTile,
  areaTileBounds,
} from "./areas";

/**
 * Cena principal: renderiza a sala, o avatar local (controlado por
 * teclado) e os avatares remotos (posições recebidas via PartyKit).
 *
 * Esta classe só cuida de RENDERIZAÇÃO e INPUT. A sincronização de rede
 * (enviar/receber posições, WebRTC) é toda feita fora, em GameRoom.tsx,
 * que fala com esta cena através de:
 *   - scene.onLocalMove(x, y)      -> callback chamado a cada frame com a nova posição local
 *   - scene.upsertRemotePlayer(...) -> chamado quando um jogador remoto se move/entra
 *   - scene.removeRemotePlayer(id)  -> chamado quando um jogador remoto sai
 *   - scene.getLocalPosition()      -> lido para calcular distância/proximidade
 *
 * Arte do avatar: sistema de CAMADAS (layers) -- o "base" (corpo/pele)
 * é um spritesheet, e cada item de customização (cabelo, óculos, barba,
 * traje) é OUTRO spritesheet separado, desenhado empilhado por cima, na
 * mesma posição e MESMO frame que o base (ver LAYER_DRAW_ORDER mais
 * abaixo). Isso troca o sistema anterior de "um visual = uma imagem só"
 * pelo esquema modular pedido: cada peça pode ser adicionada/trocada
 * independente, e o boneco base fica padronizado. "Traje" é a roupa
 * inteira do pescoço pra baixo como UMA peça só (não separada em
 * camisa/calça/tênis) -- ver OutfitOption/OUTFIT_CATALOG em
 * customization.ts.
 *
 * Cada spritesheet de camada (base ou item) usa o MESMO layout de
 * frames -- 13 frames:
 *   0-2   down  (parado, passoA, passoB)
 *   3-5   left  (parado, passoA, passoB)
 *   6-8   right (parado, passoA, passoB) -- mesma arte de "left", espelhada
 *   9-11  up    (parado, passoA, passoB)
 *   12    sentado
 * (passoA/passoB alternam a cada passo dado, pra dar sensação real de
 * andar -- ver playWalk.)
 *
 * "base", "cabelo", "barba", "oculos" e "traje" já têm (ou têm estrutura
 * pronta pra receber) arte de verdade -- cada camada nova precisa ser
 * processada pelo mesmo pipeline (chroma-key, normalização, alinhamento)
 * do base, pra bater exatamente o mesmo frame/pose/escala.
 *
 * Movimento é por GRADE (tile a tile, estilo Gather/Habbo) — ver
 * game/grid.ts. Segurando uma direção, o boneco anda de quadrado em
 * quadrado (sem diagonal); ele só é considerado "parado" quando termina
 * de chegar num tile.
 *
 * Sentar é AUTOMÁTICO por móvel (ver game/furniture.ts), não por tecla:
 * o avatar só senta quando PARA totalmente em cima do tile de um móvel
 * sentável (não é mais raio de proximidade enquanto anda perto —
 * só dispara quando ele efetivamente chega e fica parado ali). Anda de
 * novo (qualquer tecla de direção) e levanta sozinho.
 */

// exportadas (junto com AVATAR_SCALE/AVATAR_FOOT_OFFSET_Y logo abaixo)
// pro preview "boneco real" do Editor de Itens (ItemEditor.tsx, pedido
// do Douglas) conseguir montar a MESMA proporção/âncora do jogo de
// verdade fora do Phaser (CSS puro) -- uma fonte só, em vez de duplicar
// esses números lá e correr o risco de desalinhar de novo numa próxima
// mudança de escala (foi o que quase aconteceu com AVATAR_REF_HEIGHT,
// ver comentário dele em ItemEditor.tsx).
export const FRAME_W = 200;
export const FRAME_H = 260;
// caractere ocupa ~210px de altura dentro do frame de 260 -> essa escala
// deixa ele com uns 135px de altura em tela (mesma PROPORÇÃO de antes:
// ~90px numa tela de 600px de altura -> ~135px numa de 900px, ver
// GAME_HEIGHT em grid.ts -- escalado 1.5x junto pra resolver o blur do
// avatar em zoom distante: a arte original tem 260px de altura por
// frame, então essa escala aproveita mais dela em vez de encolher quase
// pela metade e depois esticar de novo pra tela real -- pedido do
// Douglas, ver conversa sobre zoom borrando "principalmente o avatar".
// Chegou a ser testado em 2x (0.86), mas pesou demais na performance --
// 1.5x é o meio-termo, ver comentário de GAME_WIDTH/GAME_HEIGHT em
// grid.ts).
export const AVATAR_SCALE = 0.645;

// o container do boneco fica ancorado no CENTRO do tile (tileToWorld) --
// isso é o que worldToTile/clampTile/movimento usam pra saber em que
// tile ele está, não pode mudar. Só que desenhar o "pé" (origem das
// sprites) bem EM CIMA desse ponto (offset 0) deixava o boneco com os
// pés "flutuando" no meio do quadrado visualmente -- por isso as
// sprites (e o label do nome) são desenhadas com um offset PRA BAIXO
// dentro do container: puramente visual, não mexe na posição lógica
// usada pro grid/colisão/sentar.
export const AVATAR_FOOT_OFFSET_Y = 21;

// [parado, passoA, passoB] -- passoA/passoB alternam a cada passo dado
// (ver playWalk), não por tempo -- assim funciona igual pra um pulo de
// um quadrado só ou pra caminhada contínua.
const WALK_FRAMES: Record<"down" | "left" | "right" | "up", [number, number, number]> = {
  down: [0, 1, 2],
  left: [3, 4, 5],
  right: [6, 7, 8],
  up: [9, 10, 11],
};

// sentado tem uma pose por direção -- ainda falta uma pose SENTADA de
// costas de verdade (essa leva só trouxe frente/esquerda/direita), então
// "up" usa por enquanto a pose de PÉ de costas (frame 9, mesma da
// caminhada) como aproximação. Funciona porque nesse caso o móvel é
// desenhado NA FRENTE do boneco (ver DEPTH_* e sitAt) -- só a cabeça
// aparece por cima do encosto, então os detalhes de "sentado" do corpo
// (que ficariam escondidos mesmo) não fazem diferença visual.
const SENTADO_FRAMES: Record<Direction, number> = {
  down: 12,
  left: 13,
  right: 14,
  up: WALK_FRAMES.up[0],
};

/**
 * Camadas de customização, na ordem em que são desenhadas (primeiro =
 * mais atrás, último = mais na frente).
 *
 * "traje" fica ATRÁS de "base": "base" (tom de pele) é só a
 * cabeça/busto (mesmo enquadramento do Avatar Padrão), e "traje" é
 * quem dá o corpo inteiro (tronco/braços/pernas) -- pedido do
 * Douglas: "a gente criou pro jogo cabeça e traje, o corpo padrão não
 * vai pro jogo" / "coloca a cabeça acima do traje e pronto". "barba"
 * fica NA FRENTE de "cabelo" (barba não pode ficar escondida atrás do
 * cabelo); "oculos" fica na frente de tudo.
 */
const LAYER_DRAW_ORDER = [
  "traje",
  "base",
  "cabelo",
  "barba",
  "oculos",
] as const;
type LayerKey = (typeof LAYER_DRAW_ORDER)[number];

/**
 * Arquivo de cada camada. Só "base" existe por enquanto -- as outras
 * ficam `null` (não carrega, não desenha) até a arte chegar. Pra
 * "adicionar" um item, basta trocar o `null` pelo nome do arquivo (já
 * processado pelo pipeline de chroma-key/normalização) em
 * `public/assets/`.
 *
 * "cabelo", "base", "barba", "oculos" e "traje" são DIFERENTES das
 * outras -- não são mais um arquivo único, e sim um CATÁLOGO de opções
 * (ver game/customization.ts / HAIR_CATALOG, SKIN_CATALOG,
 * BEARD_CATALOG, ACCESSORY_CATALOG, OUTFIT_CATALOG), porque dá pra
 * trocar ao vivo (editor de personagem, ver setLocalHairId/
 * setLocalSkinId/setLocalBeardId/setLocalAccessoryId/setLocalOutfitId).
 * O valor `null` aqui continua só pra manter o record completo/tipado --
 * a arte de verdade é carregada à parte, ver preload() e createAvatar().
 */
const LAYER_TEXTURE_FILE: Record<LayerKey, string | null> = {
  base: null,
  traje: null,
  barba: null,
  cabelo: null,
  oculos: null,
};

/** Chave da textura no Phaser pra uma camada (ex: "cabelo" -> "avatar-cabelo"). */
function layerTextureKey(layer: LayerKey): string {
  return `avatar-${layer}`;
}

/** Chave da textura no Phaser pra UMA OPÇÃO de cabelo do catálogo (ver
 * HAIR_CATALOG). Exportada (ver comentário de skinTextureKey abaixo)
 * pra GameRoom.tsx montar a mesma chave pra um cabelo CUSTOM. */
export function hairTextureKey(hairId: string): string {
  return `avatar-cabelo-${hairId}`;
}

/** Chave da textura no Phaser pra UM TOM de pele do catálogo (ver
 * SKIN_CATALOG). Exportada (diferente das outras *TextureKey da vizinhança
 * antes dessa mudança) porque GameRoom.tsx precisa montar essa mesma chave
 * pra carregar um tom CUSTOM em tempo de execução (ver
 * loadCustomAvatarLayerTextures acima e fetchAndRegisterCustomSkins,
 * GameRoom.tsx). */
export function skinTextureKey(skinId: string): string {
  return `avatar-base-${skinId}`;
}

/** Chave da textura no Phaser pra UMA OPÇÃO de barba NUM TOM de pele
 * específico (ver BEARD_CATALOG/resolveBeardSkinId) -- igual ao traje,
 * a arte varia pelos dois, então a chave carrega os dois ids. Exportada
 * pelo mesmo motivo de skinTextureKey acima -- ver
 * fetchAndRegisterCustomAvatarItems em GameRoom.tsx, uma barba CUSTOM
 * pode cobrir vários tons (skin_ids), cada um vira uma chave própria
 * aqui apontando pra MESMA folha. */
export function beardTextureKey(beardId: string, resolvedSkinId: string): string {
  return `avatar-barba-${beardId}-${resolvedSkinId}`;
}

/** Chave da textura no Phaser pra UMA OPÇÃO de acessório do catálogo (ver
 * ACCESSORY_CATALOG). Exportada pelo mesmo motivo de skinTextureKey acima. */
export function accessoryTextureKey(accessoryId: string): string {
  return `avatar-oculos-${accessoryId}`;
}

/** Chave da textura no Phaser pra UM TRAJE NUM TOM de pele específico (ver
 * OUTFIT_CATALOG/resolveOutfitSkinId) -- a arte varia pelos dois, então a
 * chave carrega os dois ids. Exportada pelo mesmo motivo de
 * skinTextureKey/beardTextureKey acima. */
export function outfitTextureKey(outfitId: string, resolvedSkinId: string): string {
  return `avatar-traje-${outfitId}-${resolvedSkinId}`;
}

// profundidade (z-order): a "fronteira" de um móvel é a borda de CIMA da
// própria fileira dele (onde o tile do móvel começa) -- o boneco fica
// por TRÁS enquanto seu Y não cruzou essa borda (ainda tá na fileira de
// CIMA, onde só a parte que "vaza" do móvel aparece), e passa pra FRENTE
// assim que entra na fileira do móvel (ou below). Comparar direto contra
// essa borda (em vez da base do móvel) é o que faz a troca acontecer
// bem quando o boneco cruza a linha entre as duas fileiras -- inclusive
// no MEIO de um passo (andando continuamente) -- e não só quando ele já
// terminou de chegar.
//
// IMPORTANTE: a fronteira usa o TILE LÓGICO do móvel (f.col/f.row), não
// a posição visual dele (furnitureWorldPos, que pode ter um baseOffsetY
// de ajuste fino -- ver furniture.ts) -- assim reposicionar a arte pra
// ficar bonita não muda em que tile a troca de profundidade acontece,
// que continua sendo sempre o vértice de TRÁS (o de cima) do losango
// onde o móvel está ancorado. No isométrico precisa do col JUNTO com o
// row (não só do row como na grade quadrada de antes) -- y agora
// depende da SOMA col+row, então dois móveis na mesma "fileira" mas em
// colunas diferentes já não ficam mais na mesma altura de tela.
const DEPTH_FURNITURE_ROW_HEIGHT = ISO_TILE_HEIGHT;

// exceção: móveis "flat" (tapete, por exemplo -- sem altura de verdade,
// não faz sentido o boneco passar "por trás" deles) ficam sempre atrás
// de tudo, feito decoração colada no chão, fora desse jogo de
// profundidade -- ver FurnitureDef.flat em furniture.ts.
const DEPTH_FLAT_FURNITURE = -1_000_000;

// piso pintado (ver game/floor.ts) fica ATRÁS até de um tapete "flat" --
// é o próprio chão, tudo o mais (móvel flat incluso) fica em cima dele.
const DEPTH_FLOOR = -2_000_000;

// tinta de área (ver game/areas.ts) fica ENTRE o piso e a mobília "flat" --
// é um "verniz" por cima do chão marcando a zona (mesa privada/sala),
// então precisa aparecer ACIMA do piso pintado, mas ainda atrás de
// qualquer móvel (mesmo um tapete flat) pra não competir visualmente com
// a mobília de verdade que fica dentro da área.
const DEPTH_AREA = -1_500_000;

// hitbox de hover do nome do dono (ver updateAreaHoverLabels) fica logo
// acima da tinta, e o próprio label (texto) mais acima ainda -- só
// precisam ficar atrás do boneco/móvel (que usam profundidade dinâmica
// bem maior, perto de 0+), nunca vão colidir de verdade.
const DEPTH_AREA_HOVER = DEPTH_AREA + 1;
const DEPTH_AREA_LABEL = DEPTH_AREA + 2;

// destaque leve do tile sob o mouse fora do modo de edição (ver
// roomHoverGraphics/handleRoomPointerMove) -- acima do piso/tinta de área
// (senão ficaria escondido debaixo deles), mas ainda abaixo de móvel/
// boneco (DEPTH_FLAT_FURNITURE e a profundidade dinâmica por fileira, que
// começam em -1_000_000 e sobem) -- assim o destaque nunca "cobre" quem
// está em cima do tile, só o piso vazio ao redor.
const DEPTH_ROOM_TILE_HOVER = DEPTH_AREA_LABEL + 1;

// pedido do Douglas: "quando o avatar entrar dentro de um ambiente,
// area, o resto do mapa tem que esmaecer, e apenas os mobis que estao
// dentro daquela area ficam na tonalidade normal, dando a sensacao de
// luz acesa e luz esmaecido no que ta fora, igual o gather" -- ver
// updateAreaDim abaixo. Fica ACIMA de TUDO (piso/área/móvel/boneco, que
// usam profundidade em torno de -2M..+900) -- um "véu" preto
// semitransparente cobrindo o mapa INTEIRO fora do retângulo da área
// onde o jogador LOCAL está agora (dentro do retângulo, nada é
// desenhado ali -- por isso "acende"). alpha 0.45 tenta bater na
// proporção visual do Gather de verdade (nem clarinho demais, que não
// dava pra notar, nem preto total, que escondia os móveis de fora por
// completo -- ainda dá pra reconhecer o que tem lá, só mais escuro).
const DEPTH_AREA_DIM = 10_000_000;
const AREA_DIM_ALPHA = 0.45;

// a arte de fundo da sala (textura "room", ver create()) precisa ficar
// AINDA MAIS atrás que o piso pintado -- sem isso ela ficava com
// profundidade padrão (0), ou seja, na FRENTE do piso (DEPTH_FLOOR é
// negativo!), e cobria completamente qualquer quadrado pintado: o piso
// era desenhado certinho, na posição certa, com a textura certa, só que
// sempre escondido atrás do fundo opaco da sala -- por isso nunca
// aparecia nada pintado, por mais que o clique/arrasto funcionasse.
const DEPTH_ROOM_BACKGROUND = -3_000_000;

/** Fronteira de profundidade de um móvel a partir do TILE lógico dele (col/row, não da posição visual) -- ver comentário acima. */
function furnitureDepthForTile(col: number, row: number): number {
  return tileToWorld(col, row).y + ISO_TILE_HEIGHT / 2 - DEPTH_FURNITURE_ROW_HEIGHT;
}

// móveis "de vidro" (FurnitureDef.transparent) desenham com essa opacidade
// em vez de opacos -- quem fica por trás (boneco, outro móvel, ordenado
// pela mesma profundidade acima) continua parcialmente visível através.
const GLASS_ALPHA = 0.55;

// "fantasma" que acompanha o cursor com o item selecionado na paleta (ver
// refreshCatalogGhost) -- opacidade BAIXA o suficiente pra ficar claro que
// ainda não foi colocado de verdade (é só um preview), mas alta o
// suficiente pra dar pra ver cor/modelo direitinho antes de clicar
// (pedido do Douglas).
const CATALOG_GHOST_ALPHA = 0.5;

/** Profundidade do boneco -- é só o próprio Y dele (ancorado no centro do tile), sem ajuste nenhum: compara direto contra furnitureDepthForTile(). */
function avatarDepthForY(y: number): number {
  return y;
}

// grade e highlight do editor de espaço (ver setEditMode) sempre por
// CIMA de tudo (móvel, boneco) -- é UI de edição, não faz parte da
// cena "de verdade".
const EDIT_UI_DEPTH = 10_000_000;

// cor do highlight de hover no editor: verde = tile livre (dá pra
// colocar), vermelho = ocupado (tile já tem âncora de outro móvel --
// clicar ali remove o item em vez de colocar um novo).
const EDIT_HOVER_COLOR_FREE = 0x59d97a;
const EDIT_HOVER_COLOR_OCCUPIED = 0xd95959;

// fonte usada em todo texto desenhado DENTRO do canvas do jogo
// (plaquinha de nome, label de área/assento) -- mesma pilha do resto
// do site (ver body em app/globals.css), que resolve pra San
// Francisco no Mac (-apple-system) e pro equivalente nativo em
// Windows/Linux, em vez de cair no "Courier" padrão do Phaser (sem
// fontFamily) ou em genéricos tipo "sans-serif"/"monospace" que o
// navegador escolhe por conta própria, sem bater com a fonte do
// resto da UI. Pedido do Douglas: "deixe as fontes iguais a fonte do
// Mac".
const GAME_FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

// bolinha de status (foco/ausente/online) ao lado do nome, dentro do
// jogo -- a COR vem sempre de fora (GameRoom.tsx, ver STATUS_COLORS),
// pra não duplicar a paleta aqui; a cena só sabe desenhar um círculo.
// (escalado 1.5x junto com GAME_WIDTH/GAME_HEIGHT/AVATAR_SCALE em
// grid.ts/acima, depois reduzido mais 10% -- pedido do Douglas: "o nome
// pode diminuir, 10%" -- proporção base idêntica à aprovada antes, só
// um pouco mais discreta agora.)
const STATUS_DOT_RADIUS = 3.375;
const STATUS_DOT_GAP = 5.4;

// plaquinha de nome (dot + texto) -- desenhada como uma "pill" de
// cantos arredondados (Graphics, ver drawNameplateBg) em vez do
// retângulo reto que o backgroundColor do Text desenharia sozinho, pra
// parecer um card de verdade e não uma caixa de debug. Paleta igual ao
// resto da UI (ver .seat-tuning-panel/.color-picker-label em
// globals.css -- roxo bem escuro, borda um tom mais claro, texto
// lavanda clarinho em vez de branco puro). Tamanho ajustado pra ficar
// mais parecido com o do Gather de verdade (print que o Douglas
// mandou) -- plaquinha bem discreta/fina, não um card grande chamando
// atenção -- por isso fonte e preenchimento um pouco menores do que a
// primeira versão.
// (escalados 1.5x junto com a resolução interna, depois reduzidos mais
// 10%, mesmo motivo do STATUS_DOT_RADIUS/GAP acima.)
const NAMEPLATE_PAD_X = 6.75;
const NAMEPLATE_PAD_Y = 2.7;
const NAMEPLATE_RADIUS = 8;
const NAMEPLATE_BG_COLOR = 0x120a1f;
const NAMEPLATE_BG_ALPHA = 0.88;
const NAMEPLATE_BORDER_COLOR = 0x3a2b57;
const NAMEPLATE_BORDER_ALPHA = 0.9;
// resolução PRÓPRIA do texto (independente da resolução interna do
// jogo, que fica travada em 800x600 -- ver game/config.ts) -- sem
// isso, o Scale.FIT esticando esse canvas pra preencher a tela real
// (bem maior que 800x600 numa tela grande) deixa a fonte serrilhada/
// pixelada, mesmo com antialias:true na config (que só afeta as
// SPRITES, não o texto renderizado à parte pelo Text). Valor alto e
// fixo porque é só uma string curta -- barato de sobra.
const NAMEPLATE_TEXT_RESOLUTION = 4;

// largura MÁXIMA (px, medida na mesma unidade da fonte -- ver
// fitNameplateText) do texto do nome -- nome maior que isso é cortado
// com "…" no final em vez de deixar o card crescer sem limite (pedido
// do Douglas: "passou do limite, quero '...' no final"). Escalado 1.5x
// junto com a resolução interna, depois reduzido mais 10% junto com o
// resto da plaquinha.
const NAMEPLATE_MAX_TEXT_WIDTH = 162;

type Activity = "idle" | "sentado";

/** Ferramenta de piso selecionada no editor (ver selectFloorTool) --
 * "paint" pinta o modelo escolhido, "erase" apaga (volta pro fundo
 * padrão da sala), null = nenhuma ferramenta armada (clique não faz
 * nada nos tiles). */
type FloorTool = { kind: "paint"; entry: FloorCatalogEntry } | { kind: "erase" } | null;

/** Ferramenta de área selecionada no editor (ver selectAreaTool) -- MESMA
 * ideia da FloorTool acima (paint pinta a área escolhida, erase apaga,
 * null = nada armado), só que "paint" leva o ID de uma área JÁ CRIADA na
 * lista (ver AreaDef em game/areas.ts) em vez de um FloorCatalogEntry --
 * não dá pra pintar sem antes criar a área na lista (ver createArea em
 * GameRoom.tsx). */
type AreaTool = { kind: "paint"; areaId: string } | { kind: "erase" } | null;

// depois de levantar (por movimento), ignora o auto-sentar por um
// instante -- senão sentaria de novo assim que parasse ainda em cima
// do mesmo tile da cadeira.
const STAND_COOLDOWN_MS = 350;

// tempo pra andar UM quadrado (grade tile a tile, não pixel livre)
const STEP_DURATION_MS = 180;

// zoom da câmera (controles "estilo Gather" no canto do mapa, ver
// MapControls em GameRoom.tsx) -- DEFAULT_ZOOM_LEVEL (1) é o zoom
// inicial, que mostra a sala inteira encostada nas bordas da tela
// (mesmo comportamento de sempre, ver game/config.ts: resolução
// interna 800x600 == GRID_ORIGIN/GRID_COLS/GRID_ROWS ocupando toda a
// área visível). MIN_ZOOM_LEVEL é o piso do botão "-" -- pedido do
// Douglas pra dar mais 3 cliques de zoom out (3 * ZOOM_STEP) além do
// padrão, então abaixo de 1 mesmo sobra fundo (backgroundColor do
// config.ts) nas bordas -- é o efeito "mais distante" pedido, não um
// bug. Exportados pra GameRoom.tsx habilitar/desabilitar os botões
// "+"/"-" no limite, sem duplicar os números aqui.
const ZOOM_STEP = 0.25;
export const DEFAULT_ZOOM_LEVEL = 1;
export const MIN_ZOOM_LEVEL = DEFAULT_ZOOM_LEVEL - 3 * ZOOM_STEP;
export const MAX_ZOOM_LEVEL = 2;

// arrastar a câmera (clampCameraScroll, chamado depois de TODA mudança
// de scroll -- arrastar com o mouse, zoom, recentralizar) não tem
// limite nenhum -- já teve (ver histórico do git), mas o Douglas
// reportou "dois limites nas laterais" (os dois regimes de clamp
// batendo em zooms diferentes) e pediu pra tirar.

export default class MainScene extends Phaser.Scene {
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: Record<"up" | "down" | "left" | "right", Phaser.Input.Keyboard.Key>;

  /**
   * true só a partir da ÚLTIMA linha de create() (ver comentário grande lá)
   * -- diferente de `game.events.once(Phaser.Core.Events.READY, ...)`, que
   * GameRoom.tsx usava antes e dispara ANTES até do preload() da cena
   * começar (checado direto no código-fonte do Phaser). GameRoom.tsx lê
   * isso (mais o evento "scene-ready" que create() emite na mesma hora)
   * pra só buscar/aplicar o piso, a mobília e a área salvos DEPOIS que o
   * catálogo inteiro (preload()) já carregou de verdade -- sem isso, a
   * corrida com o servidor de tempo real (mais rápido, local) fazia
   * loadSavedFloor/loadSavedFurniture rodarem com textura de catálogo
   * ainda faltando, toda vez que a página carregava (bug do "quadrado
   * preto"/item sumido reportado pelo Douglas).
   */
  sceneReady = false;

  // trava o movimento por teclado enquanto um campo de texto do React
  // (nome/bio/instagram/chat) está focado -- ver setMovementLocked,
  // chamado pelo listener focusin/focusout em GameRoom.tsx. Ignora o
  // estado "isDown" dos Keys do Phaser direto (que continuam sendo
  // atualizados pelo browser mesmo com o campo focado), em vez de
  // tentar desligar o KeyboardPlugin inteiro -- mais simples e sem
  // risco de tecla "grudar" pressionada ao reativar.
  private movementLocked = false;

  // ignora clique em QUALQUER boneco enquanto o card de perfil (base ou
  // editando) está aberto por cima do jogo -- ver setAvatarClicksLocked,
  // chamado pelo GameRoom.tsx toda vez que profileCard muda. Defensivo:
  // sem isso, um clique na UI do React que por algum motivo alcance o
  // canvas por baixo reabriria/resetaria o card sem querer.
  private avatarClicksLocked = false;

  private localContainer!: Phaser.GameObjects.Container;
  private remoteContainers: Map<string, Phaser.GameObjects.Container> = new Map();

  private lastSent = 0;

  private localActivity: Activity = "idle";
  private sitCooldownUntil = 0;
  private seatedAt: FurnitureDef | null = null;

  // estado do passo atual na grade (tile a tile)
  private stepping = false;
  private stepFrom = { x: 0, y: 0 };
  private stepTo = { x: 0, y: 0 };
  private stepElapsed = 0;
  private stepDir: Direction = "down";

  /** Definido de fora (GameRoom.tsx) após a cena ficar pronta. */
  onLocalMove?: (x: number, y: number) => void;

  localColor = "#5c9bff";
  localName = "Você";
  localStatusColor = "#4fd97a";
  // traje inicial do boneco local (ver pickRandomOutfitId em
  // GameRoom.tsx) -- igual localName/localStatusColor acima: guardado
  // aqui pra createAvatar() ler na hora de montar o boneco (ver ali
  // embaixo), porque setLocalOutfitId costuma ser chamado (pelo
  // "READY" da cena, GameRoom.tsx) ANTES de create() ter rodado --
  // nesse momento ainda não existe localContainer/outfitSprite pra
  // trocar a textura na hora, só dá pra deixar guardado aqui mesmo.
  localOutfitId: string = DEFAULT_OUTFIT_ID;

  // --- câmera (zoom/arrastar pra olhar ao redor, ver MapControls em
  // GameRoom.tsx: botão de centralizar + zoom "+"/"-") -- arrastar fica
  // DESLIGADO durante o editor de espaço (this.editMode), senão brigaria
  // com o clique/arrasto de colocar móvel (ver handleEditPointerDown).
  private isPanningCamera = false;
  private panStart = { x: 0, y: 0 };
  private panStartScroll = { x: 0, y: 0 };

  // --- editor de espaço ("Editar espaço", ver setEditMode) ---------
  // itens colocados pelo editor ainda não são "de verdade" (não entram
  // em ROOM_FURNITURE) -- ver comentário grande em draftFurniture logo
  // abaixo: hoje salva sozinho (POST /room/furniture), não gera mais
  // código pra colar à mão (game/furnitureCodegen.ts não é mais usado).
  private editMode = false;
  private selectedCatalogEntry: FurnitureCatalogEntry | null = null;
  // draftFurniture/draftSprites guardam TODA a mobília ADICIONAL da sala
  // (tanto a já salva no servidor, carregada por loadSavedFurniture,
  // quanto a colocada agora nesta sessão pelo editor -- MESMO Map pros
  // dois, igual draftFloor/draftFloorSprites já fazem pro piso). Já salva
  // sozinha (ver POST /room/furniture em server/index.js, autosave em
  // GameRoom.tsx) -- ROOM_FURNITURE (furniture.ts) continua existindo à
  // parte, sempre desenhado, mobília "de fábrica" fixa no código.
  private draftFurniture: Map<string, FurnitureDef> = new Map();
  private draftSprites: Map<string, Phaser.GameObjects.Image> = new Map();
  private gridGraphics?: Phaser.GameObjects.Graphics;
  private hoverGraphics?: Phaser.GameObjects.Graphics;
  // "fantasma" (ver refreshCatalogGhost) do item selecionado na paleta,
  // seguindo o cursor -- null quando nenhum item de móvel está selecionado.
  private catalogGhostSprite: Phaser.GameObjects.Image | null = null;

  // --- clique-pra-andar + destaque de tile fora do modo de edição
  // (pedido do Douglas: "pro mouse fazer o boneco andar" + "o piso
  // aparecer um elo de seleção enquanto a pessoa anda com o mouse pela
  // tela, bem leve") -----------------------------------------------------
  // destaque BEM leve do tile sob o mouse em uso normal (não edição) --
  // separado do hoverGraphics do editor de espaço (esse aqui não some
  // fora da grade de edição, e usa um alfa bem mais discreto, ver
  // handleRoomPointerMove).
  private roomHoverGraphics?: Phaser.GameObjects.Graphics;
  // fila de direções (um passo por tile) que update() consome sozinho, um
  // por frame, igual ao passo por teclado (ver startStep) -- computada por
  // BFS em computeWalkPath ao clicar num tile (handleRoomPointerDown).
  // Uma tecla de seta/WASD apertada CANCELA a fila na hora e devolve o
  // controle pro teclado (ver update()) -- clique-pra-andar nunca briga
  // com o movimento manual.
  private walkQueue: Direction[] = [];

  // --- ferramenta "Mover" do editor de espaço (ver selectMoveTool) --
  // pedido do Douglas: até aqui, clicar num item já colocado só APAGAVA
  // (ver handleEditPointerDown) -- não dava pra reposicionar sem
  // apagar e colocar de novo do zero (perdendo cor/modelo escolhido).
  // Com a ferramenta ligada, o PRIMEIRO clique num item pega ele
  // (movingFurnitureId guarda qual) em vez de apagar; o clique
  // SEGUINTE num tile livre solta ali (ou cancela, clicando de novo no
  // tile de origem). Mutuamente exclusiva com as outras ferramentas
  // (catálogo/piso/área), mesmo padrão de selectFloorTool/selectAreaTool.
  private moveToolActive = false;
  private movingFurnitureId: string | null = null;
  // ferramenta "Apagar" (ver selectDeleteTool) -- pedido do Douglas: um
  // botão explícito pra apagar item direto no espaço (fora da lista de
  // linha do painel), em vez do clique-em-cima-do-item apagar sozinho
  // sem aviso em qualquer aba de móvel (comportamento antigo, fácil de
  // apagar sem querer).
  private deleteToolActive = false;

  /** Definido de fora (GameRoom.tsx) -- chamado toda vez que um item é colocado/removido/carregado no editor, pra React manter a lista/autosave em dia. */
  onDraftChange?: (items: FurnitureDef[]) => void;

  // --- ajuste de assento por MODELO ("Assento" no editor de espaço,
  // ver resolveSeatOffset em game/furniture.ts) ----------------------
  // mapa carregado do servidor (ver setSeatOffsets, chamado pelo React
  // junto com loadSavedFurniture assim que GET /room/furniture responde)
  // -- só os grupos JÁ ajustados manualmente entram aqui, o resto usa o
  // padrão genérico (ver resolveSeatOffset).
  private seatOffsets: FurnitureSeatOffsetsMap = {};
  // true só enquanto o Douglas liga o "Assento" no editor (ver
  // setSeatTuningMode) -- com isso ligado E sentado, as setas de direção
  // NÃO levantam mais (ver update()), viram nudge fino do assento (ver
  // os listeners "keydown-LEFT" etc, registrados no create()).
  private seatTuningActive = false;
  /** Definido de fora (GameRoom.tsx) -- emitido toda vez que o estado do ajuste de assento muda (sentou/levantou/nudge), null quando não há nada pra ajustar agora (não sentado, ou modo desligado). */
  onSeatTuningChange?: (info: SeatTuningInfo | null) => void;
  /** Definido de fora (GameRoom.tsx) -- emitido só pelo botão "Redefinir" (ver resetSeatOffset), separado do onSeatTuningChange acima porque aqui o React precisa APAGAR a entrada (não só atualizar x/y): sem isso o valor salvo continuaria "travado" no que já era o padrão, em vez de voltar a acompanhar o padrão se ele mudar depois. */
  onSeatOffsetReset?: (groupKey: string, facing: Direction) => void;
  /** Definido de fora (GameRoom.tsx) -- emitido só por um NUDGE de verdade (ver nudgeSeatOffset), nunca só por sentar/levantar/ligar o modo (isso é só onSeatTuningChange, puramente de EXIBIÇÃO). É esse aqui que o React usa pra atualizar o mapa que autosalva -- sentar numa cadeira com o modo ligado não pode sozinho "gravar" o valor default como se fosse um ajuste manual. */
  onSeatOffsetChange?: (groupKey: string, facing: Direction, x: number, y: number) => void;

  // --- piso do editor de espaço (aba "Piso", ver selectFloorTool) --
  // draftFloor/draftFloorSprites guardam TODO o piso da sala (tanto o já
  // salvo no servidor, carregado por loadSavedFloor, quanto o pintado
  // agora nesta sessão -- tudo no MESMO Map, não tem mais uma lista
  // "fixa" separada), chave "col,row" (um piso por tile, não por id --
  // pintar de novo em cima troca o estilo daquele quadrado em vez de
  // empilhar) e o clique pinta/arrasta em vez de só colocar um item por
  // clique (ver paintFloorAt/handleEditPointerDown).
  private selectedFloorTool: FloorTool = null;
  private draftFloor: Map<string, FloorTileDef> = new Map();
  private draftFloorSprites: Map<string, Phaser.GameObjects.Image> = new Map();
  private isPaintingFloor = false;
  private lastPaintedFloorKey: string | null = null;

  /** Definido de fora (GameRoom.tsx) -- mesma ideia do onDraftChange, mas pro piso. */
  onDraftFloorChange?: (items: FloorTileDef[]) => void;

  /** Definido de fora (GameRoom.tsx) -- chamado ao clicar em QUALQUER avatar (local ou remoto), pra abrir o card de perfil. */
  onAvatarClick?: (info: { playerId: string; isLocal: boolean; name: string; color: string }) => void;

  // --- área do editor de espaço (aba "Área", ver selectAreaTool) --
  // MESMO esquema do piso (draftFloor acima): draftArea/draftAreaSprites
  // guardam TODA a área da sala (salva no servidor + pintada agora nesta
  // sessão, tudo no mesmo Map, chave "col,row" -- um tipo de área por
  // tile, pintar de novo em cima troca o tipo em vez de empilhar).
  private selectedAreaTool: AreaTool = null;
  private draftArea: Map<string, AreaTileDef> = new Map();
  private draftAreaSprites: Map<string, Phaser.GameObjects.Polygon> = new Map();
  private isPaintingArea = false;
  private lastPaintedAreaKey: string | null = null;

  /** Definido de fora (GameRoom.tsx) -- mesma ideia do onDraftFloorChange, mas pra área. */
  onDraftAreaChange?: (items: AreaTileDef[]) => void;

  // lista de áreas CRIADAS (nome + tipo, ver AreaDef em game/areas.ts) --
  // alimentada de fora pelo setAreaDefs (GET /room/areas inicial + toda
  // vez que a lista muda no editor). Um tile pintado (draftArea) só
  // desenha/conta se a área dele ainda estiver aqui -- ver
  // addAreaTileRect/loadSavedAreas.
  private areaDefs: Map<string, AreaDef> = new Map();
  private areaBorderGfx: Phaser.GameObjects.Graphics[] = [];

  // dono atual de cada área "mesa-privada" (areaId -> quem tomou posse
  // clicando no botão, ver onClaimArea/onReleaseArea) -- só mesas
  // privadas entram aqui, "sala" nunca tem dono. Estado puramente
  // externo: só muda via setAreaOwner (broadcast "area-owner" do
  // servidor), NUNCA derivado de quem tá sentado onde. playerId "local"
  // identifica o PRÓPRIO jogador (ver onAreaOwnerClick/isLocal).
  private areaOwnerByAreaId: Map<string, { playerId: string; name: string }> = new Map();

  // "véu" de escurecer fora da área onde o LOCAL está agora (ver
  // updateAreaDim/DEPTH_AREA_DIM) -- UM retângulo preto cobrindo o mapa
  // inteiro, com uma MÁSCARA (areaDimMaskGfx, invertida) recortando o
  // "buraco" aceso: o retângulo da área + a silhueta de tela de cada
  // móvel que esteja de pé num tile dela (ver addFurnitureHole em
  // updateAreaDim -- sem isso, um móvel desenhado maior que 1 tile de
  // altura, ex: poltrona gamer, ficava com o topo "cortado" pelo véu na
  // borda da área mesmo estando DENTRO dela). areaDimAreaId guarda a
  // área usada pra desenhar da ÚLTIMA vez, só pra updateAreaDim não
  // redesenhar à toa todo frame quando o jogador não mudou de área.
  private areaDimSprites: Phaser.GameObjects.Rectangle[] = [];
  private areaDimMaskGfx?: Phaser.GameObjects.Graphics;
  private areaDimAreaId: string | null | undefined = undefined;

  // sprite de cada móvel FIXO (ROOM_FURNITURE, ver create() logo abaixo)
  // -- guardado só pra updateAreaDim conseguir ler o tamanho/posição
  // real na TELA dele (getBounds()) na hora de recortar a máscara do véu.
  // A mobília colocada pelo editor já tem isso em draftSprites.
  private roomFurnitureSprites: Map<string, Phaser.GameObjects.Image> = new Map();

  /** Definido de fora (GameRoom.tsx) -- chamado ao clicar em "Tomar posse" numa mesa privada sem dono. */
  onClaimArea?: (areaId: string) => void;

  /** Definido de fora (GameRoom.tsx) -- chamado ao clicar no PRÓPRIO nome numa mesa privada da qual sou dono, pra soltar a posse. */
  onReleaseArea?: (areaId: string) => void;

  // móvel (id) + nome de cada jogador REMOTO sentado agora, alimentado
  // de fora pelas mensagens "seat" recebidas (ver setRemoteSeat, chamado
  // pelo GameRoom.tsx) -- o LOCAL usa this.seatedAt direto, nunca passa
  // por aqui.
  private remoteSeat: Map<string, { furnitureId: string | null; name: string }> = new Map();

  // hitbox de hover (mostra/esconde o nome) + o próprio texto do nome,
  // um par por zona "mesa-privada" -- ver updateAreaHoverLabels.
  private areaHoverZones: Map<string, Phaser.GameObjects.Zone> = new Map();
  private areaNameLabels: Map<string, Phaser.GameObjects.Text> = new Map();

  /** Definido de fora (GameRoom.tsx) -- chamado toda vez que o jogador LOCAL senta/levanta, pra mandar "seat" pro servidor (ver protocolo em server/index.js). */
  onLocalSeatChange?: (furnitureId: string | null) => void;

  /** Definido de fora (GameRoom.tsx) -- chamado ao clicar no nome (hover) do dono de uma mesa privada, pra abrir o card de perfil dele -- mesmo destino do onAvatarClick acima, só que disparado pela MESA, não pelo boneco. */
  onAreaOwnerClick?: (info: { playerId: string; isLocal: boolean }) => void;

  constructor() {
    super("main");
  }

  preload() {
    // carrega o spritesheet de cada camada que já tem arte definida em
    // LAYER_TEXTURE_FILE (as com valor `null` ficam de fora até a arte
    // chegar -- ver createAvatar, que também só desenha as camadas
    // carregadas).
    for (const layer of LAYER_DRAW_ORDER) {
      if (layer === "cabelo") continue; // carregado abaixo, ver HAIR_CATALOG
      if (layer === "base") continue; // carregado abaixo, ver SKIN_CATALOG
      if (layer === "barba") continue; // carregado abaixo, ver BEARD_CATALOG
      if (layer === "oculos") continue; // carregado abaixo, ver ACCESSORY_CATALOG
      if (layer === "traje") continue; // carregado abaixo, ver OUTFIT_CATALOG
      const file = LAYER_TEXTURE_FILE[layer];
      if (!file) continue;
      this.load.spritesheet(layerTextureKey(layer), `/assets/${file}`, {
        frameWidth: FRAME_W,
        frameHeight: FRAME_H,
        // 2px de espaço transparente entre cada frame -- sem isso, com
        // antialias:true (necessário pra arte gerada não ficar serrilhada),
        // a GPU "vaza" um fiapo de pixel do frame vizinho nas bordas
        // (bilinear filtering lendo além do frame), o que aparecia como o
        // frame de outra pose "grudado" junto, principalmente entre poses
        // adjacentes na folha (ex: perna de "passo" aparecendo junto com a
        // pose do lado).
        spacing: 2,
      });
    }

    // cada opção de cabelo do catálogo é o SEU PRÓPRIO spritesheet (mesmo
    // layout de frames do base) -- carrega todas de uma vez (não só a
    // escolhida agora) pra trocar ao vivo sem precisar recarregar nada
    // (ver setLocalHairId, chamado pelo editor de personagem). Cada
    // VARIAÇÃO DE COR (ver HairOption.colors, ex: "Castanho"/"Loiro"/
    // "Preto" de um mesmo penteado) também é seu próprio spritesheet à
    // parte -- carrega junto aqui, indexado pelo id da COR (não do
    // penteado), porque escolher uma cor troca de textura pro arquivo
    // dela, exatamente como trocar de penteado.
    for (const opt of HAIR_CATALOG) {
      this.load.spritesheet(hairTextureKey(opt.id), `/assets/${opt.file}`, {
        frameWidth: FRAME_W,
        frameHeight: FRAME_H,
        spacing: 2,
      });
      for (const color of opt.colors ?? []) {
        this.load.spritesheet(hairTextureKey(color.id), `/assets/${color.file}`, {
          frameWidth: FRAME_W,
          frameHeight: FRAME_H,
          spacing: 2,
        });
      }
    }

    // cada tom de pele do catálogo (ver SKIN_CATALOG) é o SEU PRÓPRIO
    // spritesheet, mesmo esquema de "base" -- carrega todos de uma vez
    // pra trocar ao vivo sem recarregar nada (ver setLocalSkinId).
    for (const skin of SKIN_CATALOG) {
      this.load.spritesheet(skinTextureKey(skin.id), `/assets/${skin.file}`, {
        frameWidth: FRAME_W,
        frameHeight: FRAME_H,
        spacing: 2,
      });
    }

    // barba: igual ao traje, cada OPÇÃO tem VÁRIOS arquivos (um por tom
    // de pele, ver BeardOption.bySkin) -- carrega cada combinação
    // barba+tom que existe de verdade como seu próprio spritesheet (ver
    // beardTextureKey). "Nenhuma" (arquivo transparente) é só mais um
    // spritesheet normal pro Phaser, sem tratamento especial.
    for (const beard of BEARD_CATALOG) {
      for (const [skinId, file] of Object.entries(beard.bySkin)) {
        if (!file) continue;
        this.load.spritesheet(beardTextureKey(beard.id, skinId), `/assets/${file}`, {
          frameWidth: FRAME_W,
          frameHeight: FRAME_H,
          spacing: 2,
        });
      }
    }
    // acessório: catálogo + cores aninhadas (ver ACCESSORY_CATALOG) --
    // inclui a opção "Nenhum" (arquivo transparente), que também é só
    // mais um spritesheet normal pro Phaser, sem tratamento especial.
    for (const accessory of ACCESSORY_CATALOG) {
      this.load.spritesheet(accessoryTextureKey(accessory.id), `/assets/${accessory.file}`, {
        frameWidth: FRAME_W,
        frameHeight: FRAME_H,
        spacing: 2,
      });
      for (const color of accessory.colors ?? []) {
        this.load.spritesheet(accessoryTextureKey(color.id), `/assets/${color.file}`, {
          frameWidth: FRAME_W,
          frameHeight: FRAME_H,
          spacing: 2,
        });
      }
    }

    // traje: diferente das outras camadas, cada OPÇÃO tem VÁRIOS arquivos
    // (um por tom de pele, ver OutfitOption.bySkin) -- carrega cada
    // combinação traje+tom que realmente existe (não todo tom pra todo
    // traje, só os que a pasta de origem trouxe de verdade) como seu
    // próprio spritesheet, indexado pelos dois ids (ver outfitTextureKey).
    for (const outfit of OUTFIT_CATALOG) {
      for (const [skinId, file] of Object.entries(outfit.bySkin)) {
        if (!file) continue;
        this.load.spritesheet(outfitTextureKey(outfit.id, skinId), `/assets/${file}`, {
          frameWidth: FRAME_W,
          frameHeight: FRAME_H,
          spacing: 2,
        });
      }
    }
    this.load.image("room", "/assets/room.png");

    // carrega a arte de TODA combinação tipo+direção que existe em
    // FURNITURE_ART (não só as que ROOM_FURNITURE já usa) -- assim o
    // editor de espaço (ver setEditMode/paleta) consegue colocar
    // qualquer item do catálogo na hora, mesmo um que ainda não
    // apareça em nenhum móvel fixo da sala.
    for (const type of Object.keys(FURNITURE_ART) as FurnitureType[]) {
      const artByFacing = FURNITURE_ART[type];
      for (const facing of Object.keys(artByFacing) as Direction[]) {
        const file = artByFacing[facing];
        if (!file) continue;
        this.load.image(furnitureTextureKey(type, facing), `/assets/${file}`);
      }
    }

    // mesma ideia acima, mas pra MODELO+cor (ver FURNITURE_MODELS,
    // game/furniture.ts) -- item colocado com modelId usa essas texturas
    // em vez das de FURNITURE_ART (ver resolveFurnitureArt/
    // furnitureTextureKeyFor, usadas em addFurnitureSprite).
    for (const model of FURNITURE_MODELS) {
      for (const color of model.colors) {
        for (const facing of Object.keys(color.art) as Direction[]) {
          const file = color.art[facing];
          if (!file) continue;
          this.load.image(furnitureVariantTextureKey(model.id, color.id, facing), `/assets/${file}`);
        }
      }
    }

    // cada modelo de piso (ver FLOOR_CATALOG) é uma imagem PLANA só,
    // sem poses/direção (diferente do avatar) -- carrega todos de uma
    // vez pra pintar ao vivo no editor sem recarregar nada.
    for (const entry of FLOOR_CATALOG) {
      this.load.image(floorTextureKey(entry.id), `/assets/${entry.file}`);
    }
  }

  create() {
    // posição/tamanho vêm de GAME_WIDTH/GAME_HEIGHT (grid.ts) em vez de
    // 400/300 fixo (era exatamente o centro do canvas de 800x600 antigo)
    // -- agora acompanha a resolução interna sozinho, sem precisar
    // lembrar de atualizar aqui se ela mudar nunca mais. setDisplaySize
    // também: a arte "room.png" é nativa 800x600 (a resolução VELHA) --
    // esticada aqui pra cobrir o canvas novo (1200x900) até o Douglas
    // subir uma versão em qualidade maior dela (mesma situação da
    // mobília -- ver conversa sobre a resolução interna dobrar).
    this.add
      .image(GAME_WIDTH / 2, GAME_HEIGHT / 2, "room")
      .setOrigin(0.5)
      .setDisplaySize(GAME_WIDTH, GAME_HEIGHT)
      .setDepth(DEPTH_ROOM_BACKGROUND);

    // piso pintado vai ATRÁS de tudo o resto, cobrindo só os quadrados
    // escolhidos -- por isso desenha antes até dos móveis fixos (ver
    // DEPTH_FLOOR). O piso salvo de verdade chega depois, assíncrono (ver
    // loadSavedFloor mais abaixo, chamado pelo React em GameRoom.tsx
    // assim que a busca em GET /room/floor responder) -- create() não
    // espera por ele.

    for (const f of ROOM_FURNITURE) {
      this.roomFurnitureSprites.set(f.id, this.addFurnitureSprite(f));
    }

    this.cursors = this.input.keyboard!.createCursorKeys();
    this.wasd = this.input.keyboard!.addKeys({
      up: Phaser.Input.Keyboard.KeyCodes.W,
      down: Phaser.Input.Keyboard.KeyCodes.S,
      left: Phaser.Input.Keyboard.KeyCodes.A,
      right: Phaser.Input.Keyboard.KeyCodes.D,
    }) as Record<"up" | "down" | "left" | "right", Phaser.Input.Keyboard.Key>;

    const spawn = tileToWorld(6, 4);
    this.localContainer = this.createAvatar(
      spawn.x,
      spawn.y,
      this.localColor,
      this.localName,
      true,
      "local",
      this.localStatusColor
    );

    this.drawEditGrid();
    this.hoverGraphics = this.add.graphics().setDepth(EDIT_UI_DEPTH).setVisible(false);
    this.roomHoverGraphics = this.add.graphics().setDepth(DEPTH_ROOM_TILE_HOVER).setVisible(false);

    // câmera começa igual sempre foi (zoom 1, sala inteira visível,
    // scroll em 0,0 -- ver clampCameraScroll: SEM setBounds automático
    // do Phaser, o limite de arrastar agora é todo calculado ali,
    // aplicado depois de cada mudança de scroll (arrastar/zoom/
    // recentralizar), não travado no viewport-vs-bounds do próprio
    // Phaser).
    this.cameras.main.setZoom(DEFAULT_ZOOM_LEVEL);

    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      this.handleEditPointerMove(pointer);
      this.handleRoomPointerMove(pointer);
      this.handleCameraPan(pointer);
    });
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      this.handleEditPointerDown(pointer);
      this.handleRoomPointerDown(pointer);
      this.startCameraPan(pointer);
    });
    this.input.on("pointerup", () => {
      this.stopCameraPan();
      this.stopFloorPaint();
      this.stopAreaPaint();
    });
    this.input.on("pointerupoutside", () => {
      this.stopCameraPan();
      this.stopFloorPaint();
      this.stopAreaPaint();
    });

    // nudge fino do assento (ver "Assento" no editor de espaço) -- só faz
    // algo com seatTuningActive ligado E sentado (ver nudgeSeatOffset),
    // senão essas teclas não fazem nada aqui (o movimento normal usa
    // this.cursors por polling, ver readInputDir -- os dois mecanismos
    // convivem sem conflito, o Phaser suporta os dois ao mesmo tempo).
    // Shift+seta move 5px de uma vez (ajuste grosso), sem Shift move 1px
    // (fino) -- repete sozinho enquanto segura a tecla (key repeat do
    // sistema operacional), não precisa ficar clicando várias vezes.
    this.input.keyboard!.on("keydown-LEFT", (e: KeyboardEvent) => this.nudgeSeatOffset(-1, 0, e.shiftKey));
    this.input.keyboard!.on("keydown-RIGHT", (e: KeyboardEvent) => this.nudgeSeatOffset(1, 0, e.shiftKey));
    this.input.keyboard!.on("keydown-UP", (e: KeyboardEvent) => this.nudgeSeatOffset(0, -1, e.shiftKey));
    this.input.keyboard!.on("keydown-DOWN", (e: KeyboardEvent) => this.nudgeSeatOffset(0, 1, e.shiftKey));

    // ACHADO da corrida "[piso]/[móvel] textura não estava carregada
    // ainda" (Douglas: "oq e esse quadrado de erro embaixo?" / "continua
    // la" mesmo depois da correção anterior, que só escondia o sintoma
    // sem consertar a causa -- ver addFloorSprite/addFurnitureSprite):
    // GameRoom.tsx disparava a busca do piso/mobília/área salvos (GET
    // /room/floor etc) dentro de `game.events.once(Phaser.Core.Events.
    // READY, ...)`. Conferindo o código-fonte do Phaser (node_modules/
    // phaser/src/core/Game.js, texturesReady()): esse evento "ready" do
    // GAME dispara ANTES até do game LOOP começar (this.start() só roda
    // DEPOIS de emitir "ready") -- ou seja, a cena "main" nem começou o
    // preload() ainda nesse momento, e SÓ o preload() já carrega TODAS as
    // texturas de catálogo (piso/mobília de fábrica, ver preload() logo
    // acima). Como as buscas ao servidor de tempo real (bem mais rápido,
    // rodando local) quase sempre respondem ANTES do Phaser terminar de
    // baixar/decodificar essas imagens, loadSavedFloor/loadSavedFurniture
    // rodavam com o catálogo ainda incompleto -- corrida de verdade, não
    // só "às vezes": acontecia TODA vez, exatamente como o Douglas
    // reportou.
    //
    // sceneReady (+ o evento "scene-ready" abaixo) resolve isso: só vira
    // true bem AQUI, na ÚLTIMA linha de create() -- e create() só roda
    // depois que o Loader termina 100% (garantia do próprio Phaser), ou
    // seja, com TODO o catálogo de piso/mobília já carregado de verdade.
    // GameRoom.tsx passou a esperar por isso (ver comentário grande no
    // useEffect do Phaser.Game) em vez de sair buscando o estado salvo
    // direto no "ready" do jogo.
    this.sceneReady = true;
    this.events.emit("scene-ready");
  }

  /**
   * Cria (ou recria) a imagem de UM móvel na cena, já com origem,
   * profundidade e transparência certas -- usado tanto pros móveis
   * fixos (ROOM_FURNITURE, no create()) quanto pros itens "rascunho"
   * colocados pelo editor de espaço (ver placeDraftFurniture), pra
   * garantir que os dois renderizam exatamente igual.
   */
  /**
   * Carrega a textura de item(ns) CUSTOM (Editor de Itens -- ver
   * registerCustomFurnitureModels em game/furniture.ts) DEPOIS que a
   * cena já criou. Diferente de todo o resto (preload(), roda antes de
   * qualquer coisa aparecer): a URL desses itens só existe depois de
   * buscar no Supabase (assíncrono, ver fetchCustomFurnitureModels em
   * GameRoom.tsx), então não dá pra saber ainda no preload(). Usa o
   * loader do Phaser FORA do ciclo normal -- suportado, só não pode
   * chamar de novo enquanto um load anterior ainda está em andamento
   * (por isso o `isLoading()`+fila em vez de chamar this.load.start()
   * direto, que ignoraria/atropelaria um load já rolando).
   */
  loadCustomFurnitureTextures(entries: { key: string; url: string }[], onDone?: () => void) {
    const missing = entries.filter((e) => !this.textures.exists(e.key));
    if (missing.length === 0) {
      onDone?.();
      return;
    }
    const start = () => {
      for (const e of missing) this.load.image(e.key, e.url);
      this.load.once(Phaser.Loader.Events.COMPLETE, () => onDone?.());
      this.load.start();
    };
    if (this.load.isLoading()) {
      this.load.once(Phaser.Loader.Events.COMPLETE, start);
    } else {
      start();
    }
  }

  /**
   * Igual a loadCustomFurnitureTextures acima, mas pra CAMADA DE AVATAR
   * customizada (Editor de Itens, botão "Criar Avatar" -- tom de pele,
   * cabelo, acessório, barba ou traje, ver registerCustomSkins/
   * registerCustomHair/registerCustomAccessories/registerCustomBeards/
   * registerCustomOutfits em game/customization.ts e app/api/avatar-skins
   * + app/api/avatar-items) -- diferente de móvel (imagem estática),
   * qualquer camada de avatar é um SPRITESHEET (mesma folha 8x2/200x260
   * que a pasta local usa, já composta pelo NAVEGADOR antes do upload,
   * ver ItemEditor.tsx), por isso `this.load.spritesheet` com os mesmos
   * FRAME_W/FRAME_H/spacing:2 do resto das camadas (ver preload() acima)
   * em vez de `this.load.image`. (Nome antigo: loadCustomSkinTextures --
   * generalizado quando o upload por navegador passou a cobrir as outras
   * camadas, não só tom de pele.)
   */
  loadCustomAvatarLayerTextures(entries: { key: string; url: string }[], onDone?: () => void) {
    const missing = entries.filter((e) => !this.textures.exists(e.key));
    if (missing.length === 0) {
      onDone?.();
      return;
    }
    const start = () => {
      for (const e of missing) {
        this.load.spritesheet(e.key, e.url, { frameWidth: FRAME_W, frameHeight: FRAME_H, spacing: 2 });
      }
      this.load.once(Phaser.Loader.Events.COMPLETE, () => onDone?.());
      this.load.start();
    };
    if (this.load.isLoading()) {
      this.load.once(Phaser.Loader.Events.COMPLETE, start);
    } else {
      start();
    }
  }

  private addFurnitureSprite(f: FurnitureDef): Phaser.GameObjects.Image {
    // origem embaixo-centro, igual ao avatar: a posição do móvel é o
    // pontinho onde ele "toca o chão", alinhado ao tile dele
    const pos = furnitureWorldPos(f);
    const key = furnitureTextureKeyFor(f);
    // Douglas: "oq e esse quadrado de erro embaixo?" -- o quadriculado
    // preto/verde de "textura faltando" do Phaser, bem discreto (~1
    // tile) perto de onde o boneco tava. Esse guard já existia (só o
    // console.warn), mas SÓ avisava -- continuava desenhando a imagem
    // com a `key` quebrada de qualquer jeito, e o Phaser preenchia com o
    // próprio quadriculado dele. addFloorSprite (logo abaixo) já tinha
    // sido corrigido faz tempo pra esse MESMO tipo de corrida (preload()
    // da cena x carregamento do que foi salvo) simplesmente NÃO
    // desenhando nada em vez de mostrar isso -- aqui nunca tinha
    // ganhado o mesmo tratamento. Mobília precisa continuar OCUPANDO um
    // Phaser.GameObjects.Image de verdade (Map de sprites, clique pra
    // apagar/mover, etc -- diferente do piso, que é só visual), então em
    // vez de não criar nada, cria mas deixa INVISÍVEL até a textura
    // certa estar pronta (mesma ideia de "melhor nada do que o
    // quadriculado feio").
    const textureMissing = !this.textures.exists(key);
    if (textureMissing) {
      console.warn(
        `[móvel] textura "${key}" (item "${f.id}", tipo "${f.type}") não estava carregada ainda -- item não desenhado (em vez do quadriculado de textura faltando do Phaser). Se isso aparecer toda vez que recarregar a página, é sinal de uma corrida entre o preload() da cena e o carregamento da mobília salva/custom.`
      );
    }
    const image = this.add
      .image(pos.x, pos.y, key)
      .setOrigin(0.5, 1)
      .setDepth(f.flat ? DEPTH_FLAT_FURNITURE : furnitureDepthForTile(f.col, f.row))
      .setAlpha(f.transparent ? GLASS_ALPHA : 1)
      .setVisible(!textureMissing);

    // item CUSTOM (Editor de Itens, ver FurnitureModelDef.custom em
    // game/furniture.ts) -- pedido do Douglas: subir a imagem na
    // qualidade/resolução ORIGINAL (sem precisar redimensionar antes no
    // Canva) e deixar o JOGO encolher só a EXIBIÇÃO. setDisplaySize muda
    // só o tamanho na TELA -- a textura de verdade, em resolução cheia,
    // continua carregada, então o encolhimento é feito pela GPU
    // (WebGL/bilinear) na hora de desenhar, sem perder qualidade
    // igual perderia redimensionando o ARQUIVO fora daqui. Item "de
    // fábrica" (sem modelo custom) não entra aqui -- a arte dele já foi
    // recortada certinha pelo script (scripts/syncFurnitureAssets.mjs),
    // desenha no tamanho nativo de sempre.
    const model = f.modelId ? furnitureModelById(f.modelId) : undefined;
    if (model?.custom) {
      const source = this.textures.get(key).getSourceImage() as { width?: number; height?: number };
      const nativeW = source.width || image.width;
      const nativeH = source.height || image.height;
      // preferência: tamanho ajustado à mão no preview do Editor de Itens
      // (model.displayWidth, ver FurnitureModelDef em furniture.ts) --
      // só cai no alvo genérico por categoria pra item cadastrado ANTES
      // dessa opção existir (display_width null no banco).
      const targetWidth = model.displayWidth ?? CUSTOM_ITEM_TARGET_WIDTH[FURNITURE_TYPE_CATEGORY[f.type]] ?? 225;
      if (nativeW > 0 && nativeH > 0) {
        image.setDisplaySize(targetWidth, targetWidth * (nativeH / nativeW));
      }
      // posição ajustada à mão (arrastando o item em cima do
      // boneco/quadrado de referência no preview do Editor de Itens, ver
      // FurnitureModelDef.offsetX/offsetY em game/furniture.ts) -- só
      // desloca a EXIBIÇÃO a partir da âncora padrão (pos.x/pos.y, borda
      // de baixo do tile), não muda o tile lógico nem a profundidade.
      // "down" (frente) sempre usa offsetX/offsetY direto -- as outras 3
      // direções caem no PRÓPRIO ajuste se tiver (ver
      // FurnitureModelDef.directionOffsets, pedido do Douglas: "editar
      // todos os lados do mobi"), senão reaproveitam o mesmo valor de
      // "down" (comportamento de sempre, sem regressão pros modelos
      // ajustados antes dessa opção existir).
      const directionOverride = f.facing !== "down" ? model.directionOffsets?.[f.facing] : undefined;
      const offX = directionOverride?.x ?? model.offsetX ?? 0;
      const offY = directionOverride?.y ?? model.offsetY ?? 0;
      if (offX || offY) {
        image.setPosition(pos.x + offX, pos.y + offY);
      }
    }

    return image;
  }

  /**
   * Tira da memória a textura em cache pra cada chave dada -- chamado
   * ANTES de registrar um item EDITADO no Editor de Itens
   * (fetchAndRegisterCustomFurniture, GameRoom.tsx): sem isso,
   * loadCustomFurnitureTextures vê a chave já carregada (mesma chave de
   * sempre, ver furnitureVariantTextureKey -- não muda numa edição, só o
   * conteúdo do arquivo) e pula o carregamento, deixando a arte ANTIGA
   * na tela até um F5. Só limpa do TextureManager -- não mexe em nenhum
   * sprite já desenhado (ver refreshFurnitureModel logo abaixo, que
   * cuida disso).
   */
  removeFurnitureTextures(keys: string[]) {
    for (const key of keys) {
      if (this.textures.exists(key)) this.textures.remove(key);
    }
  }

  /**
   * Recria o sprite de todo item JÁ COLOCADO (draftFurniture) que usa o
   * MODELO dado -- chamado depois de editar um item no Editor de Itens
   * (ver removeFurnitureTextures acima + loadCustomFurnitureTextures,
   * fetchAndRegisterCustomFurniture em GameRoom.tsx), pra arte/tamanho/
   * posição novos aparecerem NA HORA nos itens que já estavam na sala,
   * sem precisar de F5. Só troca o sprite (destroy + addFurnitureSprite
   * de novo, que já lê o modelo atualizado do catálogo) -- o
   * FurnitureDef em si (col/row/facing/colorId) não muda.
   */
  refreshFurnitureModel(modelId: string) {
    for (const [id, f] of this.draftFurniture.entries()) {
      if (f.modelId !== modelId) continue;
      this.draftSprites.get(id)?.destroy();
      this.draftSprites.set(id, this.addFurnitureSprite(f));
    }
  }

  /**
   * Cria (ou recria) a imagem de UM quadrado de piso pintado, já com
   * origem/tamanho/profundidade certos -- usado tanto pro piso já salvo
   * (ver loadSavedFloor) quanto pros tiles pintados na hora no editor de
   * espaço (ver paintFloorAt), mesma ideia do addFurnitureSprite. Devolve
   * null se o styleId não bate com nenhum item do catálogo (defensivo --
   * não deveria acontecer normalmente) OU se a textura desse estilo, por
   * algum motivo, não terminou de carregar ainda (ver comentário abaixo --
   * bug reportado pelo Douglas: piso salvo virando o quadriculado preto/
   * verde do Phaser -- "textura faltando" -- depois de um F5). Nos dois
   * casos, MELHOR não desenhar nada (o tile fica só sem o piso pintado,
   * mostrando o fundo padrão por baixo) do que mostrar esse quadriculado
   * feio -- e o console.warn dá uma pista de verdade (styleId + chave) da
   * próxima vez que acontecer, em vez de só "sumiu".
   */
  private addFloorSprite(f: FloorTileDef): Phaser.GameObjects.Image | null {
    const entry = floorEntryById(f.styleId);
    if (!entry) return null;
    const key = floorTextureKey(f.styleId);
    if (!this.textures.exists(key)) {
      console.warn(
        `[piso] textura "${key}" (estilo "${f.styleId}") não estava carregada ainda -- tile ${f.col},${f.row} não desenhado (em vez do quadriculado de textura faltando do Phaser). Se isso aparecer toda vez que recarregar a página, é sinal de uma corrida entre o preload() da cena e o carregamento do piso salvo.`
      );
      return null;
    }
    const pos = floorWorldPos(f);
    return this.add
      .image(pos.x, pos.y, key)
      .setOrigin(0.5, 0.5)
      .setDisplaySize(ISO_TILE_WIDTH, ISO_TILE_HEIGHT)
      .setDepth(DEPTH_FLOOR);
  }

  /**
   * Carrega o piso já salvo no servidor (ver GET /room/floor em
   * server/index.js) -- chamado UMA vez pelo React (GameRoom.tsx) assim
   * que a cena fica pronta E a busca responder (podem chegar em
   * qualquer ordem, por isso não faz parte do create() direto, que não
   * espera rede nenhuma).
   *
   * Cada tile carregado entra direto em draftFloor/draftFloorSprites --
   * o MESMO Map que o pincel usa pros tiles pintados nesta sessão -- em
   * vez de ficar num Map/desenho separado tipo "fixo". Isso é de
   * propósito: assim o botão "Apagar" e o "Limpar tudo" funcionam em
   * QUALQUER tile (salvo antes ou pintado agora), sem distinção, e o
   * autosave (ver onDraftFloorChange, disparado no fim daqui) sempre
   * manda pro servidor o piso INTEIRO certo, não só o que mudou agora.
   */
  loadSavedFloor(items: FloorTileDef[]) {
    // tenta de novo, uma vez, os tiles que não conseguiram desenhar a
    // sprite na primeira passada (ver addFloorSprite) -- bug reportado
    // pelo Douglas: piso salvo virando o quadriculado de "textura
    // faltando" e SUMINDO depois de um F5. Suspeita: corrida entre o
    // preload() da cena e essa função (que pode ser chamada assim que o
    // GET /room/floor responder, ver comentário acima) -- 400ms de
    // folga cobre isso se for o caso.
    const pendingRetry: FloorTileDef[] = [];
    for (const f of items) {
      const key = `${f.col},${f.row}`;
      if (this.draftFloor.has(key)) continue; // já carregado (ex: chamado 2x) -- não duplica sprite
      // guarda o DADO já aqui, mesmo que a sprite não tenha desenhado --
      // CRÍTICO: getDraftFloorList() (usada pelo autosave, ver
      // onDraftFloorChange) manda o piso INTEIRO pro servidor a cada
      // mudança; se um tile que falhou por causa de uma corrida de
      // carregamento sumisse daqui, o autosave ia APAGAR ele de verdade
      // no servidor no ciclo seguinte -- um simples refresh não pode
      // apagar piso já salvo.
      this.draftFloor.set(key, f);
      const sprite = this.addFloorSprite(f);
      if (sprite) {
        this.draftFloorSprites.set(key, sprite);
      } else if (floorEntryById(f.styleId)) {
        // só vale tentar de novo se o ESTILO ainda existe no catálogo --
        // um styleId de um item removido do catálogo nunca vai carregar,
        // por mais que espere.
        pendingRetry.push(f);
      }
    }
    if (pendingRetry.length > 0) {
      this.time.delayedCall(400, () => this.retryFloorSprites(pendingRetry));
    }
    this.onDraftFloorChange?.(this.getDraftFloorList());
  }

  /** Segunda tentativa (ver loadSavedFloor) de desenhar tiles de piso cuja textura ainda não estava carregada da primeira vez. Não mexe em draftFloor (o dado já está lá desde loadSavedFloor) -- só tenta criar a sprite que faltou. */
  private retryFloorSprites(items: FloorTileDef[]) {
    for (const f of items) {
      const key = `${f.col},${f.row}`;
      if (this.draftFloorSprites.has(key)) continue; // já resolveu por outro caminho nesse meio-tempo (ex: apagado/repintado)
      if (!this.draftFloor.has(key)) continue; // apagado nesse meio-tempo, não recria
      const sprite = this.addFloorSprite(f);
      if (sprite) this.draftFloorSprites.set(key, sprite);
    }
  }

  private createAvatar(
    x: number,
    y: number,
    color: string,
    name: string,
    isLocal: boolean,
    playerId: string,
    statusColor: string = "#4fd97a"
  ): Phaser.GameObjects.Container {
    // uma Sprite por camada EQUIPADA (só as que já têm arte carregada em
    // LAYER_TEXTURE_FILE), empilhadas na ordem de LAYER_DRAW_ORDER --
    // todas na mesma posição/frame, então de longe parecem um boneco só.
    // "cabelo", "base", "barba", "oculos" e "traje" são especiais:
    // sempre entram (têm catálogo de verdade agora, ver HAIR_CATALOG/
    // SKIN_CATALOG/BEARD_CATALOG/ACCESSORY_CATALOG/OUTFIT_CATALOG),
    // começando na opção padrão -- guardam a própria Sprite à parte
    // (hairSprite/skinSprite/beardSprite/accessorySprite/outfitSprite)
    // pra dar pra trocar de textura DEPOIS sem recriar o boneco inteiro
    // (ver setLocalHairId/setLocalSkinId/setLocalBeardId/
    // setLocalAccessoryId/setLocalOutfitId). "Nenhuma(o)" (barba/
    // acessório/traje) é só mais uma opção do catálogo (arquivo
    // transparente), não precisa de tratamento diferente aqui.
    const layerSprites: Phaser.GameObjects.Sprite[] = [];
    let hairSprite: Phaser.GameObjects.Sprite | null = null;
    let skinSprite: Phaser.GameObjects.Sprite | null = null;
    let beardSprite: Phaser.GameObjects.Sprite | null = null;
    let accessorySprite: Phaser.GameObjects.Sprite | null = null;
    let outfitSprite: Phaser.GameObjects.Sprite | null = null;
    for (const layer of LAYER_DRAW_ORDER) {
      if (layer === "cabelo") {
        const sprite = this.add.sprite(
          0,
          AVATAR_FOOT_OFFSET_Y,
          hairTextureKey(DEFAULT_HAIR_ID),
          WALK_FRAMES.down[0]
        );
        sprite.setOrigin(0.5, 1);
        sprite.setScale(AVATAR_SCALE);
        layerSprites.push(sprite);
        hairSprite = sprite;
        continue;
      }
      if (layer === "base") {
        const sprite = this.add.sprite(
          0,
          AVATAR_FOOT_OFFSET_Y,
          skinTextureKey(DEFAULT_SKIN_ID),
          WALK_FRAMES.down[0]
        );
        sprite.setOrigin(0.5, 1);
        sprite.setScale(AVATAR_SCALE);
        // pedido do Douglas: "tira as cabeças da pasta, sobe o avatar no
        // lugar" -- SKIN_CATALOG agora começa VAZIO (só ganha tom em
        // tempo de execução, ver fetchAndRegisterCustomSkins em
        // GameRoom.tsx), então a textura acima pode não existir AINDA
        // nesse instante (spritesheet carregado depois, via
        // loadCustomAvatarLayerTextures). Sem essa checagem o Phaser
        // desenharia o quadriculado preto/verde de "textura faltando" --
        // esconde em vez disso (fetchAndRegisterCustomSkins chama
        // setLocalSkinId de novo assim que a textura de verdade estiver
        // pronta, o que reaplica e reexibe).
        sprite.setVisible(this.textures.exists(skinTextureKey(DEFAULT_SKIN_ID)));
        layerSprites.push(sprite);
        skinSprite = sprite;
        continue;
      }
      if (layer === "traje") {
        // avatar local: usa o traje já guardado em localOutfitId (ver
        // comentário no campo -- normalmente o sorteado no spawn, já
        // setado ANTES de create() rodar via setLocalOutfitId). Avatar
        // remoto: sempre começa em DEFAULT_OUTFIT_ID mesmo (o traje de
        // verdade dele ainda não é sincronizado pela rede).
        const initialOutfitId = isLocal ? this.localOutfitId : DEFAULT_OUTFIT_ID;
        const defaultOutfit = OUTFIT_CATALOG.find((o) => o.id === initialOutfitId) ?? OUTFIT_CATALOG[0];
        const resolvedSkinId = resolveOutfitSkinId(defaultOutfit, DEFAULT_SKIN_ID) ?? DEFAULT_SKIN_ID;
        const sprite = this.add.sprite(
          0,
          AVATAR_FOOT_OFFSET_Y,
          outfitTextureKey(defaultOutfit.id, resolvedSkinId),
          WALK_FRAMES.down[0]
        );
        sprite.setOrigin(0.5, 1);
        sprite.setScale(AVATAR_SCALE);
        layerSprites.push(sprite);
        outfitSprite = sprite;
        continue;
      }
      if (layer === "barba") {
        const defaultBeard = BEARD_CATALOG.find((b) => b.id === DEFAULT_BEARD_ID) ?? BEARD_CATALOG[0];
        const resolvedBeardSkinId = resolveBeardSkinId(defaultBeard, DEFAULT_SKIN_ID) ?? DEFAULT_SKIN_ID;
        const sprite = this.add.sprite(
          0,
          AVATAR_FOOT_OFFSET_Y,
          beardTextureKey(defaultBeard.id, resolvedBeardSkinId),
          WALK_FRAMES.down[0]
        );
        sprite.setOrigin(0.5, 1);
        sprite.setScale(AVATAR_SCALE);
        layerSprites.push(sprite);
        beardSprite = sprite;
        continue;
      }
      if (layer === "oculos") {
        const sprite = this.add.sprite(
          0,
          AVATAR_FOOT_OFFSET_Y,
          accessoryTextureKey(DEFAULT_ACCESSORY_ID),
          WALK_FRAMES.down[0]
        );
        sprite.setOrigin(0.5, 1);
        sprite.setScale(AVATAR_SCALE);
        layerSprites.push(sprite);
        accessorySprite = sprite;
        continue;
      }
      if (!LAYER_TEXTURE_FILE[layer]) continue;
      const sprite = this.add.sprite(0, AVATAR_FOOT_OFFSET_Y, layerTextureKey(layer), WALK_FRAMES.down[0]);
      // origem embaixo-centro: o "pé" do boneco fica no (0,0) do
      // container, que é a posição lógica dele na sala (chão)
      sprite.setOrigin(0.5, 1);
      sprite.setScale(AVATAR_SCALE);
      layerSprites.push(sprite);
    }

    // fundo em "pill" arredondada por trás do nome (ver drawNameplateBg
    // mais abaixo) -- criado ANTES do texto/bolinha pra ficar atrás
    // deles na pilha do container (ordem de criação = ordem de
    // desenho). Sem backgroundColor/padding no Text (que só desenha um
    // retângulo reto, sem cantos arredondados) -- quem cuida do fundo
    // agora é esse Graphics.
    const nameplateBg = this.add.graphics();

    // texto criado em (0,0) -- a posição REAL acima da cabeça do
    // boneco é do GRUPO (nameplateGroup, logo abaixo), não do texto em
    // si, pra dar pra contra-escalar o grupo inteiro no zoom (ver
    // refreshNameplateScale) sem precisar mexer na posição interna de
    // cada peça.
    const label = this.add
      .text(0, 0, name, {
        fontSize: "11px", // escalado 1.5x junto com a resolução interna, depois -10% (ver NAMEPLATE_PAD_X/STATUS_DOT_RADIUS acima)
        color: "#f1ecff",
        fontFamily: GAME_FONT_FAMILY,
        resolution: NAMEPLATE_TEXT_RESOLUTION,
      })
      .setOrigin(0.5);
    this.fitNameplateText(label, name);

    // bolinha de status: fica à esquerda do nome, o par inteiro
    // (bolinha + espaço + texto) centralizado sobre o boneco -- ver
    // layoutNameplate, chamado aqui embaixo e de novo toda vez que o
    // nome muda (setNameplate).
    const statusDot = this.add.circle(
      0,
      label.y,
      STATUS_DOT_RADIUS,
      Phaser.Display.Color.HexStringToColor(statusColor).color
    );

    const dispW = layerSprites[0].displayWidth;
    const dispH = layerSprites[0].displayHeight;

    // grupo do "cartão" de nome (fundo+bolinha+texto) num container
    // PRÓPRIO, separado do container do boneco -- é ele (não as peças
    // individuais) que refreshNameplateScale() contra-escala/reposiciona
    // no zoom, pra ficar sempre do MESMO tamanho na tela (pedido do
    // Douglas: "esse card do nome tem que ser fixo"). nameplateBaseY é
    // a posição calculada pro zoom padrão (DEFAULT_ZOOM_LEVEL, ver
    // MainScene.ts) -- em qualquer outro zoom Z, a posição de verdade
    // vira nameplateBaseY / Z (mesma lógica da escala, ver
    // refreshNameplateScale).
    const nameplateBaseY = AVATAR_FOOT_OFFSET_Y - dispH - 8;
    const nameplateGroup = this.add.container(0, nameplateBaseY, [nameplateBg, statusDot, label]);

    // destaque ao passar o mouse (ver hitArea/pointerdown mais abaixo --
    // o avatar inteiro já é clicável, isso só acrescenta o feedback
    // visual de hover, igual o Gather): um CONTORNO em cada camada
    // (Phaser FX "Glow", só funciona no renderer WebGL -- ver
    // supportsGlowFX), que segue o alfa de cada sprite -- por isso
    // contorna o boneco certinho (roupa/pose/cabelo do momento, o que
    // estiver equipado), em vez de uma forma fixa por cima que só cobre
    // um pedaço dele. outerStrength começa em 0 (sem contorno visível)
    // -- pointerover/pointerout mais abaixo animam ele com tween (e um
    // leve aumento de escala nas sprites, junto). Em Canvas (sem
    // suporte a FX) essa parte não faz nada -- sobra só o zoom leve.
    const supportsGlowFX = this.game.renderer.type === Phaser.WEBGL;
    const glowFx: Phaser.FX.Glow[] = supportsGlowFX
      ? layerSprites.map((sprite) => sprite.postFX.addGlow(0x7c5cff, 0, 0, false, 0.3, 10))
      : [];

    const container = this.add.container(x, y, [...layerSprites, nameplateGroup]);
    container.setSize(dispW, dispH);
    container.setDepth(avatarDepthForY(y));
    container.setData("layers", layerSprites);
    container.setData("label", label);
    container.setData("statusDot", statusDot);
    container.setData("nameplateBg", nameplateBg);
    container.setData("nameplateGroup", nameplateGroup);
    container.setData("nameplateBaseY", nameplateBaseY);
    container.setData("dir", "down" as Direction);
    container.setData("stepToggle", false);
    container.setData("hairSprite", hairSprite);
    container.setData("hairId", DEFAULT_HAIR_ID);
    container.setData("skinSprite", skinSprite);
    container.setData("skinId", DEFAULT_SKIN_ID);
    container.setData("beardSprite", beardSprite);
    container.setData("beardId", DEFAULT_BEARD_ID);
    container.setData("accessorySprite", accessorySprite);
    container.setData("accessoryId", DEFAULT_ACCESSORY_ID);
    container.setData("outfitSprite", outfitSprite);
    container.setData("outfitId", isLocal ? this.localOutfitId : DEFAULT_OUTFIT_ID);
    container.setData("playerId", playerId);
    container.setData("isLocal", isLocal);
    this.layoutNameplate(label, statusDot, nameplateBg);

    // clicável (card de perfil, ver onAvatarClick) -- a área de clique
    // precisa ser um retângulo próprio porque as sprites são ancoradas
    // embaixo-centro (origem 0.5,1) com um offset vertical
    // (AVATAR_FOOT_OFFSET_Y), então o boneco visualmente ocupa uma faixa
    // ACIMA e ao redor do (0,0) do container, não abaixo/à direita dele
    // (que é a área padrão que setInteractive() usaria sem essa forma
    // customizada).
    const hitArea = new Phaser.Geom.Rectangle(-dispW / 2, AVATAR_FOOT_OFFSET_Y - dispH, dispW, dispH);
    container.setInteractive(hitArea, Phaser.Geom.Rectangle.Contains);
    if (container.input) container.input.cursor = "pointer";
    container.on("pointerdown", () => {
      if (this.avatarClicksLocked) return;
      this.onAvatarClick?.({ playerId, isLocal, name, color });
    });
    // destaque de hover (ver glowFx acima) -- desliga junto com o
    // clique quando avatarClicksLocked (não faz sentido destacar algo
    // que não vai responder ao clique agora).
    container.on("pointerover", () => {
      if (this.avatarClicksLocked) return;
      if (glowFx.length > 0) {
        this.tweens.killTweensOf(glowFx);
        this.tweens.add({ targets: glowFx, outerStrength: 3, duration: 120, ease: "Sine.easeOut" });
      }
      this.tweens.killTweensOf(layerSprites);
      this.tweens.add({
        targets: layerSprites,
        scaleX: AVATAR_SCALE * 1.05,
        scaleY: AVATAR_SCALE * 1.05,
        duration: 120,
        ease: "Sine.easeOut",
      });
    });
    container.on("pointerout", () => {
      if (glowFx.length > 0) {
        this.tweens.killTweensOf(glowFx);
        this.tweens.add({ targets: glowFx, outerStrength: 0, duration: 120, ease: "Sine.easeIn" });
      }
      this.tweens.killTweensOf(layerSprites);
      this.tweens.add({
        targets: layerSprites,
        scaleX: AVATAR_SCALE,
        scaleY: AVATAR_SCALE,
        duration: 120,
        ease: "Sine.easeIn",
      });
    });

    this.refreshNameplateScale();

    return container;
  }

  /**
   * Corta o nome com "…" no final se ultrapassar NAMEPLATE_MAX_TEXT_WIDTH
   * -- evita o cartão crescer sem limite pra nome grande (pedido do
   * Douglas: "passou do limite, quero '...' no final" -- e evita
   * qualquer sobreposição que um card gigante causava com o resto da
   * UI). Usa o próprio Text object pra medir (setText já remede a
   * largura sozinho) -- busca binária pelo maior prefixo que ainda
   * cabe, pra não ficar testando caractere por caractere à toa.
   */
  private fitNameplateText(label: Phaser.GameObjects.Text, fullText: string) {
    label.setText(fullText);
    if (label.width <= NAMEPLATE_MAX_TEXT_WIDTH) return;
    let lo = 0;
    let hi = fullText.length;
    let best = "…";
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const candidate = `${fullText.slice(0, mid).trimEnd()}…`;
      label.setText(candidate);
      if (label.width <= NAMEPLATE_MAX_TEXT_WIDTH) {
        best = candidate;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    label.setText(best);
  }

  /**
   * Contra-escala o GRUPO do cartão de nome (ver nameplateGroup em
   * createAvatar) de todo boneco -- local e remoto -- pra ele ficar
   * sempre do MESMO TAMANHO na tela, não importa o zoom da câmera
   * (pedido do Douglas: "esse card do nome tem que ser fixo, quando dá
   * zoom ele não aparece" -- sem contra-escala, o texto (11px em espaço
   * de mundo) encolhia junto com o zoom out até ficar ilegível).
   *
   * A POSIÇÃO (setY) fica em nameplateBaseY puro, SEM dividir pelo
   * zoom -- dividir a posição junto com a escala (como era antes) dava
   * uma distância fixa em PIXELS DE TELA entre o cartão e o pé do
   * boneco, que é exatamente o oposto do que o Douglas pediu agora
   * ("tem que ficar grudado a uma distância fixa do boneco independente
   * do zoom"): o boneco em si encolhe com o zoom out (as sprites não são
   * contra-escaladas), então um cartão preso a uma distância FIXA em
   * tela ia se afastando cada vez mais do boneco (encolhido) conforme
   * afastava a câmera -- era isso que aparecia "flutuando" longe do
   * personagem no zoom out. Deixando a posição em espaço de MUNDO (sem
   * dividir), ela encolhe/aproxima junto com o boneco (mesmo fator de
   * zoom dos dois), só o TAMANHO do cartão que fica constante -- resultado:
   * sempre colado bem em cima da cabeça, do mesmo tamanho legível,
   * em qualquer zoom. Chamado toda vez que o zoom muda (ver applyZoom) e
   * uma vez na criação de cada boneco nesse zoom.
   */
  private refreshNameplateScale() {
    const zoom = this.cameras.main.zoom || 1;
    const containers = [this.localContainer, ...this.remoteContainers.values()].filter(
      (c): c is Phaser.GameObjects.Container => Boolean(c)
    );
    for (const container of containers) {
      const group = container.getData("nameplateGroup") as Phaser.GameObjects.Container | undefined;
      const baseY = container.getData("nameplateBaseY") as number | undefined;
      if (!group || baseY === undefined) continue;
      group.setScale(1 / zoom);
      group.setY(baseY);
    }
  }

  /**
   * Reposiciona a bolinha de status + o texto do nome como UM grupo só,
   * centralizado sobre o boneco (em vez de cada um centralizado por
   * si), e redesenha o fundo em "pill" arredondada atrás dos dois --
   * precisa ser recalculado toda vez que o texto do nome muda, porque
   * a largura do label (e portanto do fundo) muda junto.
   */
  private layoutNameplate(
    label: Phaser.GameObjects.Text,
    dot: Phaser.GameObjects.Arc,
    bg: Phaser.GameObjects.Graphics
  ) {
    const groupWidth = STATUS_DOT_RADIUS * 2 + STATUS_DOT_GAP + label.width;
    const left = -groupWidth / 2;
    dot.setPosition(left + STATUS_DOT_RADIUS, label.y);
    label.setOrigin(0, 0.5);
    label.setX(left + STATUS_DOT_RADIUS * 2 + STATUS_DOT_GAP);

    const pillWidth = groupWidth + NAMEPLATE_PAD_X * 2;
    const pillHeight = label.height + NAMEPLATE_PAD_Y * 2;
    const pillX = left - NAMEPLATE_PAD_X;
    const pillY = label.y - pillHeight / 2;
    bg.clear();
    bg.fillStyle(NAMEPLATE_BG_COLOR, NAMEPLATE_BG_ALPHA);
    bg.fillRoundedRect(pillX, pillY, pillWidth, pillHeight, NAMEPLATE_RADIUS);
    bg.lineStyle(1, NAMEPLATE_BORDER_COLOR, NAMEPLATE_BORDER_ALPHA);
    bg.strokeRoundedRect(pillX, pillY, pillWidth, pillHeight, NAMEPLATE_RADIUS);
  }

  /** Atualiza nome + cor da bolinha de status de um boneco já existente (local ou remoto), sem recriar nada. */
  private setNameplate(container: Phaser.GameObjects.Container, name: string, statusColor: string) {
    const label = container.getData("label") as Phaser.GameObjects.Text | undefined;
    const dot = container.getData("statusDot") as Phaser.GameObjects.Arc | undefined;
    const bg = container.getData("nameplateBg") as Phaser.GameObjects.Graphics | undefined;
    if (!label || !dot || !bg) return;
    this.fitNameplateText(label, name);
    dot.setFillStyle(Phaser.Display.Color.HexStringToColor(statusColor).color);
    this.layoutNameplate(label, dot, bg);
  }

  /** Chamado de fora (GameRoom.tsx) toda vez que MEU nome ou status muda no card de perfil, pra refletir ao vivo no boneco dentro do jogo. */
  setLocalProfile(name: string, statusColor: string) {
    this.localName = name;
    this.localStatusColor = statusColor;
    if (this.localContainer) this.setNameplate(this.localContainer, name, statusColor);
  }

  /** Liga/desliga o clique nos bonecos (ver avatarClicksLocked) -- chamado de fora sempre que profileCard muda (GameRoom.tsx). */
  setAvatarClicksLocked(locked: boolean) {
    this.avatarClicksLocked = locked;
  }

  /** Troca o penteado do jogador LOCAL ao vivo (ver HAIR_CATALOG) -- chamado pelo editor de personagem (GameRoom.tsx). */
  setLocalHairId(hairId: string) {
    if (!this.localContainer) return;
    const sprite = this.localContainer.getData("hairSprite") as Phaser.GameObjects.Sprite | null;
    if (!sprite) return;
    const currentFrame = sprite.frame.name;
    sprite.setTexture(hairTextureKey(hairId), currentFrame);
    this.localContainer.setData("hairId", hairId);
  }

  /** Troca o tom de pele do jogador LOCAL ao vivo (ver SKIN_CATALOG) --
   * chamado pelo editor de personagem (GameRoom.tsx). Também reaplica a
   * textura do TRAJE e da BARBA equipados (se algum), porque a arte dos
   * dois varia por tom de pele -- ver resolveOutfitSkinId/
   * resolveBeardSkinId. Isso garante que trocar o tom mantém a mão e a
   * barba combinando, independente da ordem em que skin/traje/barba
   * forem trocados. */
  setLocalSkinId(skinId: string) {
    if (!this.localContainer) return;
    const sprite = this.localContainer.getData("skinSprite") as Phaser.GameObjects.Sprite | null;
    if (sprite) {
      // mesma checagem de createAvatar/"base" acima -- SKIN_CATALOG pode
      // não ter (ainda) nenhum tom custom carregado pro id escolhido
      // (ver fetchAndRegisterCustomSkins em GameRoom.tsx, que chama essa
      // função de novo assim que a textura terminar de carregar) --
      // esconde em vez de mostrar o quadriculado de "textura faltando".
      const textureKey = skinTextureKey(skinId);
      const exists = this.textures.exists(textureKey);
      if (exists) {
        const currentFrame = sprite.frame.name;
        sprite.setTexture(textureKey, currentFrame);
      }
      sprite.setVisible(exists);
    }
    this.localContainer.setData("skinId", skinId);

    const outfitSprite = this.localContainer.getData("outfitSprite") as Phaser.GameObjects.Sprite | null;
    const outfitId = this.localContainer.getData("outfitId") as string | undefined;
    if (outfitSprite && outfitId) {
      const outfit = OUTFIT_CATALOG.find((o) => o.id === outfitId);
      if (outfit) {
        const resolvedSkinId = resolveOutfitSkinId(outfit, skinId);
        if (resolvedSkinId) {
          const currentFrame = outfitSprite.frame.name;
          outfitSprite.setTexture(outfitTextureKey(outfit.id, resolvedSkinId), currentFrame);
          outfitSprite.setVisible(true);
        } else {
          // sem traje pro SEXO do tom novo (ver resolveOutfitSkinId) --
          // esconde em vez de deixar a textura antiga (de outro sexo)
          // grudada (bug relatado pelo Douglas: "masculino atrás").
          outfitSprite.setVisible(false);
        }
      }
    }

    const beardSprite = this.localContainer.getData("beardSprite") as Phaser.GameObjects.Sprite | null;
    const beardId = this.localContainer.getData("beardId") as string | undefined;
    if (beardSprite && beardId) {
      const beard = BEARD_CATALOG.find((b) => b.id === beardId);
      if (beard) {
        const resolvedBeardSkinId = resolveBeardSkinId(beard, skinId);
        if (resolvedBeardSkinId) {
          const currentFrame = beardSprite.frame.name;
          beardSprite.setTexture(beardTextureKey(beard.id, resolvedBeardSkinId), currentFrame);
          beardSprite.setVisible(true);
        } else {
          beardSprite.setVisible(false);
        }
      }
    }
  }

  /** Troca a barba do jogador LOCAL ao vivo (ver BEARD_CATALOG) -- chamado
   * pelo editor de personagem (GameRoom.tsx). Usa o tom de pele ATUAL do
   * jogador pra escolher a arte certa (ver resolveBeardSkinId) -- não
   * precisa escolha manual de cor/tom, igual o traje. */
  setLocalBeardId(beardId: string) {
    if (!this.localContainer) return;
    const sprite = this.localContainer.getData("beardSprite") as Phaser.GameObjects.Sprite | null;
    if (!sprite) return;
    const beard = BEARD_CATALOG.find((b) => b.id === beardId);
    if (!beard) return;
    const skinId = (this.localContainer.getData("skinId") as string | undefined) ?? DEFAULT_SKIN_ID;
    const resolvedSkinId = resolveBeardSkinId(beard, skinId);
    if (!resolvedSkinId) {
      // sem barba pro sexo do tom atual (ver resolveBeardSkinId) --
      // esconde em vez de deixar a textura de OUTRO sexo grudada.
      sprite.setVisible(false);
      this.localContainer.setData("beardId", beardId);
      return;
    }
    const currentFrame = sprite.frame.name;
    sprite.setTexture(beardTextureKey(beard.id, resolvedSkinId), currentFrame);
    sprite.setVisible(true);
    this.localContainer.setData("beardId", beardId);
  }

  /** Troca o acessório do jogador LOCAL ao vivo (ver ACCESSORY_CATALOG) -- chamado pelo editor de personagem (GameRoom.tsx). */
  setLocalAccessoryId(accessoryId: string) {
    if (!this.localContainer) return;
    const sprite = this.localContainer.getData("accessorySprite") as Phaser.GameObjects.Sprite | null;
    if (!sprite) return;
    const currentFrame = sprite.frame.name;
    sprite.setTexture(accessoryTextureKey(accessoryId), currentFrame);
    this.localContainer.setData("accessoryId", accessoryId);
  }

  /** Troca o traje do jogador LOCAL ao vivo (ver OUTFIT_CATALOG) --
   * chamado pelo editor de personagem (GameRoom.tsx), e também logo que
   * a cena fica pronta pra aplicar o traje sorteado no spawn (ver
   * pickRandomOutfitId em GameRoom.tsx). Guarda em localOutfitId SEMPRE
   * (mesmo se o boneco ainda não existir -- ver comentário no campo),
   * então funciona tanto ANTES quanto DEPOIS de create() ter rodado. Usa
   * o tom de pele ATUAL do jogador pra escolher a arte certa (mão
   * exposta, ver resolveOutfitSkinId) -- não precisa escolha manual de
   * cor/tom. */
  setLocalOutfitId(outfitId: string) {
    this.localOutfitId = outfitId;
    if (!this.localContainer) return;
    const sprite = this.localContainer.getData("outfitSprite") as Phaser.GameObjects.Sprite | null;
    if (!sprite) return;
    const outfit = OUTFIT_CATALOG.find((o) => o.id === outfitId);
    if (!outfit) return;
    const skinId = (this.localContainer.getData("skinId") as string | undefined) ?? DEFAULT_SKIN_ID;
    const resolvedSkinId = resolveOutfitSkinId(outfit, skinId);
    if (!resolvedSkinId) {
      // sem traje pro sexo do tom atual (ver resolveOutfitSkinId) --
      // esconde em vez de deixar a textura de OUTRO sexo grudada.
      sprite.setVisible(false);
      this.localContainer.setData("outfitId", outfitId);
      return;
    }
    const currentFrame = sprite.frame.name;
    sprite.setTexture(outfitTextureKey(outfit.id, resolvedSkinId), currentFrame);
    sprite.setVisible(true);
    this.localContainer.setData("outfitId", outfitId);
  }

  /**
   * Mostra o frame de "passo" (andando) na direção dada, direto -- sem
   * depender de uma animação com frameRate próprio. Um passo na grade
   * dura só STEP_DURATION_MS (180ms); uma animação por tempo (frameRate)
   * podia nem chegar a trocar de frame nesse intervalo curto, fazendo um
   * pulo de UM quadrado parecer que o boneco não se moveu de verdade.
   * Setando o frame direto, o "passo" fica visível a viagem toda.
   *
   * Alterna entre passoA/passoB a cada CHAMADA (ou seja, a cada passo de
   * verdade dado -- ver startStep/upsertRemotePlayer), não por tempo. Com
   * só 1 frame de passo o boneco "deslizava" parado; agora a perna troca
   * de fato a cada quadrado andado, contínuo ou não.
   */
  private playWalk(container: Phaser.GameObjects.Container, dir: Direction) {
    const layers = container.getData("layers") as Phaser.GameObjects.Sprite[];
    const prevDir = container.getData("dir") as Direction;
    // só alterna a perna se já estava andando NA MESMA direção -- ao
    // mudar de direção, recomeça do passoA pra ficar previsível
    const toggle = prevDir === dir ? !container.getData("stepToggle") : true;
    container.setData("dir", dir);
    container.setData("stepToggle", toggle);
    const frame = WALK_FRAMES[dir][toggle ? 1 : 2];
    for (const sprite of layers) sprite.setFrame(frame);
  }

  private stopWalk(container: Phaser.GameObjects.Container) {
    const layers = container.getData("layers") as Phaser.GameObjects.Sprite[];
    const dir = container.getData("dir") as Direction;
    const frame = WALK_FRAMES[dir][0];
    for (const sprite of layers) sprite.setFrame(frame);
  }

  private setPoseFrame(container: Phaser.GameObjects.Container, frame: number) {
    const layers = container.getData("layers") as Phaser.GameObjects.Sprite[];
    for (const sprite of layers) sprite.setFrame(frame);
  }

  /** Levanta (se estiver sentado) e libera o movimento de novo. */
  private standUp() {
    this.localActivity = "idle";
    this.seatedAt = null;
    this.sitCooldownUntil = this.time.now + STAND_COOLDOWN_MS;
    this.localContainer.setDepth(avatarDepthForY(this.localContainer.y));
    this.stopWalk(this.localContainer);
    // avisa o servidor que levantou (ver protocolo "seat" em
    // server/index.js) -- puramente pose-sync agora, NÃO solta posse
    // nenhuma (posse só muda via botão "Tomar posse"/onReleaseArea, ver
    // updateAreaHoverLabels).
    this.onLocalSeatChange?.(null);
    this.emitSeatTuningState();
  }

  /** Levanta o boneco local de fora (ver botão "Sair do assento" no "Assento" do editor de espaço, GameRoom.tsx) -- mesma coisa de levantar andando, só que sem precisar apertar seta (que durante o ajuste de assento não levanta mais, ver update()). Sem efeito se não estiver sentado. */
  standUpNow() {
    if (this.localActivity === "sentado") this.standUp();
  }

  /** Repõe o boneco local na posição de sentado, a partir do ajuste ATUAL (ver resolveSeatOffset) -- separado de sitAt() pra poder ser chamado nos dois casos: sentar de verdade (primeira vez) e só reposicionar depois de um nudge (ver nudgeSeatOffset), sem repetir toda a troca de pose/profundidade/aviso ao servidor. */
  private applySeatVisualPosition(furniture: FurnitureDef) {
    const pos = furnitureWorldPos(furniture);
    const offset = resolveSeatOffset(furniture, this.seatOffsets);
    this.localContainer.setPosition(pos.x + offset.x, pos.y + offset.y);
  }

  /** Senta automaticamente no móvel passado (chamado ao PARAR no tile dele). */
  private sitAt(furniture: FurnitureDef) {
    this.localActivity = "sentado";
    this.seatedAt = furniture;
    this.applySeatVisualPosition(furniture);
    // a pose sentada segue a direção que o móvel "olha" (facing), não a
    // direção que o jogador estava andando antes de sentar
    this.localContainer.setData("dir", furniture.facing);
    this.setPoseFrame(this.localContainer, SENTADO_FRAMES[furniture.facing]);
    // virado "up" (de costas pra câmera): o móvel fica NA FRENTE do
    // boneco, então só a cabeça aparece por cima do encosto -- isso é
    // uma EXCEÇÃO deliberada à regra geral de profundidade por fileira
    // (força o boneco pra 1px atrás desse móvel específico, não importa
    // o Y dele). Nas outras direções, usa a regra geral (avatarDepthForY)
    // -- como o assento fica dentro da própria fileira do móvel, ele já
    // sai na frente naturalmente, sentado "visível" sobre o móvel.
    this.localContainer.setDepth(
      furniture.facing === "up"
        ? furnitureDepthForTile(furniture.col, furniture.row) - 1
        : avatarDepthForY(this.localContainer.y)
    );
    // avisa o servidor que sentou (ver protocolo "seat" em
    // server/index.js) -- puramente pose-sync agora, NÃO toma posse de
    // mesa nenhuma (posse só muda via botão "Tomar posse", ver
    // onClaimArea/updateAreaHoverLabels).
    this.onLocalSeatChange?.(furniture.id);
    this.emitSeatTuningState();
  }

  /** Manda pro React (ver onSeatTuningChange) o estado atual do "Assento" -- null se não há nada pra ajustar agora (modo desligado, ou não sentado). Chamado sempre que esse estado pode ter mudado: sentou, levantou, ligou/desligou o modo, ou fez um nudge. */
  private emitSeatTuningState() {
    if (!this.seatTuningActive || !this.seatedAt) {
      this.onSeatTuningChange?.(null);
      return;
    }
    const offset = resolveSeatOffset(this.seatedAt, this.seatOffsets);
    this.onSeatTuningChange?.({
      groupKey: seatOffsetGroupKey(this.seatedAt),
      label: seatOffsetGroupLabel(this.seatedAt),
      facing: this.seatedAt.facing,
      x: offset.x,
      y: offset.y,
    });
  }

  /** Liga/desliga o modo de ajuste de assento (ver "Assento" no editor de espaço, GameRoom.tsx) -- com isso ligado E sentado, as setas de direção não levantam mais, viram nudge fino (ver update()/nudgeSeatOffset). */
  setSeatTuningMode(active: boolean) {
    this.seatTuningActive = active;
    this.emitSeatTuningState();
  }

  /** Carrega o mapa de ajuste de assento já salvo (ver GET /room/furniture em server/index.js) -- chamado pelo React assim que a busca inicial responder, mesmo timing de loadSavedFurniture/loadSavedFloor. */
  setSeatOffsets(map: FurnitureSeatOffsetsMap) {
    this.seatOffsets = map;
  }

  /** Ajusta fino (px) o assento do GRUPO (modelo, ver seatOffsetGroupKey) do item em que o boneco local está sentado agora -- ignorado se não estiver com o modo de ajuste ligado E sentado (ver setSeatTuningMode/update()). Reposiciona o boneco NA HORA (ver applySeatVisualPosition) e avisa o React (ver onSeatTuningChange), que autosalva (mesmo esquema de piso/área, debounced). */
  private nudgeSeatOffset(dx: number, dy: number, big: boolean) {
    if (!this.seatTuningActive || !this.seatedAt || this.movementLocked) return;
    const furniture = this.seatedAt;
    const step = big ? 5 : 1;
    const current = resolveSeatOffset(furniture, this.seatOffsets);
    const groupKey = seatOffsetGroupKey(furniture);
    const nextByFacing = { ...(this.seatOffsets[groupKey] ?? {}) };
    const nextValue = { x: current.x + dx * step, y: current.y + dy * step };
    nextByFacing[furniture.facing] = nextValue;
    this.seatOffsets = { ...this.seatOffsets, [groupKey]: nextByFacing };
    this.applySeatVisualPosition(furniture);
    this.emitSeatTuningState();
    this.onSeatOffsetChange?.(groupKey, furniture.facing, nextValue.x, nextValue.y);
  }

  /**
   * Apaga o ajuste de "Assento" salvo de um MODELO inteiro, nas 4
   * direções de uma vez -- diferente de resetSeatOffset (que só limpa a
   * direção ATUAL de quem tá sentado agora). Chamado quando o
   * seat_offset_x/y PADRÃO do próprio modelo muda no Editor de Itens
   * (ver onItemsChanged em GameRoom.tsx, ItemEditor.tsx): Douglas editou
   * lá, o preview mostrava certo, mas a sala continuava presa no ajuste
   * "Assento" antigo (prioridade #1 em resolveSeatOffset, por cima do
   * padrão do modelo) -- "no editor ta certo no mapa real nao ficou".
   * Limpar aqui deixa o valor recém-editado valer na hora, sem precisar
   * abrir "Assento" de novo só pra destravar. Reposiciona quem estiver
   * sentado nesse modelo agora, se houver (não precisa estar sentado
   * pra chamar -- ao contrário de resetSeatOffset/nudgeSeatOffset).
   *
   * BUG achado no teste do Douglas ("continua torto"): o `return` cedo
   * de baixo (nada pra limpar -> nem reposiciona) tava pulando o
   * reposicionamento sempre que o item NUNCA tinha um ajuste "Assento"
   * salvo com essa MESMA chave -- que é o caso mais comum, já que o
   * ajuste antigo (de antes dos modelos custom terem UUID) tava salvo
   * numa chave-lixo qualquer (ex: "gamer", o rótulo do item, não o id
   * de verdade) que nunca bateu com seatOffsetGroupKey(f) (sempre
   * f.modelId, o UUID) -- ou seja, na prática QUASE NUNCA existia
   * mesmo uma entrada pra apagar aqui, e o boneco já sentado ficava
   * pra sempre com a posição de ANTES da edição, só porque não tinha
   * "nada pra limpar". Reposicionar não pode depender de ter achado
   * algo pra apagar -- o padrão do MODELO mudou de qualquer jeito
   * (resolveSeatOffset prioridade #3), então quem já tá sentado nesse
   * modelo sempre precisa recalcular, com ou sem ajuste "Assento"
   * salvo por cima.
   */
  clearSeatOffsetsForModel(groupKey: string) {
    if (groupKey in this.seatOffsets) {
      const next = { ...this.seatOffsets };
      delete next[groupKey];
      this.seatOffsets = next;
    }
    if (this.seatedAt && seatOffsetGroupKey(this.seatedAt) === groupKey) {
      this.applySeatVisualPosition(this.seatedAt);
      this.emitSeatTuningState();
    }
  }

  /** Botão "Redefinir" do "Assento" (ver EditPanel, GameRoom.tsx) -- apaga o ajuste manual do grupo+direção atual (volta pro padrão genérico, ver resolveSeatOffset). Ignorado se não estiver sentado. */
  resetSeatOffset() {
    if (!this.seatedAt) return;
    const furniture = this.seatedAt;
    const groupKey = seatOffsetGroupKey(furniture);
    const byFacing = this.seatOffsets[groupKey];
    if (byFacing && furniture.facing in byFacing) {
      const nextByFacing = { ...byFacing };
      delete nextByFacing[furniture.facing];
      this.seatOffsets = { ...this.seatOffsets, [groupKey]: nextByFacing };
    }
    this.applySeatVisualPosition(furniture);
    this.emitSeatTuningState();
    this.onSeatOffsetReset?.(groupKey, furniture.facing);
  }

  /**
   * Só considera sentar quando o boneco está IDLE (parado, não no meio
   * de um passo) exatamente em cima do tile de uma cadeira -- andar
   * perto ou passar por cima sem parar não senta.
   */
  private findChairAtCurrentTile(): FurnitureDef | null {
    if (this.time.now < this.sitCooldownUntil) return null;
    const { col, row } = worldToTile(this.localContainer.x, this.localContainer.y);
    // só item sentável (ver isFurnitureSittable em furniture.ts -- por
    // MODELO se o Editor de Itens já escolheu, senão cai no fallback por
    // categoria, hoje poltrona/sofá) -- vidro/mesa/planta/computador (ou
    // um custom marcado "Nenhuma" interação) não devem disparar o
    // auto-sentar só por o boneco parar em cima do tile dele. Procura
    // tanto na mobília FIXA
    // (ROOM_FURNITURE) quanto na colocada pelo editor (draftFurniture --
    // desde que ganhou persistência de verdade, ver POST /room/furniture,
    // esses itens também precisam ser sentáveis na hora, sem precisar de
    // restart/deploy).
    for (const f of ROOM_FURNITURE) {
      if (isFurnitureSittable(f) && f.col === col && f.row === row) return f;
    }
    for (const f of this.draftFurniture.values()) {
      if (isFurnitureSittable(f) && f.col === col && f.row === row) return f;
    }
    return null;
  }

  /** Relata a posição atual pro servidor, no máximo a cada 50ms. */
  private reportPosition(_time: number) {
    if (_time - this.lastSent > 50) {
      this.lastSent = _time;
      this.onLocalMove?.(this.localContainer.x, this.localContainer.y);
      // mesmo throttle de 50ms do relato pro servidor -- não precisa
      // recalcular a cada frame de verdade, só reagir rápido o
      // suficiente quando o jogador entra/sai de uma área (ver
      // updateAreaDim/DEPTH_AREA_DIM acima).
      this.updateAreaDim();
    }
  }

  /**
   * Liga/desliga a leitura de teclado (ver comentário em movementLocked).
   * O flag sozinho barra o MOVIMENTO, mas não bastava: o Phaser também
   * "captura" teclas de seta globalmente (preventDefault direto no
   * KeyboardManager, ANTES de qualquer isDown/enabled de plugin) só pra
   * evitar a página rolar durante o jogo -- só que isso quebra também o
   * cursor de texto (setinha esquerda/direita) dentro de um input
   * focado. disableGlobalCapture()/enableGlobalCapture() desliga essa
   * captura por completo enquanto um campo de texto tá focado.
   */
  setMovementLocked(locked: boolean) {
    this.movementLocked = locked;
    if (locked) {
      this.walkQueue = []; // trava também cancela um destino clicado pendente
      this.input.keyboard?.disableGlobalCapture();
    } else {
      this.input.keyboard?.enableGlobalCapture();
    }
  }

  // --- câmera: zoom + arrastar pra olhar ao redor (botões em
  // MapControls, GameRoom.tsx) -------------------------------------

  /** Começa a arrastar a câmera com o mouse -- ignorado durante o editor
   * de espaço (o pointerdown ali já é pra colocar/selecionar móvel). */
  private startCameraPan(pointer: Phaser.Input.Pointer) {
    if (this.editMode) return;
    this.isPanningCamera = true;
    this.panStart = { x: pointer.x, y: pointer.y };
    this.panStartScroll = { x: this.cameras.main.scrollX, y: this.cameras.main.scrollY };
  }

  private handleCameraPan(pointer: Phaser.Input.Pointer) {
    if (!this.isPanningCamera || !pointer.isDown) return;
    // divide pelo zoom -- arrastar 1px de MOUSE precisa mover mais de
    // 1px de MUNDO quando a câmera tá afastada (zoom baixo) e menos
    // quando tá aproximada (zoom alto), senão o boneco "foge" ou "gruda"
    // no cursor dependendo do zoom atual.
    const zoom = this.cameras.main.zoom;
    const dx = (pointer.x - this.panStart.x) / zoom;
    const dy = (pointer.y - this.panStart.y) / zoom;
    this.setClampedScroll(this.panStartScroll.x - dx, this.panStartScroll.y - dy);
  }

  private stopCameraPan() {
    this.isPanningCamera = false;
  }

  /**
   * Antes limitava o quanto dava pra arrastar (ver PAN_MARGIN/
   * PAN_SLACK_ZOOMED_OUT) com DOIS regimes diferentes dependendo do
   * zoom (view cabendo ou não dentro da sala+margem) -- o Douglas
   * reportou isso como "dois limites nas laterais" e pediu pra tirar.
   * Agora é passagem direta, sem limite nenhum: arrasta livre em
   * qualquer zoom. Mantido como função (em vez de sumir e trocar as
   * chamadas por cam.setScroll direto) só pra não precisar mexer em
   * quem já chama setClampedScroll/clampCameraScroll -- se um dia
   * quiser algum limite de novo, é só voltar a clampar aqui.
   */
  private clampCameraScroll(x: number, y: number) {
    return { x, y };
  }

  private setClampedScroll(x: number, y: number) {
    const clamped = this.clampCameraScroll(x, y);
    this.cameras.main.setScroll(clamped.x, clamped.y);
  }

  private stopFloorPaint() {
    this.isPaintingFloor = false;
    this.lastPaintedFloorKey = null;
  }

  private stopAreaPaint() {
    this.isPaintingArea = false;
    this.lastPaintedAreaKey = null;
  }

  /** Aplica um novo zoom mantendo o mesmo PONTO CENTRAL da câmera --
   * setZoom sozinho "puxa" a visão pro canto 0,0 do mundo, o que dá um
   * pulo feio na tela toda vez que aperta "+"/"-". */
  private applyZoom(nextZoom: number) {
    const clamped = Phaser.Math.Clamp(nextZoom, MIN_ZOOM_LEVEL, MAX_ZOOM_LEVEL);
    const cam = this.cameras.main;
    const centerX = cam.worldView.centerX;
    const centerY = cam.worldView.centerY;
    cam.setZoom(clamped);
    cam.centerOn(centerX, centerY);
    // centerOn não passa pelo clampCameraScroll (só handleCameraPan
    // chamava antes) -- sem isso, dar zoom out depois de arrastar até
    // a borda da margem podia deixar o scroll fora do range válido
    // pro novo zoom.
    this.setClampedScroll(cam.scrollX, cam.scrollY);
    // cartão de nome tem que ficar do mesmo tamanho na tela em
    // qualquer zoom (ver refreshNameplateScale) -- recalcula toda vez
    // que o zoom muda.
    this.refreshNameplateScale();
    return clamped;
  }

  /** Botão "+" do MapControls -- devolve o zoom já aplicado (limitado),
   * pra GameRoom.tsx saber quando desabilitar o botão no teto. */
  zoomIn(): number {
    return this.applyZoom(this.cameras.main.zoom + ZOOM_STEP);
  }

  /** Botão "-" do MapControls -- mesma ideia, limitado no piso. */
  zoomOut(): number {
    return this.applyZoom(this.cameras.main.zoom - ZOOM_STEP);
  }

  /** Zoom pela roda do mouse/trackpad (ver o listener de "wheel" no
   * container do canvas em GameRoom.tsx) -- mesma lógica de
   * zoomIn/zoomOut (aplica e limita, devolve o valor já aplicado pra
   * sincronizar o estado dos botões +/-), só que o passo vem de fora em
   * vez do ZOOM_STEP fixo, porque a intensidade do gesto varia (roda de
   * mouse dá "cliques" grandes, dois dedos no trackpad é mais suave e
   * contínuo). */
  zoomBy(delta: number): number {
    return this.applyZoom(this.cameras.main.zoom + delta);
  }

  /** Botão de centralizar (ícone de mira) do MapControls -- volta a
   * câmera pro boneco local, SEM mudar o zoom atual (igual o Gather). */
  recenterCamera() {
    const cam = this.cameras.main;
    cam.centerOn(this.localContainer.x, this.localContainer.y);
    this.setClampedScroll(cam.scrollX, cam.scrollY);
  }

  /** Tecla de direção pressionada agora, só uma por vez (sem diagonal). */
  private readInputDir(): Direction | null {
    if (this.movementLocked) return null;
    const left = this.cursors.left?.isDown || this.wasd.left.isDown;
    const right = this.cursors.right?.isDown || this.wasd.right.isDown;
    const up = this.cursors.up?.isDown || this.wasd.up.isDown;
    const down = this.cursors.down?.isDown || this.wasd.down.isDown;
    // prioridade fixa quando mais de uma tecla está pressionada junto
    if (down) return "down";
    if (up) return "up";
    if (left) return "left";
    if (right) return "right";
    return null;
  }

  /** Começa a andar um tile na direção pedida, se o destino for válido. */
  private startStep(dir: Direction) {
    const { col, row } = worldToTile(this.localContainer.x, this.localContainer.y);
    const delta = { down: [0, 1], up: [0, -1], left: [-1, 0], right: [1, 0] }[dir];
    const target = clampTile(col + delta[0], row + delta[1]);
    const targetPos = tileToWorld(target.col, target.row);

    // bateu na borda do mapa (destino = posição atual) OU o tile de
    // destino é travado por um móvel (ex: divisória de vidro, ver
    // FURNITURE_BLOCKS_MOVEMENT em furniture.ts) -- nos dois casos só
    // vira de frente pra direção pedida, sem "andar" de verdade.
    const blocked =
      (targetPos.x === this.localContainer.x && targetPos.y === this.localContainer.y) ||
      this.isMovementBlockedAt(target.col, target.row);
    if (blocked) {
      this.localContainer.setData("dir", dir);
      this.stopWalk(this.localContainer);
      return;
    }

    this.stepping = true;
    this.stepDir = dir;
    this.stepFrom = { x: this.localContainer.x, y: this.localContainer.y };
    this.stepTo = targetPos;
    this.stepElapsed = 0;
    this.playWalk(this.localContainer, dir);
  }

  update(_time: number, delta: number) {
    const inputDir = this.readInputDir();

    if (this.localActivity === "sentado") {
      // com o "Assento" ligado (ver setSeatTuningMode), a seta NÃO
      // levanta mais -- vira nudge fino do assento (ver
      // nudgeSeatOffset, disparado pelos listeners "keydown-*" no
      // create(), não por aqui/por polling).
      // walkQueue também levanta (defensivo -- na prática
      // handleRoomPointerDown já chama standUp() direto antes de montar a
      // fila, então localActivity já não é mais "sentado" quando esse
      // frame roda; isso só cobre alguma sentada futura no meio do
      // caminho por outro caminho de código).
      if ((inputDir || this.walkQueue.length > 0) && !this.seatTuningActive) {
        // qualquer tecla de direção levanta -- o passo de verdade só
        // começa no próximo frame (já sai da cadeira "de pé" primeiro)
        this.standUp();
      }
      this.reportPosition(_time);
      return;
    }

    if (this.stepping) {
      this.stepElapsed += delta;
      const t = Math.min(1, this.stepElapsed / STEP_DURATION_MS);
      const x = Phaser.Math.Linear(this.stepFrom.x, this.stepTo.x, t);
      const y = Phaser.Math.Linear(this.stepFrom.y, this.stepTo.y, t);
      this.localContainer.setPosition(x, y);

      if (t >= 1) {
        this.stepping = false;
        this.localContainer.setPosition(this.stepTo.x, this.stepTo.y);
      }
    } else if (inputDir) {
      // teclado sempre tem prioridade sobre o clique-pra-andar -- apertar
      // uma seta/WASD cancela o destino clicado na hora, devolve o
      // controle todo pro teclado.
      this.walkQueue = [];
      this.startStep(inputDir);
    } else if (this.walkQueue.length > 0) {
      const dir = this.walkQueue.shift()!;
      this.startStep(dir);
      if (!this.stepping) {
        // startStep recusou o passo (tile ficou bloqueado nesse
        // meio-tempo -- ex: alguém colocou um móvel no caminho enquanto o
        // boneco já estava andando pra lá) -- cancela o resto do caminho
        // em vez de continuar tentando às cegas contra um caminho que já
        // não bate mais com o mapa atual.
        this.walkQueue = [];
      }
    } else {
      // totalmente parado (não só entre passos) -- só aqui checa auto-sentar
      this.stopWalk(this.localContainer);
      const chair = this.findChairAtCurrentTile();
      if (chair) this.sitAt(chair);
    }

    // profundidade recalculada todo frame (contínuo, mesmo no meio de um
    // passo) pra passar por trás/na frente dos móveis suavemente -- só
    // NÃO faz isso se acabou de sentar agora mesmo (sitAt já setou a
    // profundidade certa, inclusive a exceção de virado "up", e isso
    // sobrescreveria ela).
    // cast: TS estreita localActivity pra "idle" logo no topo desta
    // função (por causa do early-return no if de cima) e não enxerga que
    // sitAt() -- chamado poucas linhas acima, dentro do branch "parado"
    // -- pode ter mudado pra "sentado" nesse meio tempo; sem o cast, ele
    // acusa a comparação como "sempre falsa" (TS2367), o que não é
    // verdade em runtime.
    if ((this.localActivity as Activity) !== "sentado") {
      this.localContainer.setDepth(avatarDepthForY(this.localContainer.y));
    }

    this.reportPosition(_time);
  }

  upsertRemotePlayer(
    id: string,
    x: number,
    y: number,
    color: string,
    name: string,
    statusColor: string = "#4fd97a"
  ) {
    let container = this.remoteContainers.get(id);
    if (!container) {
      container = this.createAvatar(x, y, color, name, false, id, statusColor);
      this.remoteContainers.set(id, container);
    } else {
      this.setNameplate(container, name, statusColor);
      const dx = x - container.x;
      const dy = y - container.y;
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 1) {
        this.playWalk(container, dx > 0 ? "right" : "left");
      } else if (Math.abs(dy) > 1) {
        this.playWalk(container, dy > 0 ? "down" : "up");
      } else {
        this.stopWalk(container);
      }
      const target = container;
      this.tweens.add({
        targets: container,
        x,
        y,
        duration: 90,
        ease: "Linear",
        // mesma profundidade dinâmica do boneco local (ver update()) --
        // jogador remoto também passa por trás/na frente dos móveis
        // conforme a fileira. Isso é só pro MOVIMENTO -- sentado, ele já
        // não manda mais "move" nenhum (fica parado), então esse tween
        // nem roda mais; a pose/profundidade especial de "sentado" (ver
        // comentário em sitAt) é ajustada à parte, por setRemoteSeat, ao
        // receber "seat" pela rede.
        onUpdate: () => target.setDepth(avatarDepthForY(target.y)),
        onComplete: () => this.stopWalk(target),
      });
    }
  }

  removeRemotePlayer(id: string) {
    const container = this.remoteContainers.get(id);
    if (container) {
      container.destroy();
      this.remoteContainers.delete(id);
    }
    // limpa a pose sentada guardada dele -- a posse de mesa privada (se
    // houver) já é solta pelo PRÓPRIO servidor ao desconectar (ver
    // ws.on("close") em server/index.js, que manda "area-owner" null
    // antes do "leave"), então não precisa recalcular nada aqui.
    this.remoteSeat.delete(id);
  }

  getLocalPosition() {
    return { x: this.localContainer.x, y: this.localContainer.y };
  }

  // ------------------------------------------------------------------
  // Editor de espaço -- API pública chamada de fora (GameRoom.tsx),
  // igual ao onLocalMove/upsertRemotePlayer já existentes.
  // ------------------------------------------------------------------

  /** Liga/desliga o modo de edição (mostra/esconde a grade, some com a seleção da paleta/piso). Os itens já colocados continuam na cena dos dois jeitos. */
  setEditMode(active: boolean) {
    this.editMode = active;
    this.selectedCatalogEntry = null;
    this.selectedFloorTool = null;
    this.selectedAreaTool = null;
    this.moveToolActive = false;
    this.deleteToolActive = false;
    this.cancelMovingFurniture();
    this.refreshCatalogGhost();
    this.gridGraphics?.setVisible(active);
    if (!active) this.hoverGraphics?.setVisible(false);
    // entrar no modo de edição cancela um destino de clique-pra-andar
    // pendente e some com o destaque leve do tile (esse é só do uso
    // normal, ver roomHoverGraphics/handleRoomPointerMove) -- os dois
    // voltam a fazer algo só depois de sair do editor de novo.
    if (active) {
      this.walkQueue = [];
      this.roomHoverGraphics?.setVisible(false);
    }
    // a tinta/contorno de área fica mais forte durante a edição (pra
    // pintar com precisão) e mais discreta no uso normal (só um lembrete
    // visual de onde a área está) -- ver refreshAreaTileAlpha/
    // redrawAreaBorders.
    this.refreshAreaTileAlpha();
    this.redrawAreaBorders();
  }

  /** Escolhe qual item da paleta o próximo clique num tile livre vai colocar (null = nenhum selecionado, clique não faz nada em tile livre). Selecionar um item de móvel desarma as outras ferramentas (piso/área/mover, ver selectFloorTool/selectAreaTool/selectMoveTool) -- só uma ferramenta ativa por vez. */
  selectCatalogEntry(entry: FurnitureCatalogEntry | null) {
    this.selectedCatalogEntry = entry;
    this.selectedFloorTool = null;
    this.selectedAreaTool = null;
    this.deleteToolActive = false;
    this.selectMoveTool(false);
    this.refreshCatalogGhost();
  }

  /**
   * Cria (ou recria, ou remove) o "fantasma" que acompanha o cursor com o
   * item atualmente selecionado na paleta (ver catalogGhostSprite acima) --
   * chamado toda vez que selectedCatalogEntry muda, de qualquer um dos
   * métodos que mexem nele (setEditMode/selectCatalogEntry/selectFloorTool/
   * selectAreaTool/selectMoveTool/selectDeleteTool). Usa o MESMO
   * addFurnitureSprite de sempre (mesma textura/tamanho/cor de um item de
   * verdade), só com opacidade reduzida (CATALOG_GHOST_ALPHA) -- pedido do
   * Douglas: ver o resultado exato antes de clicar pra colocar. A posição
   * de verdade (seguindo o mouse) é responsabilidade de
   * handleEditPointerMove, chamado a cada frame -- aqui só troca a
   * TEXTURA/aparência quando a seleção muda.
   */
  private refreshCatalogGhost() {
    this.catalogGhostSprite?.destroy();
    this.catalogGhostSprite = null;
    const entry = this.selectedCatalogEntry;
    if (!entry) return;
    const ghostDef: FurnitureDef = {
      id: "__catalog_ghost__",
      type: entry.type,
      col: 0,
      row: 0,
      facing: entry.facing,
      modelId: entry.modelId,
      colorId: entry.colorId,
      seatOffsetY: entry.seatOffsetY,
      seatOffsetX: entry.seatOffsetX,
      baseOffsetY: entry.baseOffsetY,
    };
    const sprite = this.addFurnitureSprite(ghostDef);
    sprite.setAlpha(sprite.alpha * CATALOG_GHOST_ALPHA);
    sprite.disableInteractive();
    sprite.setVisible(false); // só aparece quando o mouse entra na grade num tile livre, ver handleEditPointerMove
    this.catalogGhostSprite = sprite;
  }

  /** Liga/desliga a ferramenta "Mover" do editor de espaço -- ver
   * comentário em moveToolActive/movingFurnitureId acima. Desarma as
   * outras ferramentas ao ligar (mesmo padrão de selectFloorTool/
   * selectAreaTool/selectCatalogEntry) e sempre solta (sem mover)
   * qualquer item que estivesse em mãos ao desligar. */
  selectMoveTool(active: boolean) {
    this.moveToolActive = active;
    if (active) {
      this.selectedCatalogEntry = null;
      this.selectedFloorTool = null;
      this.selectedAreaTool = null;
      this.deleteToolActive = false;
      this.refreshCatalogGhost();
    } else {
      this.cancelMovingFurniture();
    }
  }

  /** Liga/desliga a ferramenta "Apagar" do editor de espaço: com ela armada,
   * clicar num item já colocado apaga ele na hora (mesma restrição de
   * sempre: só rascunho, móvel FIXO de ROOM_FURNITURE não é editável por
   * aqui) -- clicar em tile vazio não faz nada. Substitui o comportamento
   * antigo de apagar ao clicar em cima de qualquer item já colocado, em
   * QUALQUER aba de móvel, sem precisar armar nada (fácil de apagar sem
   * querer tentando clicar do lado pra colocar outro item -- pedido do
   * Douglas: um botão explícito, fora da lista de linha do painel). Desarma
   * as outras ferramentas ao ligar (mesmo padrão de selectFloorTool/
   * selectAreaTool/selectCatalogEntry/selectMoveTool) -- só uma ferramenta
   * ativa por vez. */
  selectDeleteTool(active: boolean) {
    this.deleteToolActive = active;
    if (active) {
      this.selectedCatalogEntry = null;
      this.selectedFloorTool = null;
      this.selectedAreaTool = null;
      this.selectMoveTool(false);
      this.refreshCatalogGhost();
    }
  }

  /** Solta (sem mover) o item em mãos da ferramenta "Mover", se houver -- tira o destaque visual e limpa movingFurnitureId. Chamado ao desligar a ferramenta, clicar de novo no tile de origem, ou sair do modo de edição. */
  private cancelMovingFurniture() {
    if (!this.movingFurnitureId) return;
    this.draftSprites.get(this.movingFurnitureId)?.clearTint();
    this.movingFurnitureId = null;
  }

  getDraftFurnitureList(): FurnitureDef[] {
    return Array.from(this.draftFurniture.values());
  }

  /**
   * Carrega a mobília ADICIONAL já salva (ver GET /room/furniture em
   * server/index.js) -- chamado pelo React assim que a cena fica pronta,
   * mesmo timing/mesma ideia de loadSavedFloor: cada item carregado
   * entra direto em draftFurniture/draftSprites (MESMO Map que o clique
   * do editor usa), já sentável na hora (ver findChairAtCurrentTile) e
   * travando passagem se for o caso (ver isMovementBlockedAt), sem
   * precisar entrar no modo de edição pra isso valer.
   */
  loadSavedFurniture(items: FurnitureDef[]) {
    for (const f of items) {
      if (this.draftFurniture.has(f.id)) continue; // já carregado (ex: chamado 2x) -- não duplica sprite
      const sprite = this.addFurnitureSprite(f);
      this.draftFurniture.set(f.id, f);
      this.draftSprites.set(f.id, sprite);
    }
    this.onDraftChange?.(this.getDraftFurnitureList());
  }

  removeDraftFurniture(id: string) {
    this.draftSprites.get(id)?.destroy();
    this.draftSprites.delete(id);
    this.draftFurniture.delete(id);
    this.onDraftChange?.(this.getDraftFurnitureList());
  }

  clearDraftFurniture() {
    for (const sprite of this.draftSprites.values()) sprite.destroy();
    this.draftSprites.clear();
    this.draftFurniture.clear();
    this.movingFurnitureId = null; // o item em mãos (se houver) acabou de ser destruído junto
    this.onDraftChange?.(this.getDraftFurnitureList());
  }

  /** Escolhe a ferramenta de piso ativa: {kind:"paint", entry} pinta esse modelo, {kind:"erase"} apaga, null desarma. Escolher uma ferramenta de piso desarma as outras (móvel/área/mover, ver selectCatalogEntry/selectAreaTool/selectMoveTool) -- só uma ferramenta ativa por vez. */
  selectFloorTool(tool: FloorTool) {
    this.selectedFloorTool = tool;
    this.selectedCatalogEntry = null;
    this.selectedAreaTool = null;
    this.deleteToolActive = false;
    this.selectMoveTool(false);
    this.refreshCatalogGhost();
  }

  getDraftFloorList(): FloorTileDef[] {
    return Array.from(this.draftFloor.values());
  }

  clearDraftFloor() {
    for (const sprite of this.draftFloorSprites.values()) sprite.destroy();
    this.draftFloorSprites.clear();
    this.draftFloor.clear();
    this.onDraftFloorChange?.(this.getDraftFloorList());
  }

  /** Escolhe a ferramenta de área ativa -- mesma ideia da selectFloorTool acima, {kind:"paint", areaId} pinta a área escolhida NA LISTA (ver setAreaDefs), {kind:"erase"} apaga. Desarma móvel/piso/mover (só uma ferramenta ativa por vez). */
  selectAreaTool(tool: AreaTool) {
    this.selectedAreaTool = tool;
    this.selectedCatalogEntry = null;
    this.selectedFloorTool = null;
    this.deleteToolActive = false;
    this.selectMoveTool(false);
    this.refreshCatalogGhost();
  }

  getDraftAreaList(): AreaTileDef[] {
    return Array.from(this.draftArea.values());
  }

  clearDraftArea() {
    for (const sprite of this.draftAreaSprites.values()) sprite.destroy();
    this.draftAreaSprites.clear();
    this.draftArea.clear();
    this.refreshAreas();
    this.onDraftAreaChange?.(this.getDraftAreaList());
  }

  /**
   * Carrega a área já salva no servidor (ver GET /room/areas em
   * server/index.js) -- mesma ideia/timing do loadSavedFloor (chamado
   * pelo React assim que a cena fica pronta E a busca responder), só que
   * DEPOIS de setAreaDefs (a cor de cada tile vem da área dona dele, ver
   * addAreaTileRect -- precisa a lista já carregada).
   */
  loadSavedAreas(items: AreaTileDef[]) {
    for (const a of items) {
      const key = `${a.col},${a.row}`;
      if (this.draftArea.has(key)) continue; // já carregado (ex: chamado 2x) -- não duplica sprite
      if (!this.areaDefs.has(a.areaId)) continue; // órfão (área apagada entre salvar e carregar) -- não desenha lixo
      const rect = this.addAreaTileRect(a);
      this.draftArea.set(key, a);
      this.draftAreaSprites.set(key, rect);
    }
    this.refreshAreas();
    this.onDraftAreaChange?.(this.getDraftAreaList());
  }

  /**
   * Atualiza a LISTA de áreas criadas (nome + tipo, ver AreaDef em
   * game/areas.ts) -- chamado de fora (GameRoom.tsx) toda vez que ela
   * muda (criar/apagar uma área no painel React; criar uma área é
   * preencher um formulário, não clicar num tile, então quem manda essa
   * lista é sempre o React, nunca a própria cena). Uma área apagada da
   * lista deixa "órfãos" os tiles que apontavam pra ela (ver
   * AreaTileDef.areaId) -- esses são removidos aqui também, pra nunca
   * sobrar tinta na tela de uma área que não existe mais.
   */
  setAreaDefs(list: AreaDef[]) {
    this.areaDefs = new Map(list.map((a) => [a.id, a]));
    let prunedAny = false;
    for (const [key, tile] of Array.from(this.draftArea.entries())) {
      if (this.areaDefs.has(tile.areaId)) continue;
      this.draftAreaSprites.get(key)?.destroy();
      this.draftAreaSprites.delete(key);
      this.draftArea.delete(key);
      prunedAny = true;
    }
    this.refreshAreas();
    if (prunedAny) this.onDraftAreaChange?.(this.getDraftAreaList());
  }

  /**
   * Atualiza quem é dono de uma área "mesa-privada" (ver
   * "claim-area"/"release-area" no protocolo de server/index.js) --
   * chamado de fora (GameRoom.tsx) a cada broadcast "area-owner"
   * recebido (inclusive os que já vêm dentro de "init", pra quem entra
   * DEPOIS de uma mesa já ter dono). playerId "local" identifica o
   * PRÓPRIO jogador (ver onClaimArea/onAreaOwnerClick). null/null
   * significa "essa área voltou a ficar sem dono".
   */
  setAreaOwner(areaId: string, playerId: string | null, name: string | null) {
    if (playerId && name) this.areaOwnerByAreaId.set(areaId, { playerId, name });
    else this.areaOwnerByAreaId.delete(areaId);
    this.updateAreaHoverLabels();
  }

  /**
   * Consulta pura: em qual área (se alguma) a posição em MUNDO (x, y)
   * cai -- devolve o id dela ou null. Usado de fora (checkProximity em
   * GameRoom.tsx) tanto pra posição local quanto pra cada jogador
   * remoto, pra decidir isolamento de áudio/vídeo: dois jogadores só se
   * conectam por proximidade normal se NENHUM dos dois estiver numa
   * área; se algum estiver, só conectam se for a MESMA área.
   */
  areaZoneAt(x: number, y: number): string | null {
    const { col, row } = worldToTile(x, y);
    return areaIdAtTile(this.getDraftAreaList(), col, row) ?? null;
  }

  /**
   * Atualiza o que o jogador REMOTO `id` tá sentado agora (ver "seat" no
   * protocolo de server/index.js) -- chamado pelo GameRoom.tsx a cada
   * mensagem "seat" recebida (própria ou já presente no "init"/"join").
   * Só corrige a POSE do boneco remoto pra pose sentada do móvel (a
   * posição em si já chega certa pelo "move" de sempre, ver comentário
   * no protocolo) -- NÃO tem mais nada a ver com posse de mesa privada,
   * que agora é um botão explícito ("Tomar posse", ver
   * onClaimArea/onReleaseArea), não sentar numa cadeira.
   */
  setRemoteSeat(id: string, furnitureId: string | null, name: string) {
    this.remoteSeat.set(id, { furnitureId, name });
    if (furnitureId) {
      const furniture = this.furnitureById(furnitureId);
      const container = this.remoteContainers.get(id);
      if (furniture && container) {
        container.setData("dir", furniture.facing);
        this.setPoseFrame(container, SENTADO_FRAMES[furniture.facing]);
        container.setDepth(
          furniture.facing === "up"
            ? furnitureDepthForTile(furniture.col, furniture.row) - 1
            : avatarDepthForY(container.y)
        );
      }
    }
  }

  /** Item de mobília (fixo OU rascunho) com esse id, se houver -- usado só pra achar em qual tile uma cadeira ocupada está (ver setRemoteSeat). */
  private furnitureById(id: string): FurnitureDef | undefined {
    return ROOM_FURNITURE.find((f) => f.id === id) ?? this.draftFurniture.get(id);
  }

  /**
   * Pinta (ou apaga, se a ferramenta ativa for "erase") o tile col/row
   * com a ferramenta de piso selecionada -- chamado tanto por um clique
   * único quanto, repetidamente, durante um arrasto (ver
   * handleEditPointerDown/handleCameraPan... não, handleEditPointerMove
   * mais embaixo). Sem ferramenta selecionada, não faz nada.
   */
  private paintFloorAt(col: number, row: number) {
    const tool = this.selectedFloorTool;
    if (!tool) return;
    const key = `${col},${row}`;

    if (tool.kind === "erase") {
      const existing = this.draftFloor.get(key);
      if (!existing) return; // nada pintado aqui nesta sessão, não tem o que apagar
      this.draftFloorSprites.get(key)?.destroy();
      this.draftFloorSprites.delete(key);
      this.draftFloor.delete(key);
      this.onDraftFloorChange?.(this.getDraftFloorList());
      return;
    }

    const existing = this.draftFloor.get(key);
    if (existing && existing.styleId === tool.entry.id) return; // já pintado com o mesmo modelo, nada a fazer

    this.draftFloorSprites.get(key)?.destroy();
    const def: FloorTileDef = { col, row, styleId: tool.entry.id };
    const sprite = this.addFloorSprite(def);
    if (!sprite) return;
    this.draftFloor.set(key, def);
    this.draftFloorSprites.set(key, sprite);
    this.onDraftFloorChange?.(this.getDraftFloorList());
  }

  /**
   * Pinta (via paintFloorAt) cada tile ao longo da linha reta entre o
   * último tile pintado e o tile atual, não só o tile de chegada --
   * durante um arrasto rápido o pointermove pode "pular" um tile inteiro
   * sem nenhum evento disparando em cima dele (o quadrado tem 60px), o
   * que deixava buracos na pintura. Bresenham simples em coordenadas de
   * grade (col/row), não em pixels.
   */
  private paintFloorLine(fromCol: number, fromRow: number, toCol: number, toRow: number) {
    let x0 = fromCol;
    let y0 = fromRow;
    const dx = Math.abs(toCol - x0);
    const dy = -Math.abs(toRow - y0);
    const sx = x0 < toCol ? 1 : -1;
    const sy = y0 < toRow ? 1 : -1;
    let err = dx + dy;
    // limite de segurança -- a grade é pequena (12x7), nunca deveria
    // precisar de mais passos que isso; só evita um loop infinito se
    // algum bug futuro passar coordenadas malucas.
    for (let i = 0; i < 200; i++) {
      this.paintFloorAt(x0, y0);
      if (x0 === toCol && y0 === toRow) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  /**
   * Cria o losango de tinta de UM tile de área -- sem textura própria
   * (diferente do piso/mobília), é só uma cor chapada semi-transparente
   * (a cor vem do TIPO da área dona do tile, ver areaDefs/AREA_TYPES em
   * game/areas.ts). Alpha depende do modo de edição (mais forte
   * editando, mais discreto no uso normal -- ver refreshAreaTileAlpha).
   * Era um Rectangle GameObject (tile quadrado) -- virou Polygon (tile
   * losango, ver game/iso.ts): pontos relativos ao CENTRO (0,0), a
   * posição de verdade (pos.x/pos.y) é dada separada, igual o Rectangle
   * fazia antes.
   */
  private addAreaTileRect(t: AreaTileDef): Phaser.GameObjects.Polygon {
    const pos = areaWorldPos(t);
    const def = this.areaDefs.get(t.areaId);
    // cinza defensivo se a área sumiu da lista -- não deveria acontecer
    // em uso normal (setAreaDefs já limpa tile órfão), só por segurança.
    const color = def ? areaTypeMeta(def.type).color : 0x888888;
    return this.add
      .polygon(pos.x, pos.y, tileDiamondCorners(0, 0), color, this.editMode ? 0.35 : 0.16)
      .setDepth(DEPTH_AREA);
  }

  /** Reaplica o alpha certo (editando vs. uso normal) em toda tinta de área já desenhada -- chamado ao ligar/desligar o modo de edição (ver setEditMode). */
  private refreshAreaTileAlpha() {
    const alpha = this.editMode ? 0.35 : 0.16;
    for (const rect of this.draftAreaSprites.values()) rect.setAlpha(alpha);
  }

  /** Agrupa os tiles pintados por área (col/row de cada um, sem o areaId repetido) -- só uma leitura auxiliar de this.draftArea, usada pra desenhar a borda/o hover de cada área (ver redrawAreaBorders/updateAreaHoverLabels). */
  private tilesByAreaId(): Map<string, { col: number; row: number }[]> {
    const map = new Map<string, { col: number; row: number }[]>();
    for (const t of this.draftArea.values()) {
      const arr = map.get(t.areaId);
      if (arr) arr.push({ col: t.col, row: t.row });
      else map.set(t.areaId, [{ col: t.col, row: t.row }]);
    }
    return map;
  }

  /**
   * Pinta (ou apaga) o tile col/row com a ferramenta de área selecionada
   * -- mesma mecânica exata do paintFloorAt (clique único ou repetido
   * durante um arrasto, ver handleEditPointerMove/handleEditPointerDown).
   * Sem ferramenta selecionada, ou com uma área selecionada que não
   * existe (mais) na lista, não faz nada.
   */
  private paintAreaAt(col: number, row: number) {
    const tool = this.selectedAreaTool;
    if (!tool) return;
    const key = `${col},${row}`;

    if (tool.kind === "erase") {
      const existing = this.draftArea.get(key);
      if (!existing) return;
      this.draftAreaSprites.get(key)?.destroy();
      this.draftAreaSprites.delete(key);
      this.draftArea.delete(key);
      this.refreshAreas();
      this.onDraftAreaChange?.(this.getDraftAreaList());
      return;
    }

    if (!this.areaDefs.has(tool.areaId)) return;
    const existing = this.draftArea.get(key);
    if (existing && existing.areaId === tool.areaId) return; // já pintado com a mesma área, nada a fazer

    this.draftAreaSprites.get(key)?.destroy();
    const def: AreaTileDef = { col, row, areaId: tool.areaId };
    const rect = this.addAreaTileRect(def);
    this.draftArea.set(key, def);
    this.draftAreaSprites.set(key, rect);
    this.refreshAreas();
    this.onDraftAreaChange?.(this.getDraftAreaList());
  }

  /** Pinta (via paintAreaAt) cada tile ao longo da linha reta entre o último tile pintado e o atual -- mesmo Bresenham do paintFloorLine, pra não deixar buraco num arrasto rápido. */
  private paintAreaLine(fromCol: number, fromRow: number, toCol: number, toRow: number) {
    let x0 = fromCol;
    let y0 = fromRow;
    const dx = Math.abs(toCol - x0);
    const dy = -Math.abs(toRow - y0);
    const sx = x0 < toCol ? 1 : -1;
    const sy = y0 < toRow ? 1 : -1;
    let err = dx + dy;
    for (let i = 0; i < 200; i++) {
      this.paintAreaAt(x0, y0);
      if (x0 === toCol && y0 === toRow) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  /**
   * Recalcula tudo que depende dos tiles pintados: a borda de cada área
   * e o hover/nome/botão de posse de cada uma -- chamado toda vez que a
   * área muda (pintar/apagar/carregar/lista mudar). A POSSE em si
   * (areaOwnerByAreaId) não é recalculada aqui -- ela é estado que só
   * muda por fora, via setAreaOwner (broadcast "area-owner" do
   * servidor), então updateAreaHoverLabels só LÊ o que já tá guardado.
   */
  private refreshAreas() {
    this.redrawAreaBorders();
    this.updateAreaHoverLabels();
    // force:true -- a área que o jogador já está pode ter mudado de
    // FORMATO (tile pintado/apagado), mesmo continuando com o mesmo id,
    // então o véu (ver updateAreaDim) precisa redesenhar mesmo sem
    // "trocar" de área.
    this.updateAreaDim(true);
  }

  /**
   * Desenha (do zero) o contorno de cada área que já tem pelo menos 1
   * tile pintado -- um paralelogramo por área, do vértice de trás ao
   * vértice da frente do bounding-box dela em col/row (ver
   * areaTileBounds em game/areas.ts; numa área com formato irregular
   * isso pode incluir algum tile de fora, simplificação aceitável pro
   * uso esperado -- mesma simplificação de sempre, só que agora o
   * "retângulo" reto virou um paralelogramo, porque um retângulo de
   * tiles projetado no losango isométrico não fica mais com os lados
   * retos na tela, ver tileRangeCorners em game/iso.ts). Mais forte
   * durante a edição, mais discreto no uso normal.
   */
  private redrawAreaBorders() {
    for (const g of this.areaBorderGfx) g.destroy();
    this.areaBorderGfx = [];
    for (const [areaId, tiles] of this.tilesByAreaId()) {
      const def = this.areaDefs.get(areaId);
      if (!def) continue; // órfão -- não deveria sobrar depois de setAreaDefs, defensivo
      const meta = areaTypeMeta(def.type);
      const { minCol, maxCol, minRow, maxRow } = areaTileBounds(tiles);
      // -0.5/+0.5 -- igual ao "+TILE/2 de cada lado" de antes: sem isso
      // o paralelogramo passaria só pelo CENTRO dos tiles de borda, não
      // pela borda de fora deles (ver comentário de tileRangeCorners em
      // game/iso.ts).
      const corners = tileRangeCorners(tileToWorld, minCol - 0.5, minRow - 0.5, maxCol + 0.5, maxRow + 0.5);
      const g = this.add.graphics().setDepth(DEPTH_AREA);
      g.lineStyle(2, meta.color, this.editMode ? 0.85 : 0.35);
      g.strokePoints(corners, true);
      this.areaBorderGfx.push(g);
    }
  }

  /**
   * "Apaga a luz" fora da área onde o jogador LOCAL está agora (pedido
   * do Douglas: "quando o avatar entrar dentro de um ambiente, area, o
   * resto do mapa tem que esmaecer... igual o gather", ver
   * DEPTH_AREA_DIM/AREA_DIM_ALPHA acima). Chamada toda vez que o LOCAL
   * anda (reportPosition, a cada frame mas throttled a 50ms) e toda vez
   * que a área muda de forma (refreshAreas, `force=true` -- aí redesenha
   * mesmo se o id da área continuar o mesmo, porque o RETÂNGULO dela
   * pode ter mudado). Sem área nenhuma (jogador no espaço aberto), não
   * desenha nada -- fica tudo aceso normal, como sempre foi.
   */
  private updateAreaDim(force = false) {
    if (!this.localContainer) return; // pode ser chamado (via refreshAreas) antes do boneco local existir ainda
    const areaId = this.areaZoneAt(this.localContainer.x, this.localContainer.y);
    if (!force && areaId === this.areaDimAreaId) return; // não mudou de área -- nada novo pra desenhar
    this.areaDimAreaId = areaId;

    for (const r of this.areaDimSprites) r.destroy();
    this.areaDimSprites = [];
    this.areaDimMaskGfx?.destroy();
    this.areaDimMaskGfx = undefined;
    if (!areaId) return; // fora de qualquer área -- mapa inteiro aceso, sem véu nenhum

    const tiles = this.tilesByAreaId().get(areaId);
    if (!tiles || tiles.length === 0) return; // área sem tile pintado (não deveria acontecer aqui, defensivo)

    // véu ÚNICO cobrindo o mapa inteiro, recortado por uma MÁSCARA
    // (Graphics + GeometryMask invertida) -- o "buraco" da máscara é
    // CADA tile pintado da área (um losango por tile, não mais um
    // retângulo de bounding-box) + a silhueta de tela (getBounds()) de
    // cada móvel de pé num tile dela. Passou por 2 rodadas com o
    // Douglas: primeiro corrigiu o móvel maior que 1 tile (ex: poltrona
    // gamer) tendo o topo cortado na borda do bounding-box mesmo estando
    // DENTRO da área; agora ("tem que ser todos os tiles que eu
    // seleciono na criacao") corrige o bounding-box em si -- numa área
    // de formato IRREGULAR (não um retângulo sólido preenchido, ex: só
    // as casinhas junto de cada cadeira, com buracos entre elas) o
    // bounding-box acendia até tile que nunca foi pintado (over-lit) MAS
    // continuava apagando tile pintado que ficasse fora do retângulo
    // (ex: uma cadeira mais afastada, numa "aba" da área que o
    // bounding-box não cobre) -- por isso "nem todos os tiles
    // selecionados" ficavam acesos. Desenhando tile por tile, só o que
    // foi PINTADO de verdade acende, não importa o formato.
    const tileKeys = new Set(tiles.map((t) => `${t.col},${t.row}`));
    const maskGfx = this.add.graphics();
    maskGfx.fillStyle(0xffffff);
    for (const t of tiles) {
      const { x, y } = tileToWorld(t.col, t.row);
      maskGfx.fillPoints(tileDiamondCorners(x, y), true);
    }
    const addFurnitureHole = (f: FurnitureDef, sprite: Phaser.GameObjects.Image | undefined) => {
      if (!sprite || !tileKeys.has(`${f.col},${f.row}`)) return;
      const b = sprite.getBounds();
      maskGfx.fillRect(b.x, b.y, b.width, b.height);
    };
    for (const f of ROOM_FURNITURE) addFurnitureHole(f, this.roomFurnitureSprites.get(f.id));
    for (const [id, f] of this.draftFurniture) addFurnitureHole(f, this.draftSprites.get(id));
    maskGfx.setVisible(false); // só serve de fonte pra máscara, não desenha por cima da cena
    this.areaDimMaskGfx = maskGfx;
    const mask = maskGfx.createGeometryMask();
    mask.invertAlpha = true; // escurece TUDO, exceto onde a máscara desenhou (o "buraco" aceso)

    this.areaDimSprites.push(
      this.add
        .rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x000000, AREA_DIM_ALPHA)
        .setDepth(DEPTH_AREA_DIM)
        .setMask(mask)
    );
  }

  /**
   * Cria/atualiza a hitbox de hover + o texto/botão de cada área
   * "mesa-privada" que já tem tile pintado:
   * - SEM dono: mostra "Tomar posse" (estilo de botão, SEMPRE visível --
   *   é um convite pra ação, não devia depender de passar o mouse pra
   *   alguém descobrir que pode clicar) -- clicar chama onClaimArea.
   * - COM dono (outra pessoa): mostra o nome dela, só ao passar o mouse
   *   em cima (ver applyAreaLabelVisibility) -- clicar abre o card dela
   *   (onAreaOwnerClick).
   * - COM dono (EU): mesma coisa, mas clicar SOLTA a posse (onReleaseArea)
   *   em vez de abrir card -- não faz sentido abrir o próprio card
   *   clicando na própria mesa.
   * Áreas que sumiram da lista, ou que ainda não têm nenhum tile pintado
   * (nada pra "passar o mouse em cima"), têm sua hitbox/label destruídos.
   */
  private updateAreaHoverLabels() {
    const tilesByArea = this.tilesByAreaId();
    const activeAreaIds = new Set(
      Array.from(this.areaDefs.values())
        .filter((a) => a.type === "mesa-privada" && (tilesByArea.get(a.id)?.length ?? 0) > 0)
        .map((a) => a.id)
    );

    for (const [areaId, hitZone] of this.areaHoverZones.entries()) {
      if (activeAreaIds.has(areaId)) continue;
      hitZone.destroy();
      this.areaHoverZones.delete(areaId);
      this.areaNameLabels.get(areaId)?.destroy();
      this.areaNameLabels.delete(areaId);
    }

    for (const areaId of activeAreaIds) {
      const tiles = tilesByArea.get(areaId)!;
      const { minCol, maxCol, minRow, maxRow } = areaTileBounds(tiles);
      // paralelogramo da área (mesma borda -0.5/+0.5 de redrawAreaBorders,
      // ver tileRangeCorners em game/iso.ts) -- a hitbox de hover em si
      // continua um RETÂNGULO (Phaser Zone), só que agora encaixado na
      // caixa delimitadora (AABB) desse paralelogramo em vez da caixa de
      // um retângulo reto -- simplificação aceitável (mesma ideia já
      // aceita pra borda antes de virar isométrica): a área clicável fica
      // um pouco mais generosa que o losango exato nos 4 cantos, não
      // mais estreita.
      const corners = tileRangeCorners(tileToWorld, minCol - 0.5, minRow - 0.5, maxCol + 0.5, maxRow + 0.5);
      const minX = Math.min(...corners.map((p) => p.x));
      const maxX = Math.max(...corners.map((p) => p.x));
      const minY = Math.min(...corners.map((p) => p.y));
      const maxY = Math.max(...corners.map((p) => p.y));
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      const width = maxX - minX;
      const height = maxY - minY;
      const labelX = centerX;
      const labelY = minY - 6; // -6 = -4 de antes, escalado 1.5x junto com a resolução interna

      let hitZone = this.areaHoverZones.get(areaId);
      if (!hitZone) {
        hitZone = this.add
          .zone(centerX, centerY, width, height)
          .setDepth(DEPTH_AREA_HOVER)
          .setInteractive({ cursor: "pointer" });
        hitZone.on("pointerover", () => this.applyAreaLabelVisibility(areaId, true));
        hitZone.on("pointerout", () => this.applyAreaLabelVisibility(areaId, false));
        hitZone.on("pointerdown", () => {
          // igual ao clique de avatar: nada durante a edição, nem com o
          // card de perfil já aberto por cima (ver avatarClicksLocked).
          if (this.editMode || this.avatarClicksLocked) return;
          const owner = this.areaOwnerByAreaId.get(areaId);
          if (!owner) this.onClaimArea?.(areaId);
          else if (owner.playerId === "local") this.onReleaseArea?.(areaId);
          else this.onAreaOwnerClick?.({ playerId: owner.playerId, isLocal: false });
        });
        this.areaHoverZones.set(areaId, hitZone);
      } else {
        hitZone.setPosition(centerX, centerY);
        hitZone.setSize(width, height);
      }

      const owner = this.areaOwnerByAreaId.get(areaId);
      const def = this.areaDefs.get(areaId)!;
      const text = owner ? owner.name : `${def.name} · Tomar posse`;
      let label = this.areaNameLabels.get(areaId);
      if (!label) {
        label = this.add
          .text(labelX, labelY, text, {
            fontFamily: GAME_FONT_FAMILY,
            fontSize: "20px", // escalado 1.5x junto com a resolução interna
            color: "#ffffff",
            backgroundColor: owner ? "#000000cc" : "#7c5cffdd",
            padding: { x: 9, y: 3 },
          })
          .setOrigin(0.5, 1)
          .setDepth(DEPTH_AREA_LABEL);
        this.areaNameLabels.set(areaId, label);
      } else {
        label.setPosition(labelX, labelY);
        label.setText(text);
        label.setBackgroundColor(owner ? "#000000cc" : "#7c5cffdd");
      }
      // recomeça "sem hover" -- sem dono isso MOSTRA o botão (visível
      // sempre), com dono isso ESCONDE o nome (só aparece no próximo
      // pointerover, ver applyAreaLabelVisibility).
      this.applyAreaLabelVisibility(areaId, false);
    }
  }

  private applyAreaLabelVisibility(areaId: string, hovered: boolean) {
    const label = this.areaNameLabels.get(areaId);
    if (!label) return;
    const owner = this.areaOwnerByAreaId.get(areaId);
    label.setVisible(!owner || hovered);
  }

  /** Desenha o contorno de TODO tile colocável (mesmos limites que clampTile usa pro boneco) -- só visível durante o modo de edição. */
  private drawEditGrid() {
    const g = this.add.graphics().setDepth(EDIT_UI_DEPTH).setVisible(false);
    g.lineStyle(1, 0xffffff, 0.25);
    for (let col = 0; col <= GRID_COLS; col++) {
      for (let row = 0; row <= GRID_ROWS; row++) {
        const { x, y } = tileToWorld(col, row);
        g.strokePoints(tileDiamondCorners(x, y), true);
      }
    }
    this.gridGraphics = g;
  }

  /** Item (fixo OU rascunho) já ancorado nesse tile, se houver -- editor não deixa empilhar dois móveis na mesma âncora (evita duas sprites sobrepostas confundindo o preview). */
  private anyFurnitureAt(col: number, row: number): boolean {
    if (ROOM_FURNITURE.some((f) => f.col === col && f.row === row)) return true;
    for (const f of this.draftFurniture.values()) {
      if (f.col === col && f.row === row) return true;
    }
    return false;
  }

  /** Esse tile trava a passagem por causa de algum móvel (fixo OU colocado pelo editor, ver FURNITURE_BLOCKS_MOVEMENT em furniture.ts) -- usado em startStep(). blockingFurnitureAt (furniture.ts) só sabe de ROOM_FURNITURE; aqui completa com draftFurniture, pra um item colocado pelo editor (ex: nova divisória de vidro) travar passagem na hora, sem precisar de restart. */
  private isMovementBlockedAt(col: number, row: number): boolean {
    if (blockingFurnitureAt(col, row)) return true;
    for (const f of this.draftFurniture.values()) {
      if (f.col === col && f.row === row && furnitureBlocksMovement(f.type)) return true;
    }
    return false;
  }

  /**
   * Menor caminho (BFS, só as 4 direções sem diagonal, mesma grade do
   * passo por teclado) do tile atual até (targetCol,targetRow), pulando
   * qualquer tile travado (ver isMovementBlockedAt) -- usado pelo
   * clique-pra-andar (handleRoomPointerDown). Retorna a lista de direções
   * (um passo por tile) que update() vai consumir sozinho, ou null se não
   * existe caminho (destino cercado de móvel/parede). Grade pequena (13x8
   * tiles, GRID_COLS/GRID_ROWS) -- BFS simples é de sobra, sem precisar de
   * A-estrela/heurística nenhuma.
   */
  private computeWalkPath(
    fromCol: number,
    fromRow: number,
    targetCol: number,
    targetRow: number
  ): Direction[] | null {
    if (fromCol === targetCol && fromRow === targetRow) return [];
    const key = (c: number, r: number) => `${c},${r}`;
    const steps: { dir: Direction; dc: number; dr: number }[] = [
      { dir: "up", dc: 0, dr: -1 },
      { dir: "down", dc: 0, dr: 1 },
      { dir: "left", dc: -1, dr: 0 },
      { dir: "right", dc: 1, dr: 0 },
    ];
    const visited = new Set<string>([key(fromCol, fromRow)]);
    const queue: { col: number; row: number; path: Direction[] }[] = [{ col: fromCol, row: fromRow, path: [] }];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const s of steps) {
        const nc = cur.col + s.dc;
        const nr = cur.row + s.dr;
        if (nc < 0 || nc > GRID_COLS || nr < 0 || nr > GRID_ROWS) continue;
        const k = key(nc, nr);
        if (visited.has(k) || this.isMovementBlockedAt(nc, nr)) continue;
        const path = [...cur.path, s.dir];
        if (nc === targetCol && nr === targetRow) return path;
        visited.add(k);
        queue.push({ col: nc, row: nr, path });
      }
    }
    return null;
  }

  /**
   * Destaque BEM leve do tile sob o mouse fora do modo de edição --
   * pedido do Douglas: "o piso aparecer um elo de seleção enquanto a
   * pessoa anda com o mouse pela tela, bem leve". Separado do
   * hoverGraphics do editor de espaço (esse some fora da grade de edição
   * e usa cores fortes pra distinguir tile livre/ocupado -- aqui não
   * precisa: é só feedback de "clicando aqui você anda pra esse tile",
   * por isso um alfa bem baixo e uma cor neutra, sem distinguir nada.
   */
  private handleRoomPointerMove(pointer: Phaser.Input.Pointer) {
    if (!this.roomHoverGraphics) return;
    if (this.editMode) {
      this.roomHoverGraphics.setVisible(false);
      return;
    }
    const { col, row } = worldToTile(pointer.worldX, pointer.worldY);
    const inBounds = col >= 0 && col <= GRID_COLS && row >= 0 && row <= GRID_ROWS;
    if (!inBounds) {
      this.roomHoverGraphics.setVisible(false);
      return;
    }
    const { x, y } = tileToWorld(col, row);
    this.roomHoverGraphics
      .clear()
      .fillStyle(0xffffff, 0.1)
      .lineStyle(1, 0xffffff, 0.18)
      .fillPoints(tileDiamondCorners(x, y), true)
      .strokePoints(tileDiamondCorners(x, y), true)
      .setVisible(true);
  }

  /**
   * Clique fora do modo de edição: anda até o tile clicado
   * (clique-pra-andar -- pedido antigo do Douglas: "pro mouse fazer o
   * boenco andar"). Clicar em cima de um avatar continua abrindo o card
   * de perfil (ver isPointerOnAnyAvatar/onAvatarClick), não anda pra lá.
   * Clicar de novo enquanto já anda troca de destino na hora (substitui a
   * fila); uma tecla de seta/WASD cancela a fila e devolve o controle pro
   * teclado (ver update()) -- os dois jeitos de andar convivem sem
   * conflito, igual teclado+nudge de assento já conviviam antes.
   */
  private handleRoomPointerDown(pointer: Phaser.Input.Pointer) {
    if (this.editMode || this.movementLocked || this.seatTuningActive) return;
    if (this.isPointerOnAnyAvatar(pointer)) return;
    const { col: targetCol, row: targetRow } = worldToTile(pointer.worldX, pointer.worldY);
    const inBounds = targetCol >= 0 && targetCol <= GRID_COLS && targetRow >= 0 && targetRow <= GRID_ROWS;
    if (!inBounds || this.isMovementBlockedAt(targetCol, targetRow)) {
      this.walkQueue = [];
      return;
    }
    // sentado -- levanta primeiro, igual uma tecla de seta faria (ver
    // update()); o passo de verdade só começa no frame seguinte, já com
    // localActivity de volta a "idle" (standUp() muda isso na hora, sem
    // animação/timer no meio).
    if (this.localActivity === "sentado") this.standUp();
    const { col: fromCol, row: fromRow } = worldToTile(this.localContainer.x, this.localContainer.y);
    this.walkQueue = this.computeWalkPath(fromCol, fromRow, targetCol, targetRow) ?? [];
  }

  private draftIdAt(col: number, row: number): string | null {
    for (const [id, f] of this.draftFurniture.entries()) {
      if (f.col === col && f.row === row) return id;
    }
    return null;
  }

  private handleEditPointerMove(pointer: Phaser.Input.Pointer) {
    if (!this.editMode || !this.hoverGraphics) return;
    // worldX/worldY (não pointer.x/y) -- pointer.x/y é a posição na TELA
    // (câmera), só bate com a posição no MUNDO por coincidência no zoom
    // padrão (1x, sem arrastar a câmera); com os controles de zoom/pan
    // do mapa (ver MapControls em GameRoom.tsx) os dois divergem, e o
    // tile calculado ficava errado assim que zoomava ou arrastava a
    // câmera -- inclusive plausivelmente a causa do piso "não pintar"
    // que o Douglas viu, se ele tinha zoomado/arrastado o mapa antes.
    const { col, row } = worldToTile(pointer.worldX, pointer.worldY);
    const inBounds = col >= 0 && col <= GRID_COLS && row >= 0 && row <= GRID_ROWS;
    if (!inBounds) {
      this.hoverGraphics.setVisible(false);
      this.catalogGhostSprite?.setVisible(false);
      return;
    }

    // arrastar com a ferramenta de piso armada pinta CADA tile novo que
    // o cursor entra durante o arrasto (não só onde o botão foi
    // pressionado) -- é o "arrastando" que o Douglas pediu, em vez de só
    // o clique único ("unitário"). paintFloorLine (não só paintFloorAt no
    // tile atual) preenche também os tiles PULADOS entre um evento de
    // pointermove e o outro -- o quadrado (60px) é grande o suficiente
    // pra um arrasto normal "pular" um inteiro sem disparar um evento
    // bem em cima dele, o que deixava buracos na pintura.
    if (this.isPaintingFloor && pointer.isDown && this.selectedFloorTool) {
      const key = `${col},${row}`;
      if (key !== this.lastPaintedFloorKey) {
        const [lastCol, lastRow] = this.lastPaintedFloorKey
          ? this.lastPaintedFloorKey.split(",").map(Number)
          : [col, row];
        this.lastPaintedFloorKey = key;
        this.paintFloorLine(lastCol, lastRow, col, row);
      }
    }

    // mesmo esquema de arrasto acima, só que pra ferramenta de área (ver
    // paintAreaLine).
    if (this.isPaintingArea && pointer.isDown && this.selectedAreaTool) {
      const key = `${col},${row}`;
      if (key !== this.lastPaintedAreaKey) {
        const [lastCol, lastRow] = this.lastPaintedAreaKey
          ? this.lastPaintedAreaKey.split(",").map(Number)
          : [col, row];
        this.lastPaintedAreaKey = key;
        this.paintAreaLine(lastCol, lastRow, col, row);
      }
    }

    const occupied = this.anyFurnitureAt(col, row);
    const { x, y } = tileToWorld(col, row);
    this.hoverGraphics
      .clear()
      .fillStyle(occupied ? EDIT_HOVER_COLOR_OCCUPIED : EDIT_HOVER_COLOR_FREE, 0.35)
      .fillPoints(tileDiamondCorners(x, y), true)
      .setVisible(true);

    // "fantasma" do item selecionado na paleta acompanha o cursor (ver
    // refreshCatalogGhost/selectCatalogEntry) -- só aparece em tile LIVRE
    // (onde o clique realmente colocaria o item; em tile ocupado o clique
    // não faz nada, ver handleEditPointerDown), já na profundidade certa
    // pra desenhar na ordem certa em relação a bonecos/outros móveis dessa
    // fileira (pedido do Douglas: ver o resultado exato antes de clicar).
    if (this.catalogGhostSprite) {
      this.catalogGhostSprite.setPosition(x, y);
      this.catalogGhostSprite.setDepth(furnitureDepthForTile(col, row));
      this.catalogGhostSprite.setVisible(!occupied);
    }
  }

  /**
   * Clique num tile durante o modo de edição: o que acontece depende da
   * ferramenta armada no momento (Mover/Apagar/Área/Piso, mutuamente
   * exclusivas -- ver selectMoveTool/selectDeleteTool/selectAreaTool/
   * selectFloorTool). Sem nenhuma dessas armada e com um item de móvel
   * selecionado na paleta, clicar num tile LIVRE (sem móvel fixo nem
   * rascunho) coloca uma cópia nova ali -- clicar num tile já ocupado não
   * faz nada (pra apagar um item já colocado, arma a ferramenta "Apagar").
   * Clicar num tile ocupado por móvel FIXO (ROOM_FURNITURE) nunca faz
   * nada -- esses não são editáveis por aqui.
   */
  /** Verdadeiro se o clique caiu em cima de QUALQUER avatar (local ou remoto) -- usado pra não colocar/remover móvel do editor por baixo de um clique que era pra abrir o card de perfil (ver onAvatarClick). */
  private isPointerOnAnyAvatar(pointer: Phaser.Input.Pointer): boolean {
    const containers: (Phaser.GameObjects.Container | undefined)[] = [
      this.localContainer,
      ...this.remoteContainers.values(),
    ];
    for (const c of containers) {
      if (!c) continue;
      const hitArea = c.input?.hitArea as Phaser.Geom.Rectangle | undefined;
      if (!hitArea) continue;
      // containers não têm rotação/escala própria aqui -- ponto local é
      // só a diferença direto, sem precisar de matriz de transformação.
      // worldX/worldY (não pointer.x/y) pelo mesmo motivo do
      // handleEditPointerMove -- c.x/c.y são posição no MUNDO, então o
      // ponteiro precisa estar no mesmo espaço pra diferença bater.
      const localX = pointer.worldX - c.x;
      const localY = pointer.worldY - c.y;
      if (Phaser.Geom.Rectangle.Contains(hitArea, localX, localY)) return true;
    }
    return false;
  }

  private handleEditPointerDown(pointer: Phaser.Input.Pointer) {
    if (!this.editMode) return;
    if (this.isPointerOnAnyAvatar(pointer)) return;
    const { col, row } = worldToTile(pointer.worldX, pointer.worldY);
    if (col < 0 || col > GRID_COLS || row < 0 || row > GRID_ROWS) return;

    // ferramenta "Mover" armada (ver selectMoveTool) -- pedido do
    // Douglas: precisa editar a POSIÇÃO de um item já colocado, sem ter
    // que apagar e colocar de novo (perdendo cor/modelo escolhido).
    if (this.moveToolActive) {
      if (this.movingFurnitureId) {
        const moving = this.draftFurniture.get(this.movingFurnitureId);
        if (!moving) {
          // sumiu por algum outro caminho (ex: clearDraftFurniture) --
          // não devia acontecer (esses caminhos já limpam
          // movingFurnitureId), mas não deixa travado num id órfão.
          this.movingFurnitureId = null;
          return;
        }
        if (moving.col === col && moving.row === row) {
          // clicou de novo no MESMO tile onde já estava -- cancela em
          // vez de mover (solta sem soltar em lugar nenhum diferente).
          this.cancelMovingFurniture();
          return;
        }
        if (this.anyFurnitureAt(col, row)) return; // tile de destino ocupado, ignora o clique
        moving.col = col;
        moving.row = row;
        const sprite = this.draftSprites.get(this.movingFurnitureId);
        if (sprite) {
          const pos = furnitureWorldPos(moving);
          sprite.setPosition(pos.x, pos.y);
          sprite.setDepth(moving.flat ? DEPTH_FLAT_FURNITURE : furnitureDepthForTile(moving.col, moving.row));
          sprite.clearTint();
        }
        // se o boneco local tava sentado NESSE item, acompanha ele pro
        // tile novo NA HORA -- sem isso ficaria "flutuando" pra trás,
        // longe do móvel que acabou de mudar de lugar (pedido do
        // Douglas: a posição do boneco, na interação de sentar, tem que
        // seguir o ITEM, não ficar presa a um ponto fixo do espaço).
        if (this.localActivity === "sentado" && this.seatedAt?.id === this.movingFurnitureId) {
          this.applySeatVisualPosition(moving);
        }
        this.movingFurnitureId = null;
        this.onDraftChange?.(this.getDraftFurnitureList());
        return;
      }
      // nada em mãos ainda -- clicar num item já colocado PEGA ele (só
      // rascunho, mesma restrição de sempre: móvel FIXO de ROOM_FURNITURE
      // não é editável por aqui). Clicar em tile vazio não faz nada.
      const pickId = this.draftIdAt(col, row);
      if (pickId) {
        this.movingFurnitureId = pickId;
        this.draftSprites.get(pickId)?.setTint(0x7c5cff);
      }
      return;
    }

    // ferramenta "Apagar" armada (ver selectDeleteTool) -- clique num item
    // já colocado apaga ele na hora; clique em tile vazio não faz nada.
    if (this.deleteToolActive) {
      const draftId = this.draftIdAt(col, row);
      if (draftId) this.removeDraftFurniture(draftId);
      return;
    }

    // ferramenta de área armada: mesma ideia da ferramenta de piso logo
    // abaixo (clique único já pinta e entra em modo de arrasto) -- checa
    // ANTES do piso só por ordem de leitura, as duas são mutuamente
    // exclusivas mesmo (ver selectAreaTool/selectFloorTool), nunca as
    // duas armadas ao mesmo tempo.
    if (this.selectedAreaTool) {
      this.isPaintingArea = true;
      this.lastPaintedAreaKey = `${col},${row}`;
      this.paintAreaAt(col, row);
      return;
    }

    // ferramenta de piso armada: pinta/apaga esse tile (clique único --
    // "unitário") e já entra em modo de arrasto (ver
    // handleEditPointerMove) pra continuar pintando se o mouse continuar
    // pressionado e se mover; NÃO cai no fluxo de móvel abaixo.
    if (this.selectedFloorTool) {
      this.isPaintingFloor = true;
      this.lastPaintedFloorKey = `${col},${row}`;
      this.paintFloorAt(col, row);
      return;
    }

    const entry = this.selectedCatalogEntry;
    if (!entry || this.anyFurnitureAt(col, row)) return;

    const id = `${entry.type}-draft-${Date.now()}-${Math.round(Math.random() * 999)}`;
    const def: FurnitureDef = {
      id,
      type: entry.type,
      col,
      row,
      facing: entry.facing,
      // modelId/colorId só existem em entradas geradas a partir de um
      // modelo (ver furnitureModelCatalogEntries em furniture.ts) -- pra
      // "vidro" (design único) ficam undefined, igual antes. seatOffsetY/X
      // NÃO vem mais da entrada pra item com modelo (fica undefined,
      // resolveSeatOffset cuida do padrão/ajuste salvo por modelo) -- só
      // os itens sem modelId ainda usam esses dois campos direto.
      modelId: entry.modelId,
      colorId: entry.colorId,
      seatOffsetY: entry.seatOffsetY,
      seatOffsetX: entry.seatOffsetX,
      baseOffsetY: entry.baseOffsetY,
    };
    const sprite = this.addFurnitureSprite(def);
    this.draftFurniture.set(id, def);
    this.draftSprites.set(id, sprite);
    this.onDraftChange?.(this.getDraftFurnitureList());
  }
}
