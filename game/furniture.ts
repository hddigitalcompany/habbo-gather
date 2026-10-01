import { tileToWorld, Direction, ISO_TILE_HEIGHT } from "./grid";

/**
 * Facing de MÓVEL -- superset de Direction (acima, o mesmo tipo usado
 * pro ANDAR do avatar, ver walkQueue/playWalk em MainScene.ts) com 2
 * posições EXTRAS só pra parede/divisória: "cornerTop"/"cornerBottom"
 * ("quina de cima"/"quina de baixo", pedido do Douglas: "nas paredes
 * adicione mais duas posicoes, quina de cima, quina de baixo" -- depois
 * de já ter "quina esquerda"/"quina direita", que reaproveitam left/up
 * de Direction, ver WALL_DIRECTION_FIELDS em ItemEditor.tsx).
 *
 * Fica SEPARADO de Direction de propósito, em vez de simplesmente
 * adicionar as 2 quinas nele: Direction também é o tipo do walkQueue/
 * playWalk do avatar (MainScene.ts) -- o boneco só tem sprite/animação
 * pras 4 direções de sempre, então widening Direction quebraria (ou, na
 * melhor hipótese, deixaria "válidos" mas sem sentido) o andar do
 * avatar. FurnitureFacing entra só onde já era Direction MAS falando de
 * MÓVEL colocado/catálogo (FurnitureDef.facing, FurnitureCatalogEntry.facing,
 * FurnitureModelColorOption.art e os 3 overrides por direção
 * logo abaixo) -- nunca no que é do avatar.
 */
export type FurnitureFacing = Direction | "cornerTop" | "cornerBottom";

/**
 * Móveis da sala, posicionados em coordenada de TILE (não pixel) pra
 * ficarem sempre alinhados com a grade que o avatar anda. Cada item tem
 * um "tipo" (a peça de mobília) e uma "facing" (pra que lado ela olha na
 * sala) -- o avatar senta sozinho quando PARA totalmente em cima do tile
 * do móvel (não é mais por raio/proximidade enquanto anda perto).
 *
 * Cada tipo de móvel tem uma imagem POR DIREÇÃO (ver FURNITURE_ART),
 * igual ao boneco -- assim a poltrona (e os próximos móveis) aparecem
 * viradas pro lado certo em vez de usar sempre a mesma arte de frente.
 */

/**
 * "sofa"/"mesa"/"planta"/"computador" começam sem NENHUM modelo
 * cadastrado (mesma situação que "poltrona" tinha antes dos modelos
 * existirem) -- servem só pra dar um "tipo" pra onde um item CUSTOM
 * dessa categoria (ver CUSTOM_ITEM_CATEGORY_TYPE/registerCustomFurnitureModels
 * abaixo, cadastrado pelo Editor de Itens) possa se pendurar. Sem isso,
 * as categorias vazias em FURNITURE_CATEGORIES não têm em que tipo
 * um item novo entraria.
 */
export type FurnitureType = "poltrona" | "vidro" | "sofa" | "mesa" | "planta" | "computador";

export interface FurnitureDef {
  id: string;
  type: FurnitureType;
  /** posição em tiles (não pixel) -- ver game/grid.ts */
  col: number;
  row: number;
  /** direção que o avatar (e a arte do móvel) fica "olhando" -- ver
   * FurnitureFacing (acima) pro porquê desse tipo não ser Direction
   * puro: item de parede pode usar as 2 quinas extras (cornerTop/
   * cornerBottom), que não existem pro avatar. */
  facing: FurnitureFacing;
  /** qual MODELO desse tipo (ver FurnitureModelDef/FURNITURE_MODELS
   * abaixo) -- só tipos com modelo cadastrado usam isso (hoje só
   * "poltrona", ver Gamer/Poltrona Lecce). undefined = design único do
   * tipo (ver FURNITURE_ART), caso do "vidro" e dos itens antigos de
   * ROOM_FURNITURE colocados antes dos modelos existirem. */
  modelId?: string;
  /** cor escolhida dentro do modelo (ver FurnitureModelDef.colors) --
   * só faz sentido junto com modelId. Sem valor, cai na primeira cor
   * cadastrada do modelo (ver resolveFurnitureArt). */
  colorId?: string;
  /** ajuste fino (px) pra onde o avatar aparece sentado, em relação ao
   * ponto-âncora do móvel (que é onde o pé/base do móvel toca o chão).
   * Negativo = avatar sobe (senta na altura do assento). Nos itens
   * antigos (sem modelId) esse valor é usado direto; nos itens com
   * modelo, serve só de PADRÃO até alguém ajustar fino no "Assento" do
   * editor de espaço, que persiste por MODELO+direção (ver
   * FurnitureSeatOffsetsMap/resolveSeatOffset), não por instância. */
  seatOffsetY?: number;
  /** mesma ideia, no eixo horizontal -- usado principalmente nas poses
   * de lado, pra jogar o boneco um pouco mais "pra frente" (na direção
   * que ele tá olhando) dentro do assento em vez de ficar centralizado
   * exatamente em cima do pé do móvel. */
  seatOffsetX?: number;
  /** exceção à regra de profundidade por fileira (ver DEPTH_* em
   * MainScene.ts): móveis "flat" -- sem altura de verdade, tipo um
   * tapete -- não fazem sentido o boneco "passar por trás" deles, então
   * ficam sempre atrás de tudo, feito decoração colada no chão. Não usar
   * pra móveis com overflow de altura (poltrona etc.) -- esses usam a
   * profundidade dinâmica normal. */
  flat?: boolean;
  /** móvel "de vidro" -- desenhado com transparência (ver GLASS_ALPHA em
   * MainScene.ts), pra quem ficar por trás dele (boneco, outro móvel)
   * continuar visível através, em vez de totalmente escondido. */
  transparent?: boolean;
  /** ajuste fino (px) da posição-âncora do móvel (onde a arte "pousa",
   * ver furnitureWorldPos) -- por padrão ela fica na BORDA DE BAIXO do
   * tile (ancorada embaixo, ver furnitureWorldPos). Negativo SOBE o
   * móvel em relação a essa base; só reposiciona, não muda o tamanho da
   * arte. Não afeta o tile lógico (col/row) usado pra grade, travamento
   * de passagem ou a fronteira de profundidade (ver
   * furnitureDepthForRow em MainScene.ts, que usa row direto, não essa
   * posição visual). */
  baseOffsetY?: number;
}

/**
 * Arte de cada tipo de móvel, um arquivo por direção, em
 * `public/assets/`. Se uma direção não tiver arquivo, cai pra "down"
 * como fallback (ver furnitureArtFile).
 */
export const FURNITURE_ART: Record<FurnitureType, Partial<Record<FurnitureFacing, string>>> = {
  poltrona: {
    down: "poltrona_frente.png",
    left: "poltrona_lado_esq.png",
    right: "poltrona_lado_dir.png",
    up: "poltrona_costas.png",
  },
  // "vidro" = categoria DIVISÓRIA DE VIDRO -- painel decorativo que
  // também é uma parede de verdade (ver FURNITURE_BLOCKS_MOVEMENT). Não
  // senta, não tem direção (mesma arte pras 4, cai sempre no fallback
  // "down", ver furnitureArtFile). 2 tiles de altura exatos, largura sem
  // vazar o tile.
  vidro: {
    down: "vidro.png",
  },
  // sem design único -- itens dessas categorias só existem via MODELO
  // (ver FURNITURE_MODELS/registerCustomFurnitureModels), seja gerado
  // da pasta local (ainda nenhum) ou custom (Editor de Itens). Vazio
  // aqui só satisfaz o Record<FurnitureType, ...> -- nunca é lido de
  // verdade (resolveFurnitureArt só cai nisso quando falta modelId, e
  // item dessas categorias sempre tem um).
  sofa: {},
  mesa: {},
  planta: {},
  computador: {},
};

