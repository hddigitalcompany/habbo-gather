// ver comentário em game/config.ts -- import default do phaser quebra
// no bundle do navegador, precisa ser namespace import
import * as Phaser from "phaser";
import {
  ROOM_FURNITURE,
  FurnitureDef,
  FurnitureModelDef,
  FurnitureType,
  FurnitureCatalogEntry,
  FurnitureFacing,
  FURNITURE_ART,
  FURNITURE_MODELS,
  FURNITURE_TYPE_CATEGORY,
  CUSTOM_ITEM_TARGET_WIDTH,
  FurnitureSeatOffsetsMap,
  SeatTuningInfo,
  furnitureWorldPos,
  furnitureWorldPosAt,
  furnitureTextureKey,
  furnitureVariantTextureKey,
  furnitureTextureKeyFor,
  furnitureBlocksMovement,
  furnitureModelById,
  furnitureFootprintTiles,
  furnitureExtraSeats,
  isFurnitureSittable,
  blockingFurnitureAt,
  resolveSeatOffset,
  seatSpotAt,
  seatOffsetGroupKey,
  seatOffsetGroupLabel,
} from "./furniture";
import {
  tileToWorld,
  worldToTile,
  Direction,
  ISO_TILE_WIDTH,
  ISO_TILE_HEIGHT,
  GRID_COLS,
  GRID_ROWS,
  GAME_WIDTH,
  GAME_HEIGHT,
  GRID_ORIGIN_X,
  GRID_ORIGIN_Y,
} from "./grid";
import { tileDiamondCorners, tileRangeCorners, Point } from "./iso";
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
import {
  FLOOR_CATALOG,
  FloorCatalogEntry,
  FloorPatternConfig,
  FloorTileDef,
  floorTextureKey,
  floorWorldPos,
  floorEntryById,
  woodGrainShapesForPlank,
  marbleVeinShapesForSlab,
  JOINT_LINE_WIDTH,
  JOINT_LINE_ALPHA,
  TILE_SIZED_PLANK_PX,
} from "./floor";
import {
  AreaDef,
  AreaTileDef,
  areaTypeMeta,
  areaWorldPos,
  areaIdAtTile,
  areaTileBounds,
} from "./areas";
import {
  WALL_CATALOG,
  WallCatalogEntry,
  WallPatternConfig,
  WallSegmentDef,
  WallSide,
  wallEntryById,
  wallTextureKey,
  wallSegmentId,
  wallWorldAnchor,
  wallDepthForSegment,
  wallEdgeFloorPoints,
  wallPatternFrontFloorPoints,
  wallEdgeLengthPx,
  wallBrickRects,
  nearestWallEdge,
} from "./wall";
import {
  DoorSide,
  DoorFacing,
  DoorCatalogEntry,
  DoorSegmentDef,
  doorEntryById,
  doorSegmentId,
  doorEdgeBetween,
  doorEdgeLengthPx,
  doorEdgeFloorPoints,
  doorWorldAnchor,
  doorDepthForSegment,
  doorTextureKey,
} from "./door";

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

// tamanho/formato do "recorte" do boneco atrás da parede (ver
// updateWallAvatarCutoutMask em MainScene.ts) -- cobre o corpo inteiro
// do boneco (~135px de altura em tela, ver comentário de AVATAR_SCALE
// acima), dos PÉS (container.y + AVATAR_FOOT_OFFSET_Y) até um pouco
// acima da CABEÇA, um pouco mais largo que o boneco pra não cortar
// rente nas bordas (largura TRIPLICADA a pedido do Douglas: "triplique
// o vao aberto na largura").
//
// FORMATO: um PARALELOGRAMO, não um retângulo comum -- 1ª/2ª versão
// (elipse, depois retângulo arredondado) eram alinhadas ao eixo da
// TELA (largura reta na horizontal) -- só que a face da parede em si é
// desenhada ao longo da diagonal ISOMÉTRICA (ver mapPoint/alongX/
// alongY em createWallPatternGraphics), então um recorte "reto"
// destoava visivelmente da grade/parede quando visto de perto (Douglas
// com print da grade pontilhada em diagonal: "tem como o corte seguir
// a linha de angulo? ao inves de ser quadrado no boneco"). Fix: a
// LARGURA do recorte agora anda ao longo do MESMO vetor `along` da
// parede sendo recortada (ver wallAlongUnit abaixo -- só depende da
// orientação/side, não da parede específica), a ALTURA continua reta
// pra CIMA (mesma ideia da extrusão de altura da própria parede, que
// também é sempre vertical na tela, ver comentário de mapPoint) --
// então só as bordas de CIMA/BAIXO do recorte ficam diagonais, as de
// LADO continuam verticais, igual um tijolo de verdade do painel.
const WALL_AVATAR_CUTOUT_WIDTH_PX = 210; // triplicado a pedido do Douglas ("triplique o vao aberto na largura")
const WALL_AVATAR_CUTOUT_HEIGHT_PX = 150;

/** Vetor unitário na direção "ao longo" da parede (mesma ideia de
 * alongX/alongY em createWallPatternGraphics, só que calculado aqui
 * sem precisar de nenhum dado da parede específica -- só do `side`,
 * já que é sempre a MESMA direção/diagonal pra qualquer parede daquela
 * orientação, ver wallEdgeFloorPoints em game/wall.ts: colPlus/center
 * andam em (-hw,hh), rowPlus/centerRow em (-hw,-hh)). Usado só pro
 * "recorte" do boneco atrás da parede (ver WALL_AVATAR_CUTOUT_* acima)
 * -- por isso mora aqui, perto delas, e não em game/wall.ts junto das
 * outras funções de geometria "de verdade" da parede. */