/**
 * Variação de COR de uma peça de móvel -- mesma ideia do `colors` de
 * cabelo/barba (ver ColorOption em game/customization.ts): NÃO é um
 * tint/filtro aplicado em cima da mesma arte, é uma arte DIFERENTE por
 * cor (por isso `art` tem o mesmo formato de FURNITURE_ART[tipo], uma
 * imagem por direção). Testamos uma tintura simples em cima da arte
 * atual da poltrona e não dava pra ver direito (ela é bem escura/preta
 * -- tingir um preto continua preto), então o combinado com o Douglas
 * foi: estrutura pronta agora, arte de cada cor sobe depois (mesmo
 * padrão já usado pro piso e pras categorias de móvel ainda vazias).
 */
export interface FurnitureColorOption {
  id: string;
  label: string;
  art: Partial<Record<FurnitureFacing, string>>;
}

/**
 * Cores cadastradas por TIPO de móvel (não por combinação tipo+direção
 * -- uma cor cobre as 4 direções de uma vez, ver `art` acima). Vazio
 * pra todo mundo por enquanto -- ver comentário de FurnitureColorOption.
 * Quando subir arte de cor de verdade aqui, falta só ligar a escolha de
 * cor no preview (EditPanel, GameRoom.tsx) na hora de colocar o item
 * (hoje o preview já mostra "Em breve" no lugar da grade de cores).
 */
export const FURNITURE_COLORS: Partial<Record<FurnitureType, FurnitureColorOption[]>> = {};

/** Nome do arquivo em public/assets pra uma COR+direção (com fallback pra "down"), mesma lógica de furnitureArtFile. */
export function furnitureColorArtFile(color: FurnitureColorOption, facing: FurnitureFacing): string | null {
  return color.art[facing] ?? color.art.down ?? null;
}

/**
 * MODELO dentro de um tipo de móvel -- diferente de FurnitureColorOption
 * acima (que é só uma variação de cor de um design ÚNICO): um modelo é
 * um DESENHO/FORMATO diferente da peça (ex: poltrona "Gamer" x "Poltrona
 * Lecce" -- formatos bem diferentes, não só cor), cada um com sua
 * própria lista de cores (ver scripts/syncFurnitureAssets.mjs, pasta
 * Modelo/Cor/{frente,esquerda,direita,costas}). Hoje só "poltrona" tem
 * modelo cadastrado -- os outros tipos (vidro) continuam com design
 * único, direto em FURNITURE_ART, sem passar por aqui.
 */
export interface FurnitureModelColorOption {
  id: string;
  label: string;
  // Partial de propósito: modelo GERADO da pasta local (poltrona,
  // scripts/syncFurnitureAssets.mjs) sempre garante as 4 direções, mas
  // item CUSTOM (Editor de Itens, ver registerCustomFurnitureModels)
  // só exige "down" (frente) -- as outras 3 caem no fallback pra
  // "down" já usado em resolveFurnitureArt/furnitureModelCatalogEntries.
  // Partial<Record<FurnitureFacing,...>> em vez de Direction puro: item
  // de PAREDE (categoria divisória) pode ter arte nas 2 quinas extras
  // também (cornerTop/cornerBottom, ver FurnitureFacing acima).
  art: Partial<Record<FurnitureFacing, string>>;
}

export interface FurnitureModelDef {
  id: string;
  type: FurnitureType;
  label: string;
  colors: FurnitureModelColorOption[];
  /** true só pros modelos CUSTOM (ver registerCustomFurnitureModels
   * abaixo) -- marca que a imagem foi enviada pelo Editor de Itens
   * (upload direto do navegador, sem passar pela pasta local/
   * scripts/syncFurnitureAssets.mjs) e por isso pode vir em QUALQUER
   * resolução nativa (pedido do Douglas: subir a arte na qualidade
   * original, sem precisar redimensionar antes -- ver
   * CUSTOM_ITEM_TARGET_WIDTH e o uso em addFurnitureSprite,
   * MainScene.ts, que encolhe só a EXIBIÇÃO pro tamanho certo, mantendo
   * o arquivo original intacto no Storage). Modelo gerado da pasta local
   * (GENERATED_FURNITURE_MODELS) nunca tem isso -- a arte dele já foi
   * recortada/dimensionada certinha pelo script, não precisa de ajuste
   * nenhum na exibição. */
  custom?: boolean;
  /** Tamanho de exibição (px, largura) escolhido À MÃO no preview do
   * Editor de Itens (ver ItemEditor.tsx/handleSubmit e a coluna
   * display_width em supabase/migrations/0003_room_items_display_width.sql)
   * -- só existe em item CUSTOM. Quando ausente (item cadastrado ANTES
   * dessa opção existir), cai no fallback por categoria
   * (CUSTOM_ITEM_TARGET_WIDTH abaixo, ver uso em addFurnitureSprite,
   * MainScene.ts). Pedido do Douglas: a imagem gerada não vem num
   * padrão de proporção, então o mesmo alvo por categoria dava
   * resultado bem diferente de item pra item -- precisa ajustar cada
   * um. */
  displayWidth?: number;
  /** Override de displayWidth (acima) por direção -- SÓ pra
   * left/right/up (down usa displayWidth direto, sem entrada aqui).
   * Pedido do Douglas: "se eu mudar de um ele muda de todas as vistas?
   * nao tem como isolar?" -- antes o tamanho era um valor ÚNICO por
   * ITEM (não por vista), reaproveitado nas 4 direções sem exceção,
   * diferente da posição (directionOffsets acima), que já podia ser
   * ajustada por lado desde 0007. Mesmo esquema: ajustado no campo
   * digitável/slider "Tamanho no jogo" olhando a aba de cada direção no
   * preview do Editor de Itens -- direção sem entrada aqui cai no
   * displayWidth de "down" (comportamento de sempre, sem regressão pros
   * itens já cadastrados). Útil pra parede, por exemplo: a "quina" pode
   * precisar de uma largura bem diferente da "frente". */
  directionDisplayWidth?: Partial<Record<Exclude<FurnitureFacing, "down">, number>>;
  /** Ícone PRÓPRIO pro botão do catálogo (URL do Storage) -- pedido do
   * Douglas: "escolher o favicon que aparece no catálogo", separado das
   * 4 fotos de direção (a arte da peça pode não ficar boa cortada em
   * quadrado pequeno). undefined = sem ícone próprio, cai no fallback
   * de sempre (foto de frente, ver catalogEntryIconFile em
   * GameRoom.tsx). Só existe em item CUSTOM, igual displayWidth. */
  iconUrl?: string;
  /** Imagem (URL do Storage) que SUBSTITUI a arte normal do item
   * enquanto algum avatar (local ou remoto) estiver a 1 tile de
   * distância dele -- pedido do Douglas: "por proximidade, a um tile de
   * distancia, o objeto muda, muda pra outra imagem". UMA imagem só
   * (não por direção/cor -- diferente de `art`/`colors`), aplicada por
   * cima de QUALQUER direção/cor que o item esteja mostrando no
   * momento. undefined = sem efeito de proximidade, comportamento de
   * sempre. Só existe em item CUSTOM, igual iconUrl (upload próprio no
   * Editor de Itens). Resolvida pra uma textura do Phaser via
   * furnitureNearTextureKey (ver updateFurnitureProximityState,
   * MainScene.ts, chamado todo frame em update() mesmo esquema de
   * updateDoorOpenState). */
  nearImageUrl?: string;
  /** Deslocamento (px) da posição-âncora do móvel a partir do padrão
   * (borda de baixo do tile, ver furnitureWorldPos) -- ajustado À MÃO
   * arrastando o item em cima do quadrado/boneco de referência no
   * preview do Editor de Itens (pedido do Douglas: "delimitar ali no
   * editor a posição do mobi no tile"). Só existe em item CUSTOM, por
   * MODELO (não por instância colocada -- todo item desse modelo usa o
   * mesmo ajuste, ver addFurnitureSprite em MainScene.ts). 0/undefined =
   * sem deslocamento, comportamento de sempre. Vale pra direção "down"
   * (frente) -- as outras 3 podem ter o PRÓPRIO ajuste (ver
   * directionOffsets abaixo, pedido do Douglas: "editar todos os lados
   * do mobi"), sem override aí cai nesse mesmo valor. */
  offsetX?: number;
  offsetY?: number;
  /** Override de offsetX/offsetY (ver acima) por direção -- SÓ pra
   * left/right/up (down usa offsetX/offsetY direto, sem entrada aqui).
   * Ajustado arrastando o item na aba de cada direção no preview do
   * Editor de Itens (mesmo esquema do editor de posição do "Criar
   * Avatar", ver AvatarCreatorPanel em ItemEditor.tsx). Direção sem
   * entrada aqui cai no offsetX/offsetY de "down" -- útil quando o item
   * é simétrico o bastante pra não precisar de ajuste por lado. */
  directionOffsets?: Partial<Record<Exclude<FurnitureFacing, "down">, { x: number; y: number }>>;
  /** Se ESSE modelo senta (ver isFurnitureSittable acima) -- pedido do
   * Douglas: seletor "Tem interação? Sentar/Nenhuma" no Editor de
   * Itens. undefined = sem escolha feita ainda (modelo "de fábrica" ou
   * item custom cadastrado ANTES dessa opção existir) -- cai no
   * fallback por categoria (isSittableFurnitureType). */
  sittable?: boolean;
  /** Deslocamento (px) PADRÃO de onde o boneco senta nesse modelo --
   * ajustado à mão no Editor de Itens junto com "Tem interação?"
   * (arrastando um marcador em cima do preview, ver handleSeatMarkerPointerDown
   * em ItemEditor.tsx). Um valor só, aplicado nas 4 direções -- ajuste
   * fino POR DIREÇÃO continua sendo o painel "Assento" já existente no
   * editor de espaço (ver FurnitureSeatOffsetsMap/resolveSeatOffset),
   * esse aqui é só o ponto de partida pra não sentar torto assim que o
   * item é criado. undefined = cai no heurístico de sempre (frente/
   * costas vs lado, ver resolveSeatOffset). */
  seatOffsetX?: number;
  seatOffsetY?: number;
  /** Override de seatOffsetX/Y (ver acima) por direção -- SÓ pra
   * left/right/up (down usa seatOffsetX/Y direto, sem entrada aqui) --
   * MESMO esquema de directionOffsets (posição no tile), agora aplicado
   * ao assento também.
   *
   * ACHADO ("continua torto", 3ª+ rodada -- Douglas: "eu salvo a
   * posição e ele fica em outra no mapa"): até aqui seatOffsetX/Y era
   * um valor ÚNICO pras 4 direções por design (ver migration 0007) --
   * o ajuste fino por direção ficava só no painel "Assento" do editor
   * de espaço (fora do Editor de Itens, ver resolveSeatOffset). Só que
   * a diferença entre sentar de frente/costas e sentar de lado é GRANDE
   * (a poltrona é bem mais estreita de perfil -- ver
   * SEAT_Y_FRENTE_COSTAS vs SEAT_Y_LADO abaixo), então ajustar o valor
   * único olhando uma direção sempre desalinhava as outras -- e como
   * "Assento" é um painel SEPARADO (editor de espaço, não o Editor de
   * Itens onde o Douglas mexe de verdade), o resultado tinha cara de
   * "salvei e não mudou nada"/"virou outra posição" dependendo de qual
   * direção ele tava olhando. Agora o próprio preview do Editor de
   * Itens deixa arrastar o boneco sentado em CADA aba de direção (igual
   * já fazia pra posição no tile) -- down/up caem em seatOffsetX/Y,
   * left/right ganham o PRÓPRIO valor aqui quando ajustados. Sem
   * ajuste aqui, left/right NÃO reaproveitam mais o valor de baixo (ao
   * contrário de directionOffsets) -- caem direto no heurístico
   * genérico de lado (SEAT_Y_LADO/SEAT_X_LADO, ver resolveSeatOffset),
   * que já é uma aproximação bem melhor que aplicar um valor pensado
   * pra frente/costas de lado. */
  seatDirectionOffsets?: Partial<Record<Exclude<FurnitureFacing, "down">, { x: number; y: number }>>;
  /** Tamanho do FOOTPRINT (em tiles do grid col/row) desse modelo --
   * pedido do Douglas: "tenho mobis que ocupam mais tiles doq um ou
   * dois, entao preciso selecionar pra que nao se suba em um item". Até
   * aqui TODO móvel travava passagem (quando trava, ver
   * FURNITURE_BLOCKS_MOVEMENT) só no próprio tile-âncora (f.col,f.row)
   * -- um sofá/mesa desenhado mais largo que 1 tile deixava o resto da
   * peça andável, dava pra atravessar "por dentro" dela. 1/undefined
   * (padrão) = comportamento de sempre, só a âncora -- não regride
   * NENHUM item existente. >1 soma um retângulo de footprintCols x
   * footprintRows tiles a partir da âncora (ver furnitureFootprintTiles
   * abaixo), sempre travando passagem nos tiles ALÉM da âncora (mesmo
   * pra categoria que senta, tipo sofá -- só a âncora mantém o
   * comportamento de "anda até aqui e senta", o resto da peça trava
   * igual objeto sólido até ganhar assento próprio ali, ver comentário
   * grande sobre "vários assentos" combinado com o Douglas). NÃO gira
   * sozinho por direção -- ajustado olhando a peça já virada do jeito
   * que normalmente fica na sala. */
  footprintCols?: number;
  footprintRows?: number;
  /** Footprint desenhado À MÃO, tile por tile, por direção -- pedido do
   * Douglas depois de brigar com o retângulo cego acima: "quero
   * selecionar os tiles que ele ocupa, CLICANDO, e preenchendo, do jeito
   * que ta eu nao consigo decidir rumo nem nada! E isso pra CADA
   * POSICAO, pois o movel gira e muda o bloqueio pela perspectiva!!!"
   * (ex: uma peça em L trava tiles diferentes virada pra baixo do que
   * virada pro lado). Cada chave é uma direção-base (down/left/right/up,
   * MESMA Direction de directionOffsets/seatDirectionOffsets -- quina de
   * parede não tem footprint próprio, sempre cai em "down", ver
   * ItemEditor.tsx); cada entrada da lista é UM tile (dCol,dRow, OFFSET
   * a partir da âncora, mesma convenção de extraSeats) marcado no
   * clique-a-clique do Editor de Itens -- a âncora (0,0) nunca entra
   * aqui, ela trava SEMPRE, implícita. undefined pra uma direção = ainda
   * não foi customizada NESSA direção -- cai no retângulo cego de sempre
   * (footprintCols x footprintRows acima, ver furnitureFootprintTiles
   * abaixo), o que mantém TODO item já cadastrado funcionando idêntico
   * sem precisar migrar nada. */
  footprintByDirection?: Partial<Record<Direction, { dCol: number; dRow: number }[]>>;
  /** Assentos EXTRAS (além do assento padrão da âncora, ver
   * seatOffsetX/Y/seatDirectionOffsets acima) -- pedido do Douglas: "um
   * sofa ex, que ocupa mais de um tile, e mais de um tile se senta,
   * preciso inclusive dai, configurar dois avatares no caso em que tenha
   * mais de um assento". Cada entrada é um tile DENTRO do footprint
   * (dCol/dRow relativos à âncora -- 0,0 seria a própria âncora, mas ela
   * já tem assento via seatOffsetX/Y, normalmente >0) com seu PRÓPRIO
   * deslocamento (x,y) de onde o boneco senta ali -- mesma unidade/faixa
   * de seatOffsetX/Y, só que sem fallback nenhum (assento extra sem x/y
   * ajustado cai em 0,0, o Douglas arrasta certinho no preview, ver
   * ItemEditor.tsx). Diferente de directionOffsets/seatDirectionOffsets,
   * NÃO é por direção (mesma simplificação de footprintCols/Rows acima
   * -- a lista vale igual não importa a direção atual do item). Um tile
   * de assento extra NUNCA trava passagem (ver blockingFurnitureAt) --
   * é sentável, não sólido, mesmo dentro do footprint. undefined/[] =
   * comportamento de sempre, só o assento da âncora. */
  extraSeats?: FurnitureExtraSeat[];
  /** Altura (px) da SUPERFÍCIE desse modelo -- pedido do Douglas: "cada
   * item, ex: mesa mesinha de centro, eu teria que configurar, a altura
   * de um segundo item, adicionado ao tile dele". Só faz sentido em
   * móvel "de base" (mesa, mesinha de centro): quando outro item
   * marcado `stackable` (ver abaixo) é colocado na MESMA âncora, esse
   * valor vira o deslocamento vertical dele (soma no offsetY próprio,
   * ver addFurnitureSprite em MainScene.ts) -- empurra pra CIMA pra
   * parecer que tá em cima da mesa, não flutuando/enterrado nela.
   * undefined/0 = mesa sem superfície configurada ainda (item em cima
   * cai na própria posição normal, sem levantar). Unidade/sinal igual
   * offsetY: negativo sobe. */
  stackSurfaceOffsetY?: number;
  /** Esse modelo pode ser colocado em cima de OUTRO item já ancorado no
   * mesmo tile (ver anyFurnitureAt em MainScene.ts, que hoje bloqueia
   * qualquer tile já ocupado) -- pedido do Douglas pro caso do notebook
   * em cima da mesa: "eles não conseguem posicionar o item" (dono da
   * sala só arrasta pro catálogo, não ajusta nada na hora) então quem
   * garante que fica certo é essa flag + stackSurfaceOffsetY da mesa,
   * automático, não importa em cima de qual mesa o dono colocar. Falso/
   * undefined = comportamento de sempre, tile ocupado bloqueia. Só
   * empilha UM item em cima de outro NÃO-stackable (ver
   * addFurnitureSprite/anyFurnitureAt) -- evita torre de 3+ itens por
   * enquanto, sem caso de uso ainda. */
  stackable?: boolean;
}