function wallAlongUnit(side: WallSide): { x: number; y: number } {
  const hw = ISO_TILE_WIDTH / 2;
  const hh = ISO_TILE_HEIGHT / 2;
  const dx = -hw;
  const dy = side === "rowPlus" || side === "centerRow" ? -hh : hh;
  const len = Math.hypot(dx, dy);
  return { x: dx / len, y: dy / len };
}
// chave de .setData/.getData onde cada parede guarda o SEU PRÓPRIO
// Graphics-fonte da máscara de recorte (ver comentário grande de
// draftWallSprites em MainScene.ts) -- .setData em vez de um Map
// paralelo (chave = id do segmento) porque parede é criada em vários
// pontos diferentes do código (addWallSprite é o único que TODOS eles
// passam, mas o Map exigiria centralizar/repetir a chave em cada um).
const WALL_CUTOUT_MASK_GFX_DATA_KEY = "wallCutoutMaskGfx";

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
 * FurnitureFacing (game/furniture.ts) -> Direction "de verdade" do
 * boneco -- o avatar só tem sprite/pose pras 4 direções de sempre (ver
 * WALK_FRAMES/SENTADO_FRAMES acima), nunca pras 2 quinas extras de
 * parede (cornerTop/cornerBottom, pedido do Douglas: "quina de cima,
 * quina de baixo"). Usado em sitAt/setRemoteSeat, que indexam
 * SENTADO_FRAMES[furniture.facing] -- na prática NUNCA recebe uma
 * quina de verdade (parede não senta, "Tem interação?" fica sempre
 * desmarcado nela), mas o tipo de FurnitureDef.facing é largo o
 * bastante pra aceitar, então esse fallback pra "down" é só defensivo
 * (evita um frame inválido se algum dia um item de parede virar
 * sentável por engano).
 */
function avatarFacingFor(facing: FurnitureFacing): Direction {
  return facing === "cornerTop" || facing === "cornerBottom" ? "down" : facing;
}

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

// item "Sobrepor" (ver FurnitureModelDef.stackable/stackSurfaceOffsetY em
// furniture.ts, pedido do Douglas: notebook em cima da mesa) ocupa o
// MESMO tile-âncora do item de baixo, então furnitureDepthForTile dá o
// MESMO valor pros dois -- sem esse empurrãozinho, a ordem de desenho
// entre os dois ficaria só por sorte (ordem de inserção do Phaser). Bem
// menor que DEPTH_FURNITURE_ROW_HEIGHT (64) de propósito -- só desempata
// os dois móveis da MESMA fileira, nunca é grande o bastante pra
// atravessar pra fileira vizinha e bagunçar a ordem com o boneco/outros
// móveis.
const DEPTH_STACK_ON_TOP = 4;

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
// acima da tinta -- só precisa ficar atrás do boneco/móvel de verdade
// pra hit-test fazer sentido, nunca colide de verdade com clique nenhum.
const DEPTH_AREA_HOVER = DEPTH_AREA + 1;

// destaque leve do tile sob o mouse fora do modo de edição (ver
// roomHoverGraphics/handleRoomPointerMove) -- acima do piso/tinta de área
// (senão ficaria escondido debaixo deles), mas ainda abaixo de móvel/
// boneco (DEPTH_FLAT_FURNITURE e a profundidade dinâmica por fileira, que
// começam em -1_000_000 e sobem) -- assim o destaque nunca "cobre" quem
// está em cima do tile, só o piso vazio ao redor. Fica perto de
// DEPTH_AREA_HOVER, continua precisando ficar ATRÁS de móvel/boneco.
const DEPTH_ROOM_TILE_HOVER = DEPTH_AREA_HOVER + 1;

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

// o fundo sólido da sala (ver create()) precisa ficar
// AINDA MAIS atrás que o piso pintado -- sem isso ele ficava com
// profundidade padrão (0), ou seja, na FRENTE do piso (DEPTH_FLOOR é
// negativo!), e cobria completamente qualquer quadrado pintado: o piso
// era desenhado certinho, na posição certa, com a textura certa, só que
// sempre escondido atrás do fundo opaco da sala -- por isso nunca
// aparecia nada pintado, por mais que o clique/arrasto funcionasse.
const DEPTH_ROOM_BACKGROUND = -3_000_000;

// FACHADA DO PRÉDIO (pedido do Douglas: "coloca, faça a quina ali
// coladinha no piso") -- 1 imagem só (public/assets/fachada-predio.avif),
// a quina do prédio vista de fora, com o "V" de cima da fachada
// encaixado nas 2 bordas da FRENTE do losango da sala. Fica entre o
// fundo sólido e o piso: o piso sempre por cima, a fachada "pendurada"
// pra baixo a partir da quina de baixo da sala.
const FACADE_TEXTURE_KEY = "fachada-predio";
const DEPTH_FACADE = -2_500_000;
/** vértice do "V" de cima da fachada DENTRO do PNG (px) -- é esse ponto
 * que cola no vértice de baixo do piso. A quina já está centralizada na
 * largura da arte (1613px), então x = metade. */
const FACADE_APEX_X_PX = 806.4;
const FACADE_APEX_Y_PX = 336.8;
/** escala da arte: cada vão de janela da fachada mede ~53,6px no PNG --
 * pedido do Douglas: "quero cada vidraça abraçando 2 tiles" -- então
 * escalado pra 128px (= 2 x 64px, o comprimento horizontal de 2 arestas
 * do losango), cada janela cobre exatamente 2 tiles do piso. */
const FACADE_SCALE = 128 / 53.6;

// QUINA ADICIONAL (pedido do Douglas, sala em L/escada: "essa parte vai
// encaixar no predio do lado esquerdo" / "isso quina") -- peça MENOR,
// só o "V" de vidro sem as paredes laterais da peça principal, pra
// cobrir toda quina externa extra que a sala tiver além da principal
// (ver roomFrontCorners/positionFacade). Tem uma aba sobrando no topo
// esquerdo na própria arte (não calculada aqui) que cobre o trecho reto
// até a peça vizinha, escondendo a costura. Medi o espaçamento das
// vidraças nesse PNG (448x955) contra o da peça principal -- ~53px nos
// 2, mesma escala exata -- então reusa FACADE_SCALE, sem recalibrar.
const FACADE_CORNER2_TEXTURE_KEY = "fachada-predio-quina-2";
/** vértice do "V" dessa peça DENTRO do PNG (px) -- achado por perfil de
 * alpha coluna a coluna (topY(x), pico em x≈347 -> y≈276), mesma ideia
 * de FACADE_APEX_*. */
const FACADE_CORNER2_APEX_X_PX = 347;
const FACADE_CORNER2_APEX_Y_PX = 276;
/** Ajuste manual pedido pelo Douglas -- a peça da quina 2 não tem
 * trecho reto/repetível de vidro pra cobrir sozinha o vão até a peça
 * principal (as duas artes são só um "V" de telhado, sem reta no
 * meio), então em vez de gerar arte nova o ajuste pedido foi deslocar
 * essa peça por cima da posição calculada por tile. Histórico dos
 * pedidos (cada um somado em cima do anterior, ver tileToWorld em
 * grid.ts pra cada direção; "direita"/"esquerda" sempre só no eixo X
 * da tela, sem mexer no Y): "move ela tres tile pra direita" (+3
 * tiles em X), depois "4 tiles pra frente esquerda" (direção +row:
 * dx=-ISO_TILE_WIDTH/2, dy=+ISO_TILE_HEIGHT/2 por tile). Tentei somar
 * mais "meio tile pra direita" em cima disso e foi isso que abriu um
 * vão GRANDE (print "esse espaço preto precisa fechar") -- ou seja
 * empurrar mais pra direita daqui pra frente só afasta, não ajuda;
 * voltei pro valor de antes desse passo (sem o +0.5 tile). Reajustar
 * aqui e testar local (npm run dev) se precisar de mais/menos -- não
 * dá pra calibrar isso de fora sem ver o resultado ao vivo. */
const FACADE_CORNER2_OFFSET_X_PX = 3 * ISO_TILE_WIDTH - 4 * (ISO_TILE_WIDTH / 2);
const FACADE_CORNER2_OFFSET_Y_PX = 4 * (ISO_TILE_HEIGHT / 2);

/** Fronteira de profundidade de um móvel a partir do TILE lógico dele (col/row, não da posição visual) -- ver comentário acima. */
function furnitureDepthForTile(col: number, row: number): number {
  return tileToWorld(col, row).y + ISO_TILE_HEIGHT / 2 - DEPTH_FURNITURE_ROW_HEIGHT;
}

/**
 * Tile do footprint (furnitureFootprintTiles, game/furniture.ts) que
 * decide a profundidade do móvel -- ACHADO/CORRIGIDO (Douglas: "o
 * boneco tava atras da mesa, mas pelo tile de insersao dela ta no lado
 * esquerdo nao ta ficando atras"): addFurnitureSprite usava sempre
 * f.col/f.row (o tile ÂNCORA, "de inserção") pra profundidade, mesmo
 * pra um item com footprintCols/Rows > 1 (ver "Ocupa (tiles)" no Editor
 * de Itens) cujo retângulo se estende BEM além dele. Numa mesa 2x1 com
 * a âncora no tile ESQUERDO, por exemplo, a profundidade saía calculada
 * a partir do tile esquerdo (col+row MENOR = "mais fundo" no grid) --
 * um boneco de pé no tile DIREITO do footprint (col+row maior, deveria
 * ficar NA FRENTE da mesa) podia sair comparado como se estivesse atrás
 * dela, já que a mesa inteira "pensava" que só ocupava o tile esquerdo.
 * Fix: profundidade usa o tile do footprint com o MAIOR col+row (o
 * canto mais "pra frente" da tela, sem importar de que lado a âncora
 * fica) -- item 1x1 (footprint padrão) devolve o próprio f.col/f.row,
 * comportamento idêntico a antes.
 */
function furnitureDepthTile(f: FurnitureDef): { col: number; row: number } {
  const tiles = furnitureFootprintTiles(f);
  let best = tiles[0] ?? { col: f.col, row: f.row };
  for (const t of tiles) {
    if (t.col + t.row > best.col + best.row) best = t;
  }
  return best;
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

/**
 * Profundidade de quem está SENTADO num móvel -- baseada no TILE LÓGICO
 * do móvel (mesma ideia de furnitureDepthForTile, ver comentário dela),
 * NÃO na posição visual já deslocada pelo ajuste de assento
 * (resolveSeatOffset).
 *
 * ACHADO (Douglas: "quando sento na cadeira e tem uma mesa na frente,
 * fico por cima da mesa, sem estar sentado fico atrás -- o que é o
 * certo"): usar avatarDepthForY(y) com o Y JÁ deslocado empilhava
 * certo contra a PRÓPRIA cadeira (ajuste pequeno, mesma fileira dela),
 * mas não contra um móvel de OUTRA fileira -- a fronteira de
 * profundidade por fileira (DEPTH_FURNITURE_ROW_HEIGHT =
 * ISO_TILE_HEIGHT, pensada pra passos de uma fileira INTEIRA, 64px) é
 * grande demais pro nudge pequeno do assento (10-40px) sozinho
 * derrubar o boneco pra fileira anterior -- por isso às vezes ficava
 * na frente de um móvel que devia tampar. Sentado nunca "sai" da
 * fileira lógica do móvel (só se desloca visualmente uns pixels por
 * cima dele) -- por isso usa o MESMO Y que usaria em pé nesse tile
 * (tileToWorld), igual a exceção que já existia só pro "up".
 *
 * col/row recebido À PARTE (não mais furniture.col/row direto) -- pra
 * um ASSENTO EXTRA (ver FurnitureModelDef.extraSeats, game/furniture.ts)
 * a profundidade tem que usar o tile do ASSENTO em si (pode ser outra
 * fileira do sofá, por exemplo), não sempre a âncora do item. Quem
 * chama passa furniture.col+dCol/furniture.row+dRow (0/0 pra âncora,
 * comportamento de sempre).
 */
function seatDepth(furniture: FurnitureDef, col: number, row: number): number {
  if (furniture.facing === "up") return furnitureDepthForTile(col, row) - 1;
  return avatarDepthForY(tileToWorld(col, row).y);
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

// RODAPÉ de parede -- visual FIXO/padrão pra TODA parede "padrão" do
// jogo (pedido do Douglas com foto de referência: rodapé branco,
// moldura fina, contornando a quina de uma parede/coluna até o chão --
// "um formato e uma cor padrao pra todas, que vai contornar toda face
// visivel dela"). Por isso NÃO mora em WallPatternConfig (não é campo
// do formulário "Criar Parede", sem coluna no banco -- ver comentário
// grande de RODAPÉ em game/wall.ts).
//
// "CAVA" (pedido seguinte, olhando a mesma foto de novo: "uma cava
// encima e se tivesse linha nele, ficaria mais real") -- a faixa lisa
// sozinha (1ª versão) ficava chapada demais; uma moldura de verdade
// tem um SULCO entalhado perto do topo (o "quirk" da moldura na foto).
// Sem relevo de verdade (jogo 2D chapado), a ilusão de entalhe vem de
// 2 linhas finas GRUDADAS uma na outra: a de CIMA mais escura (parede
// do sulco que olha pra BAIXO, não pega luz -- sombra) e a de BAIXO
// bem clara/quase branca (parede do sulco que olha pra CIMA, pega luz
// -- brilho), mesma convenção de "luz vem de cima" já usada no resto
// do jogo (ver comentário de topColor em game/wall.ts). O olho lê essa
// dupla de linhas grudadas como um corte na madeira, não como 2
// listras soltas.
const WALL_BASEBOARD_HEIGHT_PX = 16;
const WALL_BASEBOARD_COLOR = 0xf0ebe0;
/** distância do TOPO da faixa até a cava (sulco) -- ela fica perto do
 * topo, não no meio, igual a foto de referência. */
const WALL_BASEBOARD_GROOVE_OFFSET_PX = 4;
/** espessura de CADA uma das 2 linhas que formam a cava (sombra +
 * brilho, ver comentário grande acima). */
const WALL_BASEBOARD_GROOVE_LINE_PX = 1;
const WALL_BASEBOARD_GROOVE_SHADOW_COLOR = 0xc9bfa9;
const WALL_BASEBOARD_GROOVE_HIGHLIGHT_COLOR = 0xffffff;
/** linha fina bem no TOPO da faixa (onde o rodapé encosta na parede) --
 * pedido do Douglas depois da cava: "faca uma linha encima do rodape
 * tambem, nao apenas no detalhe" (a cava sozinha, mais pra baixo, não
 * bastava -- faltava marcar também a emenda de CIMA, onde o rodapé
 * "sai" da parede). Reaproveita o mesmo tom da sombra da cava (mesmo
 * "material", só que aqui é a linha de encontro rodapé/parede, não o
 * sulco). */
const WALL_BASEBOARD_TOP_LINE_PX = 1;
const WALL_BASEBOARD_TOP_LINE_COLOR = WALL_BASEBOARD_GROOVE_SHADOW_COLOR;

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

// alpha da tinta chapada de cada tile de área (ver addAreaTileRect) --
// SÓ durante a EDIÇÃO agora (this.editMode true); fora do editor
// continua 0 (invisível). Histórico: pedido do Douglas "a cor que
// seleciono na area fica encima do tile? tira totalmente essa camada
// de cor" tirou a tinta TAMBÉM da edição (virou 0 sempre); veio de
// volta só pra edição por pedido dele: "ta mas, na edicao, quando eu
// to CRIANDO a area, tem que aparecer o campo de marcacao" -- sem ela,
// pintar um tile de área não dava NENHUM indício visual de que
// funcionou (o contorno que também dava esse indício, redrawAreaBorders,
// já tinha sido removido antes, ver addAreaTileRect). Mesmo valor de
// antes da 1ª remoção (0.35 editando); fora do editor seguiu 0 mesmo
// (aquele pedido original continua valendo pro uso normal).
const DRAFT_AREA_TILE_ALPHA_EDITING = 0.35;

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

/** Ferramenta de parede selecionada no editor (ver selectWallTool) --
 * MESMA ideia da FloorTool acima, só que "paint" pinta uma ARESTA da
 * grade (não um tile inteiro, ver WallSegmentDef em game/wall.ts). */
type WallTool = { kind: "paint"; entry: WallCatalogEntry } | { kind: "erase" } | null;

/** Ferramenta de porta selecionada no editor (ver selectDoorTool) --
 * MESMA ideia da WallTool acima (mora numa ARESTA da grade, não um tile
 * inteiro), só que "paint" também carrega o `facing` (esquerda/direita)
 * escolhido ANTES de posicionar -- pedido do Douglas: "frete esq, frente
 * dir, mesma coisa" (mesmo mecanismo de girar um móvel antes de colocar,
 * ver DOOR_FACING_ROTATE_ORDER em game/door.ts) -- GameRoom.tsx/
 * ItemEditor.tsx são donos do botão de girar; aqui só recebe o valor já
 * escolhido. */
type DoorTool = { kind: "paint"; entry: DoorCatalogEntry; facing: DoorFacing } | { kind: "erase" } | null;

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

// distância (px de TELA, mesmo espaço de PROXIMITY_CONNECT/DISCONNECT em
// GameRoom.tsx) pra abrir/fechar uma porta de correr sozinha, por
// proximidade de QUALQUER avatar (local ou remoto) -- pedido do Douglas:
// "por proximidade, como se fosse uma porta automatica" (ver
// updateDoorOpenState). Medida a partir do PONTO CENTRAL da aresta
// (doorWorldAnchor): a distância do centro de um tile vizinho até essa
// aresta é ~71px nesta grade (metade da diagonal do tile, ver
// ISO_TILE_WIDTH/ISO_TILE_HEIGHT em grid.ts), então DOOR_OPEN_DISTANCE_PX
// cobre "já entrou no tile vizinho da porta". Histerese (abre mais perto,
// só fecha depois de afastar mais) pra não ficar abrindo/fechando
// piscando bem em cima do limiar, mesma ideia de PROXIMITY_CONNECT/
// PROXIMITY_DISCONNECT.
const DOOR_OPEN_DISTANCE_PX = 100;
const DOOR_CLOSE_DISTANCE_PX = 160;

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
  // qual ASSENTO de `seatedAt` (offset relativo à âncora, não tile
  // absoluto -- continua valendo se o móvel for arrastado pro editor,
  // ver handleEditPointerDown mais abaixo) -- {0,0} pra âncora
  // (comportamento de sempre), ou o dCol/dRow de um FurnitureExtraSeat
  // (ver game/furniture.ts) pra um item com mais de um lugar (ex: sofá).
  private seatedAtOffset: { dCol: number; dRow: number } = { dCol: 0, dRow: 0 };

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
  /** fachada do prédio colada na quina de baixo da sala (ver FACADE_TEXTURE_KEY / positionFacade). */
  private facadeImage?: Phaser.GameObjects.Image;
  /** quinas EXTRAS da fachada, 1 sprite por quina (sala em L/escada com
   * mais de 1 quina externa -- ver roomFrontCorners/positionFacade),
   * indexado por "col,row" do tile-quina (mesmo padrão de
   * draftFloor/draftWall no resto do arquivo), pra sobreviver entre
   * chamadas e sumir sozinho se a quina deixar de existir. */
  private facadeCornerSprites: Map<string, Phaser.GameObjects.Image> = new Map();
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

  // clique-pra-andar agora exige DOIS cliques no MESMO tile (não um só)
  // pra disparar o andar -- pedido do Douglas: "pra andar dois cliques
  // nao um so, meu avatar t toda hroa andando". Antes, TODO pointerdown
  // no chão já mandava andar -- inclusive o começo de um arrasto de
  // câmera (startCameraPan roda no MESMO listener de pointerdown, ver
  // create()), então só tentar arrastar o mapa pra olhar em volta já
  // fazia o avatar sair andando sozinho toda hora (não tem pointerdown
  // "de sobra" durante um arrasto -- só um, no início -- por isso um
  // clique isolado nunca vira "andar" agora, e arrastar continua 100%
  // sem efeito nenhum no andar). Guarda quando/onde foi o último clique
  // "armado"; um segundo clique no MESMO tile dentro de
  // ROOM_DOUBLE_CLICK_MS confirma a intenção de andar de verdade (ver
  // handleRoomPointerDown).
  private lastRoomClickAt = 0;
  private lastRoomClickCol = -1;
  private lastRoomClickRow = -1;

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
  onSeatOffsetReset?: (groupKey: string, facing: FurnitureFacing) => void;
  /** Definido de fora (GameRoom.tsx) -- emitido só por um NUDGE de verdade (ver nudgeSeatOffset), nunca só por sentar/levantar/ligar o modo (isso é só onSeatTuningChange, puramente de EXIBIÇÃO). É esse aqui que o React usa pra atualizar o mapa que autosalva -- sentar numa cadeira com o modo ligado não pode sozinho "gravar" o valor default como se fosse um ajuste manual. */
  onSeatOffsetChange?: (groupKey: string, facing: FurnitureFacing, x: number, y: number) => void;

  // --- FORMATO da sala (aba "Tamanho", ver selectRoomShapeTool) --
  // pedido do Douglas: "eu quero adicionar mais piso alem do limite que
  // ja tem da sala, quero aumentar a sala" -- depois de confirmar que é
  // "formato livre, tile por tile", não esticar um retângulo inteiro
  // (ver comentário grande sobre GRID_COLS/GRID_ROWS em game/grid.ts --
  // essas duas constantes eram o único limite de movimento/parede/porta
  // antes, agora são só o tamanho PADRÃO de uma sala nova). roomShape é
  // a fonte de verdade de "quais tiles são a sala de verdade" -- tudo
  // que antes checava [0,GRID_COLS]x[0,GRID_ROWS] (movimento, clique-
  // pra-andar, BFS, limite de parede/porta na borda) passa a checar
  // isTileInRoom (membro do Set) em vez disso. Chave "col,row" (mesmo
  // formato de draftFloor/draftWall/etc.), populado com um retângulo
  // 13x8 (GRID_COLS/GRID_ROWS) já em create() -- ANTES até do tamanho
  // de verdade chegar do servidor (loadSavedRoomShape, assíncrono, ver
  // GameRoom.tsx) -- assim ninguém fica travado sem conseguir andar
  // enquanto isso não responde (mesma ideia de "sala funciona sem piso
  // pintado nenhum" pro autosave do piso).
  private roomShape: Set<string> = new Set();
  private selectedRoomShapeTool: "add" | "erase" | null = null;
  /** Definido de fora (GameRoom.tsx) -- mesma ideia do onDraftFloorChange, mas pro formato da sala. */
  onDraftRoomShapeChange?: (items: { col: number; row: number }[]) => void;
  /** Definido de fora (GameRoom.tsx) -- avisa quando um clique em "Apagar" (aba "Tamanho") foi bloqueado, com o motivo (ver eraseRoomShapeAt). */
  onRoomShapeEraseBlocked?: (reason: string) => void;
  // arrasto da ferramenta "Tamanho" (pedido do Douglas: "tem como
  // adicionar arrastando? clicando de um em um leva mt tempo kkk") --
  // MESMO esquema de isPaintingFloor/lastPaintedFloorKey acima, só que
  // pra add/erase de tile de sala em vez de piso. roomShapeDragWarned
  // evita um alert() (ver onRoomShapeEraseBlocked/GameRoom.tsx) POR
  // TILE bloqueado durante um arrasto de "Apagar" -- alert() é
  // SÍNCRONO e trava a página até fechar, então um arrasto passando por
  // vários tiles bloqueados abriria vários popups em fila, um jeito
  // horrível de travar o app; agora só avisa 1x por arrasto (reseta no
  // próximo pointerdown, ver handleEditPointerDown).
  private isPaintingRoomShape = false;
  private lastPaintedRoomShapeKey: string | null = null;
  private roomShapeDragWarned = false;

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
  // Image (piso "imagem", de sempre) OU Graphics (piso "padrão", ver
  // createFloorPatternGraphics/FloorPatternConfig em game/floor.ts --
  // pedido do Douglas: "criamos ali dentro uma forma de preenchimento
  // de linhas... nao precise ser imagem mesmo") -- os dois têm
  // .destroy()/.setDepth() em comum, que é tudo que o resto do código
  // usa daqui (ver destroyFloorDisplayObject logo abaixo, que cuida de
  // apagar também a máscara "escondida" de um Graphics de padrão).
  private draftFloorSprites: Map<string, Phaser.GameObjects.Image | Phaser.GameObjects.Graphics> = new Map();
  private isPaintingFloor = false;
  private lastPaintedFloorKey: string | null = null;

  /** Definido de fora (GameRoom.tsx) -- mesma ideia do onDraftChange, mas pro piso. */
  onDraftFloorChange?: (items: FloorTileDef[]) => void;

  // --- parede de sistema do editor de espaço (aba "Parede", ver
  // selectWallTool) -- MESMO esquema do piso acima (draftFloor), só que
  // a chave do Map é o id da ARESTA (wallSegmentId: "col_row_side", ver
  // game/wall.ts), não "col,row" de um tile.
  private selectedWallTool: WallTool = null;
  // "Borda" (de sempre, aresta entre 2 tiles) ou "Centro do tile" --
  // pedido do Douglas: "eu quero tambem a opcao de inserir ela no
  // centro do tile". Só importa enquanto selectedWallTool está armado
  // (ver handleEditPointerMove/handleRoomPointerDown mais abaixo, onde
  // decide entre nearestWallEdge OU worldToTile+"center"), guardado
  // fora do tool em si pra sobreviver trocando de estilo sem perder a
  // escolha de modo (ver setWallPlacementMode).
  private wallPlacementMode: "edge" | "center" = "edge";
  // Orientação usada quando wallPlacementMode é "center" -- pedido
  // posterior do Douglas: "as paredes de centro de tile precisam poder
  // nas duas direcoes, so ta em uma". "center" segue a orientação de
  // colPlus (a de sempre), "centerRow" a de rowPlus (ver WallSide em
  // game/wall.ts). Só importa no modo "center" (mesma ideia de
  // wallPlacementMode acima), guardado fora do tool em si pra
  // sobreviver trocando de estilo sem perder a escolha.
  private wallCenterOrientation: "center" | "centerRow" = "center";
  private draftWall: Map<string, WallSegmentDef> = new Map();
  // Image (estilo COM ARTE, de sempre) OU Graphics (estilo "padrão", ver
  // createWallPatternGraphics/WallPatternConfig em game/wall.ts) -- os
  // dois têm .destroy()/.setDepth() em comum, mesma ideia de
  // draftFloorSprites em floor.ts (SEM precisar do destroy especial que
  // o piso padrão precisa: um Graphics de parede não cria textura
  // própria nenhuma, então .destroy() sozinho já basta, sem vazar nada).
  private draftWallSprites: Map<string, Phaser.GameObjects.Image | Phaser.GameObjects.Graphics> = new Map();
  // "recorte" do boneco atrás da parede -- pedido do Douglas: "quando o
  // avatar fica atras da parede, teria como fazer um recorte na parede?
  // tipo, pra nao tapar o avatar, sem zerar toda ela", esclarecido como
  // "totalmente isolada da geometia delas" (o buraco NÃO pode depender
  // da geometria/pontos de CADA parede -- nada de recalcular o polígono
  // de cada segmento). Por isso é uma MÁSCARA (mesmo mecanismo já usado
  // em updateAreaDim/areaDimMaskGfx abaixo, mesmo GeometryMask com
  // invertAlpha) em vez de mexer no desenho de cada parede.
  //
  // 1ª versão: UMA máscara compartilhada, aplicada em toda parede, com
  // um retângulo pra CADA boneco (não importa se atrás ou na frente
  // dela) -- a ideia era deixar o boneco (desenhando por cima quando tá
  // NA FRENTE) esconder o buraco sozinho, sem precisar checar "esse
  // boneco tá atrás dessa parede?" em lugar nenhum. Só que o Douglas viu
  // ao vivo o furo aparecendo TAMBÉM com o boneco na frente ("ta
  // recortando quando ele ta na frente tambe", print mostrando um halo
  // com a cor do CHÃO por trás vazando ao redor do boneco): a arte do
  // boneco tem espaço TRANSPARENTE ao redor da silhueta (entre braço e
  // corpo, cantos da cabeça, etc.) -- o buraco (um retângulo/elipse
  // cheio) é maior que a silhueta de verdade, então nesses pixels
  // transparentes o buraco "vazava" e mostrava o que tem atrás da
  // PAREDE (chão/parede de trás), mesmo com o boneco tecnicamente na
  // frente.
  //
  // Fix: cada parede (Image OU Graphics, ver addWallSprite/
  // createWallPatternGraphics) ganha seu PRÓPRIO Graphics-fonte/máscara
  // À PARTE (guardado como DATA no próprio objeto da parede, chave
  // WALL_CUTOUT_MASK_GFX_DATA_KEY -- assim não precisa de um Map
  // paralelo nem mexer em cada um dos vários pontos que criam parede),
  // redesenhado TODO FRAME (updateWallAvatarCutoutMask, chamado em
  // update()) só com os bonecos cuja PROFUNDIDADE é menor que a DESSA
  // parede especificamente (== realmente atrás DELA, mesma comparação
  // que já decide a ordem de desenho normal, ver wallDepthForSegment/
  // avatarDepthForY -- CONTINUA sem tocar em nenhum ponto/aresta/canto
  // da parede, só compara 2 números). Isolado por parede: se o boneco
  // tá na frente de uma parede X mas atrás de uma parede Y mais adiante
  // na sala, só Y ganha buraco, X fica intacta.
  private isPaintingWall = false;
  private lastPaintedWallKey: string | null = null;
  // destaque da aresta mais próxima do cursor com a ferramenta de parede
  // armada (mesma ideia do hoverGraphics do piso, só que uma LINHA ao
  // longo da aresta em vez de preencher o losango inteiro do tile --
  // pedido do Douglas no desenho de referência: "tile verde" marcando
  // onde a parede vai continuar se clicar).
  private wallHoverGraphics?: Phaser.GameObjects.Graphics;

  /** Definido de fora (GameRoom.tsx) -- mesma ideia do onDraftFloorChange, mas pra parede. */
  onDraftWallChange?: (items: WallSegmentDef[]) => void;

  // --- porta do editor de espaço (aba "Porta", ver selectDoorTool) --
  // pedido do Douglas: "vamos criar uma nova categoria 'porta'... porque
  // ela precisa abrir de diferentes formas: por proximidade... [e] o
  // dono da area em questao, pode bloquear ela". MESMO esquema de
  // parede (draftWall acima: aresta da grade, mesma chave doorSegmentId
  // "col_row_side"), Map SEPARADO (uma aresta não pode ter as duas ao
  // mesmo tempo -- ver paintDoorAt/paintWallAt).
  private selectedDoorTool: DoorTool = null;
  private draftDoor: Map<string, DoorSegmentDef> = new Map();
  private draftDoorSprites: Map<string, Phaser.GameObjects.Image> = new Map();
  // ESTADO ao vivo (aberta/fechada) de cada porta -- recalculado TODO
  // FRAME (updateDoorOpenState, chamado em update()) a partir da
  // distância de QUALQUER avatar (local ou remoto, já tenho as duas
  // posições sem precisar de mensagem nova nenhuma no protocolo -- ver
  // localContainer/remoteContainers) até a aresta da porta, com uma
  // pequena histerese (mesma ideia de PROXIMITY_CONNECT/DISCONNECT do
  // checkProximity em GameRoom.tsx) pra não ficar piscando aberta/
  // fechada bem na borda do raio. true = aberta agora. Ausente = nunca
  // computado ainda (trata como fechada, mesmo padrão de !== true nos
  // lugares que leem).
  private doorOpenState: Map<string, boolean> = new Map();
  // travada MANUALMENTE pelo dono da área que ela guarda (ver
  // "lock-door"/"unlock-door" no protocolo de server/index.js,
  // setDoorLock abaixo) -- SEMPRE vence a proximidade (uma porta
  // travada não abre nem com avatar embaixo dela). Chave: doorSegmentId.
  private doorLocked: Set<string> = new Set();
  // status ao vivo de cada jogador (ProfileStatus -- "online"/"away"/
  // "focus", ver broadcast "profile" em server/index.js) -- só usado pra
  // saber se o DONO de uma área "mesa-privada" tá em modo "focus" agora
  // (ver comentário grande de updateDoorOpenState: nesse caso a porta
  // que ela guarda também fica travada sozinha, sem precisar clicar
  // nada, pedido do Douglas: "no modo foco ja trava a porta"). Guardado
  // por playerId (não por área -- um jogador pode ser dono de mais de
  // uma área ao longo da sessão, mesma chave que areaOwnerByAreaId já
  // usa pra identificar quem é o dono).
  private playerStatus: Map<string, string> = new Map();
  private isPaintingDoor = false;
  private lastPaintedDoorKey: string | null = null;

  /** Definido de fora (GameRoom.tsx) -- mesma ideia do onDraftWallChange, mas pra porta. */
  onDraftDoorChange?: (items: DoorSegmentDef[]) => void;
  /** Definido de fora -- clicar numa porta travável (ver doorGuardedAreaId abaixo) manda o pedido de travar/destravar pro servidor (protocolo "lock-door"/"unlock-door"); a mudança de verdade só aplica quando o broadcast "door-lock" volta (ver setDoorLock), mesma cautela de onClaimArea (nunca aplica otimista). */
  onLockDoor?: (col: number, row: number, side: DoorSide) => void;
  onUnlockDoor?: (col: number, row: number, side: DoorSide) => void;

  /** Definido de fora (GameRoom.tsx) -- chamado ao clicar em QUALQUER avatar (local ou remoto), pra abrir o card de perfil. */
  onAvatarClick?: (info: { playerId: string; isLocal: boolean; name: string; color: string }) => void;

  // --- área do editor de espaço (aba "Área", ver selectAreaTool) --
  // MESMO esquema do piso (draftFloor acima): draftArea/draftAreaSprites
  // guardam TODA a área da sala (salva no servidor + pintada agora nesta
  // sessão, tudo no mesmo Map, chave "col,row" -- um tipo de área por
  // tile, pintar de novo em cima troca o tipo em vez de empilhar).
  private selectedAreaTool: AreaTool = null;
  private draftArea: Map<string, AreaTileDef> = new Map();
  private draftAreaSprites: Map<string, Phaser.GameObjects.Graphics> = new Map();
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

  // dono atual de cada área "mesa-privada" (areaId -> quem tomou posse
  // clicando no botão, ver onClaimArea) -- só mesas privadas entram
  // aqui, "sala" nunca tem dono. Estado puramente externo: só muda via
  // setAreaOwner (broadcast "area-owner" do servidor), NUNCA derivado de
  // quem tá sentado onde. playerId "local" identifica o PRÓPRIO jogador
  // (ver onAreaOwnerClick/isLocal). A posse PERSISTE no servidor mesmo
  // com o dono desconectado, e agora também não sai mais clicando na
  // própria mesa (pedido do Douglas: "ela e sua, ate apagarem o espaco"
  // / "nao quero soltar a mesa clicando nela, a mesa só solta quando
  // apago o espaco dela") -- só sai de fato quando a área é apagada (ver
  // setAreaState em server/roomStore.js, que poda areaOwners de área que
  // sumiu) ou via "force-release-area" do CEO (ver onForceReleaseArea).
  // playerId null é o caso "dono offline agora", NUNCA "sem dono" (isso
  // continua sendo a área simplesmente não estar neste Map, ver
  // setAreaOwner abaixo). Status online/offline não tem mais nenhum
  // reflexo visual aqui (o rótulo "mesa de <nome>" que mostrava a
  // bolinha foi arrancado, ver comentário grande de areaHoverZones) --
  // o campo continua guardado mesmo assim, só não é mais lido pra
  // desenhar nada.
  private areaOwnerByAreaId: Map<string, { playerId: string | null; name: string }> = new Map();

  // true só DEPOIS que o "init" (ver comentário grande de
  // areaOwnerByAreaId acima) já preencheu esse Map com a posse de
  // mesa de TODO MUNDO, inclusive a minha própria -- pedido do
  // Douglas, 30/set (20): "esse balao [Assumir essa mesa?] ainda
  // aparece quando eu dou spawn na sala, mesmo eu ja tendo mesa
  // assumida". updateAreaDim (ver showAreaClaimPrompt mais abaixo) já
  // pulava a PRIMEIRA transição de área (isInitialSpawnFrame, pro bug
  // antigo do spawn caindo em cima de mesa livre), mas isso só cobre
  // o exato frame de nascer -- se o boneco local andar (ou for
  // reposicionado) ANTES do "init" chegar (rede lenta/servidor
  // dormindo no Render free tier), o Map ainda tava VAZIO nesse
  // instante: localOwnsAnyArea() dava false mesmo eu já sendo dona de
  // outra mesa de verdade, e o balão abria à toa. Setado uma vez só
  // (ver markAreaOwnersSynced, chamado por GameRoom.tsx assim que
  // processa data.areaOwners do "init"), nunca mais volta a false.
  private areaOwnersSynced = false;

  /** Chamado de fora (GameRoom.tsx) assim que os area-owners do
   * "init" já foram todos aplicados (ver comentário de
   * areaOwnersSynced acima). */
  markAreaOwnersSynced() {
    this.areaOwnersSynced = true;
  }

  /**
   * Pedido do Douglas: "uma pessoa só pode assumir uma mesa por espaço"
   * -- true se o jogador LOCAL já é dono de QUALQUER área nessa sala
   * (não importa qual). Quem decide de verdade é o servidor (ver
   * "claim-area-denied" em server/index.js), isso aqui só evita OFERECER
   * a ação quando ela já não ia dar certo mesmo -- não deixa o clique no
   * botão/hover (updateAreaHoverLabels) chegar a mandar claim-area.
   */
  private localOwnsAnyArea(): boolean {
    for (const owner of this.areaOwnerByAreaId.values()) {
      if (owner.playerId === "local") return true;
    }
    return false;
  }

  // "véu" de escurecer fora da área onde o LOCAL está agora (ver
  // updateAreaDim/DEPTH_AREA_DIM) -- UM retângulo preto cobrindo o mapa
  // inteiro, com uma MÁSCARA (areaDimMaskGfx, invertida) recortando o
  // "buraco" aceso: o retângulo da área + a silhueta de tela de cada
  // móvel que esteja de pé num tile dela (ver addFurnitureHole em
  // updateAreaDim -- sem isso, um móvel desenhado maior que 1 tile de
  // altura, ex: poltrona gamer, ficava com o topo "cortado" pelo véu na
  // borda da área mesmo estando DENTRO dela). areaDimAreaId guarda a
  // área usada pra desenhar da ÚLTIMA vez, só pra updateAreaDim não
  // recriar o retângulo/máscara à toa todo frame quando o jogador não
  // mudou de área -- o TAMANHO/POSIÇÃO do retângulo em si, porém, é
  // mantido em dia à parte, TODO frame mesmo (ver
  // syncAreaDimRectToCamera, chamada em update() abaixo), porque isso
  // muda com arrasto/zoom da câmera, que pode acontecer sem trocar de
  // área nenhuma.
  private areaDimSprites: Phaser.GameObjects.Rectangle[] = [];
  private areaDimMaskGfx?: Phaser.GameObjects.Graphics;
  private areaDimAreaId: string | null | undefined = undefined;

  // sprite de cada móvel FIXO (ROOM_FURNITURE, ver create() logo abaixo)
  // -- guardado só pra updateAreaDim conseguir ler o tamanho/posição
  // real na TELA dele (getBounds()) na hora de recortar a máscara do véu.
  // A mobília colocada pelo editor já tem isso em draftSprites.
  private roomFurnitureSprites: Map<string, Phaser.GameObjects.Image> = new Map();

  /** Definido de fora (GameRoom.tsx) -- chamado ao clicar em "Assumir mesa" numa mesa privada sem dono. */
  onClaimArea?: (areaId: string) => void;

  /**
   * Definido de fora (GameRoom.tsx) -- só o "CEO" (dono da sala, ver
   * isRoomOwner/setRoomOwner abaixo) consegue disparar isso de verdade;
   * derruba a posse de OUTRA pessoa numa mesa privada (protocolo
   * "force-release-area" em server/index.js, DIFERENTE de "release-area"
   * que só o PRÓPRIO dono pode mandar -- o servidor confere de novo quem
   * é dono da sala antes de aceitar, nunca confia só no cliente). Pedido
   * do Douglas: "somente o CEO pode destituir mesa de fulano". Sempre
   * chamado depois de uma confirmação (ver showDestituirPrompt), nunca
   * direto no clique.
   */
  onForceReleaseArea?: (areaId: string) => void;

  // true quando o jogador LOCAL é o "CEO" (dono da sala, mesmo "owner"
  // já usado pra liberar o editor de espaço -- ver roomRole/canEditRoom
  // em GameRoom.tsx) -- alimentado de fora via setRoomOwner, só usado
  // aqui pra decidir se o clique numa mesa de OUTRA pessoa oferece
  // "destituir" (ver updateAreaHoverLabels) em vez de abrir o card de
  // perfil dela.
  private isRoomOwner = false;

  // confirmação "destituir mesa de fulano?" do CEO (ver
  // showDestituirPrompt) -- disparada por CLIQUE (não por entrar
  // andando), então pode se referir a uma área BEM diferente da que o
  // jogador local está pisando agora.
  private areaDestituirPromptAreaId: string | null = null;

  /** Definido de fora (GameRoom.tsx) -- pra confirmação de "destituir" do CEO (ver showDestituirPrompt). O balão em si é um elemento de DOM de verdade por cima do canvas, não desenhado pelo Phaser (pedido do Douglas depois de ver o resultado pixelado: "nao tem como ele ficar como as coisas de fora? afinal ele e um balao com botao" -- Graphics/WebGL nunca fica com a mesma suavidade/desfoque de verdade que CSS dá de graça). `x`/`y` são coordenadas de MUNDO do Phaser (ver areaTopAnchor) -- quem escuta esse callback converte pra tela com worldToCameraPoint, escalado depois pro pixel de CSS de verdade do canvas (isso aqui não faz ideia de DOM/CSS, só do mundo do jogo). */
  onAreaDestituirPromptChange?: (info: { areaId: string; message: string; x: number; y: number } | null) => void;

  // confirmação "Assumir essa mesa?" numa área ainda sem dono (ver
  // showAreaClaimPrompt). Histórico completo, 3 formatos DIFERENTES:
  // 1) convite automático "deseja assumir essa mesa? sim/não", pulsando
  //    sozinho ao entrar ANDANDO numa mesa livre -- removido por pedido
  //    do Douglas ("ainda ta aparecendo pra eu pegar a mesa toda hora"):
  //    disparava por TILE (ver onLocalAreaTileChanged no histórico do
  //    arquivo), reabrindo a cada passo DENTRO da mesma mesa, não só ao
  //    entrar nela.
  //  2) só CLIQUE no botão "Assumir mesa" chamando onClaimArea direto,
  //     sem confirmação nenhuma.
  //  3) (ATUAL) clique abre esse card de confirmação de novo -- sentiu
  //     falta dele: "cade o CARD que a gente tinha criado? em css bem
  //     bonitinho com sim e nao" -- E TAMBÉM volta a abrir sozinho ao
  //     ANDAR pra dentro da mesa, só que dessa vez por ÁREA (ver
  //     updateAreaDim, na transição areaId !== previousAreaId, que já
  //     existia pro véu de escurecer e só dispara na FRONTEIRA de
  //     verdade), não por tile -- pedido do Douglas: "SÓ aparece quando
  //     alguem ENTRA no espaco, quando sai, ele tem que sumir". As duas
  //     formas (clique E andar) abrem o MESMO card; sair da área com o
  //     card aberto pra ela derruba sozinho, sem precisar de "Não".
  private areaClaimPromptAreaId: string | null = null;

  /** Definido de fora (GameRoom.tsx) -- pra confirmação de "Assumir mesa" (ver showAreaClaimPrompt), MESMO balão de DOM/CSS de verdade (AreaConfirmBalloon em GameRoom.tsx) que o de destituir acima -- ver o comentário grande de onAreaDestituirPromptChange, vale idêntico aqui. */
  onAreaClaimPromptChange?: (info: { areaId: string; message: string; x: number; y: number } | null) => void;

  // card "quem é o dono dessa mesa" ao passar o MOUSE numa mesa JÁ
  // assumida (dono online, diferente do jogador local -- ver
  // showAreaOwnerHoverCard) -- pedido do Douglas com print de
  // referência: card com foto de perfil (moldura circular), nome+
  // bolinha de status, status embaixo, linha separadora, fileira de
  // botões só de ÍCONE (Perfil/Chamar/"posso ir aí?"/abrir conversa).
  // DIFERENTE do "Assumir essa mesa?" (showAreaClaimPrompt): esse aqui
  // não é uma confirmação de ação (sem Sim/Não), é só um cartão de
  // INFO+atalhos que aparece/some acompanhando o hover -- por isso
  // areaId aqui serve só pra saber qual hitzone tá disparando o
  // show/hide (ver pointerover/pointerout em updateAreaHoverLabels),
  // playerId é quem o card mostra de verdade (GameRoom.tsx busca o
  // perfil dele em remoteProfiles, igual o ProfileCard já faz).
  private areaHoverCardAreaId: string | null = null;

  /** Definido de fora (GameRoom.tsx) -- ver comentário grande de areaHoverCardAreaId acima. `x`/`y` em coordenada de MUNDO (mesmo padrão de onAreaClaimPromptChange/onAreaDestituirPromptChange, ver areaTopAnchor). */
  onAreaOwnerHoverCardChange?: (info: { areaId: string; playerId: string; x: number; y: number } | null) => void;

  // móvel (id) + nome de cada jogador REMOTO sentado agora, alimentado
  // de fora pelas mensagens "seat" recebidas (ver setRemoteSeat, chamado
  // pelo GameRoom.tsx) -- o LOCAL usa this.seatedAt direto, nunca passa
  // por aqui. dCol/dRow: qual ASSENTO do item (0/0 = âncora, ver
  // FurnitureModelDef.extraSeats) -- precisa pra profundidade (seatDepth)
  // ficar certa quando o assento fica noutra fileira da âncora.
  private remoteSeat: Map<string, { furnitureId: string | null; name: string; dCol: number; dRow: number }> = new Map();

  // hitbox de hover + clique de cada zona "mesa-privada" já pintada --
  // ver updateAreaHoverLabels (claim/destituir/abrir card/etc, ver
  // comentário grande da função). Chegou a ter um rótulo visual próprio
  // por cima (pílula "Assumir mesa" pra área sem dono, "mesa de <nome>"
  // pra área com dono) -- os DOIS foram ARRANCADOS, um de cada vez: o
  // de "mesa de <nome>" por pedido do Douglas ("cancela o balãozinho
  // 'mesa de fulano' / ranca ele, vamos estruturar ele separado do
  // zero"), o de "Assumir mesa" depois, quando ficou redundante com o
  // card de confirmação novo (ver showAreaClaimPrompt, que já dispara
  // sozinho ao entrar andando OU some ao clicar em qualquer ponto da
  // área -- pedido dele: "nome nao, esse card assumir mesa antigo ai"
  // [a pílula em si, não o card CSS novo]). Hoje a hitbox é 100%
  // INVISÍVEL -- clicar nela ainda funciona igual sempre (abre a
  // confirmação/destituir/card), só não tem NENHUM rótulo Phaser
  // flutuando em cima nunca mais.
  private areaHoverZones: Map<string, Phaser.GameObjects.Zone> = new Map();

  /** Definido de fora (GameRoom.tsx) -- chamado toda vez que o jogador LOCAL senta/levanta, pra mandar "seat" pro servidor (ver protocolo em server/index.js). dCol/dRow: qual ASSENTO do item (ver FurnitureModelDef.extraSeats) -- ausentes/undefined ao levantar (furnitureId null) ou ao sentar na âncora (0,0, comportamento de sempre). */
  onLocalSeatChange?: (furnitureId: string | null, dCol?: number, dRow?: number) => void;

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

    // carrega a arte de TODA combinação tipo+direção que existe em
    // FURNITURE_ART (não só as que ROOM_FURNITURE já usa) -- assim o
    // editor de espaço (ver setEditMode/paleta) consegue colocar
    // qualquer item do catálogo na hora, mesmo um que ainda não
    // apareça em nenhum móvel fixo da sala.
    for (const type of Object.keys(FURNITURE_ART) as FurnitureType[]) {
      const artByFacing = FURNITURE_ART[type];
      for (const facing of Object.keys(artByFacing) as FurnitureFacing[]) {
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
        for (const facing of Object.keys(color.art) as FurnitureFacing[]) {
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

    // mesma ideia acima, pra parede de sistema (ver WALL_CATALOG,
    // game/wall.ts) -- também uma imagem PLANA só (sem poses/direção),
    // um painel já desenhado na inclinação certa da aresta do tile.
    for (const entry of WALL_CATALOG) {
      this.load.image(wallTextureKey(entry.id), `/assets/${entry.file}`);
    }
    this.load.image(FACADE_TEXTURE_KEY, "/assets/fachada-predio.avif");
    this.load.image(FACADE_CORNER2_TEXTURE_KEY, "/assets/fachada-predio-quina-2.png");
  }

  create() {
    // posição/tamanho vêm de GAME_WIDTH/GAME_HEIGHT (grid.ts) em vez de
    // 400/300 fixo (era exatamente o centro do canvas de 800x600 antigo)
    // -- agora acompanha a resolução interna sozinho, sem precisar
    // lembrar de atualizar aqui se ela mudar nunca mais. Era a imagem
    // "room.png" (um quadriculado roxo) esticada aqui -- pedido do
    // Douglas: "remova esses quadrados roxo do fundo". Trocado por um
    // preenchimento sólido na mesma cor de base do quadriculado antigo,
    // sem precisar gerar um asset novo.
    this.add
      .rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x201434)
      .setDepth(DEPTH_ROOM_BACKGROUND);

    // formato PADRÃO da sala (ver comentário grande de roomShape lá em
    // cima) -- um retângulo GRID_COLS x GRID_ROWS (13x8), só pra já dar
    // pra andar/editar ANTES do formato de verdade chegar do servidor
    // (loadSavedRoomShape, assíncrono, mesma ideia do piso abaixo).
    // loadSavedRoomShape SUBSTITUI isso inteiro assim que a busca
    // responder -- este é só o valor inicial.
    for (let col = 0; col <= GRID_COLS; col++) {
      for (let row = 0; row <= GRID_ROWS; row++) {
        this.roomShape.add(this.roomTileKey(col, row));
      }
    }
    this.positionFacade(); // reposicionada de novo em loadSavedRoomShape/paint/erase

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
    this.wallHoverGraphics = this.add.graphics().setDepth(EDIT_UI_DEPTH).setVisible(false);

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
      this.stopWallPaint();
      this.stopDoorPaint();
      this.stopRoomShapePaint();
    });
    this.input.on("pointerupoutside", () => {
      this.stopCameraPan();
      this.stopFloorPaint();
      this.stopAreaPaint();
      this.stopWallPaint();
      this.stopDoorPaint();
      this.stopRoomShapePaint();
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

  /** Modelo do item de BASE que ocupa esse tile (col/row) -- QUALQUER
   * tile do footprint dele (furnitureFootprintTiles, não só a âncora),
   * se tiver altura de superfície configurada (ver FurnitureModelDef.
   * stackSurfaceOffsetY em furniture.ts) -- `excludeId` pula um item
   * específico (ele mesmo) pra não se achar como base de si próprio.
   * Antes só olhava a ÂNCORA (other.col/other.row) -- pedido do Douglas
   * depois de testar uma mesa grande: "o item de sobrepor, tem que
   * acompanhar os tiles que o item bloqueia, nao so na insersao" (uma
   * mesa 3x1, por exemplo, deixava "Sobrepor" um notebook só bem em cima
   * do tile-âncora dela, os outros 2 tiles da mesa ficavam bloqueando
   * sem servir de base nenhuma). Compartilhado entre stackSurfaceOffsetYFor
   * (item já colocado) e o "fantasma" do catálogo em handleEditPointerMove
   * (preview de onde um item "Sobrepor" ficaria ANTES de clicar, pedido
   * antigo do Douglas: "ver o resultado exato antes de clicar") -- os
   * dois precisam achar a MESMA base. */
  private stackBaseModelAt(col: number, row: number, excludeId?: string): FurnitureModelDef | undefined {
    const base = this.stackBaseFurnitureAt(col, row, excludeId);
    return base?.modelId ? furnitureModelById(base.modelId) : undefined;
  }

  /** Igual stackBaseModelAt acima, só que devolve a INSTÂNCIA (FurnitureDef)
   * da base, não só o model -- precisa dela de verdade pra PROFUNDIDADE
   * (ver depthReferenceTile logo abaixo). ACHADO (Douglas: "porem o
   * notebook so ficou pra tras" / "na camada", depois de confirmar que a
   * ALTURA -- stackSurfaceOffsetYFor -- já tava certa): o item "Sobrepor"
   * (notebook) não tem footprint próprio nenhum (1 tile só, a âncora
   * dele), então addFurnitureSprite calculava a profundidade dele a
   * partir DESSE tile único. Só que a BASE (mesa, footprint grande/
   * formato por direção) calcula a profundidade dela a partir do tile
   * MAIS "pra frente" do footprint INTEIRO dela (ver furnitureDepthTile) --
   * numa mesa 3x1 esse tile podia ficar bem à frente do tile-âncora onde
   * o notebook senta. O empurrãozinho fixo (DEPTH_STACK_ON_TOP, só 4px
   * equivalente) não é grande o bastante pra superar essa diferença (uma
   * fileira inteira, 64px) -- a mesa acabava desenhando DEPOIS (por cima)
   * do notebook, escondendo ele. Fix em depthReferenceTile: usa o mesmo
   * tile de referência DA BASE, não do item de cima. */
  private stackBaseFurnitureAt(col: number, row: number, excludeId?: string): FurnitureDef | undefined {
    const baseOf = (other: FurnitureDef): FurnitureDef | undefined => {
      if (other.id === excludeId) return undefined;
      if (!furnitureFootprintTiles(other).some((t) => t.col === col && t.row === row)) return undefined;
      const model = other.modelId ? furnitureModelById(other.modelId) : undefined;
      return model?.stackSurfaceOffsetY ? other : undefined;
    };
    for (const other of ROOM_FURNITURE) {
      const base = baseOf(other);
      if (base) return base;
    }
    for (const other of this.draftFurniture.values()) {
      const base = baseOf(other);
      if (base) return base;
    }
    return undefined;
  }

  /** Tile de referência pra PROFUNDIDADE (ver furnitureDepthTile) de um
   * móvel -- normal, é o tile mais "pra frente" do PRÓPRIO footprint
   * dele. Item "Sobrepor" (stackable) com uma base configurada nesse
   * tile (ver stackBaseFurnitureAt acima) é a EXCEÇÃO: usa o tile de
   * referência DA BASE (ex: a mesa), não o dele mesmo -- garante que o
   * item de cima sempre desenha DEPOIS (na frente) da base inteira, não
   * importa o formato do footprint dela. Sem base aqui ainda (Douglas não
   * configurou "Sobrepor" em nada nesse tile), cai no comportamento de
   * sempre. */
  private depthReferenceTile(f: FurnitureDef, excludeId?: string): { col: number; row: number } {
    const model = f.modelId ? furnitureModelById(f.modelId) : undefined;
    if (model?.stackable) {
      const base = this.stackBaseFurnitureAt(f.col, f.row, excludeId ?? f.id);
      if (base) return furnitureDepthTile(base);
    }
    return furnitureDepthTile(f);
  }

  /** Deslocamento vertical (px) herdado do item de BASE no MESMO tile
   * (ver stackBaseModelAt acima / FurnitureModelDef.stackable em
   * furniture.ts -- pedido do Douglas: "cada item, ex: mesa mesinha de
   * centro, eu teria que configurar, a altura de um segundo item,
   * adicionado ao tile dele"). Só olha pra base quando ESSE item (`f`) é
   * "Sobrepor" (stackable) -- item comum ignora completamente,
   * comportamento de sempre. 0 = sem base com altura configurada nesse
   * tile ainda (Douglas não mexeu em "Sobrepor" nela, ou não tem nenhum
   * item embaixo) -- cai na posição normal, no chão. */
  private stackSurfaceOffsetYFor(f: FurnitureDef): number {
    const model = f.modelId ? furnitureModelById(f.modelId) : undefined;
    if (!model?.stackable) return 0;
    return this.stackBaseModelAt(f.col, f.row, f.id)?.stackSurfaceOffsetY ?? 0;
  }

  private addFurnitureSprite(f: FurnitureDef): Phaser.GameObjects.Image {
    // origem embaixo-centro, igual ao avatar: a posição do móvel é o
    // pontinho onde ele "toca o chão", alinhado ao tile dele
    const pos = furnitureWorldPos(f);
    // item "Sobrepor" (notebook em cima da mesa, ver
    // stackSurfaceOffsetYFor acima) sobe pela altura configurada na
    // BASE que estiver nesse mesmo tile -- 0 pra item comum/sem base
    // configurada, sem regressão nenhuma no resto da mobília.
    const stackOffsetY = this.stackSurfaceOffsetYFor(f);
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
    const depthTile = this.depthReferenceTile(f);
    const baseDepth = furnitureDepthForTile(depthTile.col, depthTile.row);
    // empurrão pequeno (ver DEPTH_STACK_ON_TOP) só quando tem base de
    // verdade embaixo (stackOffsetY !== 0) -- item "Sobrepor" sem base
    // configurada nesse tile ainda não ganha nenhum tratamento especial
    // de profundidade, continua na fileira lógica normal.
    const depth = f.flat ? DEPTH_FLAT_FURNITURE : baseDepth + (stackOffsetY !== 0 ? DEPTH_STACK_ON_TOP : 0);
    const image = this.add
      .image(pos.x, pos.y + stackOffsetY, key)
      .setOrigin(0.5, 1)
      .setDepth(depth)
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
      // dessa opção existir (display_width null no banco). "down"
      // (frente) sempre usa displayWidth direto -- as outras 3 direções
      // caem no PRÓPRIO tamanho se tiver (ver
      // FurnitureModelDef.directionDisplayWidth, pedido do Douglas: "se
      // eu mudar de um ele muda de todas as vistas? nao tem como
      // isolar?"), senão reaproveitam o mesmo valor de "down" (mesma
      // regra de directionOffsets logo abaixo, comportamento de sempre
      // sem override).
      const widthOverride = f.facing !== "down" ? model.directionDisplayWidth?.[f.facing] : undefined;
      const targetWidth = widthOverride ?? model.displayWidth ?? CUSTOM_ITEM_TARGET_WIDTH[FURNITURE_TYPE_CATEGORY[f.type]] ?? 225;
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
        // + stackOffsetY de novo aqui -- sem isso, um item CUSTOM
        // "Sobrepor" com offsetX/Y próprio perderia a altura herdada da
        // base (setPosition substitui a posição inteira, não só X/Y
        // isolados) assim que entrasse nesse if.
        image.setPosition(pos.x + offX, pos.y + offY + stackOffsetY);
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
   * Cria (ou recria) a imagem/desenho de UM quadrado de piso pintado, já
   * com origem/tamanho/profundidade certos -- usado tanto pro piso já
   * salvo (ver loadSavedFloor) quanto pros tiles pintados na hora no
   * editor de espaço (ver paintFloorAt), mesma ideia do
   * addFurnitureSprite. Ramifica em dois tipos de modelo (ver
   * FloorCatalogEntry em game/floor.ts): "imagem" (de sempre, textura
   * carregada por URL) ou "padrão" (pedido do Douglas: piso sem imagem
   * nenhuma, desenhado por código -- ver createFloorPatternGraphics
   * abaixo). Devolve null se o styleId não bate com nenhum item do
   * catálogo (defensivo -- não deveria acontecer normalmente) OU, só
   * pro tipo "imagem", se a textura desse estilo, por algum motivo, não
   * terminou de carregar ainda (ver comentário abaixo -- bug reportado
   * pelo Douglas: piso salvo virando o quadriculado preto/verde do
   * Phaser -- "textura faltando" -- depois de um F5); piso "padrão"
   * nunca cai nesse caso (não depende de textura nenhuma pra existir).
   * Nos casos de null, MELHOR não desenhar nada (o tile fica só sem o
   * piso pintado, mostrando o fundo padrão por baixo) do que mostrar
   * esse quadriculado feio -- e o console.warn dá uma pista de verdade
   * (styleId + chave) da próxima vez que acontecer, em vez de só
   * "sumiu".
   */
  private addFloorSprite(f: FloorTileDef): Phaser.GameObjects.Image | Phaser.GameObjects.Graphics | null {
    const entry = floorEntryById(f.styleId);
    if (!entry) return null;
    if (entry.pattern) return this.createFloorPatternGraphics(f, entry.pattern);
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
   * Desenha um tile de piso "padrão" (sem imagem nenhuma, ver
   * FloorPatternConfig em game/floor.ts -- pedido do Douglas: "criamos
   * ali dentro uma forma de preenchimento de linhas... nao precise ser
   * imagem mesmo, faz sentido? ficaria mais leve?"): Graphics com
   * ripas/faixas alternando colorA/colorB, recortado no formato do
   * losango do tile via GeometryMask (mesmo padrão já usado em
   * updateAreaDim mais abaixo, ver maskGfx.createGeometryMask() lá).
   *
   * A MATEMÁTICA da ripa: p(x,y) = x + 2*y é a coordenada, em pixel de
   * TELA ABSOLUTO, perpendicular à direção "ao longo de uma aresta do
   * losango" -- vem direto da proporção 2:1 do tile (ver
   * ISO_TILE_WIDTH/HEIGHT em grid.ts: a aresta "col fixo, row variando"
   * anda (-hw,+hh) por passo, e (1,2) é perpendicular a isso). Cada
   * faixa é a região entre dois valores consecutivos de p, múltiplos de
   * plankWidthPx -- desenhada como um retângulo comprido (bem maior que
   * 1 tile) na direção da ripa, sem precisar recortar contra o losango
   * na mão (a MÁSCARA cuida disso). Por p ser uma fórmula em coordenada
   * ABSOLUTA (não relativa a f.col/f.row), a MESMA faixa continua
   * exatamente de um tile pro vizinho -- é isso que faz a sala inteira
   * parecer um piso corrido, em vez de um carimbo repetido.
   */
  /** Escurece uma cor hex Phaser (ex: 0xa9835f) multiplicando cada canal
   * RGB por `factor` -- usado como linha de junta AUTOMÁTICA das tábuas
   * quando FloorPatternConfig.lineColor não é definido (ver
   * createFloorPatternGraphics abaixo). */
  private darkenColor(hex: number, factor = 0.55): number {
    const r = Math.round(((hex >> 16) & 0xff) * factor);
    const g = Math.round(((hex >> 8) & 0xff) * factor);
    const b = Math.round((hex & 0xff) * factor);
    return (r << 16) | (g << 8) | b;
  }

  /**
   * Índice determinístico (0..len-1) pra escolher a cor de UMA tábua
   * específica (coluna `i`, posição `j` dentro da coluna) dentro de
   * FloorPatternConfig.colors -- "sorteia" sem sortear de verdade: mesma
   * (i,j) sempre cai no mesmo índice, então a tábua não muda de cor
   * sozinha ao redesenhar (refreshFloorModel, reconexão, etc.) sem
   * precisar guardar em lugar nenhum qual cor cada tábua usa. Mistura de
   * bits comum (tipo hash de posição de grade em shader/procgen), não
   * precisa ser criptográfico, só bem distribuído. */
  private plankColorIndex(i: number, j: number, len: number): number {
    let h = (i * 374761393 + j * 668265263) ^ (i << 13);
    h = Math.imul(h ^ (h >>> 15), 1274126177);
    h = h ^ (h >>> 16);
    return Math.abs(h) % len;
  }

  /** Cor de uma tábua (coluna `i`, posição `j`): sorteia de
   * pattern.colors (ver plankColorIndex acima) quando essa paleta está
   * definida, senão cai no comportamento antigo de alternar só
   * colorA/colorB por coluna. */
  private pickPlankColor(pattern: FloorPatternConfig, i: number, j: number): number {
    if (pattern.colors && pattern.colors.length > 0) {
      return pattern.colors[this.plankColorIndex(i, j, pattern.colors.length)];
    }
    return ((i % 2) + 2) % 2 === 0 ? pattern.colorA : pattern.colorB;
  }

  private createFloorPatternGraphics(f: FloorTileDef, pattern: FloorPatternConfig): Phaser.GameObjects.Image {
    const pos = floorWorldPos(f);
    const step = Math.max(4, pattern.plankWidthPx);
    const sqrt5 = Math.sqrt(5);
    // vetores UNITÁRIOS fixos (não dependem do tile), OS DOIS iguais aos
    // eixos DE VERDADE da grade isométrica (ver tileToWorld em
    // game/grid.ts): rowAxis = "col fixo, row variando" (-2,1)
    // normalizada (a MESMA direção da aresta esquerda do losango do
    // tile), colAxis = "col variando, row fixo" (2,1) normalizada (a
    // MESMA direção da aresta direita do losango). Diferente de uma
    // base ortonormal (90° entre si), rowAxis/colAxis NÃO são
    // perpendiculares (ângulo de ~126.87°, igual ao ângulo do próprio
    // losango do tile) -- É ISSO QUE FAZ A TÁBUA FICAR "NO ÂNGULO DO
    // PISO": antes (dirWid = perpendicular EUCLIDIANA de dirLen, não
    // batia com nenhuma aresta de verdade do tile) o Douglas reportou,
    // com o piso já pintado na sala: "ta fora do angulo do piso" -- as
    // tábuas saíam RETANGULARES (ângulo reto de verdade na tela), mas
    // um retângulo reto NUNCA fica alinhado com as DUAS arestas de um
    // losango 2:1 ao mesmo tempo (só uma reta é perpendicular a outra
    // reta; as arestas do losango não são perpendiculares entre si).
    // Usando os eixos REAIS do losango pras tábuas (como um quadrado do
    // MUNDO 3D vira um paralelogramo ao projetar em isométrico -- é
    // assim que TODO o resto da cena já é desenhado, ver tileToWorld),
    // cada tábua vira um PARALELOGRAMO com as pontas cortadas na MESMA
    // inclinação do losango -- exatamente a foto de referência que o
    // Douglas mandou ("quero na mesma posicao/sentido da linha do
    // tile... assim como na imagem que te mandei").
    const rowAxis = { x: -2 / sqrt5, y: 1 / sqrt5 };
    const colAxis = { x: 2 / sqrt5, y: 1 / sqrt5 };
    // Decompor um ponto absoluto (x,y) em (acrossCol, alongRow) tal que
    // (x,y) = acrossCol*colAxis + alongRow*rowAxis -- como colAxis/
    // rowAxis NÃO são ortogonais, isso não é mais um produto escalar
    // simples (como era com a base ortonormal antiga), é resolver o
    // sistema linear 2x2 ponto = a*colAxis + b*rowAxis pra (a,b) -- dá
    // a = sqrt5*(x+2y)/4 e b = sqrt5*(2y-x)/4 (conta fechada, só
    // depende da proporção 2:1 do tile, não do tamanho de cada tábua).
    // acrossCol/alongRow já saem em PIXEL de verdade (não precisa
    // dividir por sqrt5 de novo mais na frente, diferente da conta
    // antiga com p0/q0) -- across/alongOf calculados em coordenada
    // ABSOLUTA da tela (não por tile), então a mesma grade de tábuas
    // continua exatamente igual de um tile pro vizinho.
    function acrossColOf(x: number, y: number) {
      return (sqrt5 * (x + 2 * y)) / 4;
    }
    function alongRowOf(x: number, y: number) {
      return (sqrt5 * (2 * y - x)) / 4;
    }
    const acrossCol0 = acrossColOf(pos.x, pos.y); // posição do centro do tile ao longo de colAxis
    // FASE da grade de faixas -- pedido do Douglas depois de travar
    // plankWidthPx/plankLengthPx num divisor exato do tile (porcelanato,
    // e o botão "Travar tábuas na grade do tile"): "continua deslocado".
    // Causa raiz: acrossCol0/alongRow0 acima são pixel ABSOLUTO da TELA
    // (x=0,y=0), não da SALA -- travar só o TAMANHO da faixa (=
    // TILE_SIZED_PLANK_PX ou um divisor dela) garante que 1 faixa cobre
    // exatamente 1 tile de largura, mas continua sem garantir ONDE cada
    // faixa começa: com a fase ancorada em x=0 (um pixel de tela
    // qualquer, quase nunca em cima de uma borda de tile de verdade,
    // porque a sala inteira já nasce deslocada de GRID_ORIGIN_X/Y, ver
    // game/grid.ts), a faixa cai com um deslocamento CONSTANTE (mesmo
    // em toda faixa/tile da sala) que faz a junta cruzar no meio do
    // losango em vez de bater na borda -- exatamente o "porcelanato
    // deslocado"/"deck cortado" que ele reportou.
    //
    // Fix: reancora a fase da grade de faixas no tile (0,0) da PRÓPRIA
    // sala (originCenter = tileToWorld(0,0), sempre o mesmo ponto fixo
    // não importa qual tile este aqui é) em vez da origem da tela --
    // acrossPhase/alongPhase abaixo são a borda ESQUERDA desse tile
    // (centro menos meio tile) nessa mesma base (colAxis/rowAxis), o
    // "zero" que faz toda faixa daí em diante (nos dois sentidos, pra
    // QUALQUER tile da sala) cair em cima da borda de algum tile sempre
    // que step/lenStep for um divisor exato de TILE_SIZED_PLANK_PX (é
    // só um deslocamento CONSTANTE aplicado em toda faixa/toda tile por
    // igual -- não quebra em nada o "piso corrido" de quem não usa
    // tileAligned/divisor exato, só muda ONDE a fase zero cai).
    const originCenter = tileToWorld(0, 0);
    const acrossPhase = acrossColOf(originCenter.x, originCenter.y) - TILE_SIZED_PLANK_PX / 2;
    const alongPhase = alongRowOf(originCenter.x, originCenter.y) - TILE_SIZED_PLANK_PX / 2;
    // alcance de faixas que podem tocar o tile -- folga de +-(hw+hh) em
    // px de verdade (acrossCol0/alongRow0 já são pixel, ver acima)
    // garante que nenhuma faixa/tábua borda fique de fora, nos dois
    // eixos -- o losango do tile cabe inteiro num raio bem menor que
    // isso nos dois sentidos.
    const reach = ISO_TILE_WIDTH / 2 + ISO_TILE_HEIGHT;
    const minIndex = Math.floor((acrossCol0 - acrossPhase - reach) / step) - 1;
    const maxIndex = Math.ceil((acrossCol0 - acrossPhase + reach) / step) + 1;

    // ACHADO depois de 3 tentativas que NÃO resolveram a linha de junta
    // picotada numa diagonal (afinar espessura 1.5->0.75->0.4px, depois
    // reduzir opacidade, depois trocar stroke por retângulos
    // preenchidos -- Douglas testou e confirmou: "ta igual ainda"):
    // causa raiz de VERDADE é a RESOLUÇÃO. O jogo roda numa resolução
    // INTERNA fixa (GAME_WIDTH/HEIGHT = 1200x900, ver grid.ts) que o
    // Phaser estica (Scale.ENVELOP) pra cobrir a tela real -- numa tela
    // grande/retina isso é um upscale considerável, e QUALQUER geometria
    // fina desenhada ao vivo ali (fill OU stroke, não importa) sai
    // picotada, porque o anti-serrilhado (WebGL MSAA) acontece ANTES do
    // upscale, na resolução BAIXA -- é só o resultado JÁ picotado que
    // fica esticado/em blocos depois. (Não dá pra simplesmente aumentar
    // GAME_WIDTH/HEIGHT pra resolver: já foi testado em 2x -- ver
    // comentário grande em grid.ts -- e o Douglas sentiu peso real de
    // performance, por afetar a cena INTEIRA em TODO frame.)
    //
    // Fix sem mexer na resolução do jogo (e sem custo de performance por
    // frame, já que roda só 1x por tile PINTADO, não a cada frame):
    // desenha o padrão dessa tábua/tile num <canvas> 2D OFFSCREEN, numa
    // resolução BEM maior que o tamanho do tile na tela (super-
    // amostragem), usando a API de Canvas 2D nativa do navegador (que
    // SEMPRE anti-serrilha bem uma diagonal fina, mesmo bem fina --
    // diferente do Graphics do Phaser em WebGL) -- e essa imagem, já com
    // a linha lisa desenhada em alta resolução, vira uma TEXTURA
    // (this.textures.createCanvas), mostrada como uma Image comum do
    // tamanho NORMAL do tile (setDisplaySize encolhe de volta pro
    // tamanho de sempre). Esse encolhimento (filtro bilinear da GPU, já
    // que pixelArt:false/antialias:true na config, ver game/config.ts) é
    // quem faz a mágica de "super-amostragem" de verdade: reamostra os
    // pixels finos da linha lisa pra menos pixels na tela, sem nenhum
    // serrilhado -- a mesma técnica clássica de "desenha em alta
    // resolução, encolhe pra exibir" usada em qualquer motor gráfico pra
    // deixar vetor fino nítido.
    const SS = 3; // fator de super-amostragem (o tile é desenhado 3x maior no canvas offscreen, depois encolhido de volta)
    const canvasW = ISO_TILE_WIDTH * SS;
    const canvasH = ISO_TILE_HEIGHT * SS;
    // chave ÚNICA por tile PINTADO (não por estilo) -- diferente do piso
    // "imagem" (que reusa a MESMA textura do catálogo em vários tiles),
    // aqui cada tile tem sua própria textura porque a fase da faixa (ver
    // acrossCol0/alongRow0 acima) depende da posição ABSOLUTA do tile,
    // então o conteúdo desenhado é único por (col,row) mesmo dentro do
    // MESMO estilo. destroyFloorDisplayObject (logo abaixo) sabe apagar
    // essa textura junto quando o tile é apagado/repintado/editado.
    const texKey = `floor-pattern-${f.styleId}-${f.col}-${f.row}`;
    if (this.textures.exists(texKey)) this.textures.remove(texKey);
    const canvasTexture = this.textures.createCanvas(texKey, canvasW, canvasH)!;
    const ctx = canvasTexture.context;
    // ponto em coordenada ABSOLUTA do mundo (a mesma base colAxis/
    // rowAxis de sempre, ver comentário grande acima) -> coordenada do
    // CANVAS desse tile: relativo ao centro do tile (pos.x,pos.y),
    // deslocado pro centro do canvas e escalado pelo super-amostragem.
    const toCanvas = (worldX: number, worldY: number) => ({
      x: (worldX - pos.x + ISO_TILE_WIDTH / 2) * SS,
      y: (worldY - pos.y + ISO_TILE_HEIGHT / 2) * SS,
    });
    const pathFor = (points: { x: number; y: number }[]) => {
      ctx.beginPath();
      points.forEach((p, idx) => {
        const c = toCanvas(p.x, p.y);
        if (idx === 0) ctx.moveTo(c.x, c.y);
        else ctx.lineTo(c.x, c.y);
      });
      ctx.closePath();
    };
    const cssColor = (hex: number) => `#${hex.toString(16).padStart(6, "0")}`;
    // recorte: só o losango do tile fica visível -- antes isso era uma
    // MÁSCARA Phaser à parte (um 2º Graphics "escondido" só de fonte de
    // recorte, ver comentário antigo removido daqui); agora é o próprio
    // canvas que recorta (ctx.clip()), mais simples, sem precisar de
    // mais nenhum objeto extra pra rastrear/apagar depois.
    const diamond = tileDiamondCorners(0, 0);
    ctx.save();
    ctx.beginPath();
    diamond.forEach((p, idx) => {
      const c = toCanvas(pos.x + p.x, pos.y + p.y);
      if (idx === 0) ctx.moveTo(c.x, c.y);
      else ctx.lineTo(c.x, c.y);
    });
    ctx.closePath();
    ctx.clip();

    if (pattern.plankLengthPx) {
      // --- Tábuas EMENDADAS, com linha de junta e desalinhamento entre
      // colunas ("amarração" de assoalho de verdade -- ver comentário
      // grande de FloorPatternConfig.plankLengthPx em game/floor.ts).
      // Pedido do Douglas junto com foto de referência de piso de
      // tábua corrida: "vamos criar padroes aqui, e depois subir lá",
      // e depois: "e é nessa ideia de intercalado". ---
      const lenStep = Math.max(4, pattern.plankLengthPx);
      const alongRow0 = alongRowOf(pos.x, pos.y); // posição do centro do tile ao longo de rowAxis
      const lineColorCss = cssColor(pattern.lineColor ?? this.darkenColor(pattern.colorA));
      for (let i = minIndex; i <= maxIndex; i++) {
        // colunas pares ficam alinhadas em j=0, colunas ímpares
        // deslocadas meio comprimento -- é isso que faz as juntas de
        // colunas vizinhas NÃO caírem todas na mesma linha (senão
        // pareceria ladrilho/grade, não piso de tábua de verdade).
        const colOffset = pattern.tileAligned ? 0 : ((i % 2) + 2) % 2 === 0 ? 0 : lenStep / 2;
        const minJ = Math.floor((alongRow0 - alongPhase - reach - colOffset) / lenStep) - 1;
        const maxJ = Math.ceil((alongRow0 - alongPhase + reach - colOffset) / lenStep) + 1;
        for (let j = minJ; j <= maxJ; j++) {
          const acrossTarget = acrossPhase + (i + 0.5) * step;
          const alongTarget = alongPhase + j * lenStep + colOffset + lenStep / 2;
          // ponto (cx,cy) = acrossTarget*colAxis + alongTarget*rowAxis
          // -- coordenadas ABSOLUTAS na base (colAxis,rowAxis), por isso
          // a mesma grade de tábuas cai exatamente igual em tiles
          // vizinhos, sem precisar de nenhum estado compartilhado entre
          // eles (mesmo truque do resto do arquivo).
          const cx = acrossTarget * colAxis.x + alongTarget * rowAxis.x;
          const cy = acrossTarget * colAxis.y + alongTarget * rowAxis.y;
          const halfWidth = step / 2;
          const halfLength = lenStep / 2;
          const lx = rowAxis.x * halfLength;
          const ly = rowAxis.y * halfLength;
          const wx = colAxis.x * halfWidth;
          const wy = colAxis.y * halfWidth;
          const points = [
            { x: cx - lx - wx, y: cy - ly - wy },
            { x: cx + lx - wx, y: cy + ly - wy },
            { x: cx + lx + wx, y: cy + ly + wy },
            { x: cx - lx + wx, y: cy - ly + wy },
          ];
          const plankColor = this.pickPlankColor(pattern, i, j);
          pathFor(points);
          ctx.fillStyle = cssColor(plankColor);
          ctx.fill();
          // linha de junta -- ctx.stroke() do Canvas 2D nativo já
          // anti-serrilha bem uma diagonal fina sozinho (é desenhado no
          // canvas offscreen supersampled, ver comentário grande no
          // início da função) -- diferente das tentativas anteriores
          // com o Graphics do Phaser em WebGL (lineStyle+strokePoints,
          // depois um truque de retângulos preenchidos), não precisa de
          // nenhuma técnica especial aqui, um stroke comum já fica liso.
          pathFor(points);
          ctx.lineWidth = JOINT_LINE_WIDTH * SS;
          ctx.strokeStyle = lineColorCss;
          ctx.globalAlpha = JOINT_LINE_ALPHA;
          ctx.stroke();
          ctx.globalAlpha = 1;
          // veios de madeira (pedido do Douglas: "agora eu quero esse
          // efeito laminado... de veios de madeira", depois "no sentido
          // das linhas também") -- riscos POR CIMA da tábua que acabou
          // de entrar, usando a MESMA função pura de game/floor.ts que o
          // preview do formulário usa (woodGrainShapesForPlank), pra
          // nunca dessincronizar dos dois (mesmo princípio de
          // floorPatternPolygons, ver comentário grande lá).
          if (pattern.woodGrain) {
            const grainShapes = woodGrainShapesForPlank(i, j, cx, cy, halfLength, halfWidth, rowAxis, colAxis, plankColor);
            for (const shape of grainShapes) {
              pathFor(shape.points);
              ctx.fillStyle = shape.fill;
              ctx.globalAlpha = shape.opacity ?? 1;
              ctx.fill();
              ctx.globalAlpha = 1;
            }
          }
          // veios de mármore (pedido do Douglas: "porcelanato... do
          // tamanho do tile... com efeito de porcelanato marmorado") --
          // mesma função pura de game/floor.ts que o preview do
          // formulário usa (marbleVeinShapesForSlab), mesmo princípio de
          // woodGrain logo acima.
          if (pattern.marble) {
            const veinShapes = marbleVeinShapesForSlab(i, j, cx, cy, halfLength, halfWidth, rowAxis, colAxis, plankColor);
            for (const shape of veinShapes) {
              pathFor(shape.points);
              ctx.fillStyle = shape.fill;
              ctx.globalAlpha = shape.opacity ?? 1;
              ctx.fill();
              ctx.globalAlpha = 1;
            }
          }
        }
      }
    } else {
      // --- ripa CONTÍNUA (sem emenda/junta), comportamento original --
      // mantido pra não mudar a aparência de nenhum piso "padrão" já
      // cadastrado por alguém sem plankLengthPx definido. ---
      const halfLength = ISO_TILE_WIDTH; // bem mais que suficiente pra cobrir 1 tile (128x64) inteiro, sobra de propósito
      for (let i = minIndex; i <= maxIndex; i++) {
        const acrossTarget = acrossPhase + (i + 0.5) * step;
        const dist = acrossTarget - acrossCol0;
        const cx = pos.x + colAxis.x * dist;
        const cy = pos.y + colAxis.y * dist;
        const halfWidth = step / 2;
        const lx = rowAxis.x * halfLength;
        const ly = rowAxis.y * halfLength;
        const wx = colAxis.x * halfWidth;
        const wy = colAxis.y * halfWidth;
        // pickPlankColor (não só o if/else de colorA/colorB) -- pra uma
        // paleta `colors` com mais de 2 tons também funcionar na ripa
        // CONTÍNUA, não só na tábua emendada (antes só funcionava lá,
        // gap encontrado ao trazer plankLengthPx/colors pra aba "Criar
        // Piso" -- ver pickPlankColor logo acima).
        pathFor([
          { x: cx - lx - wx, y: cy - ly - wy },
          { x: cx + lx - wx, y: cy + ly - wy },
          { x: cx + lx + wx, y: cy + ly + wy },
          { x: cx - lx + wx, y: cy - ly + wy },
        ]);
        ctx.fillStyle = cssColor(this.pickPlankColor(pattern, i, 0));
        ctx.fill();
      }
    }
    ctx.restore();
    canvasTexture.refresh();

    // Image comum (não mais Graphics ao vivo) mostrando a textura já
    // pronta (em alta resolução) ENCOLHIDA pro tamanho normal do tile
    // -- ver comentário grande no início da função pro motivo (é esse
    // encolhimento que deixa a linha lisa).
    const img = this.add.image(pos.x, pos.y, texKey).setDepth(DEPTH_FLOOR);
    img.setDisplaySize(ISO_TILE_WIDTH, ISO_TILE_HEIGHT);
    img.setData("patternTextureKey", texKey);
    return img;
  }

  /**
   * Apaga um tile de piso (Image OU Graphics, ver draftFloorSprites
   * acima) -- ponto ÚNICO que sabe que uma Image de piso "padrão" (ver
   * createFloorPatternGraphics acima) tem uma TEXTURA ÚNICA (uma por
   * tile pintado, não compartilhada com mais ninguém -- diferente do
   * piso "imagem", que reusa a mesma textura do catálogo em vários
   * tiles) que precisa ser apagada TAMBÉM, senão vaza 1 textura (e a
   * memória de GPU dela) por tile toda vez que um piso padrão é
   * apagado/repintado/editado. Uma Image de piso "imagem" (ou um
   * Graphics de versão antiga em memória) não tem essa data, getData
   * devolve undefined, e o `?.destroy()`/remove não fazem nada -- mesmo
   * código serve pros casos sem precisar checar qual é.
   */
  private destroyFloorDisplayObject(obj: Phaser.GameObjects.Image | Phaser.GameObjects.Graphics | undefined) {
    if (!obj) return;
    // compat com uma versão antiga (removida) que usava um 2º Graphics
    // "escondido" só de máscara -- fica só por segurança, nunca mais é
    // setado por createFloorPatternGraphics (agora recorta com
    // ctx.clip() dentro do próprio canvas, sem precisar de máscara).
    (obj.getData("maskGraphics") as Phaser.GameObjects.Graphics | undefined)?.destroy();
    const patternTextureKey = obj.getData("patternTextureKey") as string | undefined;
    if (patternTextureKey && this.textures.exists(patternTextureKey)) this.textures.remove(patternTextureKey);
    obj.destroy();
  }

  /**
   * Recria a sprite de todo tile JÁ PINTADO (draftFloor) que usa o
   * ESTILO dado -- mesma ideia de refreshFurnitureModel logo acima, só
   * que pra piso (ver registerCustomFloorModels em game/floor.ts e
   * fetchAndRegisterCustomFloor em GameRoom.tsx, chamado depois de editar
   * um piso custom no Editor de Itens). addFloorSprite pode devolver null
   * se a textura nova ainda não terminou de carregar (corrida, ver
   * comentário grande em addFloorSprite) -- nesse caso só destrói a
   * sprite velha e sai sem sprite nenhuma no lugar (raro, resolve sozinho
   * no próximo loadSavedFloor/reload; não vale a pena duplicar aqui o
   * retry de 400ms que já existe em loadSavedFloor só pra esse caso
   * bem mais raro).
   */
  refreshFloorModel(styleId: string) {
    for (const [key, f] of this.draftFloor.entries()) {
      if (f.styleId !== styleId) continue;
      this.destroyFloorDisplayObject(this.draftFloorSprites.get(key));
      const sprite = this.addFloorSprite(f);
      if (sprite) this.draftFloorSprites.set(key, sprite);
      else this.draftFloorSprites.delete(key);
    }
    // o estilo editado pode ter ganhado/perdido linha de junta própria
    // (plankLengthPx) -- ver editGridHiddenAt/drawEditGrid.
    this.drawEditGrid();
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
    this.drawEditGrid(); // ver editGridHiddenAt -- piso carregado do banco já entra sem contorno duplicado nos laminados
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
        // remoto: sempre começa em DEFAULT_OUTFIT_ID aqui (o traje de
        // verdade dele só chega DEPOIS, pela rede -- ver "look" no
        // protocolo em server/index.js e setRemoteLook mais abaixo,
        // chamado por upsertRemotePlayer/GameRoom.tsx assim que souber;
        // corrige na hora, sem esperar o próximo "traje" trocado).
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
  /** `container` opcional -- default é o boneco LOCAL (comportamento de
   * sempre); passar um container de `remoteContainers` aplica no boneco
   * REMOTO certo em vez do meu (ver setRemoteLook mais abaixo, pedido do
   * Douglas 30/set: "o estilo roupa que ele escolher do avatar, deve
   * seguir ele em qualquer ambiente que ele for" -- a aparência escolhida
   * nunca saía do navegador de quem escolheu, todo jogador remoto sempre
   * aparecia com o boneco padrão pra todo mundo, em QUALQUER sala, ver
   * comentário que existia em createAvatar/"traje"). Mesma lógica de
   * sempre, só trocando qual container ela mexe. */
  setLocalHairId(hairId: string, container: Phaser.GameObjects.Container | null = this.localContainer) {
    if (!container) return;
    const sprite = container.getData("hairSprite") as Phaser.GameObjects.Sprite | null;
    if (!sprite) return;
    // mesma checagem que setLocalSkinId já tinha (textures.exists) --
    // achado investigando avisos "Texture __MISSING has no frame N" no
    // console do Douglas (ver comentário grande em runWhenSceneReady,
    // GameRoom.tsx): GameRoom.tsx aplica o cabelo/barba/acessório/traje
    // salvos assim que a cena fica pronta, ANTES da textura custom
    // (Editor de Itens) terminar de chegar do Supabase -- sem essa
    // checagem, setTexture ia direto com a chave ainda não carregada, o
    // Phaser caía pro texture "__MISSING" (que só tem 1 frame) e o
    // currentFrame (de um frame válido da pose ANTERIOR, tipo "4"/"5")
    // não existe nela -- daí o aviso. setLocalSkinId (logo abaixo) já
    // tratava isso escondendo a sprite em vez de tentar a textura
    // quebrada; faltava replicar aqui. Não é permanente: assim que a
    // busca (fetchAndRegisterCustomSkins/fetchAndRegisterCustomAvatarItems,
    // GameRoom.tsx) termina, ela chama essa função de novo com a textura
    // já carregada, e a sprite reaparece certa.
    const key = hairTextureKey(hairId);
    const exists = this.textures.exists(key);
    if (exists) {
      const currentFrame = sprite.frame.name;
      sprite.setTexture(key, currentFrame);
    }
    sprite.setVisible(exists);
    container.setData("hairId", hairId);
  }

  /** Troca o tom de pele do jogador LOCAL ao vivo (ver SKIN_CATALOG) --
   * chamado pelo editor de personagem (GameRoom.tsx). Também reaplica a
   * textura do TRAJE e da BARBA equipados (se algum), porque a arte dos
   * dois varia por tom de pele -- ver resolveOutfitSkinId/
   * resolveBeardSkinId. Isso garante que trocar o tom mantém a mão e a
   * barba combinando, independente da ordem em que skin/traje/barba
   * forem trocados. */
  setLocalSkinId(skinId: string, container: Phaser.GameObjects.Container | null = this.localContainer) {
    if (!container) return;
    const sprite = container.getData("skinSprite") as Phaser.GameObjects.Sprite | null;
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
    container.setData("skinId", skinId);

    const outfitSprite = container.getData("outfitSprite") as Phaser.GameObjects.Sprite | null;
    const outfitId = container.getData("outfitId") as string | undefined;
    if (outfitSprite && outfitId) {
      const outfit = OUTFIT_CATALOG.find((o) => o.id === outfitId);
      if (outfit) {
        const resolvedSkinId = resolveOutfitSkinId(outfit, skinId);
        if (resolvedSkinId) {
          // mesma checagem de textures.exists do resto desta função --
          // ver comentário grande em setLocalHairId (avisos "Texture
          // __MISSING has no frame N" quando a textura do traje pro tom
          // novo ainda não chegou do Supabase).
          const key = outfitTextureKey(outfit.id, resolvedSkinId);
          const exists = this.textures.exists(key);
          if (exists) {
            const currentFrame = outfitSprite.frame.name;
            outfitSprite.setTexture(key, currentFrame);
          }
          outfitSprite.setVisible(exists);
        } else {
          // sem traje pro SEXO do tom novo (ver resolveOutfitSkinId) --
          // esconde em vez de deixar a textura antiga (de outro sexo)
          // grudada (bug relatado pelo Douglas: "masculino atrás").
          outfitSprite.setVisible(false);
        }
      }
    }

    const beardSprite = container.getData("beardSprite") as Phaser.GameObjects.Sprite | null;
    const beardId = container.getData("beardId") as string | undefined;
    if (beardSprite && beardId) {
      const beard = BEARD_CATALOG.find((b) => b.id === beardId);
      if (beard) {
        const resolvedBeardSkinId = resolveBeardSkinId(beard, skinId);
        if (resolvedBeardSkinId) {
          const key = beardTextureKey(beard.id, resolvedBeardSkinId);
          const exists = this.textures.exists(key);
          if (exists) {
            const currentFrame = beardSprite.frame.name;
            beardSprite.setTexture(key, currentFrame);
          }
          beardSprite.setVisible(exists);
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
  setLocalBeardId(beardId: string, container: Phaser.GameObjects.Container | null = this.localContainer) {
    if (!container) return;
    const sprite = container.getData("beardSprite") as Phaser.GameObjects.Sprite | null;
    if (!sprite) return;
    const beard = BEARD_CATALOG.find((b) => b.id === beardId);
    if (!beard) return;
    const skinId = (container.getData("skinId") as string | undefined) ?? DEFAULT_SKIN_ID;
    const resolvedSkinId = resolveBeardSkinId(beard, skinId);
    if (!resolvedSkinId) {
      // sem barba pro sexo do tom atual (ver resolveBeardSkinId) --
      // esconde em vez de deixar a textura de OUTRO sexo grudada.
      sprite.setVisible(false);
      container.setData("beardId", beardId);
      return;
    }
    // mesma checagem de textures.exists -- ver comentário grande em
    // setLocalHairId (avisos "Texture __MISSING has no frame N").
    const key = beardTextureKey(beard.id, resolvedSkinId);
    const exists = this.textures.exists(key);
    if (exists) {
      const currentFrame = sprite.frame.name;
      sprite.setTexture(key, currentFrame);
    }
    sprite.setVisible(exists);
    container.setData("beardId", beardId);
  }

  /** Troca o acessório do jogador LOCAL ao vivo (ver ACCESSORY_CATALOG) -- chamado pelo editor de personagem (GameRoom.tsx). */
  setLocalAccessoryId(accessoryId: string, container: Phaser.GameObjects.Container | null = this.localContainer) {
    if (!container) return;
    const sprite = container.getData("accessorySprite") as Phaser.GameObjects.Sprite | null;
    if (!sprite) return;
    // mesma checagem de textures.exists -- ver comentário grande em
    // setLocalHairId (avisos "Texture __MISSING has no frame N").
    const key = accessoryTextureKey(accessoryId);
    const exists = this.textures.exists(key);
    if (exists) {
      const currentFrame = sprite.frame.name;
      sprite.setTexture(key, currentFrame);
    }
    sprite.setVisible(exists);
    container.setData("accessoryId", accessoryId);
  }

  /** Troca o traje do jogador LOCAL ao vivo (ver OUTFIT_CATALOG) --
   * chamado pelo editor de personagem (GameRoom.tsx), e também logo que
   * a cena fica pronta pra aplicar o traje sorteado no spawn (ver
   * pickRandomOutfitId em GameRoom.tsx). Guarda em localOutfitId SEMPRE
   * (mesmo se o boneco ainda não existir -- ver comentário no campo),
   * então funciona tanto ANTES quanto DEPOIS de create() ter rodado. A
   * arte em si (skin-dependente) é aplicada por applyOutfitToContainer
   * logo abaixo -- essa aqui só cuida do rastro extra do campo
   * localOutfitId, que só faz sentido pro boneco LOCAL mesmo (ver
   * comentário no campo). */
  setLocalOutfitId(outfitId: string) {
    this.localOutfitId = outfitId;
    this.applyOutfitToContainer(this.localContainer, outfitId);
  }

  /** Aplica o traje num container QUALQUER (local OU remoto, ver
   * setLocalOutfitId acima e setRemoteLook mais abaixo -- pedido do
   * Douglas 30/set: "o estilo roupa que ele escolher do avatar, deve
   * seguir ele em qualquer ambiente que ele for", ver comentário grande
   * em setRemoteLook pro que faltava). Usa o tom de pele ATUAL do
   * container (não precisa escolha manual de cor/tom, mão exposta, ver
   * resolveOutfitSkinId). */
  private applyOutfitToContainer(container: Phaser.GameObjects.Container | null, outfitId: string) {
    if (!container) return;
    const sprite = container.getData("outfitSprite") as Phaser.GameObjects.Sprite | null;
    if (!sprite) return;
    const outfit = OUTFIT_CATALOG.find((o) => o.id === outfitId);
    if (!outfit) return;
    const skinId = (container.getData("skinId") as string | undefined) ?? DEFAULT_SKIN_ID;
    const resolvedSkinId = resolveOutfitSkinId(outfit, skinId);
    if (!resolvedSkinId) {
      // sem traje pro sexo do tom atual (ver resolveOutfitSkinId) --
      // esconde em vez de deixar a textura de OUTRO sexo grudada.
      sprite.setVisible(false);
      container.setData("outfitId", outfitId);
      return;
    }
    // mesma checagem de textures.exists -- ver comentário grande em
    // setLocalHairId (avisos "Texture __MISSING has no frame N") -- o
    // traje é justamente o mais provável de ser CUSTOM (Editor de Itens),
    // então o mais comum de bater essa corrida no carregamento inicial.
    const key = outfitTextureKey(outfit.id, resolvedSkinId);
    const exists = this.textures.exists(key);
    if (exists) {
      const currentFrame = sprite.frame.name;
      sprite.setTexture(key, currentFrame);
    }
    sprite.setVisible(exists);
    container.setData("outfitId", outfitId);
  }

  /** Aplica a aparência de VERDADE (cabelo/tom de pele/barba/acessório/
   * traje) num jogador REMOTO -- chamado ao receber "look" (ver
   * protocolo em server/index.js) ou já no "init"/"join" quando o
   * player recém-chegado já vem com o campo preenchido. ANTES disso
   * (pedido do Douglas 30/set: "o estilo roupa que ele escolher do
   * avatar, deve seguir ele em qualquer ambiente que ele for"), o boneco
   * de QUALQUER jogador remoto sempre aparecia com a aparência PADRÃO
   * pra todo mundo (ver comentário que existia em createAvatar/"traje":
   * "o traje de verdade dele ainda não é sincronizado pela rede") -- não
   * era só entre uma sala e outra, era em QUALQUER sala, porque a
   * escolha nunca saía do navegador de quem escolheu (ver
   * AVATAR_STORAGE_KEY em GameRoom.tsx, só local até então). Cada campo
   * é opcional -- só aplica o que veio preenchido, mantém o resto como
   * já estava (mesmo esquema tolerante de "profile"). Ordem importa:
   * cabelo/pele primeiro (pele recalcula barba/traje já equipados pro
   * tom novo, ver setLocalSkinId), barba/acessório/traje por último com
   * o id de verdade -- mesma ordem que saveEditingCharacter já usa pro
   * boneco local. */
  setRemoteLook(
    id: string,
    look: {
      hairId?: string | null;
      skinId?: string | null;
      beardId?: string | null;
      accessoryId?: string | null;
      outfitId?: string | null;
    }
  ) {
    const container = this.remoteContainers.get(id);
    if (!container) return;
    if (look.hairId) this.setLocalHairId(look.hairId, container);
    if (look.skinId) this.setLocalSkinId(look.skinId, container);
    if (look.beardId) this.setLocalBeardId(look.beardId, container);
    if (look.accessoryId) this.setLocalAccessoryId(look.accessoryId, container);
    if (look.outfitId) this.applyOutfitToContainer(container, look.outfitId);
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
    this.seatedAtOffset = { dCol: 0, dRow: 0 };
    this.sitCooldownUntil = this.time.now + STAND_COOLDOWN_MS;
    this.localContainer.setDepth(avatarDepthForY(this.localContainer.y));
    this.stopWalk(this.localContainer);
    // avisa o servidor que levantou (ver protocolo "seat" em
    // server/index.js) -- puramente pose-sync agora, NÃO solta posse
    // nenhuma (posse só sai apagando a área de verdade, ver comentário
    // grande de areaOwnerByAreaId).
    this.onLocalSeatChange?.(null);
    this.emitSeatTuningState();
  }

  /** Levanta o boneco local de fora (ver botão "Sair do assento" no "Assento" do editor de espaço, GameRoom.tsx) -- mesma coisa de levantar andando, só que sem precisar apertar seta (que durante o ajuste de assento não levanta mais, ver update()). Sem efeito se não estiver sentado. */
  standUpNow() {
    if (this.localActivity === "sentado") this.standUp();
  }

  /**
   * Repõe o boneco local na posição de sentado, a partir do ajuste
   * ATUAL (ver resolveSeatOffset) -- separado de sitAt() pra poder ser
   * chamado nos dois casos: sentar de verdade (primeira vez) e só
   * reposicionar depois de um nudge (ver nudgeSeatOffset) ou de arrastar
   * o móvel no editor, sem repetir toda a troca de pose/profundidade/
   * aviso ao servidor.
   *
   * dCol/dRow: qual ASSENTO de `furniture` (ver FurnitureModelDef.
   * extraSeats, game/furniture.ts) -- 0,0 é a âncora (comportamento de
   * sempre, resolveSeatOffset com toda a heurística de sempre); qualquer
   * outro valor é um assento EXTRA (sofá etc.), que usa x/y PRÓPRIO
   * (ver seatSpotAt), sem passar pelo ajuste "Assento" (esse só existe
   * pra âncora, ver nudgeSeatOffset/resetSeatOffset).
   */
  private applySeatVisualPosition(furniture: FurnitureDef, dCol: number, dRow: number) {
    const col = furniture.col + dCol;
    const row = furniture.row + dRow;
    const pos = furnitureWorldPosAt(furniture, col, row);
    const spot = seatSpotAt(furniture, col, row, this.seatOffsets);
    const offset = spot ?? resolveSeatOffset(furniture, this.seatOffsets);
    this.localContainer.setPosition(pos.x + offset.x, pos.y + offset.y);
    // profundidade junto (ver seatDepth) -- reaplicada toda vez que a
    // posição muda (nudge/reset/troca de modelo/móvel arrastado), não só
    // ao sentar de verdade (sitAt), já que ela usa o TILE, não o Y,
    // então nunca fica desatualizada por um ajuste de assento novo.
    this.localContainer.setDepth(seatDepth(furniture, col, row));
  }

  /**
   * Senta automaticamente no móvel passado (chamado ao PARAR no tile
   * dele) -- dCol/dRow (padrão 0,0 = âncora) identifica QUAL assento,
   * quando o item tem mais de um (ver FurnitureModelDef.extraSeats e
   * findChairAtCurrentTile, que já resolve isso antes de chamar aqui).
   */
  private sitAt(furniture: FurnitureDef, dCol: number = 0, dRow: number = 0) {
    this.localActivity = "sentado";
    this.seatedAt = furniture;
    this.seatedAtOffset = { dCol, dRow };
    this.applySeatVisualPosition(furniture, dCol, dRow);
    // a pose sentada segue a direção que o móvel "olha" (facing), não a
    // direção que o jogador estava andando antes de sentar
    this.localContainer.setData("dir", avatarFacingFor(furniture.facing));
    this.setPoseFrame(this.localContainer, SENTADO_FRAMES[avatarFacingFor(furniture.facing)]);
    // profundidade já aplicada por applySeatVisualPosition acima (ver
    // seatDepth) -- inclui a exceção do "up" (móvel NA FRENTE do
    // boneco, só a cabeça aparece por cima do encosto).
    // avisa o servidor que sentou (ver protocolo "seat" em
    // server/index.js) -- puramente pose-sync agora, NÃO toma posse de
    // mesa nenhuma (posse só muda via botão "Tomar posse", ver
    // onClaimArea/updateAreaHoverLabels). dCol/dRow também vão, pra quem
    // olha de fora (setRemoteSeat) desenhar a pose/profundidade certa
    // no assento certo, não sempre na âncora.
    this.onLocalSeatChange?.(furniture.id, dCol, dRow);
    this.emitSeatTuningState();
  }

  /** Manda pro React (ver onSeatTuningChange) o estado atual do "Assento" -- null se não há nada pra ajustar agora (modo desligado, não sentado, ou sentado num assento EXTRA -- ver FurnitureModelDef.extraSeats -- que não tem ajuste fino ao vivo, só a âncora tem). Chamado sempre que esse estado pode ter mudado: sentou, levantou, ligou/desligou o modo, ou fez um nudge. */
  private emitSeatTuningState() {
    if (!this.seatTuningActive || !this.seatedAt || this.seatedAtOffset.dCol !== 0 || this.seatedAtOffset.dRow !== 0) {
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

  /** Ajusta fino (px) o assento do GRUPO (modelo, ver seatOffsetGroupKey) do item em que o boneco local está sentado agora -- ignorado se não estiver com o modo de ajuste ligado E sentado (ver setSeatTuningMode/update()), ou se estiver sentado num assento EXTRA (ver FurnitureModelDef.extraSeats -- esse não tem ajuste ao vivo, só x/y fixo definido no Editor de Itens; emitSeatTuningState já manda null nesse caso, então o painel "Assento" nem aparece, mas a guarda fica aqui também por segurança). Reposiciona o boneco NA HORA (ver applySeatVisualPosition) e avisa o React (ver onSeatTuningChange), que autosalva (mesmo esquema de piso/área, debounced). */
  private nudgeSeatOffset(dx: number, dy: number, big: boolean) {
    if (!this.seatTuningActive || !this.seatedAt || this.movementLocked) return;
    if (this.seatedAtOffset.dCol !== 0 || this.seatedAtOffset.dRow !== 0) return;
    const furniture = this.seatedAt;
    const step = big ? 5 : 1;
    const current = resolveSeatOffset(furniture, this.seatOffsets);
    const groupKey = seatOffsetGroupKey(furniture);
    const nextByFacing = { ...(this.seatOffsets[groupKey] ?? {}) };
    const nextValue = { x: current.x + dx * step, y: current.y + dy * step };
    nextByFacing[furniture.facing] = nextValue;
    this.seatOffsets = { ...this.seatOffsets, [groupKey]: nextByFacing };
    this.applySeatVisualPosition(furniture, 0, 0);
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
      this.applySeatVisualPosition(this.seatedAt, this.seatedAtOffset.dCol, this.seatedAtOffset.dRow);
      this.emitSeatTuningState();
    }
  }

  /** Botão "Redefinir" do "Assento" (ver EditPanel, GameRoom.tsx) -- apaga o ajuste manual do grupo+direção atual (volta pro padrão genérico, ver resolveSeatOffset). Ignorado se não estiver sentado, ou se estiver sentado num assento EXTRA (ver comentário grande em nudgeSeatOffset -- mesma guarda, esse botão nem aparece nesse caso). */
  resetSeatOffset() {
    if (!this.seatedAt) return;
    if (this.seatedAtOffset.dCol !== 0 || this.seatedAtOffset.dRow !== 0) return;
    const furniture = this.seatedAt;
    const groupKey = seatOffsetGroupKey(furniture);
    const byFacing = this.seatOffsets[groupKey];
    if (byFacing && furniture.facing in byFacing) {
      const nextByFacing = { ...byFacing };
      delete nextByFacing[furniture.facing];
      this.seatOffsets = { ...this.seatOffsets, [groupKey]: nextByFacing };
    }
    this.applySeatVisualPosition(furniture, 0, 0);
    this.emitSeatTuningState();
    this.onSeatOffsetReset?.(groupKey, furniture.facing);
  }

  /**
   * Se `f` tem um assento no tile (col,row) -- a ÂNCORA (se `f` for
   * sentável, ver isFurnitureSittable) ou um dos assentos EXTRA dele
   * (ver FurnitureModelDef.extraSeats, game/furniture.ts -- esses valem
   * MESMO que o tipo/categoria não seja sentável por padrão: definir um
   * extraSeat já é o sinal explícito de que aquele tile é assento, ex.
   * um sofá com 2 lugares). null se não for nenhum dos dois.
   */
  private chairSpotAt(f: FurnitureDef, col: number, row: number): { furniture: FurnitureDef; dCol: number; dRow: number } | null {
    if (f.col === col && f.row === row) {
      return isFurnitureSittable(f) ? { furniture: f, dCol: 0, dRow: 0 } : null;
    }
    const spot = seatSpotAt(f, col, row, this.seatOffsets);
    return spot ? { furniture: f, dCol: spot.dCol, dRow: spot.dRow } : null;
  }

  /**
   * Só considera sentar quando o boneco está IDLE (parado, não no meio
   * de um passo) exatamente em cima do tile de uma cadeira -- andar
   * perto ou passar por cima sem parar não senta. Devolve também
   * dCol/dRow (0,0 pra âncora) pra sitAt saber EM QUAL assento sentar,
   * quando o item tem mais de um (ver chairSpotAt acima).
   */
  private findChairAtCurrentTile(): { furniture: FurnitureDef; dCol: number; dRow: number } | null {
    if (this.time.now < this.sitCooldownUntil) return null;
    const { col, row } = worldToTile(this.localContainer.x, this.localContainer.y);
    // procura tanto na mobília FIXA (ROOM_FURNITURE) quanto na colocada
    // pelo editor (draftFurniture -- desde que ganhou persistência de
    // verdade, ver POST /room/furniture, esses itens também precisam
    // ser sentáveis na hora, sem precisar de restart/deploy).
    for (const f of ROOM_FURNITURE) {
      const spot = this.chairSpotAt(f, col, row);
      if (spot) return spot;
    }
    for (const f of this.draftFurniture.values()) {
      const spot = this.chairSpotAt(f, col, row);
      if (spot) return spot;
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

  private stopRoomShapePaint() {
    this.isPaintingRoomShape = false;
    this.lastPaintedRoomShapeKey = null;
    this.roomShapeDragWarned = false;
  }

  private stopAreaPaint() {
    this.isPaintingArea = false;
    this.lastPaintedAreaKey = null;
  }

  private stopWallPaint() {
    this.isPaintingWall = false;
    this.lastPaintedWallKey = null;
  }

  private stopDoorPaint() {
    this.isPaintingDoor = false;
    this.lastPaintedDoorKey = null;
  }

  /** Checagem de limite PRÓPRIA da parede -- diferente do gate genérico
   * de tile (pensado pra móvel), porque uma aresta na BORDA da sala
   * (pedido do Douglas: "pode estar na borda também") separa um tile
   * que É da sala de um que NÃO é (ou de nada nenhum, fora de tudo) --
   * ANTES (sala sempre um retângulo [0,GRID_COLS]x[0,GRID_ROWS]) isso
   * virava uma checagem de intervalo simples; agora (sala em formato
   * livre, ver roomShape/isTileInRoom lá em cima) uma aresta é válida
   * sempre que TOCA pelo menos um tile que é da sala -- vale tanto pra
   * parede interna (divide 2 tiles da sala) quanto pra parede bem na
   * borda externa (só um dos dois lados é sala, o outro é "fora"). */
  private isWallEdgeInBounds(edge: { col: number; row: number; side: WallSide }): boolean {
    if (edge.side === "colPlus") {
      return this.isTileInRoom(edge.col, edge.row) || this.isTileInRoom(edge.col + 1, edge.row);
    }
    return this.isTileInRoom(edge.col, edge.row) || this.isTileInRoom(edge.col, edge.row + 1);
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
    const target = { col: col + delta[0], row: row + delta[1] };
    const targetPos = tileToWorld(target.col, target.row);

    // bateu na borda da sala (destino fora do formato livre, ver
    // isTileInRoom/roomShape -- ANTES era clampTile, um retângulo fixo;
    // com a sala em formato livre o "fora" de verdade é "não tá em
    // roomShape", não um intervalo de números) OU o tile de destino é
    // travado por um móvel (ex: divisória de vidro, ver
    // FURNITURE_BLOCKS_MOVEMENT em furniture.ts) -- nos dois casos só
    // vira de frente pra direção pedida, sem "andar" de verdade.
    const blocked =
      !this.isTileInRoom(target.col, target.row) ||
      this.isMovementBlockedAt(target.col, target.row, col, row);
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
    // "recorte" do boneco atrás da parede (ver comentário grande de
    // draftWallSprites acima) -- ANTES de qualquer return
    // antecipado (inclusive o de "sentado" logo abaixo: sentado atrás
    // de uma parede também precisa continuar aparecendo).
    this.updateWallAvatarCutoutMask();
    // estado ao vivo (aberta/fechada) de cada porta -- mesmo timing
    // (ANTES de qualquer return antecipado, ver comentário acima), já
    // que isMovementBlockedAt (chamado logo abaixo em startStep) precisa
    // do estado JÁ ATUALIZADO deste frame pra travar/liberar o passo
    // certo.
    this.updateDoorOpenState();
    // véu de área (ver updateAreaDim/syncAreaDimRectToCamera) precisa
    // seguir a câmera TODO frame, mesmo sentado/parado -- arrasto/zoom
    // não dependem do boneco andar.
    this.syncAreaDimRectToCamera();

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
      if (chair) this.sitAt(chair.furniture, chair.dCol, chair.dRow);
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
    this.selectedWallTool = null;
    this.selectedDoorTool = null;
    this.selectedRoomShapeTool = null;
    this.moveToolActive = false;
    this.deleteToolActive = false;
    this.cancelMovingFurniture();
    this.refreshCatalogGhost();
    this.gridGraphics?.setVisible(active);
    if (!active) {
      this.hoverGraphics?.setVisible(false);
      this.wallHoverGraphics?.setVisible(false);
    }
    // entrar no modo de edição cancela um destino de clique-pra-andar
    // pendente e some com o destaque leve do tile (esse é só do uso
    // normal, ver roomHoverGraphics/handleRoomPointerMove) -- os dois
    // voltam a fazer algo só depois de sair do editor de novo.
    if (active) {
      this.walkQueue = [];
      this.roomHoverGraphics?.setVisible(false);
      // confirmação de destituir/assumir (ver showDestituirPrompt/
      // showAreaClaimPrompt) não faz sentido nenhuma flutuando por cima
      // do editor de espaço.
      this.destroyDestituirPrompt();
      this.destroyAreaClaimPrompt();
      this.destroyAreaOwnerHoverCard();
    }
    this.refreshAreaTileAlpha();
  }

  /** Escolhe qual item da paleta o próximo clique num tile livre vai colocar (null = nenhum selecionado, clique não faz nada em tile livre). Selecionar um item de móvel desarma as outras ferramentas (piso/área/mover, ver selectFloorTool/selectAreaTool/selectMoveTool) -- só uma ferramenta ativa por vez. */
  selectCatalogEntry(entry: FurnitureCatalogEntry | null) {
    this.selectedCatalogEntry = entry;
    this.selectedFloorTool = null;
    this.selectedAreaTool = null;
    this.selectedWallTool = null;
    this.selectedDoorTool = null;
    this.selectedRoomShapeTool = null;
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
      this.selectedWallTool = null;
      this.selectedDoorTool = null;
      this.selectedRoomShapeTool = null;
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
      this.selectedWallTool = null;
      this.selectedDoorTool = null;
      this.selectedRoomShapeTool = null;
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

  /** "col,row" -- mesma chave usada em draftFloor/draftWall/etc. */
  private roomTileKey(col: number, row: number): string {
    return `${col},${row}`;
  }

  /** Esse tile faz parte da sala HOJE? Base de tudo que antes checava
   * [0,GRID_COLS]x[0,GRID_ROWS] (movimento, clique-pra-andar, BFS,
   * limite de parede/porta na borda) -- ver comentário grande de
   * roomShape lá em cima. */
  isTileInRoom(col: number, row: number): boolean {
    return this.roomShape.has(this.roomTileKey(col, row));
  }

  /** Tiles vizinhos (4 direções, sem diagonal -- mesma grade de sempre)
   * que JÁ são da sala -- usado pra decidir se um "Adicionar" é válido
   * (precisa encostar em pelo menos 1, senão viraria uma ilha solta,
   * sem caminho a pé até o resto da sala). */
  private roomNeighbors(col: number, row: number): { col: number; row: number }[] {
    return [
      { col: col + 1, row },
      { col: col - 1, row },
      { col, row: row + 1 },
      { col, row: row - 1 },
    ].filter((t) => this.isTileInRoom(t.col, t.row));
  }

  /** Vizinhos da sala que ficam "atrás" (rumo ao fundo/topo da tela --
   * ver comentário grande de roomShape lá em cima e a fórmula de
   * col+row -> profundidade em game/grid.ts) do tile (col,row) --
   * usado só por "Adicionar" (ver paintRoomShapeAt/hover abaixo), que
   * agora só deixa crescer a sala pela borda de CIMA (pedido do
   * Douglas: ideia do Tower ser um prédio de verdade, com fachada fixa
   * na borda de BAIXO -- "deixar tiles adicionaveis apenas nas borda
   * de cima"). Só (col+1,row) e (col,row+1) contam -- são
   * os 2 únicos vizinhos com col+row MAIOR que o tile novo, ou seja o
   * tile novo sempre nasce ATRÁS deles, nunca na frente/borda de baixo
   * empurrando a fachada. Diferente de roomNeighbors (usado por
   * eraseRoomShapeAt/wouldDisconnectRoom, onde qualquer direção conta
   * -- a restrição de direção é só pra CRESCER; apagar continua livre
   * em qualquer lado). */
  private roomBackNeighbors(col: number, row: number): { col: number; row: number }[] {
    return [
      { col: col + 1, row },
      { col, row: row + 1 },
    ].filter((t) => this.isTileInRoom(t.col, t.row));
  }

  /** Toda quina EXTERNA da fachada -- tile da sala sem vizinho em
   * NENHUMA das 2 direções "pra frente" (col+1,row e col,row+1, mesmo
   * critério de roomBackNeighbors/isTileInRoom). Numa sala
   * retangular/losango simples só existe 1 (o tile mais "pra frente"
   * da tela, o único candidato de sempre). Numa sala em L ou escada
   * (ver teste do Douglas com a sala em escada) o contorno pode ter
   * vários "dentes" pra frente, cada um sua própria quina -- cada uma
   * precisa da própria peça de fachada (ver positionFacade). */
  private roomFrontCorners(): { col: number; row: number }[] {
    const corners: { col: number; row: number }[] = [];
    for (const key of this.roomShape) {
      const [col, row] = key.split(",").map(Number);
      if (!this.isTileInRoom(col + 1, row) && !this.isTileInRoom(col, row + 1)) {
        corners.push({ col, row });
      }
    }
    return corners;
  }

  /** Cola o vértice do "V" da fachada PRINCIPAL (FACADE_APEX_*) na
   * quina de baixo da sala -- o tile com maior col+row (o mais "pra
   * frente" na tela, ver furnitureDepthForTile), canto de baixo do
   * losango dele. Empate (sala irregular com mais de 1 tile na frente)
   * fica com o mais central (menor |col-row|) -- mesmo critério de
   * sempre. As DEMAIS quinas externas da sala (ver roomFrontCorners --
   * sala em L/escada tem mais de uma) ganham cada uma sua própria peça
   * MENOR (FACADE_CORNER2_TEXTURE_KEY, só o "V" de vidro, sem as
   * paredes laterais da peça principal -- pedido do Douglas: "essa
   * parte vai encaixar no predio do lado esquerdo" / "isso quina". A
   * aba que sobra no topo esquerdo dessa arte é o respiro que cobre o
   * trecho reto até a peça vizinha, escondendo a costura -- já vem
   * assim na arte, nada calculado aqui pra isso). Chamado sempre que o
   * formato da sala muda. */
  private positionFacade() {
    const corners = this.roomFrontCorners();
    if (corners.length === 0) return;

    let main = corners[0];
    for (const c of corners) {
      if (
        c.col + c.row > main.col + main.row ||
        (c.col + c.row === main.col + main.row && Math.abs(c.col - c.row) < Math.abs(main.col - main.row))
      ) {
        main = c;
      }
    }
    if (this.textures.exists(FACADE_TEXTURE_KEY)) {
      const w = tileToWorld(main.col, main.row);
      const x = w.x;
      const y = w.y + ISO_TILE_HEIGHT / 2;
      if (!this.facadeImage) {
        const tex = this.textures.get(FACADE_TEXTURE_KEY).getSourceImage() as HTMLImageElement;
        this.facadeImage = this.add
          .image(x, y, FACADE_TEXTURE_KEY)
          .setOrigin(FACADE_APEX_X_PX / tex.width, FACADE_APEX_Y_PX / tex.height)
          .setScale(FACADE_SCALE)
          .setDepth(DEPTH_FACADE);
      } else {
        this.facadeImage.setPosition(x, y);
      }
    }

    // as demais quinas -- 1 sprite da peça pequena por quina, indexado
    // por tile (mesmo padrão de draftFloor/draftWall/etc no resto do
    // arquivo) pra sobreviver entre chamadas e sumir sozinho se a
    // quina deixar de existir (sala encolheu de novo, ver
    // eraseRoomShapeAt).
    const mainKey = this.roomTileKey(main.col, main.row);
    const liveKeys = new Set<string>();
    if (this.textures.exists(FACADE_CORNER2_TEXTURE_KEY)) {
      const tex = this.textures.get(FACADE_CORNER2_TEXTURE_KEY).getSourceImage() as HTMLImageElement;
      for (const c of corners) {
        const key = this.roomTileKey(c.col, c.row);
        if (key === mainKey) continue;
        liveKeys.add(key);
        const w = tileToWorld(c.col, c.row);
        const x = w.x + FACADE_CORNER2_OFFSET_X_PX;
        const y = w.y + ISO_TILE_HEIGHT / 2 + FACADE_CORNER2_OFFSET_Y_PX;
        let sprite = this.facadeCornerSprites.get(key);
        if (!sprite) {
          sprite = this.add
            .image(x, y, FACADE_CORNER2_TEXTURE_KEY)
            .setOrigin(FACADE_CORNER2_APEX_X_PX / tex.width, FACADE_CORNER2_APEX_Y_PX / tex.height)
            .setScale(FACADE_SCALE)
            .setDepth(DEPTH_FACADE);
          this.facadeCornerSprites.set(key, sprite);
        } else {
          sprite.setPosition(x, y);
        }
      }
    }
    for (const [key, sprite] of this.facadeCornerSprites) {
      if (!liveKeys.has(key)) {
        sprite.destroy();
        this.facadeCornerSprites.delete(key);
      }
    }
  }

  /** Carrega o formato salvo da sala (ver GET /room/shape em
   * server/index.js) -- chamado pelo React assim que a cena fica pronta
   * (mesmo timing de loadSavedFloor/loadSavedFurniture). SUBSTITUI o
   * retângulo padrão que create() já tinha colocado em roomShape (não
   * soma) -- a lista que vem do servidor é sempre o estado completo,
   * mesma convenção de floor/wall/etc. Redesenha o contorno do editor
   * em seguida (drawEditGrid é re-chamável, mesma ideia de sempre).
   * Defensivo contra lista vazia (nunca aplica um formato sem tile
   * nenhum -- ver eraseRoomShapeAt, que já impede isso de acontecer de
   * verdade, mas uma resposta velha/corrompida do servidor não devia
   * conseguir deixar a sala inteira intransitável). */
  loadSavedRoomShape(list: { col: number; row: number }[]) {
    if (list.length === 0) return;
    this.roomShape = new Set(list.map((t) => this.roomTileKey(t.col, t.row)));
    this.drawEditGrid();
    this.positionFacade();
  }

  getDraftRoomShapeList(): { col: number; row: number }[] {
    return Array.from(this.roomShape).map((key) => {
      const [col, row] = key.split(",").map(Number);
      return { col, row };
    });
  }

  /** Escolhe a ferramenta "Tamanho" ativa: "add" pinta um tile novo
   * encostado na sala, "erase" apaga um já pintado, null desarma.
   * Mesmo padrão de exclusão mútua das outras ferramentas (ver
   * selectFloorTool/selectAreaTool/etc. logo abaixo). Redesenha o
   * contorno na hora (ver drawEditGrid) -- é ela quem liga/desliga a
   * tinta azul leve que confirma visualmente quais tiles já são da
   * sala, então precisa aparecer/sumir NA HORA ao entrar/sair da aba
   * "Tamanho", sem esperar o próximo clique de add/erase. */
  selectRoomShapeTool(tool: "add" | "erase" | null) {
    this.selectedRoomShapeTool = tool;
    this.selectedCatalogEntry = null;
    this.selectedFloorTool = null;
    this.selectedAreaTool = null;
    this.selectedWallTool = null;
    this.selectedDoorTool = null;
    this.deleteToolActive = false;
    this.selectMoveTool(false);
    this.refreshCatalogGhost();
    this.drawEditGrid();
  }

  /** Algum avatar (local OU remoto) tá em pé nesse tile agora? Não dá
   * pra apagar o chão debaixo de alguém. */
  private someoneStandingAt(col: number, row: number): boolean {
    const local = worldToTile(this.localContainer.x, this.localContainer.y);
    if (local.col === col && local.row === row) return true;
    for (const container of this.remoteContainers.values()) {
      const t = worldToTile(container.x, container.y);
      if (t.col === col && t.row === row) return true;
    }
    return false;
  }

  /** Apagar esse tile SEPARARIA a sala em duas (ou mais) partes
   * desconectadas? Anda (BFS pelas 4 direções, mesma grade de sempre) a
   * partir de QUALQUER outro tile restante e confere se alcança todos
   * os demais -- se sobrar algum de fora, apagar esse tile isolaria ele
   * (inacessível a pé). Mesma ideia de computeWalkPath (BFS simples,
   * grade pequena, sem heurística nenhuma). */
  private wouldDisconnectRoom(col: number, row: number): boolean {
    const removedKey = this.roomTileKey(col, row);
    const remaining = Array.from(this.roomShape).filter((k) => k !== removedKey);
    if (remaining.length === 0) return false; // eraseRoomShapeAt já bloqueia esvaziar a sala antes de chegar aqui
    const start = remaining[0];
    const visited = new Set<string>([start]);
    const queue = [start];
    while (queue.length > 0) {
      const key = queue.shift()!;
      const [c, r] = key.split(",").map(Number);
      for (const n of [
        { col: c + 1, row: r },
        { col: c - 1, row: r },
        { col: c, row: r + 1 },
        { col: c, row: r - 1 },
      ]) {
        const nKey = this.roomTileKey(n.col, n.row);
        if (nKey === removedKey || !this.roomShape.has(nKey) || visited.has(nKey)) continue;
        visited.add(nKey);
        queue.push(nKey);
      }
    }
    return visited.size < remaining.length;
  }

  /** Esse tile tem piso pintado, móvel, parede, porta ou área -- usado
   * por eraseRoomShapeAt logo abaixo pra bloquear apagar em cima de
   * conteúdo sem avisar (mesma cautela de edgeHasContent numa tentativa
   * anterior desse pedido, agora por TILE em vez de por borda inteira). */
  private tileHasContent(col: number, row: number): boolean {
    const hits = (c: number, r: number) => c === col && r === row;
    if (this.draftFloor.has(this.roomTileKey(col, row))) return true;
    for (const f of this.draftFurniture.values()) {
      if (furnitureFootprintTiles(f).some((t) => hits(t.col, t.row))) return true;
    }
    for (const w of this.draftWall.values()) if (hits(w.col, w.row)) return true;
    for (const d of this.draftDoor.values()) if (hits(d.col, d.row)) return true;
    for (const a of this.draftArea.values()) if (hits(a.col, a.row)) return true;
    return false;
  }

  /** Pinta (adiciona) um tile novo na sala -- só aceita se ele AINDA
   * não for da sala e encostar em algo que já é (roomNeighbors, as 4
   * direções livres -- pedido do Douglas: desbloqueado de novo pela
   * borda de baixo "enquanto isso", pra poder testar tile ali embaixo
   * sem mexer no posicionamento da fachada fixa (positionFacade/
   * FACADE_* continuam exatamente como estavam -- ela só reacompanha
   * sozinha a nova quina de baixo). roomBackNeighbors acima fica
   * guardada caso a restrição de só crescer por cima volte depois).
   * Mantém a sala sempre conectada, nunca uma ilha solta. Silencioso
   * quando inválido (mesmo padrão de clicar num tile já ocupado com
   * outra ferramenta -- não faz nada). */
  private paintRoomShapeAt(col: number, row: number) {
    const key = this.roomTileKey(col, row);
    if (this.roomShape.has(key)) return;
    if (this.roomNeighbors(col, row).length === 0) return;
    this.roomShape.add(key);
    this.drawEditGrid();
    this.positionFacade();
    this.onDraftRoomShapeChange?.(this.getDraftRoomShapeList());
  }

  /** Apaga (remove) um tile da sala -- bloqueado se: for o ÚLTIMO tile
   * (a sala nunca pode ficar vazia), tiver piso/móvel/parede/porta/área
   * colocado nele (apaga isso primeiro), tiver alguém em pé nele agora,
   * ou se isso separasse a sala em duas partes (ver
   * wouldDisconnectRoom). Devolve o MOTIVO do bloqueio (pra
   * GameRoom.tsx mostrar um aviso) ou null quando apagou de verdade. */
  private eraseRoomShapeAt(col: number, row: number): string | null {
    const key = this.roomTileKey(col, row);
    if (!this.roomShape.has(key)) return null; // clique num tile que já não é da sala -- nada a fazer, sem aviso
    if (this.roomShape.size <= 1) return "A sala não pode ficar sem nenhum quadrado.";
    if (this.tileHasContent(col, row)) {
      return "Tem piso, móvel, parede, porta ou área nesse tile -- apague o que tiver lá antes.";
    }
    if (this.someoneStandingAt(col, row)) {
      return "Tem alguém em pé nesse tile agora -- peça pra sair antes de apagar.";
    }
    if (this.wouldDisconnectRoom(col, row)) {
      return "Isso ia separar a sala em duas partes -- apague de um jeito que não isole nenhum pedaço.";
    }
    this.roomShape.delete(key);
    this.drawEditGrid();
    this.positionFacade();
    this.onDraftRoomShapeChange?.(this.getDraftRoomShapeList());
    return null;
  }

  /** Aplica add/erase (ver paintRoomShapeAt/eraseRoomShapeAt acima) em
   * CADA tile ao longo do caminho entre o último tile tocado no arrasto
   * e o atual -- pedido do Douglas ("tem como adicionar arrastando?
   * clicando de um em um leva mt tempo"). Diferente de paintFloorLine
   * (Bresenham, aceita passo DIAGONAL -- ok pro piso, que não tem
   * restrição de vizinhança): aqui o caminho precisa ser só ORTOGONAL
   * (nunca um passo na diagonal), porque "Adicionar" só aceita um tile
   * novo que encosta em algo que JÁ é da sala (ver roomNeighbors) -- um
   * pulo diagonal faria o meio do caminho falhar essa checagem mesmo
   * arrastando por cima de tiles válidos um a um. Anda primeiro na
   * coluna até alinhar, depois na linha (um "L"), sempre um passo de
   * cada vez -- cada tile novo sempre encosta no tile anterior (já
   * pintado nesse mesmo arrasto, ou o ponto de partida). Pro "Apagar",
   * a checagem de vizinhança não existe, mas o mesmo caminho serve
   * igual (linha contínua, sem pular tile). Silencioso pra "Adicionar"
   * (mesmo comportamento de paintRoomShapeAt); pro "Apagar", avisa no
   * máximo 1x por arrasto via onRoomShapeEraseBlocked (ver
   * roomShapeDragWarned/handleEditPointerDown -- alert() é síncrono,
   * várias chamadas em fila travariam a página). */
  private dragRoomShapeLine(fromCol: number, fromRow: number, toCol: number, toRow: number) {
    let col = fromCol;
    let row = fromRow;
    const stepCol = col < toCol ? 1 : -1;
    const stepRow = row < toRow ? 1 : -1;
    while (col !== toCol) {
      col += stepCol;
      this.applyRoomShapeTool(col, row);
    }
    while (row !== toRow) {
      row += stepRow;
      this.applyRoomShapeTool(col, row);
    }
  }

  /** Aplica a ferramenta "Tamanho" ativa (add/erase) num tile só --
   * usado tanto pelo clique único (ver handleEditPointerDown) quanto
   * pelo arrasto (ver dragRoomShapeLine acima). */
  private applyRoomShapeTool(col: number, row: number) {
    if (this.selectedRoomShapeTool === "add") {
      this.paintRoomShapeAt(col, row);
      return;
    }
    if (this.selectedRoomShapeTool === "erase") {
      const reason = this.eraseRoomShapeAt(col, row);
      if (reason && !this.roomShapeDragWarned) {
        this.onRoomShapeEraseBlocked?.(reason);
        this.roomShapeDragWarned = true;
      }
    }
  }

  /** Escolhe a ferramenta de piso ativa: {kind:"paint", entry} pinta esse modelo, {kind:"erase"} apaga, null desarma. Escolher uma ferramenta de piso desarma as outras (móvel/área/mover, ver selectCatalogEntry/selectAreaTool/selectMoveTool) -- só uma ferramenta ativa por vez. */
  selectFloorTool(tool: FloorTool) {
    this.selectedFloorTool = tool;
    this.selectedCatalogEntry = null;
    this.selectedAreaTool = null;
    this.selectedWallTool = null;
    this.selectedDoorTool = null;
    this.selectedRoomShapeTool = null;
    this.deleteToolActive = false;
    this.selectMoveTool(false);
    this.refreshCatalogGhost();
  }

  getDraftFloorList(): FloorTileDef[] {
    return Array.from(this.draftFloor.values());
  }

  clearDraftFloor() {
    for (const sprite of this.draftFloorSprites.values()) this.destroyFloorDisplayObject(sprite);
    this.draftFloorSprites.clear();
    this.draftFloor.clear();
    this.drawEditGrid(); // ver editGridHiddenAt -- sem piso nenhum, contorno volta em toda célula
    this.onDraftFloorChange?.(this.getDraftFloorList());
  }

  /** Troca o modo de inserção da ferramenta de parede ("Borda" de sempre
   * ou "Centro do tile", ver comentário de wallPlacementMode acima) --
   * chamado pelo toggle novo no painel de parede (GameRoom.tsx), some o
   * destaque na hora se a ferramenta já estiver armada (o hover do frame
   * seguinte já redesenha do jeito certo sozinho). */
  setWallPlacementMode(mode: "edge" | "center") {
    this.wallPlacementMode = mode;
    this.wallHoverGraphics?.setVisible(false);
  }

  /** Troca a ORIENTAÇÃO usada no modo "Centro do tile" (ver comentário
   * de wallCenterOrientation acima) -- chamado pelo toggle "/"/"\" novo
   * no painel de parede (GameRoom.tsx), só aparece ali quando
   * wallPlacementMode já é "center". Mesma ideia de setWallPlacementMode
   * (some o destaque na hora, o hover do frame seguinte redesenha certo). */
  setWallCenterOrientation(orientation: "center" | "centerRow") {
    this.wallCenterOrientation = orientation;
    this.wallHoverGraphics?.setVisible(false);
  }

  /** Escolhe a ferramenta de parede ativa -- mesma ideia da selectFloorTool acima. Desarma as outras (móvel/piso/área/mover, só uma ferramenta ativa por vez). */
  selectWallTool(tool: WallTool) {
    this.selectedWallTool = tool;
    this.selectedCatalogEntry = null;
    this.selectedFloorTool = null;
    this.selectedAreaTool = null;
    this.selectedDoorTool = null;
    this.selectedRoomShapeTool = null;
    this.deleteToolActive = false;
    this.selectMoveTool(false);
    this.refreshCatalogGhost();
    if (!tool) this.wallHoverGraphics?.setVisible(false);
  }

  getDraftWallList(): WallSegmentDef[] {
    return Array.from(this.draftWall.values());
  }

  clearDraftWall() {
    for (const sprite of this.draftWallSprites.values()) sprite.destroy();
    this.draftWallSprites.clear();
    this.draftWall.clear();
    this.onDraftWallChange?.(this.getDraftWallList());
  }

  /**
   * Cria a imagem/desenho de UM segmento de parede, já ancorado/profundo
   * certo -- mesma ideia de addFloorSprite, ramificando em dois tipos de
   * modelo (ver WallCatalogEntry em game/wall.ts): "imagem" (de sempre,
   * textura carregada por URL) ou "padrão" (pedido do Douglas: "a gente
   * não consegue criar uma geometria seguindo a mesma ideia de piso, sem
   * que seja feito fora?" -- ver createWallPatternGraphics abaixo).
   * Devolve null se o styleId não bate com nenhum item do catálogo OU,
   * só pro tipo "imagem", se a textura ainda não carregou (mesma
   * defensiva de addFloorSprite -- ver comentário lá).
   */
  /**
   * Monta o "recorte" de UMA parede específica (ver comentário grande de
   * draftWallSprites acima pro histórico/motivo) -- Graphics-fonte
   * PRÓPRIO (invisível, só serve de fonte da máscara), guardado como
   * DATA no próprio `target` (WALL_CUTOUT_MASK_GFX_DATA_KEY) pra
   * updateWallAvatarCutoutMask achar de novo todo frame sem precisar de
   * um Map paralelo. Chamada 1x por parede, na hora que ela é criada
   * (addWallSprite/createWallPatternGraphics) -- o Graphics começa
   * VAZIO (sem boneco nenhum ainda posicionado), updateWallAvatarCutoutMask
   * é quem desenha os retângulos de verdade a cada frame. `target.once("destroy", ...)`
   * garante que o Graphics-fonte morre junto quando a parede é apagada/
   * substituída (os vários `.destroy()` de parede espalhados pelo código
   * não precisam saber que essa máscara existe).
   */
  private applyWallAvatarCutoutMask(target: Phaser.GameObjects.Image | Phaser.GameObjects.Graphics): void {
    const maskGfx = this.add.graphics();
    maskGfx.setVisible(false); // só serve de fonte pra máscara, não desenha por cima da cena
    const mask = maskGfx.createGeometryMask();
    mask.invertAlpha = true; // a parede SOME onde o retângulo caiu, aparece normal no resto
    target.setMask(mask);
    target.setData(WALL_CUTOUT_MASK_GFX_DATA_KEY, maskGfx);
    target.once(Phaser.GameObjects.Events.DESTROY, () => maskGfx.destroy());
  }

  /**
   * Redesenha o Graphics-fonte de recorte de CADA parede (ver
   * applyWallAvatarCutoutMask acima) -- chamado todo frame em update(),
   * já que o boneco pode estar andando/se movendo o tempo todo. Pra CADA
   * parede, só entram no recorte os bonecos cuja profundidade é MENOR
   * que a DESSA parede (== ela desenharia por cima/escondendo ele, mesma
   * comparação de sempre entre wallDepthForSegment/avatarDepthForY) --
   * um boneco na FRENTE de uma parede não abre buraco nela (ACHADO,
   * Douglas: "ta recortando quando ele ta na frente tambe", ver
   * comentário grande de draftWallSprites acima pro motivo/print). O
   * recorte de CADA parede é um PARALELOGRAMO alinhado ao `along` DELA
   * (ver wallAlongUnit/WALL_AVATAR_CUTOUT_* acima) -- por isso o loop
   * usa `.entries()` (não só `.values()`): a CHAVE é o mesmo id de
   * segmento de draftWall, usado aqui só pra achar o `side` de volta
   * (this.draftWall.get(key)?.side) e saber pra que lado inclinar.
   */
  private updateWallAvatarCutoutMask() {
    if (this.draftWallSprites.size === 0) return;
    const containers = [this.localContainer, ...this.remoteContainers.values()].filter(
      (c): c is Phaser.GameObjects.Container => Boolean(c)
    );
    for (const [key, wall] of this.draftWallSprites.entries()) {
      const maskGfx = wall.getData(WALL_CUTOUT_MASK_GFX_DATA_KEY) as Phaser.GameObjects.Graphics | undefined;
      if (!maskGfx) continue;
      maskGfx.clear();
      if (containers.length === 0) continue;
      const side = this.draftWall.get(key)?.side;
      if (!side) continue; // defensivo -- não deveria existir sprite sem segmento correspondente
      const along = wallAlongUnit(side);
      const halfW = WALL_AVATAR_CUTOUT_WIDTH_PX / 2;
      maskGfx.fillStyle(0xffffff);
      for (const c of containers) {
        if (c.depth >= wall.depth) continue; // não tá atrás DESSA parede -- sem buraco aqui
        // container.y é o CENTRO do tile (ver comentário de
        // AVATAR_FOOT_OFFSET_Y) -- os pés de verdade ficam em y+offset;
        // a base do paralelogramo (bl/br) anda a partir daí ao longo da
        // diagonal `along` (mesma direção da própria parede), e o topo
        // (tl/tr) sobe reto na VERTICAL a partir da base (mesma ideia
        // de `raise`/mapPoint em createWallPatternGraphics -- altura
        // sempre reta, só a largura acompanha a diagonal).
        const feetY = c.y + AVATAR_FOOT_OFFSET_Y;
        const bl = { x: c.x - along.x * halfW, y: feetY - along.y * halfW };
        const br = { x: c.x + along.x * halfW, y: feetY + along.y * halfW };
        const tl = { x: bl.x, y: bl.y - WALL_AVATAR_CUTOUT_HEIGHT_PX };
        const tr = { x: br.x, y: br.y - WALL_AVATAR_CUTOUT_HEIGHT_PX };
        maskGfx.fillPoints([bl, br, tr, tl], true);
      }
    }
  }

  private addWallSprite(seg: WallSegmentDef): Phaser.GameObjects.Image | Phaser.GameObjects.Graphics | null {
    const entry = wallEntryById(seg.styleId);
    if (!entry) return null;
    if (entry.pattern) return this.createWallPatternGraphics(seg, entry.pattern);
    const key = wallTextureKey(seg.styleId);
    if (!this.textures.exists(key)) {
      console.warn(`[parede] textura "${key}" (estilo "${seg.styleId}") não estava carregada ainda -- segmento ${seg.col},${seg.row},${seg.side} não desenhado.`);
      return null;
    }
    const pos = wallWorldAnchor(seg);
    // origem (0.5, 1) -- centro-baixo, mesma ideia de "pé" de móvel: a
    // arte "cresce pra cima" a partir do ponto no CHÃO da aresta, sem
    // precisar de nenhum campo de altura guardado (ver comentário de
    // wallWorldAnchor em game/wall.ts). rowPlus usa a MESMA arte
    // espelhada (setFlipX) -- as 2 orientações de parede são reflexo uma
    // da outra nesse sistema isométrico (mesma ideia do Habbo: só 2
    // texturas de parede, uma pra cada "lado"), então o Douglas só
    // precisa desenhar UMA arte por estilo, não duas. "centerRow" segue
    // a MESMA orientação de rowPlus (ver WallSide em game/wall.ts),
    // então espelha junto.
    const image = this.add
      .image(pos.x, pos.y, key)
      .setOrigin(0.5, 1)
      .setFlipX(seg.side === "rowPlus" || seg.side === "centerRow")
      .setDepth(wallDepthForSegment(seg, furnitureDepthForTile));
    this.applyWallAvatarCutoutMask(image); // "recorte" do boneco atrás -- ver comentário grande de draftWallSprites
    return image;
  }

  /**
   * Desenha um segmento de parede "padrão" (sem imagem nenhuma, ver
   * WallPatternConfig em game/wall.ts) -- tijolo em "amarração"/running
   * bond na face da FRENTE, com espessura de verdade. Correção do
   * Douglas testando ao vivo a primeira versão (folha 2D encostada na
   * linha da divisa): "voce ficou ela na divisa, eu quero ela no meio do
   * tile... com espessura de parede" -- e, depois de eu ter tirado o
   * tijolo por engano interpretando "cor solida" errado: "nao era pra
   * tirar o tijolinho kkk" (a cor sólida era só pra face de CIMA, que
   * representa a espessura -- tijolo minúsculo numa tira fina não faria
   * sentido nenhum ali).
   *
   * A parede vira um bloco com 2 faces (sem desenhar a face de trás,
   * escondida da câmera -- ver abaixo o motivo de qual lado é o de
   * FRENTE):
   *   1) face da FRENTE (vertical, tijolo/argamassa) -- igual a versão
   *      anterior, só que deslocada `thicknessPx/2` PRA DENTRO do tile
   *      vizinho (em vez de ficar bem na linha da divisa).
   *   2) face de CIMA (o topo, plano na altura heightPx) -- liga a borda
   *      de cima da face da frente até a borda "de trás" (deslocada
   *      `thicknessPx/2` pro OUTRO lado) -- é essa faixa que dá volume de
   *      verdade (sem ela a parede pareceria uma folha, mesmo mais
   *      larga). Cor: pattern.topColor -- campo PRÓPRIO, escolhido no
   *      formulário "Criar Parede" (deu volta depois de ida e volta: foi
   *      campo próprio, virou calculada/escurecida testando ao vivo com
   *      cor destoando do tijolo, e voltou a ser campo próprio quando o
   *      Douglas separou "a cor encima da parede eu quero escolher" da
   *      cor das faces de PONTA, que essas sim continuam calculadas --
   *      ver comentário grande de WallPatternConfig em game/wall.ts).
   *      Só vale pra ESTA face -- as faces de PONTA (mais abaixo) usam
   *      brickColor escurecido direto, nunca topColor.
   *
   * Direção da espessura: em vez de girar a direção da aresta 90° na
   * TELA (sairia torto -- a grade não é ortogonal em pixel de tela, ver
   * colAxis/rowAxis em floor.ts), usa o vetor de verdade entre os
   * CENTROS dos 2 tiles que essa aresta separa (mesma dupla de
   * wallDepthForSegment acima) -- perpendicular correto nesse sistema
   * isométrico, sem chute de ângulo. Pro modo "center" (ver WallSide em
   * game/wall.ts, sem vizinho de verdade -- mora dentro de só 1 tile),
   * usa a MESMA direção de colPlus só pra ter um perpendicular
   * consistente (é sempre o vetor tileToWorld(col+1,row)-tileToWorld(col,row),
   * que não depende de (col+1,row) existir de verdade dentro da grade --
   * é só direção, não posição).
   *
   * Qual lado é a FRENTE (visível): como col+row maior = y maior = mais
   * profundidade = desenhado por cima/mais "perto da câmera" (ver
   * furnitureDepthForTile), quem olha a cena vê a face que aponta pro
   * lado de MAIOR profundidade -- por isso a face com tijolo fica voltada
   * pro VIZINHO (que sempre tem col ou row +1, logo profundidade maior),
   * e a face de cima fecha de volta pro lado de (seg.col,seg.row). Uma
   * parede na borda de cima da sala, por exemplo, fica com a face de
   * tijolo virada PRA DENTRO da sala -- exatamente como uma parede de
   * fundo de verdade, vista de frente.
   *
   * "Encontros" (pedido do Douglas com print: "arrume esses encontros
   * tambem" -- 2 segmentos vizinhos, ex: colPlus e rowPlus do MESMO
   * tile, compartilham 1 ponto de verdade em wallEdgeFloorPoints, mas
   * cada um desloca ESSE ponto pelo seu PRÓPRIO perpendicular -- então
   * os dois deixam de coincidir depois do deslocamento de espessura,
   * abrindo uma fresta em forma de cunha bem na quina, tanto na face de
   * cima quanto na de baixo da parede).
   *
   * 1ª correção: "esticar" as 2 pontas de CADA segmento por metade da
   * espessura ("square line cap"), fechando a fresta -- só que aí os 2
   * segmentos passaram a ter uma ÁREA EXTRA se sobrepondo bem na quina
   * (cada um é um Graphics/profundidade PRÓPRIO -- não tem blend nenhum
   * entre os dois, um desenha só por cima do outro), o que o Douglas viu
   * ao vivo como uma aresta feia cortando a faixa clara de cima: "crie
   * uma forma dos cantos se entenderem... sem que fique passando por
   * cima assim".
   *
   * 2ª correção: hexágono com cap FIXO -- melhor, mas ainda uma
   * aproximação (cada segmento estica sua própria ponta por uma
   * distância fixa, então as 2 pontas esticadas não caem EXATAMENTE uma
   * em cima da outra): sobrou uma "lasca" pequena ("deu certo nao kkk").
   *
   * 3ª tentativa (miter de verdade, mas aplicado em TODA ponta cega, sem
   * checar se era realmente uma quina de 90° ou uma continuação reta):
   * abriu um buraco escuro enorme numa parede comprida ("tudo errado") e
   * não fechava a lateral de pontas soltas ("e nao preencheu a face topo
   * de espessura vertical"). O bug de verdade: eu tratava CADA ponta
   * igual (sempre esticando por um cap fixo OU tentando um miter),
   * mas uma parede reta de vários segmentos emendados NÃO é uma sequência
   * de pontas soltas -- é UMA sessão contínua, e só as 2 PONTAS DE
   * VERDADE dessa sessão (onde não tem mais parede emendando) deveriam
   * ter cap/bisel. Douglas confirmou o diagnóstico: "a parede deve
   * identificar o encontro com outra e sincronizar, e o topo deve ser só
   * no final de uma sessao continua de parede".
   *
   * 4ª versão (ATUAL) -- cada ponta (A e B) do segmento é classificada
   * ao desenhar (ver wallJunctionAt), sempre consultando this.draftWall
   * AO VIVO (nunca um cache), em 3 tipos:
   *
   *   - "straight" (emenda reta -- mesmo side, tile vizinho na direção
   *     certa, MESMO styleId): a régua de fora NÃO estica nada ali
   *     (farX2 = farX, sem cap, sem bisel) -- a face de cima vira um
   *     corte reto exatamente na divisa do tile, que bate 100% com o
   *     corte do vizinho (mesma fórmula, mesmo bottomA/perp, então os 2
   *     pontos são IDÊNTICOS por construção, não por aproximação). Numa
   *     parede reta de N segmentos, o resultado visual é uma faixa de
   *     cima CONTÍNUA e lisa cruzando todos eles -- só os 2 segmentos
   *     das PONTAS de verdade da fileira têm bisel. Isso é literalmente
   *     "o topo só no final de uma sessão contínua".
   *
   *   - "corner" (quina 90° de verdade -- só existe na ponta B de
   *     colPlus/ponta A de rowPlus do MESMO tile, ver fato geométrico
   *     abaixo): estica a régua de fora até o ponto onde as 2 RÉGUAS DE
   *     FORA (retas infinitas) se cruzam de verdade (wallFarRailLine +
   *     lineIntersect) -- os 2 segmentos convergem pro MESMO ponto exato
   *     (mesma conta pros 2 lados), fechando a quina sem lasca nenhuma.
   *     Com uma salvaguarda (wallCornerMiterPoint): se o cruzamento sair
   *     bizarro (bem longe do esperado -- ex. thickness muito diferente,
   *     ou um bug futuro), cai de volta no cap fixo em vez de arriscar
   *     abrir um buraco de novo.
   *
   *   - "open" (ponta solta -- nada emendando ali, ou vizinho de estilo
   *     de IMAGEM sem espessura): cap fixo + bisel de 45° (a versão 2),
   *     E agora também uma face de PONTA (retângulo vertical fechando a
   *     espessura, perto -> longe, piso -> altura) -- pedido do Douglas
   *     na mesma leva: "e nao preencheu a face topo de espessura
   *     vertical". Só desenhada aqui, numa ponta genuinamente solta (ex:
   *     pilastra isolada do lado de um painel de vidro) -- numa
   *     emenda/quina ela ficaria sobrando por cima de uma parede que já
   *     fecha ali sozinha.
   *
   * Fato geométrico usado o tempo todo (verificado numericamente): a
   * ponta B de colPlus(c,r) e a ponta A de rowPlus(c,r) são SEMPRE o
   * mesmo ponto de verdade (wallEdgeFloorPoints) -- mas essa NÃO é a
   * ÚNICA quina 90° deste sistema (era o que eu achava até o Douglas
   * mandar prints de novo confirmando "igual" depois do miter das 2
   * réguas já estar matematicamente certo -- o bug não era de conta,
   * era de CLASSIFICAÇÃO: um tipo inteiro de quina nunca era
   * reconhecido como quina, caía sempre em "open"). Existe um SEGUNDO
   * tipo, num tile DIAGONAL vizinho (verificado na mão com os mesmos
   * GRID_ORIGIN/ISO_TILE de sempre):
   *
   *   - colPlus(c,r).A == rowPlus(c+1,r-1).B (mesmo ponto de verdade)
   *   - rowPlus(c,r).B == colPlus(c-1,r+1).A (mesmo ponto de verdade)
   *
   * Faz sentido geometricamente: colPlus e rowPlus são sempre as 2
   * arestas perpendiculares de um losango, então QUALQUER colPlus
   * encostando em QUALQUER rowPlus no mesmo ponto é uma quina de 90°,
   * não só quando são do mesmo tile. Uma parede em "L" que dobra
   * "puxando" um tile na diagonal (em vez de dobrar exatamente no tile
   * de quina) cai nesse 2º caso -- e antes desse fix as 2 pontas dessa
   * quina eram classificadas "open" (nenhum vizinho reto, e o único
   * check de quina só olhava o mesmo tile), daí o cap+bisel de ponta
   * solta desenhado nos 2 lados = a faixa escura vertical cheia que o
   * Douglas via na quina. Todo o resto (colPlus(c,r).B com
   * colPlus(c,r+1).A, rowPlus(c,r).A com rowPlus(c+1,r).B) continua
   * sendo continuação RETA, não quina.
   *
   * Sincronização: pintar/apagar um segmento muda a classificação das
   * pontas dos vizinhos diretos dele (até 3: reta-A, reta-B, quina) --
   * eles precisam redesenhar NA HORA (refreshWallNeighbors, chamado por
   * paintWallAt) pra "aprender" do novo vizinho (ou da falta dele).
   * loadSavedWall faz o load inteiro e, só DEPOIS de todo mundo já estar
   * no mapa, redesenha tudo de novo uma vez (independente da ordem em
   * que os segmentos vieram do servidor).
   */
  /** Classifica a ponta A ou B de um segmento colPlus/rowPlus (ver
   * comentário grande de createWallPatternGraphics abaixo) -- consulta
   * this.draftWall AO VIVO, nunca cacheado. "center"/"centerRow" nunca
   * fazem quina (não dobram 90°, ver ACHADO abaixo), só reta. */
  private wallJunctionAt(
    col: number,
    row: number,
    side: WallSide,
    end: "A" | "B",
    styleId: string
  ): { kind: "corner"; neighbor: WallSegmentDef } | { kind: "straight"; neighbor: WallSegmentDef } | { kind: "open" } {
    // ACHADO (pedido do Douglas: "as paredes de centro de tile precisam
    // poder nas duas direcoes" + print de 3 pilares "Centro do tile"
    // numa fileira com fresta/bisel entre eles, igual o bug de
    // colPlus/rowPlus que já tinha sido corrigido) -- "center"/
    // "centerRow" são pilares SOLTOS dentro do próprio tile (nunca
    // dividem 2 tiles de verdade, ver WallSide em game/wall.ts), então
    // nunca fazem QUINA (não tem como dobrar 90° "dentro" do mesmo
    // tile) -- só reta, quando o tile VIZINHO na direção da própria
    // orientação também tem um pilar da MESMA orientação+estilo
    // ("center" segue colPlus -- vizinho reto em row±1 -- "centerRow"
    // segue rowPlus -- vizinho reto em col±1", mesma ideia de
    // colPlus/rowPlus abaixo). Sem isso, cada pilar de uma fileira
    // desenhava sempre "open" nos 2 lados (cap+bisel+face de ponta
    // sobrando entre eles), mesmo formando uma parede contínua de
    // verdade.
    if (side === "center" || side === "centerRow") {
      const straightCol = side === "centerRow" ? (end === "A" ? col + 1 : col - 1) : col;
      const straightRow = side === "center" ? (end === "A" ? row - 1 : row + 1) : row;
      const straightNeighbor = this.draftWall.get(wallSegmentId(straightCol, straightRow, side));
      if (straightNeighbor && straightNeighbor.styleId === styleId) {
        return { kind: "straight", neighbor: straightNeighbor };
      }
      return { kind: "open" };
    }
    // quina 90°: 2 tipos possíveis por ponta (ver fato geométrico no
    // comentário grande acima) -- wallCornerNeighborKeys devolve as
    // CHAVES dos possíveis parceiros pra essa combinação de side/end
    // (array vazio se essa ponta não pode ser quina). Testa cada uma na
    // ordem, usando a primeira que existir de verdade E for do tipo
    // certo (padrão/pattern).
    for (const cornerKey of this.wallCornerNeighborKeys(col, row, side, end)) {
      const cornerNeighbor = this.draftWall.get(cornerKey);
      if (cornerNeighbor && wallEntryById(cornerNeighbor.styleId)?.pattern) {
        return { kind: "corner", neighbor: cornerNeighbor };
      }
    }
    // continuação reta: mesmo side, tile vizinho na direção certa (ver
    // fato geométrico acima) -- só conta como "reta de verdade" se for
    // o MESMO estilo (thickness igual garantida, sem precisar de miter
    // nenhum ali, só encostar).
    let straightCol = col;
    let straightRow = row;
    if (side === "colPlus") straightRow = end === "A" ? row - 1 : row + 1;
    else straightCol = end === "A" ? col + 1 : col - 1;
    const straightNeighbor = this.draftWall.get(wallSegmentId(straightCol, straightRow, side));
    if (straightNeighbor && straightNeighbor.styleId === styleId) {
      return { kind: "straight", neighbor: straightNeighbor };
    }
    return { kind: "open" };
  }

  /** Devolve as CHAVES (wallSegmentId) dos possíveis parceiros de quina
   * de uma ponta A/B de colPlus/rowPlus (array vazio se essa ponta não
   * pode ser quina). Quem chama testa cada uma na ordem e usa a
   * primeira que existir de verdade e for do tipo certo
   * (padrão/pattern) -- ver wallJunctionAt.
   *
   * ACHADO (6ª rodada, Douglas com o zigue-zague: "so tem duas quinas
   * que ele nao ta identificando", print mostrando um "bico" solto bem
   * ao lado de uma quina de verdade): até aqui só existiam 2 casos por
   * SIDE inteiro (mesmo tile pra colPlus.B/rowPlus.A, tile diagonal pra
   * colPlus.A/rowPlus.B) -- mas cada PONTA na verdade tem 2 parceiros
   * possíveis, não 1, porque o MESMO ponto de quina pode ser alcançado
   * por 2 segmentos rowPlus/colPlus diferentes (eles são vizinhos retos
   * um do outro -- ver fato geométrico da continuação reta). Conferido
   * na mão com os mesmos GRID_ORIGIN/ISO_TILE de sempre:
   *
   *   - colPlus(c,r).A == rowPlus(c+1,r-1).B (já existia) E TAMBÉM
   *     colPlus(c,r).A == rowPlus(c,r-1).A (faltava)
   *   - colPlus(c,r).B == rowPlus(c,r).A (já existia) E TAMBÉM
   *     colPlus(c,r).B == rowPlus(c+1,r).B (faltava)
   *   - rowPlus(c,r).A == colPlus(c,r).B (já existia) E TAMBÉM
   *     rowPlus(c,r).A == colPlus(c,r+1).A (faltava)
   *   - rowPlus(c,r).B == colPlus(c-1,r+1).A (já existia) E TAMBÉM
   *     rowPlus(c,r).B == colPlus(c-1,r).B (faltava)
   *
   * Sem o 2º caso, uma quina pintada com o parceiro "errado" (o outro
   * dos 2 possíveis, ex: rowPlus(c+1,r) em vez de rowPlus(c,r) pra
   * fechar colPlus(c,r).B) nunca era reconhecida -- ficava "open" dos
   * 2 lados mesmo os 2 segmentos se ENCOSTANDO de verdade no mesmo
   * ponto, daí o "bico" solto do Douglas ao lado da quina de verdade.
   * A ordem/direção (outX,outY) do miter não muda o ponto de
   * interseção calculado (é a mesma reta infinita nos 2 sentidos, só
   * muda o sinal do t em wallCornerMiterPoint) -- conferido numérico
   * que o novo caso fecha a quina igual aos outros 2 (polígono válido,
   * sem auto-interseção, mesma área). */
  private wallCornerNeighborKeys(col: number, row: number, side: WallSide, end: "A" | "B"): string[] {
    if (side === "colPlus") {
      if (end === "B") {
        return [wallSegmentId(col, row, "rowPlus"), wallSegmentId(col + 1, row, "rowPlus")];
      }
      return [wallSegmentId(col + 1, row - 1, "rowPlus"), wallSegmentId(col, row - 1, "rowPlus")];
    }
    // rowPlus
    if (end === "A") {
      return [wallSegmentId(col, row, "colPlus"), wallSegmentId(col, row + 1, "colPlus")];
    }
    return [wallSegmentId(col - 1, row + 1, "colPlus"), wallSegmentId(col - 1, row, "colPlus")];
  }

  /** Régua de um segmento (achatada num RAIO 2D -- ponto+direção, sem
   * limite de comprimento), usada pelo miter de quina de
   * wallCornerMiterPoint abaixo. `railSign` +1 pega a régua de
   * FORA/longe (a visível, com tijolo -- mesma conta de
   * bottomA/perp/farA que já existe em createWallPatternGraphics),
   * -1 pega a régua de DENTRO/perto (nearA/nearB). Parametrizada
   * (col,row,side,thicknessPx quaisquer) pra poder calcular a régua do
   * PARCEIRO da quina, não só a do próprio segmento. */
  private wallRailLine(
    col: number,
    row: number,
    side: WallSide,
    thicknessPx: number,
    railSign: 1 | -1
  ): { point: { x: number; y: number }; dirX: number; dirY: number } {
    const { a: bottomA, b: bottomB } = wallEdgeFloorPoints(col, row, side);
    const neighbor = side === "rowPlus" ? { col, row: row + 1 } : { col: col + 1, row };
    const centerNear = tileToWorld(col, row);
    const centerFar = tileToWorld(neighbor.col, neighbor.row);
    const perpDist = Math.hypot(centerFar.x - centerNear.x, centerFar.y - centerNear.y) || 1;
    const perpX = (centerFar.x - centerNear.x) / perpDist;
    const perpY = (centerFar.y - centerNear.y) / perpDist;
    const halfThick = thicknessPx / 2;
    const point = { x: bottomA.x + railSign * perpX * halfThick, y: bottomA.y + railSign * perpY * halfThick };
    const edgeLength = wallEdgeLengthPx(col, row, side) || 1;
    return { point, dirX: (bottomB.x - bottomA.x) / edgeLength, dirY: (bottomB.y - bottomA.y) / edgeLength };
  }

  /** Ponto de interseção de 2 retas 2D (ponto+direção cada) -- null só
   * se forem paralelas (não deveria acontecer aqui: colPlus e rowPlus
   * nunca têm a MESMA direção). */
  private lineIntersect(
    r1: { point: { x: number; y: number }; dirX: number; dirY: number },
    r2: { point: { x: number; y: number }; dirX: number; dirY: number }
  ): { x: number; y: number } | null {
    const denom = r1.dirX * r2.dirY - r1.dirY * r2.dirX;
    if (Math.abs(denom) < 1e-6) return null;
    const t = ((r2.point.x - r1.point.x) * r2.dirY - (r2.point.y - r1.point.y) * r2.dirX) / denom;
    return { x: r1.point.x + r1.dirX * t, y: r1.point.y + r1.dirY * t };
  }

  /** Ponto de miter de uma ponta "corner" (ver wallJunctionAt) --
   * estica a régua (de FORA se `railSign` for +1, de DENTRO se -1) até
   * onde ela cruza de VERDADE a MESMA régua do parceiro da quina.
   * `outX/outY` é a direção de fora (extensão) desta ponta --
   * (-alongX,-alongY) na ponta A, (alongX,alongY) na ponta B, ver
   * chamadas em createWallPatternGraphics.
   *
   * ACHADO (2ª rodada, Douglas com os mesmos prints de novo: "crie um
   * sistema que identifique quando as pontas se encontram... ta errado
   * esses cotpos atras"): a régua de FORA já mitrava certinho (conferi
   * na mão, bate em cima do ponto certo -- não era bug de cálculo), mas
   * a régua de DENTRO continuava só um bisel de 45° aproximado (mesma
   * ideia da 2ª versão) -- isso deixava a face de cima com uma "lasca"
   * triangular na ponta de DENTRO da quina (o "corpo atrás" que ele
   * viu). Mitrando a régua de DENTRO também (mesma função, só com
   * railSign=-1) fecha a quina inteira num retângulo limpo dos 2 lados,
   * sem bisel nenhum sobrando -- ver uso em createWallPatternGraphics.
   *
   * Salvaguarda: se o cruzamento sair longe demais do esperado (reta
   * quase paralela, thickness bizarro etc.), cai no cap fixo de sempre
   * em vez de arriscar abrir um buraco de novo (ver "3ª tentativa" no
   * comentário grande acima). */
  private wallCornerMiterPoint(
    neighbor: WallSegmentDef,
    rawPoint: { x: number; y: number },
    outX: number,
    outY: number,
    cap: number,
    railSign: 1 | -1
  ): { x: number; y: number } {
    const fallback = { x: rawPoint.x + outX * cap, y: rawPoint.y + outY * cap };
    const neighborPattern = wallEntryById(neighbor.styleId)?.pattern;
    if (!neighborPattern) return fallback;
    const ray1 = { point: rawPoint, dirX: outX, dirY: outY };
    const ray2 = this.wallRailLine(neighbor.col, neighbor.row, neighbor.side, neighborPattern.thicknessPx, railSign);
    const hit = this.lineIntersect(ray1, ray2);
    if (!hit) return fallback;
    const dist = Math.hypot(hit.x - rawPoint.x, hit.y - rawPoint.y);
    const maxReasonable = Math.max(cap, neighborPattern.thicknessPx / 2, 30) * 4;
    if (dist > maxReasonable) return fallback;
    return hit;
  }

  private createWallPatternGraphics(seg: WallSegmentDef, pattern: WallPatternConfig): Phaser.GameObjects.Graphics {
    const { a: bottomA, b: bottomB } = wallEdgeFloorPoints(seg.col, seg.row, seg.side);
    // "centerRow" segue a MESMA orientação de rowPlus (ver WallSide em
    // game/wall.ts) -- precisa do mesmo tile "vizinho" sintético (só
    // pra achar a direção perpendicular certa da espessura, já que
    // "center"/"centerRow" não separam 2 tiles de verdade).
    const neighbor =
      seg.side === "rowPlus" || seg.side === "centerRow"
        ? { col: seg.col, row: seg.row + 1 }
        : { col: seg.col + 1, row: seg.row };
    const centerNear = tileToWorld(seg.col, seg.row);
    const centerFar = tileToWorld(neighbor.col, neighbor.row);
    const perpDist = Math.hypot(centerFar.x - centerNear.x, centerFar.y - centerNear.y) || 1;
    const perpX = (centerFar.x - centerNear.x) / perpDist;
    const perpY = (centerFar.y - centerNear.y) / perpDist;
    const halfThick = pattern.thicknessPx / 2;

    // 2 arestas paralelas à original (uma de cada lado da divisa) -- a
    // parede fica CENTRADA nela, metade da espessura pra cada tile.
    const nearA = { x: bottomA.x - perpX * halfThick, y: bottomA.y - perpY * halfThick };
    const nearB = { x: bottomB.x - perpX * halfThick, y: bottomB.y - perpY * halfThick };
    const farA = { x: bottomA.x + perpX * halfThick, y: bottomA.y + perpY * halfThick };
    const farB = { x: bottomB.x + perpX * halfThick, y: bottomB.y + perpY * halfThick };

    const edgeLength = wallEdgeLengthPx(seg.col, seg.row, seg.side);
    const alongX = edgeLength > 0 ? (farB.x - farA.x) / edgeLength : 0;
    const alongY = edgeLength > 0 ? (farB.y - farA.y) / edgeLength : 0;
    const cap = halfThick;

    // classifica as 2 pontas AO VIVO (ver comentário grande acima) --
    // nunca cacheado, sempre consultando this.draftWall na hora de
    // desenhar, então um refreshWallNeighbors (chamado por paintWallAt)
    // já é suficiente pra qualquer vizinho direto se atualizar.
    const junctionA = this.wallJunctionAt(seg.col, seg.row, seg.side, "A", seg.styleId);
    const junctionB = this.wallJunctionAt(seg.col, seg.row, seg.side, "B", seg.styleId);

    // RESOLVIDO (6ª rodada) -- console.log temporário confirmou (print
    // do Douglas lado a lado com o log): cada ponta pode encostar em 1
    // de 2 parceiros perpendiculares possíveis (mesmo ponto de quina,
    // alcançável por 2 segmentos retos-vizinhos-entre-si diferentes),
    // mas só 1 dos 2 era checado -- ver ACHADO grande em
    // wallCornerNeighborKeys. Fix lá. Log removido depois de confirmado
    // ("FINALMENTEEE").

    // ACHADO (3ª rodada, Douglas com print de uma quina em "Borda" E de
    // uma parede "Centro do tile": "ela ta meio que passando do tile na
    // vertical pra baixo" / "a parede que ficou no MEIO do tile ta com
    // o problema que resolvemos ali ainda") -- o fix anterior da face de
    // PONTA (ver ACHADO logo abaixo, "ângulo errado") trocou farA2 por
    // farA (corte reto, sem esticar) SÓ naquela face -- mas aqui em
    // cima o TOPO de uma ponta "open" continuava esticando até o bisel
    // (farA - along*cap), ficando MAIOR que a face de ponta que fecha
    // embaixo dele. Resultado: uma fresta/frincha sem nada desenhado
    // bem na base, na tira entre o corte reto (onde a face de ponta
    // para) e a ponta do bisel (onde o topo ainda ia) -- exatamente o
    // "passando pra baixo" que apareceu nos prints, e presente em TODA
    // ponta "open" (inclusive as 2 de uma parede "center", que são
    // sempre open dos 2 lados). Fix: ponta "open" não estica mais nada
    // -- vira um corte reto de verdade (igual "straight"), só que sem
    // vizinho pra casar (por isso ainda ganha a face de ponta lateral
    // logo abaixo). Só "corner" continua esticando/mitrando (ali o
    // vizinho de verdade fecha o buraco, não sobra fresta nenhuma).
    // ACHADO (4ª rodada, Douglas confirmando na quina de VERDADE depois
    // de eu reverter a tentativa de sobreposição na ponta solta: "continua"):
    // a quina em si (colPlus/rowPlus mitrados) tem a MESMA frincha de
    // antialiasing que eu suspeitava, só que eu tinha mexido no lugar
    // errado (a face de ponta solta, que nem participa da quina). Aqui
    // são 2 segmentos = 2 Graphics OBJETOS SEPARADOS -- mesmo com o
    // miter batendo no MESMO ponto matematicamente pros 2 lados (já
    // verificado com conta na mão em rodada anterior), o navegador pode
    // deixar passar um fiapo na borda entre 2 desenhos distintos que só
    // se ENCOSTAM sem se sobrepor. Fix: estica cada ponto mitrado mais
    // 1px na MESMA direção de fora (outX,outY -- a mesma usada pro
    // miter) depois de achar a interseção -- os 2 lados passam a
    // AVANÇAR um pouquinho território do outro (mesma cor/estilo dos 2
    // lados aqui, então a sobreposição não aparece), fechando a frincha
    // sem reabrir o "ângulo errado" (esticar 1px não é a mesma coisa que
    // o bisel antigo de halfThick inteiro).
    //
    // RESOLVIDO (5ª rodada) -- botei um console.log temporário em
    // wallJunctionAt pra conferir contra o navegador de verdade (3
    // fixes seguidos sem mudar NADA visualmente não fazia sentido só
    // com erro de geometria). O log confirmou: a classificação sempre
    // esteve CERTA (a quina de verdade sempre foi "corner" dos 2
    // lados). O print que o Douglas foi mandando repetido NÃO era
    // dessa quina -- era de outro segmento, uma parede "2,0,colPlus"
    // SOLTA (A=open, B=open, sem nada emendando nos 2 lados), que fica
    // perto da escada. Toda parede (mesmo reta) tem uma dobra visível
    // entre a face de tijolo e o telhado por causa do ângulo
    // isométrico -- então essa pilastra solta PARECIA uma quina de
    // verdade a olho nu, mas não era. A quina de verdade (colPlus/rowPlus
    // mitrados) sempre renderizou limpa -- confirmado no print da tela
    // inteira depois do log. Log removido depois de confirmado.
    const seamEps = 1;
    const extendOutward = (p: { x: number; y: number }, outX: number, outY: number) => ({
      x: p.x + outX * seamEps,
      y: p.y + outY * seamEps,
    });
    // ACHADO (7ª rodada, Douglas com print de 2 pilares "Centro do
    // tile": "continua as linhas no topo de tras") -- a mesma frincha de
    // antialiasing entre 2 Graphics OBJETOS SEPARADOS que já tinha sido
    // corrigida pra "corner" (ver ACHADO grande acima) também acontece
    // em "straight": os 2 lados de uma emenda reta calculam o MESMO
    // ponto exato (mesma fórmula/entrada, sem precisar de miter), mas
    // ainda são 2 desenhos distintos que só se ENCOSTAM sem se
    // sobrepor -- o navegador deixa passar o mesmo fiapo 1px, só que
    // dessa vez visível na face de CIMA (cor sólida, sem tijolo pra
    // "esconder" a frincha atrás da junta de argamassa como a face da
    // frente tem). Fix: mesmo truque de "corner" (estica 1px pra fora,
    // mesma cor dos 2 lados então a sobreposição não aparece), sem
    // miter nenhum (não precisa -- já é a mesma reta, só empurra na
    // mesma direção de along).
    const farA2 =
      junctionA.kind === "corner"
        ? extendOutward(this.wallCornerMiterPoint(junctionA.neighbor, farA, -alongX, -alongY, cap, 1), -alongX, -alongY)
        : junctionA.kind === "straight"
          ? extendOutward(farA, -alongX, -alongY)
          : farA;
    const farB2 =
      junctionB.kind === "corner"
        ? extendOutward(this.wallCornerMiterPoint(junctionB.neighbor, farB, alongX, alongY, cap, 1), alongX, alongY)
        : junctionB.kind === "straight"
          ? extendOutward(farB, alongX, alongY)
          : farB;
    // régua de DENTRO: mitrada nas pontas "corner" (ver ACHADO no
    // comentário grande de wallCornerMiterPoint, fecha a quina num
    // retângulo limpo dos 2 lados, sem bisel/lasca sobrando na ponta de
    // dentro) OU esticada 1px nas pontas "straight" (mesmo ACHADO
    // acima). "open" continua com o ponto cru de sempre (ponta solta é
    // corte reto, sem bisel -- ver ACHADO mais acima).
    const nearA2 =
      junctionA.kind === "corner"
        ? extendOutward(this.wallCornerMiterPoint(junctionA.neighbor, nearA, -alongX, -alongY, cap, -1), -alongX, -alongY)
        : junctionA.kind === "straight"
          ? extendOutward(nearA, -alongX, -alongY)
          : nearA;
    const nearB2 =
      junctionB.kind === "corner"
        ? extendOutward(this.wallCornerMiterPoint(junctionB.neighbor, nearB, alongX, alongY, cap, -1), alongX, alongY)
        : junctionB.kind === "straight"
          ? extendOutward(nearB, alongX, alongY)
          : nearB;

    // comprimento/mapeamento local (u,v) -> mundo usados pra desenhar a
    // argamassa e o tijolo -- baseados em farA2/farB2 (que já refletem a
    // classificação de cada ponta acima), então a face da frente sempre
    // acompanha até onde a face de cima realmente vai.
    const edgeLengthExt = Math.hypot(farB2.x - farA2.x, farB2.y - farA2.y);
    const mapPoint = (u: number, v: number) => ({
      x: farA2.x + alongX * u,
      y: farA2.y + alongY * u - v,
    });

    const gfx = this.add.graphics();
    // argamassa como fundo (o paralelogramo inteiro, já esticado),
    // tijolo desenhado por cima já com a folga -- mesma ideia visual de
    // FloorPatternConfig (linha de junta = a cor de baixo "vazando" pela
    // folga entre tábuas). Passa edgeLengthExt (não o bruto) pra
    // wallBrickRects, então a amarração de tijolo continua natural
    // dentro do trechinho esticado, sem faixa vazia nas pontas.
    gfx.fillStyle(pattern.mortarColor, 1);
    gfx.fillPoints(
      [
        mapPoint(0, 0),
        mapPoint(edgeLengthExt, 0),
        mapPoint(edgeLengthExt, pattern.heightPx),
        mapPoint(0, pattern.heightPx),
      ],
      true
    );
    gfx.fillStyle(pattern.brickColor, 1);
    for (const rect of wallBrickRects(pattern, edgeLengthExt)) {
      gfx.fillPoints(
        [mapPoint(rect.u0, rect.v0), mapPoint(rect.u1, rect.v0), mapPoint(rect.u1, rect.v1), mapPoint(rect.u0, rect.v1)],
        true
      );
    }
    // RODAPÉ -- pedido do Douglas, com foto de referência (rodapé
    // branco, moldura fina, contornando a quina de uma parede/coluna
    // até o chão): "preciso criar uma especie de rodapé pras paredes",
    // esclarecido como "um formato e uma cor padrao pra todas, que vai
    // contornar toda face visivel dela" -- visual FIXO (mesma altura/
    // cor em TODA parede "padrão", sem exceção nenhuma -- não é campo
    // do formulário "Criar Parede", ver comentário grande de RODAPÉ em
    // game/wall.ts). Faixa sólida colada no chão (v=0 até
    // WALL_BASEBOARD_HEIGHT_PX), desenhada por CIMA do tijolo (mesma
    // largura esticada `edgeLengthExt` do resto da face, então
    // acompanha a emenda/quina sem frincha na junção com o vizinho),
    // com a CAVA (sulco sombra+brilho, ver comentário grande das
    // constantes WALL_BASEBOARD_* acima -- pedido seguinte do Douglas:
    // "uma cava encima e se tivesse linha nele, ficaria mais real")
    // perto do topo da faixa. Esta aqui é a face da FRENTE -- a MESMA
    // faixa (com a MESMA cava) se repete nas faces de PONTA (mais
    // abaixo, quando alguma delas é a visível) pra "contornar" a quina
    // inteira, igual a foto.
    const baseboardGrooveTop = WALL_BASEBOARD_HEIGHT_PX - WALL_BASEBOARD_GROOVE_OFFSET_PX;
    const baseboardGrooveMid = baseboardGrooveTop - WALL_BASEBOARD_GROOVE_LINE_PX;
    const baseboardGrooveBottom = baseboardGrooveMid - WALL_BASEBOARD_GROOVE_LINE_PX;
    gfx.fillStyle(WALL_BASEBOARD_COLOR, 1);
    gfx.fillPoints(
      [mapPoint(0, 0), mapPoint(edgeLengthExt, 0), mapPoint(edgeLengthExt, WALL_BASEBOARD_HEIGHT_PX), mapPoint(0, WALL_BASEBOARD_HEIGHT_PX)],
      true
    );
    // sombra (parede do sulco que olha pra BAIXO -- fica em CIMA, mais
    // perto do topo da faixa).
    gfx.fillStyle(WALL_BASEBOARD_GROOVE_SHADOW_COLOR, 1);
    gfx.fillPoints(
      [mapPoint(0, baseboardGrooveMid), mapPoint(edgeLengthExt, baseboardGrooveMid), mapPoint(edgeLengthExt, baseboardGrooveTop), mapPoint(0, baseboardGrooveTop)],
      true
    );
    // brilho (parede do sulco que olha pra CIMA -- fica GRUDADA embaixo
    // da linha de sombra, formando o entalhe).
    gfx.fillStyle(WALL_BASEBOARD_GROOVE_HIGHLIGHT_COLOR, 1);
    gfx.fillPoints(
      [mapPoint(0, baseboardGrooveBottom), mapPoint(edgeLengthExt, baseboardGrooveBottom), mapPoint(edgeLengthExt, baseboardGrooveMid), mapPoint(0, baseboardGrooveMid)],
      true
    );
    // linha de CIMA -- marca a emenda rodapé/parede (ver
    // WALL_BASEBOARD_TOP_LINE_* acima), bem no topo da faixa.
    gfx.fillStyle(WALL_BASEBOARD_TOP_LINE_COLOR, 1);
    gfx.fillPoints(
      [
        mapPoint(0, WALL_BASEBOARD_HEIGHT_PX - WALL_BASEBOARD_TOP_LINE_PX),
        mapPoint(edgeLengthExt, WALL_BASEBOARD_HEIGHT_PX - WALL_BASEBOARD_TOP_LINE_PX),
        mapPoint(edgeLengthExt, WALL_BASEBOARD_HEIGHT_PX),
        mapPoint(0, WALL_BASEBOARD_HEIGHT_PX),
      ],
      true
    );
    // face de CIMA -- percurso ao redor da tira (farA2 -> farB2 ->
    // nearB2 -> nearA2), SEM pivô nenhum em NENHUM tipo de ponta --
    // "straight" e "open" usam farX/nearX crus (corte reto exato, sem
    // esticar -- ver ACHADO acima), "corner" usa os 2 mitrados de
    // verdade (ver ACHADO em wallCornerMiterPoint, fecha a quina num
    // retângulo limpo). Cor: pattern.topColor -- campo PRÓPRIO,
    // escolhido no formulário "Criar Parede" (ver comentário grande de
    // WallPatternConfig em game/wall.ts pro histórico de ida e volta:
    // "a cor encima da parede eu quero escolher"). Vale só pra ESTA
    // face -- as faces de PONTA logo abaixo NÃO usam topColor, ver
    // shadeColor mais abaixo.
    const h = pattern.heightPx;
    const raise = (p: { x: number; y: number }) => ({ x: p.x, y: p.y - h });
    const topPoints = [raise(farA2), raise(farB2), raise(nearB2), raise(nearA2)];
    gfx.fillStyle(pattern.topColor, 1);
    gfx.fillPoints(topPoints, true);
    // faces de PONTA -- só em ponta "open" de verdade (ver comentário
    // grande acima): fecha a espessura (perto -> longe, piso -> altura)
    // pra pilastras/pontas soltas não vazarem o fundo por trás. Numa
    // emenda reta ou quina o próprio vizinho já fecha ali, então
    // desenhar aqui também só criaria uma faixa escura falsa cruzando a
    // parede.
    //
    // ACHADO (Douglas com print: "topo com face norte nao tem geometri,
    // topo ali ta com um angulo errado"): a 1ª versão usava farA2/farB2
    // esticado (na época, ponta "open" ainda tinha bisel) como canto de
    // fora dessa face -- só que farA2 ficava NUM "u" diferente de nearA
    // (esticado só no eixo do comprimento, não no da espessura), então
    // o retângulo saía TORTO (diagonal). Fix original: usar farA/farB
    // (corte reto, sem esticar) aqui. Isso resolveu o ângulo torto, mas
    // abriu um bug NOVO (2ª rodada, "ela ta meio que passando do tile
    // na vertical pra baixo" / "a parede que ficou no MEIO do tile ta
    // com o problema que resolvemos ali ainda"): o topo (acima) ainda
    // esticava até o bisel, e essa face de ponta (aqui embaixo) parava
    // antes, na divisa de verdade -- sobrava uma fresta sem nada
    // desenhado entre os dois. Fix definitivo: tirou-se o bisel de vez
    // (farA2/farB2 agora são farA/farB crus pra ponta "open" também, ver
    // ACHADO logo acima de farA2/farB2) -- agora topo e face de ponta
    // usam exatamente a MESMA divisa (farA/nearA), sem folga nenhuma
    // entre os dois.
    // ACHADO (tentativa revertida): cheguei a esticar 1px a borda de
    // DENTRO dessa face pra "colar" na face da frente/topo, suspeitando
    // de uma frincha de antialiasing entre os 3 polígonos ("a parede de
    // tile central continua com a linha nas costas"). Só que, testado
    // ao vivo, Douglas viu o problema voltar bem na QUINA de verdade
    // (colPlus/rowPlus mitrados) logo depois -- e essa quina não passa
    // por este bloco `if (kind === "open")` nenhuma vez (os 2 segmentos
    // que formam ela são "corner"/"straight" nas pontas, nunca "open"),
    // então o mais seguro é não arriscar mexer mais aqui sem ver exatamente
    // onde a linha aparece -- revertido pro corte reto exato (farA/farB,
    // sem esticar nada), mesmo estado de quando o "passando pra baixo"
    // foi resolvido.
    // ACHADO (8ª rodada, Douglas com print de 2 pilares "Centro do
    // tile" totalmente isolados -- os 2 lados curtos ficam "open" ao
    // mesmo tempo pela 1ª vez, então os 2 bugs simultâneos finalmente
    // ficaram visíveis juntos: "continua as linhas no topo de tras" +
    // "assim como nas paredes de canto, esse topo frontal so deve
    // aparecer na face que fica visivel, aquele de tras fica pra tras
    // da parede") -- a câmera isométrica é FIXA, então uma extrusão
    // convexa (a parede tem altura) só pode mostrar 3 faces de verdade
    // de cada vez: topo, frente (já é sempre a mesma, +perp -- por isso
    // a face de trás -perp NUNCA é desenhada) e UM dos 2 lados curtos
    // (ponta A OU ponta B, nunca os 2). Até aqui a face de ponta
    // desenhava sempre que a ponta fosse "open", dos 2 lados -- correto
    // quando só 1 lado tá "open" (comum: só uma ponta solta numa
    // parede que emenda no resto), mas errado quando os 2 estão
    // (pilar/segmento 100% isolado): desenhava as 2 faces de ponta ao
    // mesmo tempo, e uma delas é fisicamente impossível de ver dessa
    // câmera -- sobra/"vaza" por cima do telhado, exatamente a "2ª
    // linha no topo" que ele via.
    //
    // Qual ponta é a visível: mesma lógica de +perp/-perp (a única
    // direção "de fora" que a câmera enxerga) aplicada no eixo
    // along -- colPlus/"center" tem along apontando pra
    // x-diminui/y-aumenta (rumo à câmera, ver tileToWorld: y maior =
    // mais perto), então a ponta B (que fica na direção +along) é a
    // visível, A nunca. rowPlus/"centerRow" tem along invertido (y
    // diminui), então é o oposto: A é a visível, B nunca. Testado com
    // print antes/depois (pilar isolado com os 2 lados "open"): só a
    // ponta certa desenha face agora, a "fantasma" sumiu.
    // Cor das faces de PONTA: SEMPRE calculada (brickColor escurecido),
    // NUNCA pattern.topColor -- pedido explícito do Douglas separando os
    // 2 casos: "a cor da face na espessura vertical é a cor que segue
    // da parede" / "essa segue como esta" (a face de CIMA, acima, é que
    // virou campo próprio -- ver comentário grande ali e em
    // WallPatternConfig em game/wall.ts).
    const shadeColor = this.darkenColor(pattern.brickColor, 0.8);
    // RODAPÉ na face de PONTA -- mesma faixa fixa (com a mesma cava)
    // da face da frente (ver comentário grande lá em cima), repetida
    // aqui pra "contornar toda face visível" da parede, exatamente
    // como a foto de referência do Douglas (rodapé branco envolvendo a
    // quina de uma coluna até o chão). `raiseBaseboard` é a mesma
    // ideia de `raise` (acima), só que subindo uma altura ARBITRÁRIA
    // (v) em vez da altura inteira da parede.
    const raiseBaseboard = (p: { x: number; y: number }, v: number) => ({ x: p.x, y: p.y - v });
    const visibleCapEnd: "A" | "B" = seg.side === "colPlus" || seg.side === "center" ? "B" : "A";
    if (junctionA.kind === "open" && visibleCapEnd === "A") {
      gfx.fillStyle(shadeColor, 1);
      gfx.fillPoints([nearA, raise(nearA), raise(farA), farA], true);
      gfx.fillStyle(WALL_BASEBOARD_COLOR, 1);
      gfx.fillPoints([nearA, raiseBaseboard(nearA, WALL_BASEBOARD_HEIGHT_PX), raiseBaseboard(farA, WALL_BASEBOARD_HEIGHT_PX), farA], true);
      gfx.fillStyle(WALL_BASEBOARD_GROOVE_SHADOW_COLOR, 1);
      gfx.fillPoints(
        [raiseBaseboard(nearA, baseboardGrooveMid), raiseBaseboard(nearA, baseboardGrooveTop), raiseBaseboard(farA, baseboardGrooveTop), raiseBaseboard(farA, baseboardGrooveMid)],
        true
      );
      gfx.fillStyle(WALL_BASEBOARD_GROOVE_HIGHLIGHT_COLOR, 1);
      gfx.fillPoints(
        [raiseBaseboard(nearA, baseboardGrooveBottom), raiseBaseboard(nearA, baseboardGrooveMid), raiseBaseboard(farA, baseboardGrooveMid), raiseBaseboard(farA, baseboardGrooveBottom)],
        true
      );
    }
    if (junctionB.kind === "open" && visibleCapEnd === "B") {
      gfx.fillStyle(shadeColor, 1);
      gfx.fillPoints([nearB, raise(nearB), raise(farB), farB], true);
      gfx.fillStyle(WALL_BASEBOARD_COLOR, 1);
      gfx.fillPoints([nearB, raiseBaseboard(nearB, WALL_BASEBOARD_HEIGHT_PX), raiseBaseboard(farB, WALL_BASEBOARD_HEIGHT_PX), farB], true);
      gfx.fillStyle(WALL_BASEBOARD_GROOVE_SHADOW_COLOR, 1);
      gfx.fillPoints(
        [raiseBaseboard(nearB, baseboardGrooveMid), raiseBaseboard(nearB, baseboardGrooveTop), raiseBaseboard(farB, baseboardGrooveTop), raiseBaseboard(farB, baseboardGrooveMid)],
        true
      );
      gfx.fillStyle(WALL_BASEBOARD_GROOVE_HIGHLIGHT_COLOR, 1);
      gfx.fillPoints(
        [raiseBaseboard(nearB, baseboardGrooveBottom), raiseBaseboard(nearB, baseboardGrooveMid), raiseBaseboard(farB, baseboardGrooveMid), raiseBaseboard(farB, baseboardGrooveBottom)],
        true
      );
    }
    gfx.setDepth(wallDepthForSegment(seg, furnitureDepthForTile));
    this.applyWallAvatarCutoutMask(gfx); // "recorte" do boneco atrás -- ver comentário grande de draftWallSprites
    return gfx;
  }

  /**
   * Recria a sprite/desenho de todo segmento JÁ PINTADO (draftWall) que
   * usa o ESTILO dado -- mesma ideia de refreshFloorModel logo acima, só
   * que pra parede (ver registerCustomWallModels em game/wall.ts e
   * fetchAndRegisterCustomWall em GameRoom.tsx, chamado depois de editar
   * um padrão de parede custom no Editor de Itens, aba "Criar Parede").
   * Sem destroyFloorDisplayObject-equivalente aqui -- o estilo "padrão"
   * não cria textura nenhuma pra vazar (só Graphics, ver comentário de
   * createWallPatternGraphics acima), então `.destroy()` direto já basta.
   */
  refreshWallModel(styleId: string) {
    for (const [key, seg] of this.draftWall.entries()) {
      if (seg.styleId !== styleId) continue;
      this.draftWallSprites.get(key)?.destroy();
      const sprite = this.addWallSprite(seg);
      if (sprite) this.draftWallSprites.set(key, sprite);
      else this.draftWallSprites.delete(key);
      // se essa parede tem vizinho reto ou de quina com um estilo
      // DIFERENTE (não afetado pelo loop acima), ele também precisa
      // redesenhar -- editar a espessura/tijolo aqui pode mudar o ponto
      // de encontro (ver wallJunctionAt/refreshWallNeighbors).
      this.refreshWallNeighbors(seg.col, seg.row, seg.side);
    }
  }

  /** Redesenha os vizinhos DIRETOS de col/row/side (ver wallJunctionAt)
   * depois de pintar/apagar/editar um segmento -- até 4: reta na ponta
   * A, reta na ponta B, quina na ponta A, quina na ponta B (ver
   * wallCornerNeighborKeys -- side colPlus/rowPlus só; "center"/
   * "centerRow" só têm os 2 retos, nunca quina, ver wallJunctionAt) --
   * cada um precisa "aprender" do vizinho novo (ou da falta dele) NA
   * HORA, senão só o segmento que acabou de mudar sairia com a
   * classificação certa, e os vizinhos ficariam com a geometria antiga
   * até um F5. Sem-efeito pra quem não estiver pintado ali (nada a
   * redesenhar). */
  private refreshWallNeighbors(col: number, row: number, side: WallSide) {
    let straightKeys: string[];
    let cornerKeys: string[] = [];
    if (side === "colPlus" || side === "rowPlus") {
      straightKeys =
        side === "colPlus"
          ? [wallSegmentId(col, row - 1, "colPlus"), wallSegmentId(col, row + 1, "colPlus")]
          : [wallSegmentId(col + 1, row, "rowPlus"), wallSegmentId(col - 1, row, "rowPlus")];
      cornerKeys = [
        ...this.wallCornerNeighborKeys(col, row, side, "A"),
        ...this.wallCornerNeighborKeys(col, row, side, "B"),
      ];
    } else {
      // "center"/"centerRow" -- só reta na direção da própria
      // orientação (ver ACHADO grande em wallJunctionAt), sem quina.
      straightKeys =
        side === "center"
          ? [wallSegmentId(col, row - 1, "center"), wallSegmentId(col, row + 1, "center")]
          : [wallSegmentId(col + 1, row, "centerRow"), wallSegmentId(col - 1, row, "centerRow")];
    }
    const keys: string[] = [...straightKeys, ...cornerKeys];
    for (const key of keys) {
      const neighborSeg = this.draftWall.get(key);
      if (!neighborSeg) continue;
      this.draftWallSprites.get(key)?.destroy();
      const sprite = this.addWallSprite(neighborSeg);
      if (sprite) this.draftWallSprites.set(key, sprite);
      else this.draftWallSprites.delete(key);
    }
  }

  /**
   * Carrega a parede já salva no servidor (ver GET /room/walls em
   * server/index.js) -- mesma ideia/timing de loadSavedFloor.
   */
  loadSavedWall(items: WallSegmentDef[]) {
    const pendingRetry: WallSegmentDef[] = [];
    for (const seg of items) {
      const key = wallSegmentId(seg.col, seg.row, seg.side);
      if (this.draftWall.has(key)) continue;
      this.draftWall.set(key, seg);
      const sprite = this.addWallSprite(seg);
      if (sprite) {
        this.draftWallSprites.set(key, sprite);
      } else if (wallEntryById(seg.styleId)) {
        pendingRetry.push(seg);
      }
    }
    // 2ª passada: agora que TODOS os segmentos carregados já estão no
    // mapa, redesenha de novo cada um (ver wallJunctionAt) -- sem isso,
    // o segmento que veio ANTES na lista (items[] não garante ordem)
    // teria sido desenhado sem o vizinho existir ainda, então ficaria
    // com uma ponta "open" em vez de "straight"/"corner". Simples e à
    // prova de ordem: redesenha tudo de novo uma vez só, sem tentar
    // adivinhar quem precisa (ver refreshWallNeighbors, usado só no
    // caminho de pintar/apagar UM segmento por vez).
    for (const seg of items) {
      const key = wallSegmentId(seg.col, seg.row, seg.side);
      if (!this.draftWall.has(key)) continue; // falhou ao carregar (estilo removido) -- pendingRetry cuida
      this.draftWallSprites.get(key)?.destroy();
      const sprite = this.addWallSprite(seg);
      if (sprite) this.draftWallSprites.set(key, sprite);
      else this.draftWallSprites.delete(key);
    }
    if (pendingRetry.length > 0) {
      this.time.delayedCall(400, () => this.retryWallSprites(pendingRetry));
    }
    this.onDraftWallChange?.(this.getDraftWallList());
    // "sai e entrei bugou" (Douglas) -- /room/walls e /room/areas (ver
    // GameRoom.tsx) são 2 fetches em PARALELO, sem nenhuma ordem
    // garantida entre eles. Se a resposta de áreas chegar ANTES da de
    // paredes, loadSavedAreas já roda updateAreaDim com this.draftWall
    // ainda VAZIO -- o véu fica em cache (areaDimAreaId) achando que já
    // "acendeu" tudo que tinha pra acender naquela área, e como o
    // jogador não troca de área nenhuma só por isso, o buraco das
    // paredes que chegaram DEPOIS nunca é desenhado (mesmo com a conta
    // de geometria certa) -- só reentrando na sala de novo, na hora que
    // a corrida der sorte ao contrário. refreshAreas (force=true, ver
    // comentário lá) resolve incondicionalmente: reprocessa o véu com o
    // que tiver carregado ATÉ AGORA, então mesmo chegando por último a
    // parede força o recálculo certo.
    this.refreshAreas();
  }

  /** Segunda tentativa (ver loadSavedWall), mesma ideia de retryFloorSprites. */
  private retryWallSprites(items: WallSegmentDef[]) {
    let addedAny = false;
    for (const seg of items) {
      const key = wallSegmentId(seg.col, seg.row, seg.side);
      if (this.draftWallSprites.has(key)) continue;
      if (!this.draftWall.has(key)) continue;
      const sprite = this.addWallSprite(seg);
      if (sprite) {
        this.draftWallSprites.set(key, sprite);
        addedAny = true;
      }
    }
    // mesma corrida do véu de área explicada em loadSavedWall -- essa
    // parede só ganhou sprite AGORA (400ms depois, textura custom que
    // não tinha chegado ainda), então precisa do mesmo empurrão.
    if (addedAny) this.refreshAreas();
  }

  /**
   * Pinta (ou apaga) a ARESTA col/row/side com a ferramenta de parede
   * selecionada -- mesma ideia de paintFloorAt, só que a "unidade" é uma
   * aresta em vez de um tile inteiro.
   */
  private paintWallAt(col: number, row: number, side: WallSide) {
    const tool = this.selectedWallTool;
    if (!tool) return;
    const key = wallSegmentId(col, row, side);

    if (tool.kind === "erase") {
      const existing = this.draftWall.get(key);
      if (!existing) return;
      this.draftWallSprites.get(key)?.destroy();
      this.draftWallSprites.delete(key);
      this.draftWall.delete(key);
      this.refreshWallNeighbors(col, row, side);
      this.onDraftWallChange?.(this.getDraftWallList());
      // apagar uma parede pode abrir um "buraco" na borda de uma área
      // ativa (ver comentário grande de wallTouchesArea em
      // updateAreaDim) -- force=true porque o id da área não muda
      // (updateAreaDim ignora chamadas sem mudança de área, senão).
      this.updateAreaDim(true);
      return;
    }

    // uma aresta não pode ter parede E porta ao mesmo tempo -- ver mesma
    // checagem (espelhada) em paintDoorAt/comentário grande de
    // DoorSegmentDef em game/door.ts.
    if (this.draftDoor.has(key)) return;

    const existing = this.draftWall.get(key);
    if (existing && existing.styleId === tool.entry.id) return;

    this.draftWallSprites.get(key)?.destroy();
    const def: WallSegmentDef = { col, row, side, styleId: tool.entry.id };
    this.draftWall.set(key, def);
    const sprite = this.addWallSprite(def);
    if (!sprite) {
      this.draftWall.delete(key);
      return;
    }
    this.draftWallSprites.set(key, sprite);
    this.refreshWallNeighbors(col, row, side);
    this.onDraftWallChange?.(this.getDraftWallList());
    // parede nova pintada na borda de uma área ativa (ver comentário
    // grande de wallTouchesArea em updateAreaDim) -- sem isso o véu só
    // "aprenderia" dela na próxima vez que o jogador mudasse de área.
    this.updateAreaDim(true);
  }

  // ------------------------------------------------------------------
  // Porta (categoria separada de parede -- ver comentário grande de
  // selectedDoorTool/draftDoor/doorOpenState/doorLocked/playerStatus lá
  // em cima, e o comentário no topo de game/door.ts pro "porquê" geral).
  // ------------------------------------------------------------------

  /** nearestWallEdge (game/wall.ts) devolve WallSide "genérico" (as 4
   * variantes, incluindo "center"/"centerRow") só porque a MESMA função
   * é reaproveitada pelo modo "Centro do tile" de parede -- pela própria
   * implementação dela (só compara fracCol/fracRow, nunca produz
   * "center"/"centerRow" sozinha), o valor devolvido é sempre colPlus/
   * rowPlus. Porta não tem modo "centro" nenhum (ver DoorSide = só as 2
   * variantes de fronteira), então este cast é seguro -- só existe pra
   * TypeScript aceitar o tipo mais estreito nos 2 pontos de uso abaixo
   * (handleEditPointerMove/handleEditPointerDown). */
  private toDoorSide(side: WallSide): DoorSide {
    return side as DoorSide;
  }

  /** Escolhe a ferramenta de porta ativa -- mesma ideia da selectWallTool
   * acima (porta mora na MESMA aresta da grade que parede, ver DoorSide
   * em game/door.ts, por isso reaproveita o wallHoverGraphics de destaque
   * -- só uma ferramenta de aresta ativa por vez, nunca parede e porta
   * armadas juntas). Desarma as outras (móvel/piso/área/parede/mover). */
  selectDoorTool(tool: DoorTool) {
    this.selectedDoorTool = tool;
    this.selectedCatalogEntry = null;
    this.selectedFloorTool = null;
    this.selectedWallTool = null;
    this.selectedAreaTool = null;
    this.selectedRoomShapeTool = null;
    this.deleteToolActive = false;
    this.selectMoveTool(false);
    this.refreshCatalogGhost();
    if (!tool) this.wallHoverGraphics?.setVisible(false);
  }

  getDraftDoorList(): DoorSegmentDef[] {
    return Array.from(this.draftDoor.values());
  }

  clearDraftDoor() {
    for (const sprite of this.draftDoorSprites.values()) sprite.destroy();
    this.draftDoorSprites.clear();
    this.draftDoor.clear();
    this.doorOpenState.clear();
    this.doorLocked.clear();
    this.onDraftDoorChange?.(this.getDraftDoorList());
  }

  /** Escolhe a URL/textura certa pra ESSE lado (facing) -- com fallback
   * pro lado ESQUERDO (mesmo esquema de furnitureArtFile em
   * game/furniture.ts, que cai pra "down" quando falta uma direção)
   * quando a arte da direita ainda não foi enviada (pedido do Douglas:
   * "eu subirei a arte" -- ele sobe as duas, mas uma porta recém-criada
   * pode ter só a esquerda por enquanto). Sem espelhar nada (setFlipX)
   * -- diferente de parede (que reaproveita 1 arte só pras 2 orientações
   * da aresta), aqui o Douglas desenha os 2 lados à mão, mesma ideia de
   * FurnitureFacing "left"/"right" (não é geometria de aresta, é só qual
   * arte mostrar). */
  private resolveDoorTextureKey(entry: DoorCatalogEntry, facing: DoorFacing, open: boolean): string {
    const effectiveFacing: DoorFacing = entry.art[facing] ? facing : "left";
    return doorTextureKey(entry.id, effectiveFacing, open);
  }

  /**
   * Cria a imagem de UM segmento de porta, já ancorada/profunda certa --
   * mesma ideia do ramo "imagem" de addWallSprite (porta é SEMPRE imagem,
   * nunca "padrão" desenhado por código, ver comentário no topo de
   * game/door.ts). Devolve null se o styleId não bate com nenhum item do
   * catálogo OU se a textura (do lado/estado certo, ver
   * resolveDoorTextureKey) ainda não carregou.
   *
   * SEM recorte de boneco atrás (ver applyWallAvatarCutoutMask, usado em
   * toda parede) de propósito, por enquanto: uma porta só fica no estado
   * "aberta" (ver updateDoorOpenState) justamente quando tem alguém perto
   * dela -- na prática, pelo tempo que o boneco realmente estaria ATRÁS
   * da porta encostada nessa aresta, ela já trocou pra arte "aberta"
   * (folha(s) deslizada(s) pro lado, ver DoorArtSet), que por natureza
   * ocupa bem menos da aresta que a fechada. Se isso não bastar na
   * prática com a arte de verdade do Douglas, dá pra ligar
   * applyWallAvatarCutoutMask aqui depois (já é genérico pra Image).
   */
  private addDoorSprite(seg: DoorSegmentDef): Phaser.GameObjects.Image | null {
    const entry = doorEntryById(seg.styleId);
    if (!entry) return null;
    const key = doorSegmentId(seg.col, seg.row, seg.side);
    const open = this.doorOpenState.get(key) === true;
    const textureKey = this.resolveDoorTextureKey(entry, seg.facing, open);
    if (!this.textures.exists(textureKey)) {
      console.warn(`[porta] textura "${textureKey}" (estilo "${seg.styleId}") não estava carregada ainda -- segmento ${seg.col},${seg.row},${seg.side} não desenhado.`);
      return null;
    }
    const pos = doorWorldAnchor(seg);
    const image = this.add
      .image(pos.x, pos.y, textureKey)
      .setOrigin(0.5, 1)
      .setDepth(doorDepthForSegment(seg, furnitureDepthForTile));
    // porta sobe pelo NAVEGADOR (Editor de Itens, resolução ORIGINAL do
    // arquivo do Douglas, sem redimensionar antes) -- diferente de
    // parede (arte sempre vem já do tamanho certo, pela pasta local
    // scripts/syncWallAssets.mjs, sem upload por aqui), então PRECISA de
    // setDisplaySize aqui, mesma técnica de item custom de móvel (ver
    // comentário grande em addFurnitureSprite): a textura de verdade
    // continua em resolução cheia, só a EXIBIÇÃO encolhe/cresce pra
    // caber exatamente na largura de uma aresta da grade
    // (doorEdgeLengthPx -- grade uniforme, mesmo valor pra qualquer
    // aresta), preservando a proporção original da imagem pra altura.
    const source = this.textures.get(textureKey).getSourceImage() as { width?: number; height?: number };
    const nativeW = source.width || image.width;
    const nativeH = source.height || image.height;
    if (nativeW > 0 && nativeH > 0) {
      // largura ajustável (ver DoorCatalogEntry.displayWidth em
      // game/door.ts, pedido do Douglas "quero editar a dimensao dos
      // arquivos que subo nelas tambem... igual os mobis normais") --
      // sem valor configurado (undefined, modelo cadastrado antes desse
      // campo existir, ou "Tamanho no jogo" nunca mexido), cai pro
      // comportamento de sempre: encaixa exatamente na aresta.
      const targetWidth = entry.displayWidth ?? doorEdgeLengthPx(seg.col, seg.row, seg.side);
      image.setDisplaySize(targetWidth, targetWidth * (nativeH / nativeW));
    }
    return image;
  }

  /** Recria a sprite de todo segmento JÁ PINTADO (draftDoor) que usa o
   * ESTILO dado -- mesma ideia de refreshWallModel, chamado pelo
   * GameRoom.tsx (fetchAndRegisterCustomDoor) depois de editar uma porta
   * custom no Editor de Itens (aba "Criar Porta"). */
  refreshDoorModel(styleId: string) {
    for (const [key, seg] of this.draftDoor.entries()) {
      if (seg.styleId !== styleId) continue;
      this.draftDoorSprites.get(key)?.destroy();
      const sprite = this.addDoorSprite(seg);
      if (sprite) this.draftDoorSprites.set(key, sprite);
      else this.draftDoorSprites.delete(key);
    }
  }

  /** Carrega a porta já salva no servidor (ver GET /room/doors em
   * server/index.js) -- mesma ideia/timing de loadSavedFloor (sem a
   * complicação de 2 passadas de loadSavedWall: porta não tem "encontro"
   * nenhum pra sincronizar com o vizinho, cada segmento é 100%
   * independente visualmente). */
  loadSavedDoor(items: DoorSegmentDef[]) {
    const pendingRetry: DoorSegmentDef[] = [];
    for (const seg of items) {
      const key = doorSegmentId(seg.col, seg.row, seg.side);
      if (this.draftDoor.has(key)) continue;
      this.draftDoor.set(key, seg);
      const sprite = this.addDoorSprite(seg);
      if (sprite) {
        this.draftDoorSprites.set(key, sprite);
      } else if (doorEntryById(seg.styleId)) {
        pendingRetry.push(seg);
      }
    }
    if (pendingRetry.length > 0) {
      this.time.delayedCall(400, () => this.retryDoorSprites(pendingRetry));
    }
    this.onDraftDoorChange?.(this.getDraftDoorList());
    // mesma corrida de /room/walls x /room/areas explicada em
    // loadSavedWall -- /room/doors também é um fetch em paralelo com
    // /room/areas, sem ordem garantida.
    this.refreshAreas();
  }

  /** Segunda tentativa (ver loadSavedDoor), mesma ideia de retryWallSprites/retryFloorSprites. */
  private retryDoorSprites(items: DoorSegmentDef[]) {
    let addedAny = false;
    for (const seg of items) {
      const key = doorSegmentId(seg.col, seg.row, seg.side);
      if (this.draftDoorSprites.has(key)) continue;
      if (!this.draftDoor.has(key)) continue;
      const sprite = this.addDoorSprite(seg);
      if (sprite) {
        this.draftDoorSprites.set(key, sprite);
        addedAny = true;
      }
    }
    // mesma corrida do véu de área explicada em loadSavedWall/loadSavedDoor.
    if (addedAny) this.refreshAreas();
  }

  /**
   * Pinta (ou apaga) a ARESTA col/row/side com a ferramenta de porta
   * selecionada -- mesma ideia de paintWallAt.
   */
  private paintDoorAt(col: number, row: number, side: DoorSide) {
    const tool = this.selectedDoorTool;
    if (!tool) return;
    const key = doorSegmentId(col, row, side);

    if (tool.kind === "erase") {
      const existing = this.draftDoor.get(key);
      if (!existing) return;
      this.draftDoorSprites.get(key)?.destroy();
      this.draftDoorSprites.delete(key);
      this.draftDoor.delete(key);
      this.doorOpenState.delete(key);
      this.doorLocked.delete(key);
      this.onDraftDoorChange?.(this.getDraftDoorList());
      this.updateAreaDim(true); // ver comentário grande em paintWallAt/updateAreaDim
      return;
    }

    // uma aresta não pode ter parede E porta ao mesmo tempo (ver
    // comentário grande de DoorSegmentDef em game/door.ts) -- recusa em
    // silêncio em vez de substituir a parede sem avisar (mesma cautela
    // de "Sobrepor" em móvel: melhor não fazer nada do que apagar sem
    // querer o que já tava lá).
    if (this.draftWall.has(key)) return;

    const existing = this.draftDoor.get(key);
    if (existing && existing.styleId === tool.entry.id && existing.facing === tool.facing) return;

    this.draftDoorSprites.get(key)?.destroy();
    const def: DoorSegmentDef = { col, row, side, styleId: tool.entry.id, facing: tool.facing };
    this.draftDoor.set(key, def);
    const sprite = this.addDoorSprite(def);
    if (!sprite) {
      this.draftDoor.delete(key);
      return;
    }
    this.draftDoorSprites.set(key, sprite);
    this.onDraftDoorChange?.(this.getDraftDoorList());
    this.updateAreaDim(true); // ver comentário grande em paintWallAt/updateAreaDim
  }

  /** Mesma ideia de doorGuardedAreaId em server/index.js, só que do lado
   * do CLIENTE (usa this.areaDefs/getDraftAreaList/areaOwnerByAreaId, já
   * disponíveis aqui) -- olha os 2 tiles que essa aresta separa, devolve
   * o id da primeira área "mesa-privada" encontrada num deles (null se
   * nenhum dos 2 lados tiver área com dono). Usado só pra DECIDIR O
   * ESTADO na hora de desenhar/travar (updateDoorOpenState, clique de
   * porta) -- quem decide de VERDADE se um "lock-door" é aceito é
   * sempre o servidor (ver setDoorLock: nunca aplicado otimista). */
  private doorGuardedAreaId(col: number, row: number, side: DoorSide): string | null {
    const neighbor = side === "colPlus" ? { col: col + 1, row } : { col, row: row + 1 };
    const tiles = this.getDraftAreaList();
    for (const t of [{ col, row }, neighbor]) {
      const areaId = areaIdAtTile(tiles, t.col, t.row);
      if (!areaId) continue;
      const def = this.areaDefs.get(areaId);
      if (def?.type === "mesa-privada") return areaId;
    }
    return null;
  }

  /**
   * Recalcula o ESTADO ao vivo (aberta/fechada) de cada porta -- chamado
   * TODO FRAME em update(), sem precisar de mensagem nova nenhuma no
   * protocolo (só usa localContainer/remoteContainers, já atualizados a
   * cada "move" recebido -- ver comentário grande de doorOpenState lá em
   * cima). Prioridade, da mais forte pra mais fraca:
   *   1) doorLocked (trava MANUAL do dono, ver setDoorLock) -- sempre
   *      fechada, nem olha avatar nenhum.
   *   2) dono da área que essa porta guarda em modo "focus" (pedido do
   *      Douglas: "no modo foco ja trava a porta") -- mesmo efeito da
   *      trava manual, só que automático enquanto o status durar.
   *   3) proximidade de QUALQUER avatar (local ou remoto) até a ARESTA
   *      da porta, com histerese (DOOR_OPEN_DISTANCE_PX/
   *      DOOR_CLOSE_DISTANCE_PX) pra não ficar piscando bem na borda do
   *      raio.
   * Só redesenha a sprite (destroy + addDoorSprite de novo, textura
   * "aberta"/"fechada" certa) quando o estado realmente MUDA -- nada a
   * fazer todo frame pra portas que não têm ninguém por perto.
   */
  private updateDoorOpenState() {
    if (this.draftDoor.size === 0) return;
    const containers = [this.localContainer, ...this.remoteContainers.values()].filter(
      (c): c is Phaser.GameObjects.Container => Boolean(c)
    );
    for (const [key, seg] of this.draftDoor.entries()) {
      const wasOpen = this.doorOpenState.get(key) === true;
      let nextOpen: boolean;
      if (this.doorLocked.has(key)) {
        nextOpen = false;
      } else {
        const areaId = this.doorGuardedAreaId(seg.col, seg.row, seg.side);
        const owner = areaId ? this.areaOwnerByAreaId.get(areaId) : undefined;
        // dono OFFLINE (owner.playerId null, ver comentário grande de
        // areaOwnerByAreaId) nunca tem status "focus" nenhum pra travar
        // a porta -- trata igual "sem status conhecido" (undefined).
        const ownerStatus = owner?.playerId ? this.playerStatus.get(owner.playerId) : undefined;
        if (ownerStatus === "focus") {
          nextOpen = false;
        } else if (containers.length === 0) {
          nextOpen = false;
        } else {
          const anchor = doorWorldAnchor(seg);
          let closestDist = Infinity;
          for (const c of containers) {
            const d = Phaser.Math.Distance.Between(c.x, c.y, anchor.x, anchor.y);
            if (d < closestDist) closestDist = d;
          }
          nextOpen = wasOpen ? closestDist <= DOOR_CLOSE_DISTANCE_PX : closestDist <= DOOR_OPEN_DISTANCE_PX;
        }
      }
      if (nextOpen !== wasOpen) {
        this.doorOpenState.set(key, nextOpen);
        this.draftDoorSprites.get(key)?.destroy();
        const sprite = this.addDoorSprite(seg);
        if (sprite) this.draftDoorSprites.set(key, sprite);
        else this.draftDoorSprites.delete(key);
      }
    }
  }

  /** Chamado de fora (GameRoom.tsx) a cada broadcast "profile" (ver
   * protocolo em server/index.js) -- só guarda o STATUS ao vivo (ver
   * playerStatus lá em cima), usado em updateDoorOpenState pra saber se
   * o DONO de uma área "mesa-privada" tá em "focus" agora. `playerId` já
   * vem traduzido pro sentinela "local" quando for o próprio jogador
   * (mesma tradução de setAreaOwner -- ver comentário grande de
   * areaOwnerByAreaId). */
  setPlayerStatus(playerId: string, status: string) {
    this.playerStatus.set(playerId, status);
  }

  /** Chamado de fora (GameRoom.tsx) a cada broadcast "door-lock" (ver
   * protocolo "lock-door"/"unlock-door" em server/index.js) -- NUNCA
   * aplicado otimista (mesma cautela de setAreaOwner/onClaimArea): só
   * muda de verdade quando o SERVIDOR confirmar (é ele quem valida se
   * quem pediu é mesmo o dono da área que essa porta guarda). */
  setDoorLock(col: number, row: number, side: DoorSide, locked: boolean) {
    const key = doorSegmentId(col, row, side);
    if (locked) this.doorLocked.add(key);
    else this.doorLocked.delete(key);
  }

  /** Acha a porta (se houver) embaixo do ponteiro -- testa o retângulo de
   * CADA sprite de porta (getBounds() já reflete origin/depth certos,
   * sem precisar de hitArea customizada tipo isPointerOnAnyAvatar).
   * Usado só fora do modo de edição (ver handleRoomPointerDown), pra
   * permitir clicar numa porta (do dono da área que ela guarda) pra
   * travar/destravar (ver onLockDoor/onUnlockDoor) sem também disparar o
   * clique-pra-andar nesse mesmo clique. */
  private doorSegmentAtPointer(pointer: Phaser.Input.Pointer): DoorSegmentDef | null {
    for (const [key, sprite] of this.draftDoorSprites.entries()) {
      if (Phaser.Geom.Rectangle.Contains(sprite.getBounds(), pointer.worldX, pointer.worldY)) {
        return this.draftDoor.get(key) ?? null;
      }
    }
    return null;
  }

  /** Escolhe a ferramenta de área ativa -- mesma ideia da selectFloorTool acima, {kind:"paint", areaId} pinta a área escolhida NA LISTA (ver setAreaDefs), {kind:"erase"} apaga. Desarma móvel/piso/mover (só uma ferramenta ativa por vez). */
  selectAreaTool(tool: AreaTool) {
    this.selectedAreaTool = tool;
    this.selectedCatalogEntry = null;
    this.selectedFloorTool = null;
    this.selectedWallTool = null;
    this.selectedDoorTool = null;
    this.selectedRoomShapeTool = null;
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
   * PRÓPRIO jogador (ver onClaimArea/onAreaOwnerClick); playerId null
   * COM name identifica um dono que persiste mas está offline agora
   * (pedido do Douglas: "ela e sua, ate apagarem o espaco" -- ver
   * comentário grande de areaOwnerByAreaId acima). name null (sempre
   * junto de playerId null) é o ÚNICO caso que significa "essa área
   * voltou a ficar sem dono de verdade" (release-area/force-release-area/
   * área apagada).
   */
  setAreaOwner(areaId: string, playerId: string | null, name: string | null) {
    if (name) this.areaOwnerByAreaId.set(areaId, { playerId, name });
    else this.areaOwnerByAreaId.delete(areaId);
    this.updateAreaHoverLabels();
    // o balão de "destituir" do CEO (ver showDestituirPrompt) embute o
    // NOME do dono no texto -- se essa área específica mudou de dono
    // enquanto o balão tava aberto, o texto ficaria desatualizado ou sem
    // sentido nenhum; mais simples derrubar e deixar o CEO clicar de
    // novo se ainda quiser.
    if (this.areaDestituirPromptAreaId === areaId) this.destroyDestituirPrompt();
    // MESMA ideia pro balão de "Assumir essa mesa?" -- se ALGUÉM ganhou
    // essa área (nem que seja o próprio jogador local por outro
    // caminho) enquanto o balão tava aberto, confirmar de novo não faz
    // sentido (o servidor recusaria, ver "claim-area-denied"); derruba e
    // deixa clicar de novo se ainda estiver livre.
    if (this.areaClaimPromptAreaId === areaId) this.destroyAreaClaimPrompt();
    // MESMA ideia pro card de "quem é o dono dessa mesa" (ver
    // showAreaOwnerHoverCard) -- se o dono mudou enquanto o card tava
    // aberto (posse trocou de mão, foi destituído, virou o próprio
    // jogador local etc.), as ações dele (Chamar/"posso ir aí?"/abrir
    // conversa) já não fazem mais sentido pra quem tava mostrado ali.
    if (this.areaHoverCardAreaId === areaId) this.destroyAreaOwnerHoverCard();
  }

  /**
   * Define se o jogador LOCAL é o "CEO" (dono da sala) -- chamado de
   * fora (GameRoom.tsx) toda vez que o papel dele muda (mesmo roomRole
   * já usado pra liberar o editor de espaço, ver canEditRoom lá). Só
   * decide se o clique numa mesa de OUTRA pessoa oferece "destituir" em
   * vez de abrir o card de perfil (ver updateAreaHoverLabels) -- a
   * permissão de VERDADE é sempre reconferida no servidor (protocolo
   * "force-release-area"), isso aqui é só a UI.
   */
  setRoomOwner(isOwner: boolean) {
    this.isRoomOwner = isOwner;
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
   * que agora é um botão explícito ("Tomar posse", ver onClaimArea), não
   * sentar numa cadeira.
   *
   * dCol/dRow (padrão 0,0 = âncora): qual ASSENTO desse item (ver
   * FurnitureModelDef.extraSeats) -- vem da mensagem "seat" da rede
   * (ver onLocalSeatChange/server/index.js), só importa pra profundidade
   * (seatDepth usa o tile do ASSENTO, não sempre a âncora).
   */
  setRemoteSeat(id: string, furnitureId: string | null, name: string, dCol: number = 0, dRow: number = 0) {
    this.remoteSeat.set(id, { furnitureId, name, dCol, dRow });
    if (furnitureId) {
      const furniture = this.furnitureById(furnitureId);
      const container = this.remoteContainers.get(id);
      if (furniture && container) {
        container.setData("dir", avatarFacingFor(furniture.facing));
        this.setPoseFrame(container, SENTADO_FRAMES[avatarFacingFor(furniture.facing)]);
        // mesma correção de seatDepth (ver comentário grande dela) --
        // baseada no tile do ASSENTO (âncora + dCol/dRow), não no Y (já
        // deslocado pelo assento) da posição que chegou pelo "move".
        container.setDepth(seatDepth(furniture, furniture.col + dCol, furniture.row + dRow));
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
      this.destroyFloorDisplayObject(this.draftFloorSprites.get(key));
      this.draftFloorSprites.delete(key);
      this.draftFloor.delete(key);
      this.drawEditGrid(); // ver editGridHiddenAt -- apagar um laminado pode voltar a precisar do contorno ali
      this.onDraftFloorChange?.(this.getDraftFloorList());
      return;
    }

    const existing = this.draftFloor.get(key);
    if (existing && existing.styleId === tool.entry.id) return; // já pintado com o mesmo modelo, nada a fazer

    this.destroyFloorDisplayObject(this.draftFloorSprites.get(key));
    const def: FloorTileDef = { col, row, styleId: tool.entry.id };
    const sprite = this.addFloorSprite(def);
    if (!sprite) return;
    this.draftFloor.set(key, def);
    this.draftFloorSprites.set(key, sprite);
    this.drawEditGrid(); // ver editGridHiddenAt -- pintar um laminado ali some com o contorno duplicado
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
   * Cria o losango de UM tile de área -- sem textura própria (diferente
   * do piso/mobília, ver comentário antigo abaixo). Tinta chapada na
   * cor do TIPO da área (ver areaTypeMeta/AREA_TYPES em game/areas.ts)
   * -- SÓ visível durante a edição agora (ver DRAFT_AREA_TILE_ALPHA_EDITING/
   * refreshAreaTileAlpha): pedido original do Douglas ("a cor que
   * seleciono na area fica encima do tile? tira totalmente essa camada
   * de cor") tirou ela também da edição, mas sem NENHUM indício visual
   * (nem tinta, nem o contorno de borda que existia antes disso,
   * redrawAreaBorders, também removido por pedido dele depois -- "fica
   * uma camada visual amarela por cima do piso, com uma linha, remova")
   * pintar um tile de área ficava "mudo": nenhuma prova na hora de que
   * o clique funcionou. Pedido dele: "na edicao, quando eu to CRIANDO a
   * area, tem que aparecer o campo de marcacao" -- volta a tinta, mas
   * só enquanto this.editMode for true; fora do editor continua
   * INVISÍVEL (alpha 0), que é o que ele pediu pro uso normal desde o
   * início. O objeto em si continua sendo criado/guardado em
   * draftAreaSprites (bookkeeping puro -- nenhum outro código depende
   * do fill dele pra hit-test ou qualquer outra coisa, ver os outros
   * usos do Map).
   *
   * Era um Rectangle, depois virou um Phaser.GameObjects.Polygon (pontos
   * relativos ao CENTRO 0,0, posicionado separado em pos.x/pos.y) --
   * TROCADO pra Graphics (achado com o Douglas: "eu seleciono o tile, e
   * a marcacao comeca um pra cima" -- assim que a tinta voltou a
   * aparecer de verdade, ver comentário grande acima, ficou visível que
   * o losango do Polygon desenhava DESLOCADO ~1 tile pra cima/trás da
   * posição certa; a origem/bounding-box que o Polygon calcula sozinho
   * a partir de pontos "soltos" não bate com o centro geométrico de
   * verdade do losango -- Shape do Phaser não é confiável pra isso).
   * FIX: mesma técnica JÁ usada (e comprovadamente certa) em TODO o
   * resto do arquivo pra desenhar losango de tile -- hoverGraphics,
   * a extinta redrawAreaBorders, updateAreaDim -- um Graphics comum
   * (sem posição/origem própria nenhuma) com fillPoints em cima dos
   * pontos JÁ ABSOLUTOS de tileDiamondCorners(pos.x, pos.y), nunca
   * relativos a um (0,0) que dependa do Polygon adivinhar o centro.
   */
  private addAreaTileRect(t: AreaTileDef): Phaser.GameObjects.Graphics {
    const pos = areaWorldPos(t);
    const def = this.areaDefs.get(t.areaId);
    // cinza defensivo se a área sumiu da lista -- não deveria acontecer
    // em uso normal (setAreaDefs já limpa tile órfão), só por segurança
    // (fora do editor a cor em si não aparece, ver
    // DRAFT_AREA_TILE_ALPHA_EDITING acima, mas o Graphics ainda precisa
    // de uma cor válida pro fillStyle).
    const color = def ? areaTypeMeta(def.type).color : 0x888888;
    const g = this.add.graphics().setDepth(DEPTH_AREA);
    g.fillStyle(color, 1); // alpha de verdade é o do OBJETO (setAlpha, ver refreshAreaTileAlpha), não do fillStyle
    g.fillPoints(tileDiamondCorners(pos.x, pos.y), true);
    g.setAlpha(this.editMode ? DRAFT_AREA_TILE_ALPHA_EDITING : 0);
    return g;
  }

  /** Reaplica o alpha em toda tinta de área já desenhada -- chamado ao
   * ligar/desligar o modo de edição (ver setEditMode), pra tinta
   * aparecer/sumir NA HORA ao entrar/sair do editor, sem precisar
   * repintar tile nenhum (ver comentário grande de addAreaTileRect:
   * DRAFT_AREA_TILE_ALPHA_EDITING editando, 0 fora do editor). */
  private refreshAreaTileAlpha() {
    const alpha = this.editMode ? DRAFT_AREA_TILE_ALPHA_EDITING : 0;
    for (const rect of this.draftAreaSprites.values()) rect.setAlpha(alpha);
  }

  /** Agrupa os tiles pintados por área (col/row de cada um, sem o areaId repetido) -- só uma leitura auxiliar de this.draftArea, usada pra desenhar o hover de cada área (ver updateAreaHoverLabels). */
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
   * Recalcula tudo que depende dos tiles pintados: o hover/nome/botão
   * de posse de cada área -- chamado toda vez que a área muda (pintar/
   * apagar/carregar/lista mudar). Chegou a redesenhar também o CONTORNO
   * de cada área (redrawAreaBorders) -- removido por pedido do Douglas
   * ("quando crio a area, fica uma camada visual amarela por cima do
   * piso, com uma linha, remova", ver comentário grande de
   * addAreaTileRect): hoje uma área pintada não tem nenhum indício
   * visual próprio, nem tinta nem contorno. A POSSE em si
   * (areaOwnerByAreaId) não é recalculada aqui -- ela é estado que só
   * muda por fora, via setAreaOwner (broadcast "area-owner" do
   * servidor), então updateAreaHoverLabels só LÊ o que já tá guardado.
   */
  private refreshAreas() {
    this.updateAreaHoverLabels();
    // force:true -- a área que o jogador já está pode ter mudado de
    // FORMATO (tile pintado/apagado), mesmo continuando com o mesmo id,
    // então o véu (ver updateAreaDim) precisa redesenhar mesmo sem
    // "trocar" de área.
    this.updateAreaDim(true);
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
    // guardado ANTES do early-return/atribuição logo abaixo -- é o
    // valor de this.areaDimAreaId de ANTES dessa chamada, usado tanto na
    // comparação de troca quanto (mais abaixo) pra saber qual área
    // "perdeu" o jogador local, se alguma.
    const previousAreaId = this.areaDimAreaId;
    if (!force && areaId === previousAreaId) return; // não mudou de área -- nada novo pra desenhar
    this.areaDimAreaId = areaId;
    if (areaId !== previousAreaId) {
      // confirmação "Assumir essa mesa?" (ver showAreaClaimPrompt) --
      // pedido do Douglas: "SÓ aparece quando alguem ENTRA no espaco,
      // quando sai, ele tem que sumir". Reusa essa MESMA transição de
      // área (não dispara de novo a cada passo DENTRO da mesma área, só
      // na fronteira de verdade -- é exatamente isso que faltava no 1º
      // convite automático que existiu, ver onLocalAreaTileChanged no
      // histórico do arquivo: disparava por TILE, não por ÁREA,
      // reabrindo a cada passo dentro da mesma mesa -- "ainda ta
      // aparecendo pra eu pegar a mesa toda hora"). SAIU de uma área com
      // o balão aberto pra ELA: derruba (sem confirmar nem recusar, só
      // some -- sair do espaço já é a resposta). Nunca durante a edição
      // (this.editMode) -- pintar o 1º tile de uma área nova embaixo do
      // próprio boneco (comum, ver os prints do Douglas testando) também
      // conta como "entrar" pra areaZoneAt, mas não é hora de perguntar
      // nada.
      if (previousAreaId && this.areaClaimPromptAreaId === previousAreaId) this.destroyAreaClaimPrompt();
      // previousAreaId === undefined (diferente de null) só acontece na
      // PRIMEIRA vez que updateAreaDim roda pro boneco local, isto é,
      // no exato frame em que ele nasce na sala (ver o comentário do
      // campo areaDimAreaId lá em cima: começa undefined -- "nenhuma
      // área calculada ainda", diferente de null que já é "calculado,
      // tá em espaço aberto"). Bug reportado pelo Douglas (29/set):
      // "minha acesso na pagina caindo em uma mesa aleatoria ta
      // aparecendo o balao de assumir" -- a sala sempre nasce o boneco
      // num tile FIXO (tileToWorld(6,4), ver spawn lá embaixo), sem
      // ligação nenhuma com onde o dono da sala colocou as mesas;
      // quando esse tile fixo cai em cima de uma área "mesa-privada"
      // livre, esse bloco via isso como "entrou andando" (undefined
      // !== areaId) e mostrava o balão sem o jogador ter dado nem um
      // passo. NÃO é delay de carregamento (nunca foi corrida/race --
      // é sempre o MESMO frame, com ou sem atraso de rede). Fix: só
      // dispara o convite quando a transição é de verdade (saiu de um
      // espaço já conhecido -- null ou outra área -- pra essa), nunca
      // no cálculo inicial do spawn.
      const isInitialSpawnFrame = previousAreaId === undefined;
      // areaOwnersSynced (ver comentário grande dele lá em cima) --
      // sem os area-owners do "init" ainda aplicados, esse Map pode
      // estar vazio mesmo eu já sendo dona de mesa de verdade (rede
      // lenta), então nem VALE testar ownership ainda -- espera
      // sincronizar antes de decidir mostrar o balão.
      if (areaId && !this.editMode && !isInitialSpawnFrame && this.areaOwnersSynced) {
        const def = this.areaDefs.get(areaId);
        if (def?.type === "mesa-privada" && !this.areaOwnerByAreaId.has(areaId) && !this.localOwnsAnyArea()) {
          this.showAreaClaimPrompt(areaId);
        }
      }
    }

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
      // ANTES: sprite.getBounds() -- retângulo AXIS-ALIGNED que envolve
      // o sprite (mesmo problema já corrigido pra porta, ver comentário
      // grande do loop de porta mais abaixo: um sprite desenhado na
      // inclinação isométrica sempre gera um bounding-box bem mais
      // LARGO que o losango do tile de verdade). Achado com o Douglas
      // ("a luz nao acompanha o tile, ta quinado onde tem mobi na
      // divisa"): bem no tile com móvel (ex: a divisória de vidro), o
      // contorno do buraco "estufava" pro lado (o retângulo do
      // getBounds() é mais largo que o losango), formando um
      // degrau/escada na borda da área -- em vez do zigue-zague liso
      // que os tiles SEM móvel já mostravam certinho (usando o mesmo
      // losango do piso, ver loop logo acima).
      //
      // FIX: reusa o MESMO losango do tile (tileDiamondCorners, igual o
      // buraco de piso) em vez do bounding-box do sprite -- sempre bate
      // exatamente com a borda dos tiles vizinhos, não importa a arte.
      // Extrude ele pra CIMA por sprite.displayHeight (móvel tem
      // origem embaixo-centro no VÉRTICE DA FRENTE do losango, ver
      // furnitureWorldPos em game/furniture.ts -- cresce reto pra cima
      // dali) formando um prisma -- só as 2 faces da FRENTE (as que a
      // câmera vê, mesma regra de "qual lado é visível" de
      // createWallPatternGraphics) entram no contorno: losango de baixo
      // já coberto pelo loop de piso, então só falta o topo (losango
      // deslocado pra cima) + as 2 laterais da frente ligando os dois.
      const { x, y } = tileToWorld(f.col, f.row);
      const [top, right, bottom, left] = tileDiamondCorners(x, y);
      const heightPx = sprite.displayHeight;
      const up = (p: Point) => ({ x: p.x, y: p.y - heightPx });
      maskGfx.fillPoints([left, up(left), up(top), up(right), right, bottom], true);
    };
    for (const f of ROOM_FURNITURE) addFurnitureHole(f, this.roomFurnitureSprites.get(f.id));
    for (const [id, f] of this.draftFurniture) addFurnitureHole(f, this.draftSprites.get(id));

    // parede de SISTEMA (game/wall.ts) + porta (game/door.ts) que tocam
    // algum tile da área -- pedido do Douglas: "quero que pegue as
    // paredes que estao no tile da area tambem, mesmo que na borda". Uma
    // parede/porta mora numa ARESTA entre 2 tiles (ver WallSide/DoorSide),
    // não um tile só -- "na borda" quer dizer que ela conta mesmo quando
    // só UM dos 2 tiles que ela separa está pintado da área (a divisória
    // que FECHA a área por fora nunca tem os 2 lados pintados, senão não
    // seria a borda). NÃO precisa cobrir "Divisória" (categoria de
    // móvel, aba "Criar Divisória") -- essa já é FurnitureDef normal,
    // entra pelo addFurnitureHole/draftFurniture acima igual qualquer
    // outro móvel.
    //
    // Desenha um PARALELOGRAMO (2 pontos no CHÃO da aresta + sobe reto
    // por uma altura, mesma técnica da face da frente em
    // createWallPatternGraphics) em vez de sprite.getBounds() -- esse
    // método não existe pra parede "padrão" (Phaser.GameObjects.Graphics,
    // ver WallPatternConfig; é o ÚNICO tipo de parede que dá pra
    // cadastrar pelo Editor de Itens hoje, ver comentário grande no topo
    // de WallPatternCreatorPanel em ItemEditor.tsx), então essa é a única
    // conta que funciona pros dois tipos (padrão E imagem) ao mesmo
    // tempo, sem precisar checar qual é qual aqui.
    const wallTouchesArea = (seg: { col: number; row: number; side: WallSide }): boolean => {
      if (tileKeys.has(`${seg.col},${seg.row}`)) return true;
      if (seg.side === "colPlus" && tileKeys.has(`${seg.col + 1},${seg.row}`)) return true;
      if (seg.side === "rowPlus" && tileKeys.has(`${seg.col},${seg.row + 1}`)) return true;
      return false;
    };
    for (const [key, seg] of this.draftWall.entries()) {
      if (!wallTouchesArea(seg)) continue;
      const sprite = this.draftWallSprites.get(key);
      const entry = wallEntryById(seg.styleId);
      // parede "padrão" (Graphics) tem altura fixa no PRÓPRIO estilo
      // (pattern.heightPx); parede de IMAGEM (Image, ver addWallSprite)
      // NÃO tem -- desenha do tamanho NATIVO do arquivo, sem
      // setDisplaySize nenhum (diferente de porta, que escala pro
      // tamanho do tile) -- por isso o fallback fixo de 100px ficava
      // curto demais numa parede de imagem mais alta (ex: com telhado/
      // gable desenhado), deixando a PONTA de cima dela de fora do
      // buraco -- achado testando ao vivo com o Douglas ("nas bordas
      // que tem movel, ficou em quadrado": um retângulo escuro sobrando
      // bem em cima da parede/porta, onde a imagem passava dos 100px
      // "oficiais"). sprite.displayHeight já reflete a altura de
      // verdade renderizada na tela, então usa ela quando a parede for
      // Image; Graphics (padrão) não tem displayHeight que sirva pra
      // isso, cai pro pattern.heightPx de sempre.
      const heightPx =
        sprite instanceof Phaser.GameObjects.Image
          ? sprite.displayHeight
          : (entry?.pattern?.heightPx ?? 100);
      // parede "padrão" (Graphics, ver entry.pattern acima) desenha a
      // face de FRENTE (tijolo/cor) deslocada thicknessPx/2 PRA DENTRO
      // do tile vizinho (ver createWallPatternGraphics/farA/farB em
      // MainScene.ts) -- usar o ponto CRU de wallEdgeFloorPoints aqui
      // (como antes) recortava o buraco em cima da linha da divisa, uns
      // pixels ANTES de onde a parede de verdade começa a aparecer na
      // tela, deixando a parede inteira escura (achado com o Douglas:
      // "agora deu, mas as paredes ficare de fora" -- só uma tira fina
      // aparecia acesa, onde os dois quase se tocavam). Parede de
      // IMAGEM não tem esse deslocamento (a arte cresce reto a partir do
      // ponto cru, ver wallWorldAnchor em wall.ts), então só entra nesse
      // desvio quando for "padrão" de verdade.
      const { a, b } = entry?.pattern
        ? wallPatternFrontFloorPoints(seg, entry.pattern.thicknessPx)
        : wallEdgeFloorPoints(seg.col, seg.row, seg.side);
      maskGfx.fillPoints([a, b, { x: b.x, y: b.y - heightPx }, { x: a.x, y: a.y - heightPx }], true);
    }
    // porta -- MESMO paralelogramo da parede acima, não getBounds()
    // (achado testando ao vivo com o Douglas: getBounds() devolve o
    // retângulo AXIS-ALIGNED que envolve o sprite girado/isométrico,
    // bem maior que o desenho de verdade da porta -- o "buraco" saía um
    // retângulo grosseiro cobrindo até tile de FORA da área, do jeito
    // errado que apareceu na print dele). Usa sprite.displayHeight (já
    // escalado por setDisplaySize em addDoorSprite) no lugar do
    // pattern.heightPx da parede, que porta não tem.
    for (const [key, seg] of this.draftDoor.entries()) {
      if (!wallTouchesArea(seg)) continue;
      const sprite = this.draftDoorSprites.get(key);
      if (!sprite) continue;
      const heightPx = sprite.displayHeight;
      const { a, b } = doorEdgeFloorPoints(seg.col, seg.row, seg.side);
      maskGfx.fillPoints([a, b, { x: b.x, y: b.y - heightPx }, { x: a.x, y: a.y - heightPx }], true);
    }

    maskGfx.setVisible(false); // só serve de fonte pra máscara, não desenha por cima da cena
    this.areaDimMaskGfx = maskGfx;
    const mask = maskGfx.createGeometryMask();
    mask.invertAlpha = true; // escurece TUDO, exceto onde a máscara desenhou (o "buraco" aceso)

    // GAME_WIDTH/GAME_HEIGHT (tamanho de MUNDO fixo, "resolução interna"
    // do mapa) em vez do viewport de verdade era o 1º bug que o Douglas
    // achou dando zoom out (botão "-" do mapa): com a câmera afastada,
    // dá pra ver MAIS mundo do que GAME_WIDTH/HEIGHT cobre, então esse
    // retângulo sobrava curto nas bordas.
    //
    // TENTATIVA 2 (cameras.main.width/height + setScrollFactor(0)):
    // parecia resolver, mas scrollFactor(0) só ignora o ARRASTO
    // (scroll) da câmera -- o ZOOM continua se aplicando normal em cima
    // de um objeto scrollFactor(0) (pegadinha conhecida do Phaser: isso
    // NÃO vira um HUD de verdade, só para de acompanhar o pan). Com
    // zoom < 1 (botão "-" de novo), um retângulo do tamanho
    // cameras.main.width/height (fixo, em "pixels de câmera") encolhia
    // na tela pelo mesmo fator do zoom, sobrando pequeno no meio da
    // tela -- achado com o Douglas: "seu esmaecer ta pequeno ainda, nao
    // ta travado na tela de jogo toda".
    //
    // TENTATIVA 3 (ATUAL) -- cameras.main.worldView: é o retângulo, em
    // coordenada de MUNDO, que a câmera está enxergando NESTE EXATO
    // instante (já leva em conta arrasto E zoom nas próprias contas do
    // Phaser). Deixa o retângulo com scrollFactor NORMAL (1, o padrão
    // de qualquer objeto -- removido o setScrollFactor(0) da tentativa
    // 2) do tamanho de worldView: cobre exatamente o viewport visível,
    // não importa arrasto/zoom, pelo MESMO motivo que a MÁSCARA
    // (maskGfx acima, também scrollFactor normal) já seguia os
    // tiles/paredes certinho -- os dois passam pela MESMA transformação
    // de câmera, então nunca desalinham entre si. Só que worldView muda
    // a cada frame que a câmera se mexe, e updateAreaDim só roda quando
    // o jogador MUDA de área -- por isso o tamanho/posição de verdade
    // do retângulo é mantido em dia à parte, TODO frame (ver
    // syncAreaDimRectToCamera, chamada em update()), não só aqui na
    // criação. Ainda cobre só o CANVAS do jogo, nunca a barra de
    // status/botões (esses são DOM por cima, fora do Phaser).
    this.areaDimSprites.push(
      this.add.rectangle(0, 0, 1, 1, 0x000000, AREA_DIM_ALPHA).setDepth(DEPTH_AREA_DIM).setMask(mask)
    );
    this.syncAreaDimRectToCamera();
  }

  /**
   * Mantém areaDimSprites[0] (ver updateAreaDim acima) do tamanho/
   * posição exatos do viewport visível da câmera AGORA
   * (cameras.main.worldView) -- chamado TODO FRAME (ver update() mais
   * abaixo), porque worldView muda com arrasto/zoom da câmera, que pode
   * acontecer sem o jogador trocar de área nenhuma (a única hora que
   * updateAreaDim recria o retângulo do zero). Sem isso o retângulo
   * ficava preso no tamanho/posição de QUANDO foi criado, saindo de
   * lugar assim que a câmera se mexesse de novo depois.
   */
  private syncAreaDimRectToCamera() {
    const rect = this.areaDimSprites[0];
    if (!rect) return; // fora de qualquer área -- sem retângulo nenhum pra atualizar
    const view = this.cameras.main.worldView;
    rect.setPosition(view.centerX, view.centerY);
    rect.setSize(view.width, view.height);
  }

  /**
   * Ponto de ancoragem (centro-topo) da caixa delimitadora de uma área,
   * em coordenadas de MUNDO -- mesmo paralelogramo usado pro nome/hover
   * de sempre (ver updateAreaHoverLabels logo abaixo) e reusado aqui pro
   * balão de confirmação (showDestituirPrompt). null se a área não tiver
   * tile nenhum pintado ainda (nada pra ancorar em cima).
   */
  private areaTopAnchor(areaId: string): Point | null {
    const tiles = this.tilesByAreaId().get(areaId);
    if (!tiles || tiles.length === 0) return null;
    const { minCol, maxCol, minRow, maxRow } = areaTileBounds(tiles);
    const corners = tileRangeCorners(tileToWorld, minCol - 0.5, minRow - 0.5, maxCol + 0.5, maxRow + 0.5);
    const minX = Math.min(...corners.map((p) => p.x));
    const maxX = Math.max(...corners.map((p) => p.x));
    const minY = Math.min(...corners.map((p) => p.y));
    return { x: (minX + maxX) / 2, y: minY - 6 };
  }

  /**
   * Converte um ponto em coordenadas de MUNDO pra coordenadas de tela na
   * resolução INTERNA do jogo (mesmo espaço de cameras.main.width/height
   * -- ainda NÃO é pixel de CSS/DOM: falta multiplicar pela escala real
   * do canvas em tela, isso aqui só cuida da parte que depende de
   * câmera/zoom/scroll do Phaser; quem converte o resto é GameRoom.tsx,
   * que é quem sabe o tamanho de verdade do <canvas> na página).
   * Usado pra ancorar o balão de "destituir" (ver
   * onAreaDestituirPromptChange) -- um elemento de DOM de verdade por
   * cima do canvas, não mais desenhado pelo Phaser. Pedido do Douglas,
   * depois de ver o resultado ficar
   * "pixelado"/com cara de jogo mesmo depois de várias rodadas tentando
   * imitar um design moderno: "nao tem como ele ficar como as coisas de
   * fora? afinal ele e um balao com botao" -- Graphics/WebGL desenha em
   * pixel bruto (sem anti-aliasing suave, sem desfoque de verdade,
   * sujeito a artefato de triangulação em gradiente, ver histórico
   * dessa função antes dela sumir), então SEMPRE ia parecer "do jogo";
   * um <div> de CSS de verdade por cima resolve isso de vez -- a
   * responsabilidade do Phaser vira só "onde" (mundo -> tela), a
   * aparência em si (cor/blur/sombra/fonte) é 100% CSS do lado de fora.
   */
  worldToCameraPoint(worldX: number, worldY: number): { x: number; y: number } {
    const cam = this.cameras.main;
    const view = cam.worldView;
    return {
      x: cam.x + ((worldX - view.x) / view.width) * cam.width,
      y: cam.y + ((worldY - view.y) / view.height) * cam.height,
    };
  }

  /**
   * Confirmação do CEO antes de destituir a mesa de outra pessoa (ver
   * updateAreaHoverLabels -- disparado pelo clique na mesa, não por
   * entrar andando) -- pedido do Douglas: "somente o CEO pode destituir
   * mesa de fulano". Sempre com confirmação (nunca direto no clique):
   * tirar o espaço de alguém à força é uma ação sensível, não dá pra
   * confiar só num clique sem querer no hover da mesa. Só avisa QUEM/
   * ONDE (ver onAreaDestituirPromptChange) -- GameRoom.tsx que desenha o
   * balão em DOM de verdade. "Sim" chama confirmDestituir (protocolo
   * "force-release-area", DIFERENTE do "release-area" de soltar a
   * própria mesa -- ver comentário do campo onForceReleaseArea).
   */
  private showDestituirPrompt(areaId: string, ownerName: string) {
    const anchor = this.areaTopAnchor(areaId);
    if (!anchor) return;
    this.areaDestituirPromptAreaId = areaId;
    this.onAreaDestituirPromptChange?.({
      areaId,
      message: `Destituir mesa de ${ownerName}?`,
      x: anchor.x,
      y: anchor.y - 8,
    });
  }

  private destroyDestituirPrompt() {
    if (!this.areaDestituirPromptAreaId) return;
    this.areaDestituirPromptAreaId = null;
    this.onAreaDestituirPromptChange?.(null);
  }

  /** Chamado de fora (GameRoom.tsx) ao clicar "Sim" no balão de destituir. */
  confirmDestituir(areaId: string) {
    this.destroyDestituirPrompt();
    this.onForceReleaseArea?.(areaId);
  }

  /** Chamado de fora (GameRoom.tsx) ao clicar "Não" no balão de destituir. */
  cancelDestituir() {
    this.destroyDestituirPrompt();
  }

  /**
   * Confirmação "Assumir essa mesa?" numa área ainda sem dono -- chamada
   * de DOIS lugares (ver comentário grande de areaClaimPromptAreaId
   * acima): clique no botão/hover "Assumir mesa" (updateAreaHoverLabels)
   * E ao entrar ANDANDO na área (updateAreaDim, na transição de
   * verdade). MESMO card de DOM/CSS do destituir (AreaConfirmBalloon em
   * GameRoom.tsx) -- pedido do Douglas: "cade o CARD que a gente tinha
   * criado? em css bem bonitinho com sim e nao". Só avisa QUEM/ONDE (ver
   * onAreaClaimPromptChange); "Sim" chama confirmAreaClaim (protocolo
   * "claim-area" de sempre, ver onClaimArea).
   */
  private showAreaClaimPrompt(areaId: string) {
    const anchor = this.areaTopAnchor(areaId);
    if (!anchor) return;
    this.areaClaimPromptAreaId = areaId;
    this.onAreaClaimPromptChange?.({
      areaId,
      message: "Assumir essa mesa?",
      x: anchor.x,
      y: anchor.y - 8,
    });
  }

  private destroyAreaClaimPrompt() {
    if (!this.areaClaimPromptAreaId) return;
    this.areaClaimPromptAreaId = null;
    this.onAreaClaimPromptChange?.(null);
  }

  /** Chamado de fora (GameRoom.tsx) ao clicar "Sim" no balão de "Assumir essa mesa?". */
  confirmAreaClaim(areaId: string) {
    this.destroyAreaClaimPrompt();
    this.onClaimArea?.(areaId);
  }

  /** Chamado de fora (GameRoom.tsx) ao clicar "Não" no balão de "Assumir essa mesa?". */
  cancelAreaClaim() {
    this.destroyAreaClaimPrompt();
  }

  /**
   * Card de "quem é o dono dessa mesa" ao passar o mouse numa mesa JÁ
   * assumida (ver comentário grande de areaHoverCardAreaId lá em cima)
   * -- chamado só do pointerover da hitzone (updateAreaHoverLabels),
   * nunca ao entrar andando (isso é o véu/areaDimAreaId, coisa
   * separada). GameRoom.tsx decide o resto (foto/nome/status vêm de
   * remoteProfiles[playerId], ações de Perfil/Chamar/"posso ir aí?"/
   * abrir conversa reusam sendPoke/sendMessageTo/setProfileCard que já
   * existiam pro ProfileCard de clique).
   */
  private showAreaOwnerHoverCard(areaId: string, playerId: string) {
    const anchor = this.areaTopAnchor(areaId);
    if (!anchor) return;
    this.areaHoverCardAreaId = areaId;
    this.onAreaOwnerHoverCardChange?.({ areaId, playerId, x: anchor.x, y: anchor.y - 8 });
  }

  private destroyAreaOwnerHoverCard() {
    if (!this.areaHoverCardAreaId) return;
    this.areaHoverCardAreaId = null;
    this.onAreaOwnerHoverCardChange?.(null);
  }

  /**
   * Cria/atualiza a hitbox de clique (Phaser Zone) de cada área
   * "mesa-privada" que já tem tile pintado. Hitbox 100% INVISÍVEL --
   * nunca teve/tem NENHUM rótulo Phaser flutuando por cima (nem pílula
   * "Assumir mesa", nem "mesa de <nome>"). Clicar nela, sim, ainda faz a
   * mesma coisa de sempre, dependendo de quem é dono:
   * - SEM dono: abre a confirmação "Assumir essa mesa?" (ver
   *   showAreaClaimPrompt), que só manda onClaimArea de verdade se
   *   confirmado -- a MESMA confirmação também dispara sozinha ao entrar
   *   ANDANDO na área (ver updateAreaDim), então a hitbox aqui é só a
   *   forma de abrir isso via clique direto também.
   * - COM dono (outra pessoa): abre o card dela (onAreaOwnerClick), OU,
   *   se quem clicou é o "CEO" (dono da sala, ver isRoomOwner/
   *   setRoomOwner), oferece "destituir" em vez disso (ver
   *   showDestituirPrompt) -- pedido do Douglas: "somente o CEO pode
   *   'destituir mesa de fulano'".
   * - COM dono (EU): clicar não faz mais NADA -- pedido do Douglas: "nao
   *   quero soltar a mesa clicando nela, a mesa só solta quando apago o
   *   espaco dela". Chegou a soltar a posse direto no clique antes disso
   *   (sem confirmação nenhuma, ver histórico do arquivo) -- removido:
   *   agora só sai apagando a área de verdade (ver setAreaState em
   *   server/roomStore.js) ou via "destituir" do CEO
   *   (onForceReleaseArea).
   * Dois rótulos visuais chegaram a existir por cima dessa hitbox, cada
   * um ARRANCADO por pedido do Douglas em momentos diferentes: "mesa de
   * <nome>" (nome + bolinha de status, COM dono) foi o primeiro
   * ("cancela o balãozinho 'mesa de fulano' / ranca ele, vamos
   * estruturar ele separado do zero"); a pílula "Assumir mesa" (SEM
   * dono) foi depois, já com o card CSS novo cobrindo o mesmo papel
   * (walk-in + clique) -- pedido dele: "passando o mouse na area da
   * mesa lIVRE, o nome do espaco ta aparecendo ainda" / "nome nao, esse
   * card assumir mesa antigo ai". Áreas que sumiram da lista, ou que
   * ainda não têm nenhum tile pintado, têm sua hitbox destruída.
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
      if (this.areaHoverCardAreaId === areaId) this.destroyAreaOwnerHoverCard();
    }

    for (const areaId of activeAreaIds) {
      const tiles = tilesByArea.get(areaId)!;
      const { minCol, maxCol, minRow, maxRow } = areaTileBounds(tiles);
      // paralelogramo da área (mesma borda -0.5/+0.5 do contorno que a
      // área já teve, ver tileRangeCorners em game/iso.ts) -- a hitbox de hover em si
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

      let hitZone = this.areaHoverZones.get(areaId);
      if (!hitZone) {
        hitZone = this.add
          .zone(centerX, centerY, width, height)
          .setDepth(DEPTH_AREA_HOVER)
          .setInteractive({ cursor: "pointer" });
        hitZone.on("pointerover", () => {
          // card "quem é o dono dessa mesa" (ver showAreaOwnerHoverCard)
          // -- só faz sentido com dono ONLINE e que não seja o próprio
          // jogador local (poder de novo ligar/conversar consigo mesmo
          // não faz sentido, mesmo espírito do "não faz nada" já usado
          // pro clique na própria mesa). Sem dono (mesa livre) não tem
          // MAIS nenhum rótulo de hover (ver comentário grande da
          // função) -- esse card é só pra mesa JÁ assumida.
          if (this.editMode || this.avatarClicksLocked) return;
          const owner = this.areaOwnerByAreaId.get(areaId);
          if (owner && owner.playerId && owner.playerId !== "local") {
            this.showAreaOwnerHoverCard(areaId, owner.playerId);
          }
        });
        hitZone.on("pointerout", () => {
          if (this.areaHoverCardAreaId === areaId) this.destroyAreaOwnerHoverCard();
        });
        hitZone.on("pointerdown", () => {
          // igual ao clique de avatar: nada durante a edição, nem com o
          // card de perfil já aberto por cima (ver avatarClicksLocked).
          if (this.editMode || this.avatarClicksLocked) return;
          // qualquer clique aqui já resolve alguma ação (abrir confirmação/
          // destituir/card) -- esconde o card de hover primeiro pra não
          // ficar flutuando atrás do que abrir em seguida.
          this.destroyAreaOwnerHoverCard();
          const owner = this.areaOwnerByAreaId.get(areaId);
          // pedido do Douglas: "uma pessoa só pode assumir uma mesa por
          // espaço" -- já é dono de OUTRA área, clicar no "Assumir mesa"
          // dessa aqui não faz nada (servidor recusaria mesmo, ver
          // "claim-area-denied" em server/index.js -- localOwnsAnyArea
          // só evita mandar a mensagem à toa). Clicar de verdade abre a
          // confirmação "Assumir essa mesa?" (ver showAreaClaimPrompt) em
          // vez de mandar claim-area na hora -- pedido do Douglas depois
          // de sentir falta do card de confirmação ("cade o CARD que a
          // gente tinha criado? em css bem bonitinho com sim e nao").
          if (!owner) {
            if (!this.localOwnsAnyArea()) this.showAreaClaimPrompt(areaId);
          } else if (owner.playerId === "local") {
            // CLICANDO NA PRÓPRIA mesa: não faz mais nada -- pedido do
            // Douglas: "nao quero soltar a mesa clicando nela, a mesa só
            // solta quando apago o espaco dela". Chegou a soltar direto
            // no clique antes disso (sem confirmação, e antes disso
            // ainda com confirmação -- ver histórico do arquivo);
            // removido: só sai apagando a área de verdade ou via
            // "destituir" do CEO.
          } else if (this.isRoomOwner) {
            // CEO clicando na mesa de OUTRA pessoa: oferece "destituir"
            // em vez de abrir o card dela (que já dá pra abrir clicando
            // no BONECO dela direto, ver onAvatarClick) -- SEMPRE com
            // confirmação (showDestituirPrompt), nunca direto no clique,
            // porque é uma ação sensível (tira o espaço de alguém à
            // força). Pedido do Douglas: "somente o CEO pode 'destituir
            // mesa de fulano'".
            this.showDestituirPrompt(areaId, owner.name);
          } else if (owner.playerId) {
            // dono OFFLINE agora (posse persiste sem boneco na cena, ver
            // comentário grande de areaOwnerByAreaId) -- não tem card de
            // perfil pra abrir de ninguém que não tá na sala, então nem
            // tenta (owner.playerId null cai aqui e não faz nada,
            // clique silencioso, mesmo espírito de "não faz sentido
            // nenhuma das duas coisas" já usado acima pra própria mesa).
            this.onAreaOwnerClick?.({ playerId: owner.playerId, isLocal: false });
          }
        });
        this.areaHoverZones.set(areaId, hitZone);
      } else {
        hitZone.setPosition(centerX, centerY);
        hitZone.setSize(width, height);
      }
    }
  }

  /** Uma célula da grade de edição (ver drawEditGrid abaixo) NÃO precisa
   * do contorno adicional quando o piso pintado ali já desenha linha de
   * junta própria (piso "padrão" com plankLengthPx, ex: laminado/tábua
   * emendada, ver FloorPatternConfig em game/floor.ts) -- pedido do
   * Douglas com print mostrando uma linha pontilhada cruzando o piso de
   * tábua: "tira essas marcações de limite de tile, nos laminados".
   * Causa: essa linha de contorno é um Graphics WebGL cru
   * (strokePoints), NUNCA passou pela técnica de super-amostragem em
   * canvas offscreen que deixa a linha de junta da tábua lisa (ver
   * comentário grande no início de createFloorPatternGraphics) -- numa
   * diagonal ela sai serrilhada/com cara de pontilhado, e sobreposta à
   * própria linha de junta (que agora BATE na borda do tile, depois do
   * fix de fase acima) só poluía a textura sem acrescentar nada -- a
   * própria linha de junta já mostra onde o tile termina.
   *
   * Checava SÓ `pattern.plankLengthPx` antes -- voltou a aparecer nos
   * laminados (pedido do Douglas de novo: "as linhas de limitacao do
   * tile estao aparecendo em pisos laminados, retire") porque isso cobre
   * só o laminado "padrão" PROCEDURAL com comprimento de tábua definido,
   * não um laminado CUSTOM cadastrado pela aba "Criar Piso" (ver
   * fetchAndRegisterCustomFloor em GameRoom.tsx): lá `plank_length_px`
   * é OPCIONAL mesmo pro kind "pattern" (linha de junta contínua sem
   * comprimento de tábua nenhum é uma escolha válida), e um laminado por
   * IMAGEM (`kind` diferente de "pattern") nem tem `pattern` nenhum, só
   * `file` -- os dois casos passavam batido por esse `Boolean(...)` e
   * ficavam com o contorno riscado por cima da textura mesmo assim.
   * Categoria resolve os dois de uma vez: TODO laminado (de fábrica,
   * "padrão" sem comprimento definido, ou por imagem) cai na mesma
   * categoria "laminado" (ver FloorCategory/FLOOR_CATEGORIES no topo de
   * game/floor.ts), escolhida por ELE na hora de cadastrar -- não
   * depende de nenhum campo opcional do banco pra funcionar.
   */
  private editGridHiddenAt(col: number, row: number): boolean {
    const f = this.draftFloor.get(`${col},${row}`);
    if (!f) return false;
    const entry = floorEntryById(f.styleId);
    if (!entry) return false;
    return entry.category === "laminado" || Boolean(entry.pattern?.plankLengthPx);
  }

  /** Desenha o contorno de TODO tile colocável (mesmos limites que
   * isTileInRoom usa pro boneco) -- só visível durante o modo de edição.
   * Re-chamável (destrói o Graphics anterior e refaz do zero, mantendo
   * o visible() de antes) -- precisa ser, porque editGridHiddenAt acima
   * depende do piso JÁ PINTADO, que muda com o tempo (pintar/apagar
   * tile, ver paintFloorAt, e o piso carregado do banco, ver
   * loadSavedFloor/retryFloorSprites), então o contorno precisa ser
   * refeito toda vez que isso acontece, não só 1x na criação da cena.
   *
   * Com a ferramenta "Tamanho" armada (selectedRoomShapeTool), TAMBÉM
   * pinta uma tinta azul bem leve em cima de cada tile já pertencente à
   * sala -- achado do Douglas testando "Adicionar" ("os tiles novos nao
   * etao adicionando... fica verdinho quando passa encima mas nao
   * adiciona quando clica"): o clique tava funcionando (o tile ENTRA em
   * roomShape, ver paintRoomShapeAt), só que sem NENHUM piso pintado
   * ali ainda, o tile novo ficava visualmente IDÊNTICO ao vazio fora da
   * sala (o contorno de 1px 25% opacidade é fraco demais pra notar) --
   * parecia que nada tinha acontecido. Essa tinta só aparece enquanto a
   * aba "Tamanho" tá aberta (mesma ideia de DRAFT_AREA_TILE_ALPHA_EDITING
   * pra área -- só um guia visual de edição, não fica ligada fora
   * dela), então crescer a sala agora dá uma confirmação óbvia na hora. */
  private drawEditGrid() {
    const wasVisible = this.gridGraphics?.visible ?? false;
    this.gridGraphics?.destroy();
    const g = this.add.graphics().setDepth(EDIT_UI_DEPTH).setVisible(wasVisible);
    g.lineStyle(1, 0xffffff, 0.25);
    // itera roomShape (o Set de tiles que são a sala HOJE, ver
    // comentário grande lá em cima) em vez do antigo retângulo
    // [0,GRID_COLS]x[0,GRID_ROWS] -- desenha o contorno só onde a sala
    // de fato existe, mesmo formato livre que o resto do movimento/
    // colocação já respeita.
    for (const key of this.roomShape) {
      const [col, row] = key.split(",").map(Number);
      if (this.editGridHiddenAt(col, row)) continue;
      const { x, y } = tileToWorld(col, row);
      if (this.selectedRoomShapeTool) {
        g.fillStyle(0x60a5fa, 0.16);
        g.fillPoints(tileDiamondCorners(x, y), true);
      }
      g.strokePoints(tileDiamondCorners(x, y), true);
    }
    this.gridGraphics = g;
  }

  /** Item (fixo OU rascunho) já ocupando esse tile, se houver -- editor não deixa colocar móvel comum em cima de outro móvel comum no mesmo tile (evita duas sprites sobrepostas confundindo o preview). Olha o FOOTPRINT INTEIRO de cada móvel (ver furnitureFootprintTiles), não só a âncora -- mesmo ajuste já feito em stackBaseModelAt acima ("o item de sobrepor, tem que acompanhar os tiles que o item bloqueia, nao so na insersao"): uma mesa 3x1 tem que bloquear/aceitar Sobrepor nos 3 tiles dela, não só no tile-âncora. EXCEÇÃO (`allowStackOn`, ver FurnitureModelDef.stackable em furniture.ts, checkbox "Sobrepor" no Editor de Itens): quando true, ignora QUALQUER item já ocupando ali -- notebook em cima da mesa, ou um SEGUNDO item "Sobrepor" (ex: caneca) na mesma mesa, ao lado do notebook. Antes um 2º "Sobrepor" no mesmo tile ficava bloqueado (só valia um por vez, pensando em evitar torre de 3+) -- pedido do Douglas: "agora, libera por mais de um item encima". Sem a flag marcada nesse modelo (allowStackOn=false, padrão) o tile ocupado bloqueia igual sempre bloqueou -- pedido do Douglas: "o item que eu não tickar a opção de sobrepor, continua igual tá agora". */
  private anyFurnitureAt(col: number, row: number, allowStackOn = false): boolean {
    const blocks = (f: FurnitureDef) => {
      if (!furnitureFootprintTiles(f).some((t) => t.col === col && t.row === row)) return false;
      return !allowStackOn; // "Sobrepor" nunca bloqueia -- vale vários itens (ou um em cima de outro) no mesmo tile
    };
    if (ROOM_FURNITURE.some(blocks)) return true;
    for (const f of this.draftFurniture.values()) {
      if (blocks(f)) return true;
    }
    return false;
  }

  /** Esse tile trava a passagem por causa de algum móvel (fixo OU colocado pelo editor, ver FURNITURE_BLOCKS_MOVEMENT em furniture.ts) OU de uma parede "Centro do tile" (ver WallSide em game/wall.ts) OU de uma porta FECHADA na aresta entre `fromCol,fromRow` e `col,row` -- usado em startStep()/computeWalkPath(). blockingFurnitureAt (furniture.ts) só sabe de ROOM_FURNITURE; aqui completa com draftFurniture, pra um item colocado pelo editor (ex: nova divisória de vidro) travar passagem na hora, sem precisar de restart.
   *
   * `fromCol`/`fromRow` são OPCIONAIS -- diferente da parede "Centro do
   * tile" (bloqueia o TILE em si, não importa de que lado alguém vem), uma
   * porta bloqueia uma TRAVESSIA específica (ver doorEdgeBetween em
   * game/door.ts): só faz sentido checar quando sabemos de qual tile
   * vizinho o passo estaria vindo. Os 2 únicos chamadores que têm essa
   * intenção de verdade (startStep, computeWalkPath) sempre passam os
   * dois; handleRoomPointerDown chama sem eles só pra saber se o TILE
   * clicado é válido (sem travessia nenhuma em mente ainda, o caminho de
   * verdade quem calcula é computeWalkPath logo depois). */
  private isMovementBlockedAt(col: number, row: number, fromCol?: number, fromRow?: number): boolean {
    if (blockingFurnitureAt(col, row)) return true;
    // mesma regra de blockingFurnitureAt (furniture.ts) pro item RASCUNHO
    // (colocado agora no editor, sem restart) -- âncora só trava se a
    // categoria travar, tile de ASSENTO extra (ver FurnitureModelDef.
    // extraSeats) nunca trava, resto do footprint (ver
    // furnitureFootprintTiles) trava sempre.
    for (const f of this.draftFurniture.values()) {
      if (f.col === col && f.row === row) {
        if (furnitureBlocksMovement(f.type)) return true;
        continue;
      }
      if (furnitureExtraSeats(f).some((s) => f.col + s.dCol === col && f.row + s.dRow === row)) continue;
      if (furnitureFootprintTiles(f).some((t) => t.col === col && t.row === row)) return true;
    }
    // parede "Centro do tile" -- pedido do Douglas: "no centro do tile,
    // ela tem que bloquear o caminhar dai, no canto nao bloqueia" -- só
    // essa variante trava (colPlus/rowPlus, "no canto", continuam
    // decorativas/atravessáveis, comportamento de sempre), nas 2
    // orientações possíveis ("center"/"centerRow", ver WallSide em
    // game/wall.ts). draftWall guarda tanto a parede já salva
    // (loadSavedWall) quanto a recém pintada agora no editor
    // (paintWallAt), então uma única checagem aqui já cobre os dois
    // casos, sem precisar de restart.
    if (this.draftWall.has(wallSegmentId(col, row, "center"))) return true;
    if (this.draftWall.has(wallSegmentId(col, row, "centerRow"))) return true;
    // porta FECHADA na aresta cruzada -- ver comentário grande acima
    // sobre fromCol/fromRow serem opcionais.
    if (fromCol !== undefined && fromRow !== undefined) {
      const edge = doorEdgeBetween(fromCol, fromRow, col, row);
      if (edge) {
        const doorKey = doorSegmentId(edge.col, edge.row, edge.side);
        if (this.draftDoor.has(doorKey) && this.doorOpenState.get(doorKey) !== true) return true;
      }
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
        if (!this.isTileInRoom(nc, nr)) continue;
        const k = key(nc, nr);
        if (visited.has(k) || this.isMovementBlockedAt(nc, nr, cur.col, cur.row)) continue;
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
    const inBounds = this.isTileInRoom(col, row);
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
    // clicar numa porta que o jogador local é DONO da área guardada por
    // ela (ver doorGuardedAreaId) alterna travar/destravar na hora --
    // mesmo esquema de clicar na PRÓPRIA mesa-privada já feito
    // (owner.playerId === "local", ver o listener "pointerdown" da
    // hitZone de área/comentário grande de areaOwnerByAreaId) -- pedido
    // do Douglas: "o dono da area em
    // questao, pode bloquear ela, fechar". Só INTERCEPTA o clique (não
    // anda pra lá) nesse caso; porta sem área, ou guardando área de
    // OUTRO dono, cai no comportamento normal de clique-pra-andar logo
    // abaixo (like clicar em qualquer tile perto de uma porta aberta).
    const doorSeg = this.doorSegmentAtPointer(pointer);
    if (doorSeg) {
      const guardedAreaId = this.doorGuardedAreaId(doorSeg.col, doorSeg.row, doorSeg.side);
      const owner = guardedAreaId ? this.areaOwnerByAreaId.get(guardedAreaId) : undefined;
      if (owner?.playerId === "local") {
        const doorKey = doorSegmentId(doorSeg.col, doorSeg.row, doorSeg.side);
        if (this.doorLocked.has(doorKey)) this.onUnlockDoor?.(doorSeg.col, doorSeg.row, doorSeg.side);
        else this.onLockDoor?.(doorSeg.col, doorSeg.row, doorSeg.side);
        return;
      }
    }
    const { col: targetCol, row: targetRow } = worldToTile(pointer.worldX, pointer.worldY);
    const inBounds = this.isTileInRoom(targetCol, targetRow);
    if (!inBounds || this.isMovementBlockedAt(targetCol, targetRow)) {
      this.walkQueue = [];
      this.lastRoomClickAt = 0;
      return;
    }

    // exige DOIS cliques no mesmo tile (não um só) pra confirmar o andar
    // -- ver comentário grande de lastRoomClickAt acima. Um clique
    // isolado só "arma" a intenção (guarda quando/onde); sem um segundo
    // clique aqui perto (ROOM_DOUBLE_CLICK_MS) e no MESMO tile, sai sem
    // mexer no walkQueue -- é exatamente isso que faz um clique único
    // pra começar a arrastar a câmera nunca mais disparar o andar.
    const ROOM_DOUBLE_CLICK_MS = 400;
    const now = this.time.now;
    const isSecondClick =
      now - this.lastRoomClickAt <= ROOM_DOUBLE_CLICK_MS &&
      this.lastRoomClickCol === targetCol &&
      this.lastRoomClickRow === targetRow;
    if (!isSecondClick) {
      this.lastRoomClickAt = now;
      this.lastRoomClickCol = targetCol;
      this.lastRoomClickRow = targetRow;
      return;
    }
    // consome o clique -- um 3º clique logo em seguida precisa contar
    // como um NOVO primeiro clique, não como "2º" de novo (senão viraria
    // clique único disfarçado, o oposto do pedido).
    this.lastRoomClickAt = 0;

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

    // ferramenta de parede armada: checagem/desenho PRÓPRIOS, ANTES do
    // gate de "inBounds" genérico logo abaixo (pensado pra tile de
    // móvel) -- uma aresta na BORDA do mapa (pedido do Douglas: "pode
    // estar na borda também") tem col/row FORA desse intervalo de
    // propósito (ver isWallEdgeInBounds), e esse gate rejeitaria ela.
    // Em vez de destacar o TILE inteiro (como as outras ferramentas
    // fazem), destaca a ARESTA mais perto do cursor (ver nearestWallEdge
    // em game/wall.ts) -- o "tile verde" do desenho de referência do
    // Douglas, só que uma linha em vez de um losango, já que a unidade
    // aqui é a borda entre 2 tiles. Arrasto pinta cada aresta nova que o
    // cursor aponta (sem preencher "buracos" via Bresenham como o piso
    // faz -- parede costuma ser colocada com mais cuidado, segmento a
    // segmento, então não valeu a pena pela complexidade extra de uma
    // linha em espaço de aresta).
    //
    // Modo "Centro do tile" (ver wallPlacementMode/setWallPlacementMode
    // acima, pedido do Douglas "eu quero tambem a opcao de inserir ela
    // no centro do tile"): sem aresta nenhuma envolvida, usa direto o
    // col/row do TILE (já calculado acima, mesmo cálculo de móvel) e o
    // mesmo gate de limite que móvel usa -- side vira "center" ou
    // "centerRow" conforme wallCenterOrientation (ver ACHADO/pedido
    // posterior do Douglas: "as paredes de centro de tile precisam
    // poder nas duas direcoes, so ta em uma").
    if (this.selectedWallTool) {
      this.hoverGraphics.setVisible(false);
      this.catalogGhostSprite?.setVisible(false);
      if (this.wallPlacementMode === "center") {
        const inTileBounds = this.isTileInRoom(col, row);
        if (!inTileBounds) {
          this.wallHoverGraphics?.setVisible(false);
          return;
        }
        const orientation = this.wallCenterOrientation;
        const { a, b } = wallEdgeFloorPoints(col, row, orientation);
        this.wallHoverGraphics?.clear().lineStyle(6, 0x4ade80, 0.9).lineBetween(a.x, a.y, b.x, b.y).setVisible(true);
        if (this.isPaintingWall && pointer.isDown) {
          const key = wallSegmentId(col, row, orientation);
          if (key !== this.lastPaintedWallKey) {
            this.lastPaintedWallKey = key;
            this.paintWallAt(col, row, orientation);
          }
        }
        return;
      }
      const edge = nearestWallEdge(pointer.worldX, pointer.worldY, GRID_ORIGIN_X, GRID_ORIGIN_Y);
      if (!this.isWallEdgeInBounds(edge)) {
        this.wallHoverGraphics?.setVisible(false);
        return;
      }
      const { a, b } = wallEdgeFloorPoints(edge.col, edge.row, edge.side);
      this.wallHoverGraphics
        ?.clear()
        .lineStyle(6, 0x4ade80, 0.9)
        .lineBetween(a.x, a.y, b.x, b.y)
        .setVisible(true);
      if (this.isPaintingWall && pointer.isDown) {
        const key = wallSegmentId(edge.col, edge.row, edge.side);
        if (key !== this.lastPaintedWallKey) {
          this.lastPaintedWallKey = key;
          this.paintWallAt(edge.col, edge.row, edge.side);
        }
      }
      return;
    }

    // ferramenta de porta armada: MESMA lógica do bloco de parede acima
    // (porta só mora em aresta "de borda" mesmo, ver DoorSide em
    // game/door.ts -- sem o modo "Centro do tile" que só faz sentido pra
    // parede/pilastra), reaproveitando o mesmo wallHoverGraphics de
    // destaque (só uma ferramenta de aresta ativa por vez).
    if (this.selectedDoorTool) {
      this.hoverGraphics.setVisible(false);
      this.catalogGhostSprite?.setVisible(false);
      const rawEdge = nearestWallEdge(pointer.worldX, pointer.worldY, GRID_ORIGIN_X, GRID_ORIGIN_Y);
      if (!this.isWallEdgeInBounds(rawEdge)) {
        this.wallHoverGraphics?.setVisible(false);
        return;
      }
      const edge = { col: rawEdge.col, row: rawEdge.row, side: this.toDoorSide(rawEdge.side) };
      const { a, b } = wallEdgeFloorPoints(edge.col, edge.row, edge.side);
      this.wallHoverGraphics
        ?.clear()
        .lineStyle(6, 0x4ade80, 0.9)
        .lineBetween(a.x, a.y, b.x, b.y)
        .setVisible(true);
      if (this.isPaintingDoor && pointer.isDown) {
        const key = doorSegmentId(edge.col, edge.row, edge.side);
        if (key !== this.lastPaintedDoorKey) {
          this.lastPaintedDoorKey = key;
          this.paintDoorAt(edge.col, edge.row, edge.side);
        }
      }
      return;
    }

    // ferramenta "Tamanho" armada (formato livre da sala, ver
    // selectRoomShapeTool) -- checagem/desenho PRÓPRIOS, ANTES do gate
    // de "inBounds" genérico logo abaixo (mesma ideia da parede acima):
    // ao contrário de TODAS as outras ferramentas, "Adicionar" PRECISA
    // aceitar hover num tile que ainda não é da sala (é assim que ela
    // cresce, ver roomShape/paintRoomShapeAt lá em cima) -- esse gate
    // (pensado pra só aceitar tile que já é sala) rejeitaria bem o caso
    // de uso principal dela. Verde = clique funcionaria; vermelho =
    // clique não faz nada (tile já é da sala ao "Adicionar", ou tile
    // fora da sala ao "Apagar", ou -- só pro "Adicionar" -- um tile sem
    // NENHUM vizinho já na sala, o que viraria uma ilha solta sem
    // caminho a pé até o resto).
    //
    // Arrasto (pedido do Douglas: "tem como adicionar arrastando?
    // clicando de um em um leva mt tempo kkk") -- igual ao piso/área
    // (paintFloorLine/paintAreaLine): enquanto o botão continuar
    // pressionado e o cursor entrar num tile novo, aplica a ferramenta
    // em CADA tile do caminho até lá (dragRoomShapeLine), não só onde o
    // cursor tá agora -- sem isso um arrasto rápido "pularia" tiles
    // entre um evento de pointermove e outro, deixando buracos.
    if (this.selectedRoomShapeTool) {
      this.wallHoverGraphics?.setVisible(false);
      this.catalogGhostSprite?.setVisible(false);
      const already = this.isTileInRoom(col, row);
      const valid = this.selectedRoomShapeTool === "add" ? !already && this.roomNeighbors(col, row).length > 0 : already;
      const { x, y } = tileToWorld(col, row);
      this.hoverGraphics
        .clear()
        .fillStyle(valid ? EDIT_HOVER_COLOR_FREE : EDIT_HOVER_COLOR_OCCUPIED, 0.35)
        .fillPoints(tileDiamondCorners(x, y), true)
        .setVisible(true);
      if (this.isPaintingRoomShape && pointer.isDown) {
        const key = this.roomTileKey(col, row);
        if (key !== this.lastPaintedRoomShapeKey) {
          const [lastCol, lastRow] = this.lastPaintedRoomShapeKey
            ? this.lastPaintedRoomShapeKey.split(",").map(Number)
            : [col, row];
          this.lastPaintedRoomShapeKey = key;
          this.dragRoomShapeLine(lastCol, lastRow, col, row);
        }
      }
      return;
    }
    this.wallHoverGraphics?.setVisible(false);

    const inBounds = this.isTileInRoom(col, row);
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

    // mesmo modelId da entrada selecionada pro catálogo (ver
    // handleEditPointerDown mais abaixo) -- hover tem que prever o MESMO
    // resultado do clique, senão o preview mostraria vermelho (ocupado)
    // num tile que na verdade aceita um item "Sobrepor" (notebook em
    // cima da mesa). "Ocupado" (móvel já em cima) só existe de verdade
    // pra ferramenta de COLOCAR MÓVEL (catálogo) -- ferramenta de
    // área/piso pinta por baixo de QUALQUER móvel numa boa (ver
    // paintAreaAt/paintFloorAt, nenhuma das duas olha draftFurniture/
    // ROOM_FURNITURE). Achado com o Douglas ("nao ta me deixando
    // selecionar tiles que tem mobi, ele da uma bugada"): antes disso o
    // hover calculava `occupied` pelo mesmo anyFurnitureAt de SEMPRE,
    // mesmo com a ferramenta de área/piso armada (não só a de
    // colocar/catálogo) -- o tile ficava VERMELHO (parecendo bloqueado)
    // em cima de qualquer móvel mesmo pintando a área por baixo dele sem
    // problema nenhum, dando a impressão de que o clique não tava
    // funcionando ali.
    const hoverEntry = this.selectedCatalogEntry;
    const hoverModel = hoverEntry?.modelId ? furnitureModelById(hoverEntry.modelId) : undefined;
    const occupied =
      this.selectedAreaTool || this.selectedFloorTool
        ? false
        : this.anyFurnitureAt(col, row, hoverModel?.stackable === true);
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
      // mesma altura que o item ganharia DE VERDADE se clicado aqui (ver
      // stackBaseModelAt/stackSurfaceOffsetYFor) -- sem isso o fantasma
      // ficava no chão enquanto passeava por cima de uma mesa com
      // "Sobrepor", só subindo de repente depois do clique. ghostBase
      // (instância de verdade, não só o model) também dá o tile de
      // PROFUNDIDADE certo (ver depthReferenceTile/stackBaseFurnitureAt
      // acima, achado "notebook so ficou pra tras/na camada") -- sem
      // isso o fantasma já mostrava a altura certa, mas continuava
      // desenhado ATRÁS da base nesse preview também.
      const ghostBase = hoverModel?.stackable ? this.stackBaseFurnitureAt(col, row) : undefined;
      const ghostBaseModel = ghostBase?.modelId ? furnitureModelById(ghostBase.modelId) : undefined;
      const ghostStackOffsetY = ghostBaseModel?.stackSurfaceOffsetY ?? 0;
      const ghostDepthTile = ghostBase ? furnitureDepthTile(ghostBase) : { col, row };
      this.catalogGhostSprite.setPosition(x, y + ghostStackOffsetY);
      this.catalogGhostSprite.setDepth(
        furnitureDepthForTile(ghostDepthTile.col, ghostDepthTile.row) + (ghostStackOffsetY !== 0 ? DEPTH_STACK_ON_TOP : 0)
      );
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
    // ferramenta de parede/porta NÃO usa esse gate -- as duas moram numa
    // ARESTA, não num tile (ver isWallEdgeInBounds logo abaixo, que faz a
    // checagem própria delas); a ferramenta "Tamanho" (selectedRoomShapeTool)
    // também não usa -- ela PRECISA aceitar clique fora da sala de hoje
    // (é assim que "Adicionar" funciona, ver paintRoomShapeAt); as
    // outras ferramentas continuam usando esse aqui.
    //
    // BUG achado com o Douglas ("continua nao adicionando mobis nas
    // areas novas, tudo que e de piso... so parede que ta entrando"):
    // esse gate ainda comparava col/row contra o retângulo ESTÁTICO
    // antigo (GRID_COLS/GRID_ROWS), sobrevivente da conversão pra
    // formato livre (ver fa4bf7b) -- todo o RESTO do arquivo (hover,
    // movimento, BFS) já tinha trocado pra isTileInRoom (o Set
    // roomShape de verdade), MENOS esse aqui. Resultado: piso/área/
    // móvel clicavam fora do retângulo 13x8 original e não faziam
    // nada, MESMO num tile que "Adicionar" (Tamanho) já tinha colocado
    // de verdade dentro da sala -- só parede/porta funcionavam lá
    // (bypassavam esse gate por inteiro) e "Tamanho" (mesma razão).
    // Fix: usa isTileInRoom, igual todo o resto.
    if (
      !this.selectedWallTool &&
      !this.selectedDoorTool &&
      !this.selectedRoomShapeTool &&
      !this.isTileInRoom(col, row)
    )
      return;

    // ferramenta "Tamanho" armada (ver selectRoomShapeTool) -- "add"
    // tenta pintar um tile novo, "erase" tenta apagar um já pintado (os
    // dois são no-op silencioso ou mostram um aviso via
    // onRoomShapeEraseBlocked, ver applyRoomShapeTool/paintRoomShapeAt/
    // eraseRoomShapeAt). Fora daqui em diante o clique é sempre num
    // TILE já validado como parte da sala (ver gate acima), diferente
    // de add, que pode mirar qualquer coordenada.
    // isPaintingRoomShape/lastPaintedRoomShapeKey armam o ARRASTO (ver
    // handleEditPointerMove/dragRoomShapeLine) -- pedido do Douglas
    // ("tem como adicionar arrastando? clicando de um em um leva mt
    // tempo") -- mesmo esquema de isPaintingFloor pro piso.
    if (this.selectedRoomShapeTool) {
      this.isPaintingRoomShape = true;
      this.lastPaintedRoomShapeKey = this.roomTileKey(col, row);
      this.roomShapeDragWarned = false;
      this.applyRoomShapeTool(col, row);
      return;
    }

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
        // "Sobrepor" (ver anyFurnitureAt acima) deixa mover pra cima de
        // outro item de base já ancorado ali, mesma exceção do clique de
        // colocar novo (mais abaixo nesse handler).
        const movingModel = moving.modelId ? furnitureModelById(moving.modelId) : undefined;
        if (this.anyFurnitureAt(col, row, movingModel?.stackable === true)) return; // tile de destino ocupado, ignora o clique
        moving.col = col;
        moving.row = row;
        const sprite = this.draftSprites.get(this.movingFurnitureId);
        if (sprite) {
          const pos = furnitureWorldPos(moving);
          const movingDepthTile = this.depthReferenceTile(moving);
          // recalcula a altura herdada da base no tile NOVO (ver
          // stackSurfaceOffsetYFor) -- mover um item "Sobrepor" pra cima
          // de mesa diferente (ou pra um tile sem base nenhuma) precisa
          // atualizar a altura na hora, sem esperar F5.
          const stackOffsetY = this.stackSurfaceOffsetYFor(moving);
          sprite.setPosition(pos.x, pos.y + stackOffsetY);
          sprite.setDepth(
            moving.flat
              ? DEPTH_FLAT_FURNITURE
              : furnitureDepthForTile(movingDepthTile.col, movingDepthTile.row) + (stackOffsetY !== 0 ? DEPTH_STACK_ON_TOP : 0)
          );
          sprite.clearTint();
        }
        // se o boneco local tava sentado NESSE item, acompanha ele pro
        // tile novo NA HORA -- sem isso ficaria "flutuando" pra trás,
        // longe do móvel que acabou de mudar de lugar (pedido do
        // Douglas: a posição do boneco, na interação de sentar, tem que
        // seguir o ITEM, não ficar presa a um ponto fixo do espaço).
        if (this.localActivity === "sentado" && this.seatedAt?.id === this.movingFurnitureId) {
          this.applySeatVisualPosition(moving, this.seatedAtOffset.dCol, this.seatedAtOffset.dRow);
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

    // ferramenta de parede armada: mesma ideia da ferramenta de piso
    // acima, só que a "unidade" pintada é a ARESTA mais perto do cursor
    // (ver nearestWallEdge), não o tile inteiro que col/row já dão --
    // por isso recalcula a partir de pointer.worldX/worldY em vez de
    // usar col/row direto. Checagem de limite PRÓPRIA (ver
    // isWallEdgeInBounds) -- pedido do Douglas: "pode estar na borda
    // também" -- a aresta mais externa do mapa (col -1 ou GRID_COLS,
    // row -1 ou GRID_ROWS) representa exatamente a BORDA da sala, um
    // valor FORA do intervalo [0,GRID_COLS]/[0,GRID_ROWS] que o gate lá
    // em cima (pensado pra tile de móvel, não aresta) rejeitaria.
    //
    // Modo "Centro do tile" (ver handleEditPointerMove acima pro mesmo
    // ramo no hover): usa col/row de tile direto, side "center"/
    // "centerRow" conforme wallCenterOrientation.
    if (this.selectedWallTool) {
      if (this.wallPlacementMode === "center") {
        const inTileBounds = this.isTileInRoom(col, row);
        if (!inTileBounds) return;
        const orientation = this.wallCenterOrientation;
        this.isPaintingWall = true;
        this.lastPaintedWallKey = wallSegmentId(col, row, orientation);
        this.paintWallAt(col, row, orientation);
        return;
      }
      const edge = nearestWallEdge(pointer.worldX, pointer.worldY, GRID_ORIGIN_X, GRID_ORIGIN_Y);
      if (!this.isWallEdgeInBounds(edge)) return;
      this.isPaintingWall = true;
      this.lastPaintedWallKey = wallSegmentId(edge.col, edge.row, edge.side);
      this.paintWallAt(edge.col, edge.row, edge.side);
      return;
    }

    // ferramenta de porta armada: mesma ideia do bloco de parede acima
    // (sem modo "Centro do tile" -- ver bloco espelhado em
    // handleEditPointerMove).
    if (this.selectedDoorTool) {
      const rawEdge = nearestWallEdge(pointer.worldX, pointer.worldY, GRID_ORIGIN_X, GRID_ORIGIN_Y);
      if (!this.isWallEdgeInBounds(rawEdge)) return;
      const edge = { col: rawEdge.col, row: rawEdge.row, side: this.toDoorSide(rawEdge.side) };
      this.isPaintingDoor = true;
      this.lastPaintedDoorKey = doorSegmentId(edge.col, edge.row, edge.side);
      this.paintDoorAt(edge.col, edge.row, edge.side);
      return;
    }

    const entry = this.selectedCatalogEntry;
    if (!entry) return;
    // "Sobrepor" (ver anyFurnitureAt acima) -- item do catálogo marcado
    // assim no Editor de Itens pode ser colocado em cima de outra base
    // já ancorada no mesmo tile (notebook em cima da mesa).
    const entryModel = entry.modelId ? furnitureModelById(entry.modelId) : undefined;
    if (this.anyFurnitureAt(col, row, entryModel?.stackable === true)) return;

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