/** Um assento EXTRA (ver FurnitureModelDef.extraSeats acima) -- tile
 * (dCol,dRow, relativo à âncora do item) + deslocamento (x,y) de onde o
 * boneco senta nesse tile. */
export interface FurnitureExtraSeat {
  dCol: number;
  dRow: number;
  x: number;
  y: number;
}

/** Lista de assentos extras do MODELO desse item (ver
 * FurnitureModelDef.extraSeats) -- [] quando não tem modelo ou o modelo
 * não tem nenhum configurado. */
export function furnitureExtraSeats(f: FurnitureDef): FurnitureExtraSeat[] {
  const model = f.modelId ? furnitureModelById(f.modelId) : undefined;
  return model?.extraSeats ?? [];
}

/**
 * Tiles (col,row) que ESSE item ocupa -- a âncora (f.col,f.row) sempre,
 * mais:
 *  1) o footprint DESENHADO À MÃO da direção atual (f.facing, ver
 *     FurnitureModelDef.footprintByDirection acima), se essa direção já
 *     foi customizada no Editor de Itens; quina de parede (cornerTop/
 *     cornerBottom) sempre olha a entrada "down" (footprint não muda por
 *     quina, só pelas 4 direções-base); OU, sem customização NESSA
 *     direção --
 *  2) o retângulo cego de sempre (footprintCols x footprintRows,
 *     crescendo em col/row a partir da âncora) -- mantém TODO item já
 *     cadastrado (sem footprintByDirection nenhum) funcionando idêntico.
 * Sem modelo ou footprint 1x1 (padrão de sempre), devolve só a âncora.
 */
export function furnitureFootprintTiles(f: FurnitureDef): { col: number; row: number }[] {
  const model = f.modelId ? furnitureModelById(f.modelId) : undefined;
  const anchor = { col: f.col, row: f.row };
  const dir: Direction = f.facing === "cornerTop" || f.facing === "cornerBottom" ? "down" : f.facing;
  const custom = model?.footprintByDirection?.[dir];
  if (custom) {
    const tiles = [anchor];
    for (const t of custom) {
      if (t.dCol === 0 && t.dRow === 0) continue; // âncora já entra sempre, evita duplicar
      tiles.push({ col: f.col + t.dCol, row: f.row + t.dRow });
    }
    return tiles;
  }
  const cols = Math.max(1, Math.round(model?.footprintCols ?? 1));
  const rows = Math.max(1, Math.round(model?.footprintRows ?? 1));
  if (cols <= 1 && rows <= 1) return [anchor];
  const tiles: { col: number; row: number }[] = [];
  for (let dc = 0; dc < cols; dc++) {
    for (let dr = 0; dr < rows; dr++) {
      tiles.push({ col: f.col + dc, row: f.row + dr });
    }
  }
  return tiles;
}

/**
 * Largura ALVO (px, na tela do jogo) de um item CUSTOM por categoria --
 * só usada quando o modelo é custom (ver FurnitureModelDef.custom
 * acima). Calibrada pela mobília "de fábrica" já existente (poltrona
 * tem uns 150-175px de largura nativa, ver comentário do TILE em
 * game/grid.ts) -- sofá/mesa um pouco mais largos (peça maior na vida
 * real), planta/computador um pouco menores. A ALTURA acompanha
 * proporcionalmente (mantém a proporção da imagem original, ver
 * addFurnitureSprite) -- só a largura é fixada aqui.
 */
// (escalados 1.5x junto com a resolução interna do jogo -- ver
// GAME_WIDTH/GAME_HEIGHT/TILE em game/grid.ts -- mantém a mesma
// proporção aprovada de antes, só que calculada na resolução nova.)
export const CUSTOM_ITEM_TARGET_WIDTH: Record<FurnitureCategoryId, number> = {
  poltrona: 240,
  sofa: 390,
  mesa: 270,
  planta: 135,
  computador: 150,
  divisoria: 195,
};

// modelos gerados automaticamente a partir da pasta de origem (ver
// scripts/avatarAssetsConfig.mjs/syncFurnitureAssets.mjs, roda sozinho
// junto com `npm run dev`). NÃO editar esse import nem o arquivo dele à
// mão -- pra adicionar um modelo novo, sobe a pasta na origem (ver
// POLTRONAS_SRC_ROOT).
import { GENERATED_FURNITURE_MODELS } from "./furnitureModels.generated";

export const FURNITURE_MODELS: FurnitureModelDef[] = [...GENERATED_FURNITURE_MODELS];

export function furnitureModelById(id: string): FurnitureModelDef | undefined {
  return FURNITURE_MODELS.find((m) => m.id === id);
}

/** Modelos cadastrados pra um TIPO de móvel (ex: os 2 modelos de poltrona) -- lista vazia = tipo ainda usa o design único de FURNITURE_ART. */
export function furnitureModelsForType(type: FurnitureType): FurnitureModelDef[] {
  return FURNITURE_MODELS.filter((m) => m.type === type);
}

/** Cor de um modelo pelo id, com fallback pra primeira cor cadastrada (nunca null se o modelo tiver pelo menos 1 cor). */
export function furnitureModelColor(model: FurnitureModelDef, colorId?: string): FurnitureModelColorOption | undefined {
  return (colorId && model.colors.find((c) => c.id === colorId)) || model.colors[0];
}

/**
 * Resolve modelo+cor de um item colocado (com fallback pra primeira cor
 * cadastrada do modelo quando f.colorId não bate/não veio, ver
 * furnitureModelColor) -- devolve null se o item não tiver modelo (caso
 * do vidro e dos itens antigos de ROOM_FURNITURE, ver FurnitureDef) ou
 * se o modelId não existir mais no catálogo gerado (ex: pasta de origem
 * renomeada/apagada).
 */
function resolveFurnitureModelColor(f: FurnitureDef): { model: FurnitureModelDef; color: FurnitureModelColorOption } | null {
  if (!f.modelId) return null;
  const model = furnitureModelById(f.modelId);
  if (!model) return null;
  const color = furnitureModelColor(model, f.colorId);
  if (!color) return null;
  return { model, color };
}

/**
 * Arte final (nome do arquivo em public/assets) pra um item COLOCADO --
 * resolve pelo MODELO+COR quando o item tiver (f.modelId, ver
 * FurnitureDef), senão cai no design único do tipo (furnitureArtFile,
 * caso do vidro e dos itens antigos sem modelo). Usado no lugar de
 * furnitureArtFile(f.type, f.facing) em qualquer lugar que já tenha o
 * FurnitureDef inteiro em mãos (ver addFurnitureSprite em MainScene.ts).
 */
export function resolveFurnitureArt(f: FurnitureDef): string | null {
  const resolved = resolveFurnitureModelColor(f);
  if (resolved) return resolved.color.art[f.facing] ?? resolved.color.art.down ?? null;
  return furnitureArtFile(f.type, f.facing);
}

/** Chave da textura no Phaser pra um item COLOCADO -- mesma ideia de furnitureTextureKey, mas cobrindo também a variação modelo+cor (ver resolveFurnitureArt). Usa a cor JÁ RESOLVIDA (com fallback), pra bater exatamente com a chave pré-carregada em preloadFurnitureVariantTextures (MainScene.ts). */
export function furnitureTextureKeyFor(f: FurnitureDef): string {
  const resolved = resolveFurnitureModelColor(f);
  if (resolved) return furnitureVariantTextureKey(resolved.model.id, resolved.color.id, f.facing);
  return furnitureTextureKey(f.type, f.facing);
}

/** Chave da textura no Phaser pra um modelo+cor+direção (ex: "gamer"+"rosa"+"left" -> "furniture-variant-gamer-rosa-left"). */
export function furnitureVariantTextureKey(modelId: string, colorId: string, facing: FurnitureFacing): string {
  return `furniture-variant-${modelId}-${colorId}-${facing}`;
}

/** Chave da textura no Phaser pra imagem "de perto" de um modelo (ver
 * FurnitureModelDef.nearImageUrl) -- UMA só por modelo, sem cor/direção
 * (diferente de furnitureVariantTextureKey). */
export function furnitureNearTextureKey(modelId: string): string {
  return `furniture-near-${modelId}`;
}

/**
 * Categorias da barra de ícones do editor de espaço ("Editar espaço",
 * ver EditPanel em GameRoom.tsx) -- cada uma vira um botão com ícone lá
 * em cima, igual ao padrão de referência que o Douglas mandou (barra de
 * categoria + grade de itens embaixo). "Piso" NÃO entra aqui -- é uma
 * aba separada, sem tipo de móvel (ver game/floor.ts), tratada à parte
 * dentro do EditPanel.
 *
 * poltrona/divisória (vidro) já têm arte de verdade; sofá/mesa/planta/
 * computador ainda não (ver FURNITURE_ART/FURNITURE_CATALOG -- nenhum
 * FurnitureType criado pra eles ainda) -- por enquanto a categoria
 * aparece na barra mas fica vazia ("monta a estrutura agora, arte
 * depois", combinado com o Douglas), até subir os arquivos de origem e
 * virar um FurnitureType de verdade igual poltrona/vidro.
 */
export type FurnitureCategoryId =
  | "poltrona"
  | "sofa"
  | "mesa"
  | "planta"
  | "computador"
  | "divisoria";

export const FURNITURE_CATEGORIES: { id: FurnitureCategoryId; label: string }[] = [
  { id: "poltrona", label: "Poltrona" },
  { id: "sofa", label: "Sofá" },
  { id: "mesa", label: "Mesa" },
  { id: "planta", label: "Planta" },
  { id: "computador", label: "Computador" },
  { id: "divisoria", label: "Divisória" },
];

/** Categoria de cada tipo de móvel que JÁ existe (tem arte/catálogo) -- decide em qual aba da barra de ícones ele aparece. */
export const FURNITURE_TYPE_CATEGORY: Record<FurnitureType, FurnitureCategoryId> = {
  poltrona: "poltrona",
  vidro: "divisoria",
  sofa: "sofa",
  mesa: "mesa",
  planta: "planta",
  computador: "computador",
};

/**
 * Categoria (escolhida no formulário do Editor de Itens) -> TIPO --
 * inverso de FURNITURE_TYPE_CATEGORY, usado só na hora de REGISTRAR um
 * item custom (ver registerCustomFurnitureModels abaixo e
 * components/ItemEditor.tsx). "poltrona"/"divisoria" reaproveitam os
 * tipos que já existem (item custom dessa categoria vira só mais um
 * MODELO do mesmo tipo, lado a lado com os gerados da pasta local).
 */
export const CUSTOM_ITEM_CATEGORY_TYPE: Record<FurnitureCategoryId, FurnitureType> = {
  poltrona: "poltrona",
  divisoria: "vidro",
  sofa: "sofa",
  mesa: "mesa",
  planta: "planta",
  computador: "computador",
};

/**
 * Tipos de móvel cujo TILE (o próprio, onde ele está ancorado) trava a
 * passagem -- o boneco não consegue andar pra cima (ver startStep() em
 * MainScene.ts, que usa isso pra recusar o passo igual já fazia na
 * borda do mapa). O tile de CIMA (onde só a parte que "vaza" pra cima
 * do móvel aparece, por overflow de altura) continua livre normalmente
 * -- só o próprio tile do móvel é que trava.
 */
export const FURNITURE_BLOCKS_MOVEMENT: Record<FurnitureType, boolean> = {
  poltrona: false,
  vidro: true,
  sofa: false, // senta, igual poltrona
  mesa: true,
  planta: true,
  computador: true,
};

export function furnitureBlocksMovement(type: FurnitureType): boolean {
  return FURNITURE_BLOCKS_MOVEMENT[type] ?? false;
}

/** Tipos em que o boneco senta sozinho ao parar em cima (ver findChairAtCurrentTile em MainScene.ts) -- vidro/mesa/planta/computador são decoração, não sentam. Só o PADRÃO/fallback pra item sem modelo (ver isFurnitureSittable abaixo, que checa o modelo primeiro). */
export function isSittableFurnitureType(type: FurnitureType): boolean {
  return type === "poltrona" || type === "sofa";
}

/**
 * Se ESSE item senta -- pedido do Douglas: "editar... se vai ter
 * interação, e qual interação" (Editor de Itens, seletor "Tem
 * interação?" -- ver AvatarCreatorPanel não, esse é o de MÓVEL mesmo,
 * ver handleSubmit em ItemEditor.tsx). Antes disso, sentar dependia só
 * da CATEGORIA (isSittableFurnitureType acima) -- um item custom criado
 * em "poltrona" sentava sempre, um em "mesa" nunca, sem escolha. Agora,
 * se o MODELO (ver FurnitureModelDef.sittable) tiver um valor explícito
 * (marcado no Editor de Itens), esse vale -- só cai no fallback por
 * categoria pros modelos "de fábrica" e pros itens custom cadastrados
 * ANTES dessa opção existir (sittable ainda null no banco).
 */
export function isFurnitureSittable(f: FurnitureDef): boolean {
  const model = f.modelId ? furnitureModelById(f.modelId) : undefined;
  if (model?.sittable !== undefined) return model.sittable;
  return isSittableFurnitureType(f.type);
}

/** Chave da textura no Phaser pra um móvel numa direção (ex: "poltrona" + "left" -> "furniture-poltrona-left"). */
export function furnitureTextureKey(type: FurnitureType, facing: FurnitureFacing): string {
  return `furniture-${type}-${facing}`;
}

/** Nome do arquivo em public/assets pra essa peça+direção (com fallback pra "down"). */
export function furnitureArtFile(type: FurnitureType, facing: FurnitureFacing): string | null {
  const art = FURNITURE_ART[type];
  return art[facing] ?? art.down ?? null;
}

// 4 poltronas de teste, uma virada pra cada direção -- pra validar as 4
// artes (frente/lado esq/lado dir/costas) juntas na sala de uma vez.
// Posição definitiva vem depois, junto com o resto da mobília da sala.
//
// O ajuste de encaixe (seatOffsetY/X) é DIFERENTE por direção -- não dá
// mais pra usar um valor único pras 4: de frente/costas o boneco tava
// subindo demais (perto do valor antigo -12), então baixa quase pro
// zero; de lado ele tava baixo demais, então sobe mais que antes, e
// ganha um empurrão horizontal (seatOffsetX) na direção que a poltrona
// olha, pra não ficar sentado bem no meio do "pé" do móvel.
// -21 aqui compensa o AVATAR_FOOT_OFFSET_Y (ver MainScene.ts) -- as
// sprites do boneco agora são desenhadas 21px mais pra baixo dentro do
// próprio container (só isso resolve o "pé não fica centralizado" ao
// caminhar), mas isso empurraria o boneco sentado junto -- subtrai os
// mesmos 21px aqui pra ele continuar encaixado na poltrona do jeito que
// já tinha sido aprovado. (Era 14, escalou 1.5x junto com
// AVATAR_FOOT_OFFSET_Y quando a resolução interna do jogo aumentou --
// ver GAME_WIDTH/GAME_HEIGHT em game/grid.ts.)
//
// O resto do ajuste (-4/-18 de base, +12 horizontal) NÃO dobrou -- é
// calibrado pra encaixar na arte ATUAL da poltrona (pequena, resolução
// original, ainda sem o reupload em qualidade maior que o Douglas vai
// fazer -- ver conversa sobre a resolução interna). Quando a arte nova
// entrar, ajusta ao vivo pela ferramenta "Assento" do editor de espaço
// (ver setSeatTuningMode/resetSeatOffset em MainScene.ts) em vez de
// mexer aqui de novo.
export const SEAT_Y_FRENTE_COSTAS = -4 - 21;
export const SEAT_Y_LADO = -18 - 21;
export const SEAT_X_LADO = 12;

// divisória de vidro: sobe meio tile em relação à base padrão (que fica
// no vértice de baixo do losango) -- ou seja, a base dela passa a ficar
// exatamente no CENTRO do tile (mesmo ponto onde o boneco anda
// ancorado), não mais encostada no chão. Só reposiciona -- o tamanho da
// arte continua o mesmo (ver build/process do vidro, não mudou).
export const VIDRO_BASE_OFFSET_Y = -ISO_TILE_HEIGHT / 2;

/**
 * Catálogo de opções que aparecem na paleta do editor (botão "Editar
 * espaço", ver MainScene.ts / GameRoom.tsx) -- uma entrada por
 * combinação tipo+direção que faz sentido colocar. Cada entrada já leva
 * os MESMOS ajustes finos (seatOffsetY/X, baseOffsetY) usados nos itens
 * fixos de ROOM_FURNITURE acima, pra um item colocado pelo editor
 * renderizar/sentar exatamente igual a um item escrito à mão.
 */
export interface FurnitureCatalogEntry {
  type: FurnitureType;
  facing: FurnitureFacing;
  label: string;
  seatOffsetY?: number;
  seatOffsetX?: number;
  baseOffsetY?: number;
  /** entrada gerada a partir de um MODELO (ver FURNITURE_MODELS) -- tem
   * modelId + a lista de cores dele; a paleta do editor (EditPanel,
   * GameRoom.tsx) usa isso pra desenhar o seletor de cor e passar
   * modelId/colorId adiante pro FurnitureDef colocado. undefined = design
   * único do tipo (caso do vidro), sem seleção de cor. */
  modelId?: string;
  colorId?: string;
  colors?: FurnitureModelColorOption[];
}

/**
 * Ordem de rotação (sentido horário, começando de frente) usada pelo
 * botão de girar no preview do item selecionado -- ver
 * catalogIndicesForGroup abaixo. Precisa vir ANTES de FURNITURE_CATALOG
 * (usada por furnitureModelCatalogEntries logo abaixo, que roda na hora
 * que o módulo carrega).
 *
 * "cornerTop"/"cornerBottom" no fim (pedido do Douglas: "nas paredes
 * adicione mais duas posicoes, quina de cima, quina de baixo") --
 * seguro adicionar aqui pra QUALQUER móvel, não só parede: o loop que
 * usa essa ordem (furnitureModelCatalogEntries/registerCustomFurnitureModels
 * logo abaixo) já pula direção sem arte cadastrada
 * (`if (!defaultColor.art[facing]) continue`), e só item de parede
 * (categoria divisória, ver WALL_DIRECTION_FIELDS em ItemEditor.tsx)
 * chega a ter arte nessas 2 chaves -- um mobi comum simplesmente nunca
 * gera entrada de catálogo pra elas, sem precisar bifurcar essa lista
 * por categoria.
 */
export const FURNITURE_ROTATE_ORDER: FurnitureFacing[] = ["down", "right", "up", "left", "cornerTop", "cornerBottom"];

// entradas do design ÚNICO por tipo (sem modelo) -- hoje só o vidro
// (divisória); poltrona deixou de ter entrada fixa aqui desde que ganhou
// modelo (ver furnitureModelCatalogEntries abaixo, gerado a partir
// da pasta de origem) -- os 4 itens antigos de ROOM_FURNITURE continuam
// renderizando normalmente (usam o design único como PADRÃO quando não
// têm modelId, ver resolveFurnitureArt), só não aparecem mais como opção
// nova na paleta.
const FURNITURE_CATALOG_STATIC: FurnitureCatalogEntry[] = [
  { type: "vidro", facing: "down", label: "Vidro (divisória)", baseOffsetY: VIDRO_BASE_OFFSET_Y },
];

/** Uma entrada de catálogo por MODELO+direção cadastrada (ver FURNITURE_MODELS) -- a cor default é sempre a primeira da lista do modelo; trocar de cor no editor não muda de entrada, só o colorId escolhido por cima (ver EditPanel em GameRoom.tsx). */
function furnitureModelCatalogEntries(): FurnitureCatalogEntry[] {
  const entries: FurnitureCatalogEntry[] = [];
  for (const model of FURNITURE_MODELS) {
    const defaultColor = model.colors[0];
    if (!defaultColor) continue;
    for (const facing of FURNITURE_ROTATE_ORDER) {
      if (!defaultColor.art[facing]) continue;
      entries.push({
        type: model.type,
        facing,
        label: model.label,
        modelId: model.id,
        colorId: defaultColor.id,
        colors: model.colors,
      });
    }
  }
  return entries;
}

export const FURNITURE_CATALOG: FurnitureCatalogEntry[] = [
  ...FURNITURE_CATALOG_STATIC,
  ...furnitureModelCatalogEntries(),
];

/**
 * Registra modelo(s) de móvel CUSTOMIZADO(s), cadastrado(s) pelo dono da
 * sala pelo Editor de Itens (upload direto, guardado na tabela
 * room_items/Storage do Supabase -- ver components/ItemEditor.tsx e
 * app/api/items) -- diferente de GENERATED_FURNITURE_MODELS (gerado em
 * BUILD-TIME pela pasta local, ver scripts/syncFurnitureAssets.mjs),
 * esses chegam em TEMPO DE EXECUÇÃO, buscados assim que a sala carrega
 * (ver fetchCustomFurnitureModels em GameRoom.tsx).
 *
 * Empurra direto pra dentro de FURNITURE_MODELS/FURNITURE_CATALOG (em
 * vez de expor um "getCatalog()" separado) de propósito: array é tipo
 * referência, então todo código que já importa esses dois const direto
 * (GameRoom.tsx/EditPanel) enxerga os itens novos sem precisar mudar
 * nada -- só precisa forçar uma re-renderização depois de chamar isso
 * (o array mutou por dentro, mas o React não percebe sozinho).
 *
 * UPSERT: chamar de novo com o mesmo id (ex: reconexão, refetch depois
 * de cadastrar/EDITAR um item, ver "Editar" no Editor de Itens) SUBSTITUI
 * o modelo e reconstrói as entradas de catálogo dele a partir do zero --
 * não duplica, e agora também não fica preso na versão antiga (antes
 * disso existir, editar um item cadastrado não tinha efeito nenhum aqui:
 * o registro simplesmente era ignorado por já existir o id). Devolve os
 * ids que já EXISTIAM antes dessa chamada (ou seja, que acabaram de ser
 * atualizados, não criados) -- quem chama usa isso pra saber quando
 * precisa limpar a textura antiga da cena e recriar os sprites já
 * colocados desse modelo (ver fetchAndRegisterCustomFurniture,
 * GameRoom.tsx, e removeFurnitureTextures/refreshFurnitureModel em
 * MainScene.ts), já que só re-registrar aqui não muda nada que já foi
 * desenhado na tela.
 */
export function registerCustomFurnitureModels(models: FurnitureModelDef[]): string[] {
  const updatedIds: string[] = [];
  for (const model of models) {
    const existingIndex = FURNITURE_MODELS.findIndex((m) => m.id === model.id);
    // custom:true SEMPRE, não importa o que o chamador mandou -- essa
    // função só existe pra registrar item vindo do Editor de Itens, então
    // por definição é sempre custom (ver CUSTOM_ITEM_TARGET_WIDTH/
    // addFurnitureSprite em MainScene.ts, que dependem dessa flag pra
    // saber quando encolher a exibição de uma imagem enviada em
    // qualidade/resolução alta).
    if (existingIndex !== -1) {
      updatedIds.push(model.id);
      FURNITURE_MODELS[existingIndex] = { ...model, custom: true };
    } else {
      FURNITURE_MODELS.push({ ...model, custom: true });
    }
    // reconstrói as entradas de catálogo desse modelo do zero (cobre os
    // dois casos: item novo, sem entrada nenhuma ainda, e item editado,
    // cuja arte/direções disponíveis podem ter mudado).
    for (let i = FURNITURE_CATALOG.length - 1; i >= 0; i--) {
      if (FURNITURE_CATALOG[i].modelId === model.id) FURNITURE_CATALOG.splice(i, 1);
    }
    const defaultColor = model.colors[0];
    if (!defaultColor) continue;
    for (const facing of FURNITURE_ROTATE_ORDER) {
      if (!defaultColor.art[facing]) continue;
      FURNITURE_CATALOG.push({
        type: model.type,
        facing,
        label: model.label,
        modelId: model.id,
        colorId: defaultColor.id,
        colors: model.colors,
      });
    }
  }
  return updatedIds;
}

/**
 * Nome "de tipo" (sem a direção) -- usado só pro vidro/design único
 * agora (peça com modelo usa model.label direto, ver
 * FurnitureCatalogEntry.label já vir preenchido com o nome do modelo em
 * furnitureModelCatalogEntries).
 */
export const FURNITURE_TYPE_LABEL: Record<FurnitureType, string> = {
  poltrona: "Poltrona",
  vidro: "Divisória de vidro",
  sofa: "Sofá",
  mesa: "Mesa",
  planta: "Planta",
  computador: "Computador",
};

/**
 * Chave de AGRUPAMENTO de uma entrada de catálogo -- o modelo (quando
 * tiver, ver FurnitureCatalogEntry.modelId) ou o tipo (design único, ex:
 * vidro). É por isso que dá pra ter 2 modelos do MESMO tipo (poltrona
 * "Gamer" x "Poltrona Lecce") sem as 8 direções (4+4) se misturarem num
 * giro só -- cada modelo gira dentro do próprio grupo.
 */
export function catalogEntryGroupKey(entry: FurnitureCatalogEntry): string {
  return entry.modelId ?? entry.type;
}

/**
 * Índices (em FURNITURE_CATALOG) de todas as direções cadastradas pro
 * grupo (modelo ou tipo, ver catalogEntryGroupKey) dado, na ordem de
 * FURNITURE_ROTATE_ORDER -- direções sem entrada ficam de fora. Se tiver
 * só 1 direção, não tem o que girar (ver canRotate no preview,
 * GameRoom.tsx).
 */
export function catalogIndicesForGroup(groupKey: string): number[] {
  return FURNITURE_ROTATE_ORDER.map((facing) =>
    FURNITURE_CATALOG.findIndex((e) => catalogEntryGroupKey(e) === groupKey && e.facing === facing)
  ).filter((i) => i !== -1);
}

// Era uma lista de móveis de TESTE escritos à mão (4 poltronas, 2
// painéis de vidro) pra validar arte/profundidade/transparência antes
// dos modelos e do editor de espaço existirem de verdade -- "posição
// definitiva vem depois" já dizia o comentário antigo aqui. Ficaram
// fixos demais tempo (não editáveis pela ferramenta "Apagar", que só
// mexe em móvel colocado pelo editor -- ver comentário em
// selectDeleteTool, MainScene.ts) e o Douglas pediu pra tirar ("os
// mobis que colocamos no começo tão fixos ali no meio, não dá pra
// apagar"). Removidos -- toda mobília da sala agora entra 100% pelo
// editor de espaço (draftFurniture, salva no banco), que já tem
// colocar/mover/apagar completos.
export const ROOM_FURNITURE: FurnitureDef[] = [];

/** Retorna o móvel que TRAVA a passagem no tile dado, se houver (ver startStep() em MainScene.ts). */
/**
 * Item (fixo, ROOM_FURNITURE) que trava passagem nesse tile -- a âncora
 * (f.col,f.row) só trava se a CATEGORIA travar (FURNITURE_BLOCKS_MOVEMENT,
 * comportamento de sempre: poltrona/sofá não travam a própria âncora,
 * é onde se senta), mas qualquer OUTRO tile do footprint (ver
 * furnitureFootprintTiles/FurnitureModelDef.footprintCols) trava SEMPRE,
 * mesmo pra categoria que senta -- o resto da peça (ex: o braço/almofada
 * extra de um sofá largo) ainda não tem assento próprio ali, então
 * continua sólido em vez de andável.
 */
export function blockingFurnitureAt(col: number, row: number): FurnitureDef | undefined {
  return ROOM_FURNITURE.find((f) => {
    if (f.col === col && f.row === row) return furnitureBlocksMovement(f.type);
    // tile de ASSENTO extra (ver FurnitureModelDef.extraSeats) nunca
    // trava -- é sentável, não sólido, mesmo dentro do footprint.
    if (furnitureExtraSeats(f).some((s) => f.col + s.dCol === col && f.row + s.dRow === row)) return false;
    return furnitureFootprintTiles(f).some((t) => t.col === col && t.row === row);
  });
}

export function furnitureWorldPos(f: FurnitureDef) {
  return furnitureWorldPosAt(f, f.col, f.row);
}

/**
 * Mesma conta de furnitureWorldPos acima, num tile QUALQUER (não só a
 * âncora do item) -- usada pro boneco sentado num ASSENTO EXTRA (ver
 * FurnitureModelDef.extraSeats), que fica num tile diferente da âncora
 * mas ainda "pertence" a esse item (baseOffsetY/overflow por cima
 * seguem os mesmos, só o tile embaixo muda).
 */
export function furnitureWorldPosAt(f: FurnitureDef, col: number, row: number) {
  // tileToWorld() dá o CENTRO do tile -- é onde o boneco anda ancorado
  // (origin bottom-center dele fica bem no meio do losango, ver
  // MainScene). O móvel é diferente: ele precisa ficar "dentro do tile,
  // alinhado embaixo" (o pé/base encostando no VÉRTICE da frente do
  // losango -- o canto mais perto da câmera --, não flutuando no meio
  // dele) -- por isso ancora meio tile ABAIXO do centro, na ponta de
  // baixo (ISO_TILE_HEIGHT/2, não mais TILE/2 -- o losango é mais baixo
  // que largo, ver game/grid.ts). Ele ainda pode ultrapassar o tile por
  // CIMA (altura normalmente > 1 tile), só não pro lado nem pra baixo --
  // isso é o overflow esperado, como no Habbo.
  const center = tileToWorld(col, row);
  return { x: center.x, y: center.y + ISO_TILE_HEIGHT / 2 + (f.baseOffsetY ?? 0) };
}

// --- assento por MODELO (ver "Assento" no editor de espaço,
// GameRoom.tsx/MainScene.ts) --------------------------------------

/** Chave de agrupamento do assento -- por MODELO (não por instância colocada, ver FurnitureDef.modelId), pra ajustar um modelo UMA vez e valer pra todo item já colocado dele. Itens antigos sem modelId (ROOM_FURNITURE de antes dos modelos existirem) caem no grupo especial "classic". */
export function seatOffsetGroupKey(f: FurnitureDef): string {
  return f.modelId ?? "classic";
}

/** { grupo (ver seatOffsetGroupKey): { direção: {x,y} } } -- só guarda os que JÁ foram ajustados manualmente (ver "Assento"); um modelo nunca ajustado nem entra aqui, cai direto no padrão (ver resolveSeatOffset). Persistido no servidor junto com os móveis colocados (ver GET/POST /room/furniture em server/index.js). */
export type FurnitureSeatOffsetsMap = Record<string, Partial<Record<FurnitureFacing, { x: number; y: number }>>>;

/**
 * Deslocamento (px) de onde o boneco aparece sentado num móvel -- ordem
 * de prioridade:
 *  1. Ajuste salvo por MODELO+direção (ver FurnitureSeatOffsetsMap,
 *     "Assento" no editor de espaço) -- vale pra TODO item já colocado
 *     desse modelo, não só o que foi usado pra ajustar.
 *  2. Valor gravado na própria instância (seatOffsetX/Y no FurnitureDef)
 *     -- só existe nos itens antigos de ROOM_FURNITURE escritos à mão
 *     antes dos modelos existirem.
 *  3. Padrão do MODELO custom PARA AQUELA DIREÇÃO -- left/right/up
 *     primeiro checam seatDirectionOffsets (ajustado por aba de direção
 *     no Editor de Itens, ver comentário grande na interface); down/up
 *     sem override aí (ou down direto) caem no seatOffsetX/Y "geral" do
 *     modelo. left/right SEM seatDirectionOffsets NÃO reaproveitam o
 *     valor geral (ver #4 abaixo) -- diferente de directionOffsets (tile),
 *     um valor pensado pra frente/costas fica torto de lado com muito
 *     mais frequência do que a posição do móvel em si.
 *  4. Padrão genérico por GRUPO de direção (frente/costas x lado) -- pra
 *     um modelo novo (ou left/right sem ajuste ainda, ver #3) já sentar
 *     numa posição razoável antes de qualquer ajuste fino (mesmos
 *     valores que já eram usados fixos pra poltrona, ver
 *     SEAT_Y_FRENTE_COSTAS/SEAT_Y_LADO/SEAT_X_LADO).
 */
export function resolveSeatOffset(f: FurnitureDef, seatOffsets: FurnitureSeatOffsetsMap): { x: number; y: number } {
  const override = seatOffsets[seatOffsetGroupKey(f)]?.[f.facing];
  if (override) return override;
  if (f.seatOffsetX !== undefined || f.seatOffsetY !== undefined) {
    return { x: f.seatOffsetX ?? 0, y: f.seatOffsetY ?? 0 };
  }
  const model = f.modelId ? furnitureModelById(f.modelId) : undefined;
  const isSide = f.facing === "left" || f.facing === "right";
  if (model) {
    // narrowing inline (não via `isSide`) -- TS não propaga a checagem
    // de `f.facing` feita lá em cima pra dentro dessa variável boolean.
    if (f.facing === "left" || f.facing === "right") {
      const perDirection = model.seatDirectionOffsets?.[f.facing];
      if (perDirection) return perDirection;
    } else if (model.seatOffsetX !== undefined || model.seatOffsetY !== undefined) {
      return { x: model.seatOffsetX ?? 0, y: model.seatOffsetY ?? 0 };
    }
  }
  if (!isSide) return { x: 0, y: SEAT_Y_FRENTE_COSTAS };
  return { x: f.facing === "left" ? -SEAT_X_LADO : SEAT_X_LADO, y: SEAT_Y_LADO };
}

/**
 * Assento (se houver) no tile (col,row) dado, considerando ESSE item --
 * devolve o deslocamento (x,y) pra sentar aí, mais o dCol/dRow (relativo
 * à âncora) do assento encontrado, ou null se esse tile não é nem a
 * âncora nem um assento extra desse item (ver
 * FurnitureModelDef.extraSeats). A âncora usa resolveSeatOffset de
 * sempre (facing/override/heurístico) -- um assento extra usa o x,y
 * PRÓPRIO dele direto, sem fallback (ver comentário grande em
 * FurnitureExtraSeat). Usada tanto pra decidir se o boneco senta ao
 * parar num tile (findChairAtCurrentTile, MainScene.ts) quanto pra
 * calcular a posição visual dele sentado ali (applySeatVisualPosition).
 */
export function seatSpotAt(
  f: FurnitureDef,
  col: number,
  row: number,
  seatOffsets: FurnitureSeatOffsetsMap
): { x: number; y: number; dCol: number; dRow: number } | null {
  if (f.col === col && f.row === row) {
    const offset = resolveSeatOffset(f, seatOffsets);
    return { x: offset.x, y: offset.y, dCol: 0, dRow: 0 };
  }
  const extra = furnitureExtraSeats(f).find((s) => f.col + s.dCol === col && f.row + s.dRow === row);
  return extra ? { x: extra.x, y: extra.y, dCol: extra.dCol, dRow: extra.dRow } : null;
}

/** Nome pra mostrar no "Assento" do editor pro grupo de um item (ver seatOffsetGroupKey) -- nome do modelo quando tiver, senão o nome do tipo + "(clássica)" pros itens antigos sem modelo. */
export function seatOffsetGroupLabel(f: FurnitureDef): string {
  if (f.modelId) {
    const model = furnitureModelById(f.modelId);
    if (model) return model.label;
  }
  return `${FURNITURE_TYPE_LABEL[f.type]} (clássica)`;
}

/** Info mostrada/editada no "Assento" do editor de espaço (ver EditPanel em GameRoom.tsx) -- emitida pela cena (MainScene.ts) toda vez que o boneco local senta/levanta/tem o assento ajustado com as setas, enquanto o modo de ajuste está ligado. */
export interface SeatTuningInfo {
  groupKey: string;
  label: string;
  facing: FurnitureFacing;
  x: number;
  y: number;
}
