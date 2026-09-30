import { ISO_TILE_WIDTH, ISO_TILE_HEIGHT, tileToWorld } from "./grid";
import { Point } from "./iso";

/**
 * Parede de sistema -- pedido do Douglas: "agora eu quero paredes,
 * paredes de sistema igual o piso, mesma ideia do habbo assim, mas
 * quero elas moldaveis, podem estar em qualquer lugar da sala", com um
 * desenho de referência mostrando um painel de parede (textura de
 * tijolo) encostado numa ARESTA da grade, não num tile inteiro. Por
 * isso este arquivo NÃO reaproveita FloorTileDef (piso pinta o
 * QUADRADO, parede pinta a BORDA entre dois quadrados) -- é um modelo
 * de dado novo, "aresta da grade" em vez de "centro do tile".
 *
 * Geometria da aresta: cada tile tem 4 lados no losango (ver
 * tileDiamondCorners em iso.ts: topo/direita/baixo/esquerda), e cada
 * lado é COMPARTILHADO com um vizinho -- então dá pra identificar
 * QUALQUER aresta do mapa usando só 2 valores por tile, sem duplicar:
 *   - "colPlus": lado direita->baixo do losango de (col,row), o mesmo
 *     lado esquerda->topo do vizinho (col+1,row).
 *   - "rowPlus": lado baixo->esquerda do losango de (col,row), o mesmo
 *     lado topo->direita do vizinho (col,row+1).
 * Os outros dois lados de um tile (topo->direita e esquerda->topo) NÃO
 * têm nome próprio -- são sempre a aresta colPlus/rowPlus do VIZINHO
 * correspondente (col,row-1)/(col-1,row). Isso garante que toda aresta
 * do mapa pertence a EXATAMENTE um tile+lado (sem risco de salvar a
 * "mesma parede" duas vezes com coordenadas diferentes).
 *
 * - "center"/"centerRow": pedido do Douglas ("eu quero também a opção
 *   de inserir ela no centro do tile") -- 2 opções extras, sem aresta
 *   nenhuma envolvida: o painel fica plantado bem no meio do próprio
 *   tile (col,row), mesmo comprimento de colPlus/rowPlus só que
 *   recentrado (ver wallEdgeFloorPoints abaixo), igual um pilar/divisória
 *   avulsa dentro do quadrado em vez de uma parede na fronteira entre
 *   dois. "center" segue a orientação de colPlus, "centerRow" a de
 *   rowPlus (ACHADO/pedido posterior do Douglas: "as paredes de centro
 *   de tile precisam poder nas duas direcoes, so ta em uma" -- até
 *   então só existia a variante colPlus). Só pode existir 1 de CADA
 *   orientação por tile (mesma ideia de 1 por aresta -- um "center" e
 *   um "centerRow" PODEM coexistir no mesmo tile, cruzando em X no
 *   meio dele), e são as ÚNICAS variantes que TRAVAM passagem (ver
 *   isMovementBlockedAt em MainScene.ts) -- pedido dele também: "no
 *   centro do tile, ela tem que bloquear o caminhar dai, no canto nao
 *   bloqueia", ou seja colPlus/rowPlus continuam
 *   decorativos/atravessáveis como sempre. Cada orientação só faz
 *   emenda RETA com a mesma orientação no tile vizinho na direção certa
 *   (mesma ideia de colPlus/rowPlus, ver wallJunctionAt em
 *   MainScene.ts) -- nunca quina (não dobra 90°, só estica reto).
 */
export type WallSide = "colPlus" | "rowPlus" | "center" | "centerRow";

/** Id canônico e ESTÁVEL de uma aresta -- serve tanto pra chave de mapa
 * (Map<string, ...>) quanto, no futuro, pra um item de "Decoração de
 * parede" (quadro, TV) apontar "estou pendurado NESTA parede" sem
 * precisar guardar col/row/side repetido (ver pedido do Douglas:
 * "essas paredes vao virar unidade de insercao tambem"). Determinístico
 * (não é um uuid aleatório) porque só pode existir 1 parede por aresta
 * -- o próprio col/row/side já identifica ela sozinho. */
export function wallSegmentId(col: number, row: number, side: WallSide): string {
  return `${col}_${row}_${side}`;
}

/**
 * Parede "padrão" -- pedido do Douglas: "a gente não consegue criar uma
 * geometria seguindo a mesma ideia de piso, algo criado AQUI, sem que
 * seja feito fora?" (ver FloorPatternConfig em game/floor.ts, mesma
 * ideia: SEM imagem nenhuma, desenhado por código). Criado pela aba
 * "Criar Parede" do Editor de Itens, igual "Criar Piso" -> "Padrão".
 *
 * Primeira versão (tijolo em "amarração"/running bond) desenhava a
 * parede como uma folha 2D de espessura ZERO, encostada bem na LINHA da
 * divisa entre os 2 tiles -- correção do Douglas testando ao vivo: "voce
 * ficou ela na divisa, eu quero ela no meio do tile... com espessura de
 * parede, inclusive quero editar isso na criacao" (e, depois de eu ter
 * tirado o tijolo por engano interpretando "cor solida" errado: "nao era
 * pra tirar o tijolinho kkk" -- "cor solida" era só sobre a face de CIMA,
 * que representa a espessura e não faz sentido ter tijolo nela, ver
 * comentário grande de createWallPatternGraphics em MainScene.ts). Então
 * o tijolo/argamassa CONTINUAM na face da frente (ver WallBrickRect/
 * wallBrickRects abaixo) -- o que mudou foi só a GEOMETRIA: a parede
 * agora tem volume de verdade (fica CENTRADA na divisa, metade de
 * thicknessPx pra cada lado) com uma face de CIMA fechando esse volume.
 *
 * A face de CIMA: 1ª tentativa foi clareando brickColor (efeito "luz vindo
 * de cima"); o Douglas pediu pra poder ESCOLHER essa cor à parte ("quero
 * pintar a cor de cima tambem" / "quero escolher a cor do topo"), então
 * virou campo próprio (topColor) -- só que testando ao vivo com uma cor
 * de fato diferente do tijolo (ver print: tira rosa clara destoando do
 * tijolo terracota) ele voltou atrás: "os topos devem ser preenchidos
 * igual a cor da face da parede, um pouco mais escuro por um efeito de
 * 'sombra'". Voltou a ser CALCULADA (sem campo próprio, sem formulário) --
 * só que ESCURECENDO brickColor (sombra), não clareando (luz) -- ver
 * migrations 0027/0028_room_wall_items_*top_color*.sql.
 *
 * Reversão da reversão (0029_room_wall_items_top_color_v2.sql): as
 * faces de PONTA/lateral (que fecham a espessura da parede nas pontas
 * soltas, ver createWallPatternGraphics em MainScene.ts) passaram a
 * existir depois disso, usando o MESMO escurecido automático da face de
 * CIMA -- e aí o Douglas separou os 2 casos: "a cor encima da parede eu
 * quero escolher" (a face de CIMA, plana, vista de cima) + "a cor da
 * face na espessura vertical é a cor que segue da parede" (as faces de
 * PONTA continuam calculadas, sem campo próprio -- "essa segue como
 * esta"). Então topColor voltou, mas com escopo mais estreito que antes:
 * só controla a face de CIMA. As faces de ponta continuam chamando
 * darkenColor(brickColor) direto (ver createWallPatternGraphics em
 * MainScene.ts) -- nunca leem topColor.
 */
export interface WallPatternConfig {
  /** Altura do painel em px "de tela" -- sem imagem pra "ditar" isso
   * (diferente do estilo com arte, ver wallWorldAnchor abaixo), esse
   * número decide o tanto que a parede sobe. Ajusta por olho no preview
   * ao vivo do Editor de Itens. */
  heightPx: number;
  /** Espessura da parede, em px "de tela" -- METADE fica de cada lado da
   * divisa entre os 2 tiles que essa aresta separa (ver
   * createWallPatternGraphics em MainScene.ts), dando volume de verdade
   * à parede em vez da folha 2D de espessura zero da primeira versão.
   * Editável no formulário "Criar Parede" (ItemEditor.tsx), como pedido. */
  thicknessPx: number;
  /** Largura de UM tijolo, em px "de tela" (mesma unidade solta de
   * FloorPatternConfig.plankWidthPx -- não é 1:1 com pixel de verdade,
   * ajusta por olho). */
  brickWidthPx: number;
  /** Altura de UMA fileira de tijolo, em px. */
  brickHeightPx: number;
  /** cor do tijolo (hex Phaser, ex: 0xb5502e). */
  brickColor: number;
  /** cor da argamassa/junta entre tijolos (hex Phaser) -- aparece como a
   * "grade" por trás, os tijolos são desenhados um pouco menores (ver
   * mortarWidthPx) por cima pra sobrar uma faixa dela em volta. */
  mortarColor: number;
  /** espessura da linha de junta (argamassa) entre tijolos, em px. */
  mortarWidthPx: number;
  /** cor da face de CIMA (topo/espessura, olhando pra cima -- hex
   * Phaser) -- campo PRÓPRIO, escolhido no formulário "Criar Parede"
   * (ver comentário grande acima pro histórico de ida e volta). Vale só
   * pra ESSA face: as faces de PONTA/lateral (createWallPatternGraphics
   * em MainScene.ts) não leem este campo, continuam escurecendo
   * brickColor automaticamente. */
  topColor: number;
  /** "brick" (padrão, ausente = "brick" pra não quebrar nenhuma parede
   * já salva no banco antes deste campo existir) desenha tijolo+
   * argamassa+rodapé de sempre na face da frente. "glass" é a FACHADA
   * FIXA do prédio (pedido do Douglas: "quero montar uma vidraca na
   * parte de baixo, qmostrando que eles estao em um andar alto...
   * vidraca toda reflexo, vidraca mesmo, com perfis metalicos na
   * vertical... embaixo do vidro aquele esmaecido da laje") -- troca só
   * a face da frente (gradiente de vidro + perfil metálico vertical nas
   * 2 pontas do painel + faixa escura de "laje" colada no chão, em vez
   * de tijolo+rodapé branco) e pula o rodapé branco de sempre (nas 3
   * faces: frente e as 2 de ponta) -- ver isGlass em
   * createWallPatternGraphics (MainScene.ts). Face de CIMA (topColor) e
   * faces de PONTA (brickColor escurecido) continuam iguais, sem
   * branch nenhum -- só a frente + rodapé mudam. Nunca editável pelo
   * formulário "Criar Parede" (não é campo do form, só existe no
   * catálogo fixo FACADE_GLASS_ENTRY abaixo) -- todo registro vindo do
   * banco (room_wall_items) sempre cai em "brick". */
  material?: "brick" | "glass";
}

/**
 * RODAPÉ -- pedido do Douglas: "preciso criar uma especie de rodapé
 * pras paredes", esclarecido logo em seguida como "um formato e uma
 * cor padrao pra todas, que vai contornar toda face visivel dela" --
 * ou seja, ao contrário de brickColor/topColor/etc acima, NÃO é campo
 * do formulário "Criar Parede" (sem tabela/migration, sem
 * ColorPickerField) -- é um visual FIXO, igual em toda parede "padrão"
 * do jogo, sem exceção. Uma faixa sólida (sem tijolo) colada no CHÃO
 * (v=0, ver wallBrickRects), desenhada por cima do tijolo em TODA face
 * VISÍVEL da parede (frente + a face de PONTA quando ela aparece, ver
 * createWallPatternGraphics em MainScene.ts -- "contornar toda face
 * visível" = a régua acompanha a base inteira do volume que dá pra
 * ver, não só a frente). As 2 constantes abaixo (altura/cor) moram
 * junto do resto do desenho de parede, não aqui (esse arquivo é só o
 * MODELO de dado, sem Phaser) -- ver WALL_BASEBOARD_HEIGHT_PX/
 * WALL_BASEBOARD_COLOR em MainScene.ts.
 */

/** Um retângulo de tijolo, em coordenada LOCAL do painel (u = horizontal
 * ao longo da aresta, v = vertical, v=0 na base/chão e crescendo pra
 * cima) -- já com a folga da argamassa subtraída (ver mortarWidthPx) e
 * recortado pra nunca sair de [0,edgeLengthPx]x[0,heightPx], mesmo nos
 * tijolos de PONTA (parciais, cortados pela borda do painel). */
export interface WallBrickRect {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

/**
 * Calcula os retângulos de tijolo que cobrem um painel de parede de
 * comprimento `edgeLengthPx` (u, horizontal) por `pattern.heightPx` (v,
 * vertical) -- padrão "amarração"/running bond, cada fileira
 * desencontrada da vizinha por meio tijolo (mesma ideia do colOffset de
 * FloorPatternConfig.plankLengthPx em MainScene.ts). Função PURA (sem
 * Phaser/DOM) -- usada tanto pelo preview ao vivo do Editor de Itens
 * (SVG, aba "Criar Parede") quanto pelo desenho de verdade no jogo
 * (createWallPatternGraphics em MainScene.ts), garantindo que os dois
 * batem exatamente (mesma ideia de floorPatternPolygons/
 * createFloorPatternGraphics em floor.ts/MainScene.ts).
 */
export function wallBrickRects(pattern: WallPatternConfig, edgeLengthPx: number): WallBrickRect[] {
  const rects: WallBrickRect[] = [];
  const rowH = Math.max(4, pattern.brickHeightPx);
  const brickW = Math.max(4, pattern.brickWidthPx);
  const gap = Math.max(0, pattern.mortarWidthPx);
  const rowCount = Math.max(1, Math.ceil(pattern.heightPx / rowH));
  for (let j = 0; j < rowCount; j++) {
    const v0Full = j * rowH;
    const v1Full = Math.min(pattern.heightPx, v0Full + rowH);
    if (v1Full <= v0Full) continue;
    const v0 = v0Full + gap / 2;
    const v1 = v1Full - gap / 2;
    if (v1 <= v0) continue;
    // fileira ímpar desloca meio tijolo -- mesma "amarração" do piso de
    // tábua (evita juntas verticais alinhadas entre fileiras, que
    // ficaria com cara de grade/ladrilho em vez de alvenaria de verdade.
    const offset = j % 2 === 0 ? 0 : brickW / 2;
    for (let uStart = -offset; uStart < edgeLengthPx; uStart += brickW) {
      const u0Full = uStart;
      const u1Full = uStart + brickW;
      const u0Clamped = Math.max(0, u0Full);
      const u1Clamped = Math.min(edgeLengthPx, u1Full);
      if (u1Clamped <= u0Clamped) continue;
      // só desconta a folga da junta no lado que É uma junta de verdade
      // (não no lado que foi cortado pela BORDA do painel, senão um
      // tijolo de ponta ficaria com uma faixa vazia encostada na quina).
      const u0 = u0Clamped + (u0Full >= 0 ? gap / 2 : 0);
      const u1 = u1Clamped - (u1Full <= edgeLengthPx ? gap / 2 : 0);
      if (u1 > u0) rects.push({ u0, u1, v0, v1 });
    }
  }
  return rects;
}

export interface WallCatalogEntry {
  /** "sistema-<slug-do-arquivo>" de fábrica (ver scripts/syncWallAssets.mjs)
   * pro estilo com ARTE -- pro estilo "padrão" (ver pattern abaixo) ou
   * pro custom com arte, é o uuid da linha no Supabase. */
  id: string;
  label: string;
  /** De fábrica: só o NOME do arquivo em public/assets/ (precisa do
   * prefixo "/assets/", ver preload() em MainScene.ts). Custom (com
   * arte): URL pública completa do Storage, já pronta pra usar direto.
   * Vazio ("") quando `pattern` está preenchido (tipo "padrão", sem
   * imagem nenhuma, ver abaixo) -- nunca os dois ao mesmo tempo. */
  file: string;
  /** Presente = esse modelo é "padrão" (sem imagem, ver
   * WallPatternConfig acima) -- ausente/undefined = modelo de IMAGEM,
   * comportamento de sempre (`file` é o que manda). */
  pattern?: WallPatternConfig;
  /** true só pros modelos CUSTOM (ver registerCustomWallModels abaixo)
   * -- mesma ideia de FloorCatalogEntry.custom. */
  custom?: boolean;
}

// gerado automaticamente a partir da pasta de origem (ver
// scripts/avatarAssetsConfig.mjs/syncWallAssets.mjs, roda sozinho junto
// com `npm run dev`) -- NÃO editar esse import nem o arquivo dele à mão.
import { GENERATED_WALL_CATALOG } from "./wallCatalog.generated";

/** Id fixo (nunca vem do banco) da fachada de vidro do prédio -- pedido
 * do Douglas pra dar a sensação de "prédio de verdade" (ver
 * WallPatternConfig.material acima). Comparado direto (===) em vários
 * lugares (MainScene.ts: bloqueia apagar/mover; ItemEditor.tsx: não
 * lista no catálogo de "Criar Parede" pro usuário comum) -- é assim que
 * ela fica "fixa, ninguem mexe": não tem UI nenhuma pra um usuário
 * comum colocar ou remover essa parede, só entra numa sala via script/
 * banco direto (mesma ideia do Douglas escolher à mão "os tiles que eu
 * fixar embaixo nas salas modelo"). */
export const FACADE_GLASS_STYLE_ID = "sistema-fachada-vidro";

/** Catálogo fixo (1 item só) da fachada -- NÃO vem de
 * GENERATED_WALL_CATALOG (pasta de imagem) nem de room_wall_items
 * (tabela de padrão customizado pelo usuário): é código puro, igual
 * pensado, pra nunca aparecer nem editável nem deletável por ninguém
 * além de quem mexe direto no banco/servidor. */
const FACADE_GLASS_ENTRY: WallCatalogEntry = {
  id: FACADE_GLASS_STYLE_ID,
  label: "Fachada de vidro (sistema)",
  file: "",
  pattern: {
    heightPx: 120,
    thicknessPx: 10,
    brickWidthPx: 24,
    brickHeightPx: 14,
    brickColor: 0x3c6e82,
    mortarColor: 0x3c6e82,
    mortarWidthPx: 0,
    topColor: 0xb9c3c9,
    material: "glass",
  },
};

export const WALL_CATALOG: WallCatalogEntry[] = [...GENERATED_WALL_CATALOG, FACADE_GLASS_ENTRY];

export function wallEntryById(id: string): WallCatalogEntry | undefined {
  return WALL_CATALOG.find((e) => e.id === id);
}

/** Registra modelo(s) de parede CUSTOMIZADO(s) -- mesma ideia de
 * registerCustomFloorModels em floor.ts (upsert por id, empurra direto
 * pra dentro de WALL_CATALOG, que é array por referência). Sem uso
 * ainda (não existe upload de parede custom no Editor de Itens hoje),
 * guardado pronto pro dia que existir, mesmo padrão do piso. */
export function registerCustomWallModels(entries: WallCatalogEntry[]): string[] {
  const updatedIds: string[] = [];
  for (const entry of entries) {
    const existingIndex = WALL_CATALOG.findIndex((e) => e.id === entry.id);
    const withFlag: WallCatalogEntry = { ...entry, custom: true };
    if (existingIndex !== -1) {
      updatedIds.push(entry.id);
      WALL_CATALOG[existingIndex] = withFlag;
    } else {
      WALL_CATALOG.push(withFlag);
    }
  }
  return updatedIds;
}

/** Chave da textura no Phaser pra um modelo de parede. */
export function wallTextureKey(styleId: string): string {
  return `wall-${styleId}`;
}

/** Um segmento de parede pintado numa aresta da grade. */
export interface WallSegmentDef {
  col: number;
  row: number;
  side: WallSide;
  styleId: string;
}

/**
 * Os 2 pontos (em pixel) que marcam essa aresta no CHÃO (base da
 * parede, antes de "subir" -- a altura em si vem da própria arte, ver
 * comentário de wallWorldAnchor abaixo) -- derivados dos MESMOS 4
 * cantos do losango de tileDiamondCorners (iso.ts), só que calculados
 * direto aqui (em vez de importar a função) pra pegar só os 2 cantos
 * que interessam por lado, sem montar o losango inteiro:
 *   colPlus: canto DIREITA -> canto BAIXO do losango de (col,row).
 *   rowPlus: canto BAIXO -> canto ESQUERDA do losango de (col,row).
 *   center: SEM aresta de verdade (ver comentário de WallSide acima) --
 *     mesmo comprimento/direção de colPlus (canto direita->baixo), só
 *     que recentrado no meio do losango (cx,cy) em vez de encostado no
 *     canto -- por isso plantado dentro do PRÓPRIO tile em vez de na
 *     fronteira com um vizinho.
 */
export function wallEdgeFloorPoints(col: number, row: number, side: WallSide): { a: Point; b: Point } {
  const { x: cx, y: cy } = tileToWorld(col, row);
  const hw = ISO_TILE_WIDTH / 2;
  const hh = ISO_TILE_HEIGHT / 2;
  if (side === "colPlus") {
    return { a: { x: cx + hw, y: cy }, b: { x: cx, y: cy + hh } };
  }
  if (side === "center") {
    return { a: { x: cx + hw / 2, y: cy - hh / 2 }, b: { x: cx - hw / 2, y: cy + hh / 2 } };
  }
  if (side === "centerRow") {
    // mesma ideia de "center" (recentrado no meio do losango), só que a
    // partir da aresta rowPlus em vez de colPlus -- a OUTRA orientação
    // (ver ACHADO de WallSide acima: "as paredes de centro do tile
    // precisam poder nas duas direções"). Mesma conta de recentragem
    // (desloca pelo vetor que leva o meio da aresta crua pro centro do
    // losango), aplicada em cima de rowPlus (cx,cy+hh)->(cx-hw,cy) em
    // vez de colPlus.
    return { a: { x: cx + hw / 2, y: cy + hh / 2 }, b: { x: cx - hw / 2, y: cy - hh / 2 } };
  }
  return { a: { x: cx, y: cy + hh }, b: { x: cx - hw, y: cy } };
}

/**
 * Mesmos 2 pontos de wallEdgeFloorPoints, só que DESLOCADOS pra onde a
 * face de FRENTE (tijolo/cor) de uma parede "padrão" (ver
 * WallPatternConfig acima) realmente fica desenhada --
 * createWallPatternGraphics (MainScene.ts) desloca essa face por
 * thicknessPx/2 PRA DENTRO do tile vizinho (dá volume de verdade à
 * parede, ver comentário grande lá: "a régua de fora... farA/farB"), em
 * vez de ficar bem em cima da linha da divisa como wallEdgeFloorPoints
 * devolve cru -- só a parede "padrão" tem esse deslocamento (a de
 * IMAGEM cresce reto a partir do ponto cru, ver wallWorldAnchor logo
 * abaixo).
 *
 * Usada pelo "buraco" do véu de área (updateAreaDim, MainScene.ts) pra
 * recortar a máscara no lugar CERTO -- achado testando ao vivo com o
 * Douglas ("agora deu, mas as paredes ficare de fora"): o buraco
 * desenhado em cima da linha crua não batia com a face de verdade da
 * parede "padrão" (que fica alguns pixels adiante dela, dentro do tile
 * vizinho), deixando a parede inteira escura -- só uma tira fina, onde
 * os dois quase se tocavam na base, ficava acesa.
 *
 * TAMBÉM estica as 2 pontas (a e b) por halfThick, na direção AO LONGO
 * da própria aresta -- achado com o Douglas ("olha os cantos quinados
 * onde tem mobi"): numa QUINA de verdade (2 paredes "padrão" se
 * encontrando em 90°, ver wallCornerMiterPoint/wallJunctionAt em
 * MainScene.ts), o desenho de VERDADE estica a régua de fora até o
 * ponto onde as 2 retas se CRUZAM -- fica maior que só os 2 cantos
 * crus do segmento, exatamente na quina. Sem essa esticada, o buraco
 * (que só cobre o segmento "reto", sem saber da quina) sobrava curto
 * bem na dobra -- meio pixel de parede real ficando de fora do buraco
 * ali, mais visível ainda quando tem MÓVEL colado na quina (perde a
 * "sombra" do móvel pra disfarçar). Replicar o miter de verdade
 * (interseção de retas, olhando o vizinho de cada ponta) seria a conta
 * exata, mas essa função é só uma APROXIMAÇÃO pro recorte da máscara
 * (não pro desenho de verdade) -- esticar as duas pontas por
 * halfThick (mesma ordem de grandeza do desvio que já faz a quina
 * "vazar" pra fora do segmento reto) cobre a quina sem precisar
 * consultar os vizinhos aqui. Numa emenda RETA (não quina) isso só faz
 * o buraco desse segmento se sobrepor um pouco com o do vizinho, sem
 * problema nenhum (preencher a mesma área da máscara 2x não muda
 * nada); numa ponta solta de verdade (sem vizinho nenhum), só acende
 * um pouquinho além da ponta real da parede, imperceptível no véu
 * semi-transparente.
 */
export function wallPatternFrontFloorPoints(
  seg: { col: number; row: number; side: WallSide },
  thicknessPx: number
): { a: Point; b: Point } {
  const { a, b } = wallEdgeFloorPoints(seg.col, seg.row, seg.side);
  const neighbor =
    seg.side === "rowPlus" || seg.side === "centerRow"
      ? { col: seg.col, row: seg.row + 1 }
      : { col: seg.col + 1, row: seg.row };
  const centerNear = tileToWorld(seg.col, seg.row);
  const centerFar = tileToWorld(neighbor.col, neighbor.row);
  const perpDist = Math.hypot(centerFar.x - centerNear.x, centerFar.y - centerNear.y) || 1;
  const perpX = (centerFar.x - centerNear.x) / perpDist;
  const perpY = (centerFar.y - centerNear.y) / perpDist;
  const halfThick = thicknessPx / 2;
  const frontA = { x: a.x + perpX * halfThick, y: a.y + perpY * halfThick };
  const frontB = { x: b.x + perpX * halfThick, y: b.y + perpY * halfThick };
  const edgeLength = Math.hypot(frontB.x - frontA.x, frontB.y - frontA.y) || 1;
  const alongX = (frontB.x - frontA.x) / edgeLength;
  const alongY = (frontB.y - frontA.y) / edgeLength;
  return {
    a: { x: frontA.x - alongX * halfThick, y: frontA.y - alongY * halfThick },
    b: { x: frontB.x + alongX * halfThick, y: frontB.y + alongY * halfThick },
  };
}

/** Ponto de ANCORAGEM (meio da aresta, no chão) onde a arte da parede é
 * posicionada -- origem da sprite fica em (0.5, 1) (centro-baixo, mesma
 * ideia de "pé" que várias artes de móvel já usam), então a arte
 * "cresce pra cima" a partir daí. Só usado pro estilo COM ARTE -- a
 * altura, nesse caso, não é um número guardado em lugar nenhum, é
 * literalmente o tanto de pixel que a arte (PNG) tem, exatamente como
 * já funciona pra móvel (sem campo de "altura" no FurnitureModelDef, é
 * só o tamanho da imagem) -- ver scripts/syncWallAssets.mjs. O estilo
 * "padrão" (ver WallPatternConfig acima) não usa esse ponto -- desenha
 * direto a partir dos 2 cantos de wallEdgeFloorPoints (ver
 * createWallPatternGraphics em MainScene.ts), já que aí SIM existe um
 * heightPx explícito. */
export function wallWorldAnchor(seg: WallSegmentDef): Point {
  const { a, b } = wallEdgeFloorPoints(seg.col, seg.row, seg.side);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Comprimento (euclidiano, em px de tela) da aresta -- é o "u" máximo do
 * painel de parede "padrão" (ver wallBrickRects acima), usado tanto pelo
 * desenho de verdade (createWallPatternGraphics em MainScene.ts) quanto
 * pelo preview ao vivo do formulário "Criar Parede" (ItemEditor.tsx/
 * WallPatternSwatch.tsx). Constante pra qualquer aresta do jogo hoje (a
 * grade é uniforme), mas calculado a partir dos pontos de verdade em vez
 * de fixo, por clareza. */
export function wallEdgeLengthPx(col: number, row: number, side: WallSide): number {
  const { a, b } = wallEdgeFloorPoints(col, row, side);
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Profundidade de desenho de uma parede -- ela fica ENTRE as
 * profundidades dos dois tiles que ela separa (o de trás e o da
 * frente), assim o móvel/boneco do tile de trás desenha ATRÁS dela e o
 * do tile da frente desenha NA FRENTE dela, igual uma parede de
 * verdade dividindo o ambiente. `furnitureDepthForTile` é passado por
 * fora (MainScene.ts) pra este arquivo não duplicar essa fórmula.
 *
 * "center" não separa 2 tiles (mora dentro de só 1, ver WallSide acima)
 * -- só que usar a profundidade do próprio tile DIRETO (ideia original,
 * "mesma ideia de um móvel comum") tinha um bug sério, só visível numa
 * parede (móvel comum é baixo/raso, nunca dava pra notar): o valor de
 * furnitureDepthForTile(col,row) é EXATAMENTE igual ao centro do tile
 * ATRÁS dela (col+row-1) -- um EMPATE de verdade contra o boneco parado
 * ali, não uma aproximação. Empate de profundidade no Phaser desenha
 * por ORDEM DE INSERÇÃO (não por posição), e o boneco quase sempre é
 * inserido DEPOIS da parede (ela já existia, salva, antes dele entrar
 * na sala) -- então o boneco sempre "ganhava" o empate e desenhava por
 * cima, mesmo estando no tile de TRÁS (deveria ficar escondido atrás
 * da parede). Pra móvel baixo isso nunca dava pra perceber (não tem
 * silhueta alta o bastante pra notar a ordem errada), mas numa
 * pilastra alta ficava bem visível (Douglas com print: "parede com
 * regra de camada errada, avatar ta na frentet"). Fix: desloca meio
 * passo de fileira (ISO_TILE_HEIGHT/4) pra dentro do próprio tile --
 * mesmo deslocamento que a MÉDIA de 2 tiles já dá de graça pro
 * colPlus/rowPlus abaixo (por isso eles nunca tiveram esse bug), só
 * que sem vizinho nenhum pra tirar média -- tira o empate de vez (o
 * boneco do tile de trás nunca mais bate exatamente na fronteira).
 */
export function wallDepthForSegment(
  seg: WallSegmentDef,
  furnitureDepthForTile: (col: number, row: number) => number
): number {
  if (seg.side === "center" || seg.side === "centerRow") {
    return furnitureDepthForTile(seg.col, seg.row) + ISO_TILE_HEIGHT / 4;
  }
  const neighbor = seg.side === "colPlus" ? { col: seg.col + 1, row: seg.row } : { col: seg.col, row: seg.row + 1 };
  return (furnitureDepthForTile(seg.col, seg.row) + furnitureDepthForTile(neighbor.col, neighbor.row)) / 2;
}

/**
 * Dado um ponto qualquer em coordenada de MUNDO (pixel), acha a aresta
 * da grade mais perto dele -- usado pela ferramenta de pintar parede no
 * modo "Borda" (ver wallPlacementMode em MainScene.ts; mesma ideia de
 * worldToTile, mas pra aresta em vez de tile inteiro). Só sabe achar
 * colPlus/rowPlus -- o modo "Centro do tile" (pedido do Douglas, ver
 * WallSide acima) usa worldToTile direto (col/row do tile mesmo, sem
 * aresta nenhuma envolvida), então não passa por esta função.
 *
 * Truque: no espaço col/row (antes de projetar pra tela) a grade é só
 * um quadriculado comum -- o losango é só a PROJEÇÃO na tela (ver
 * comentário grande em grid.ts). Então, em vez de medir distância até
 * cada segmento de reta na tela, basta calcular col/row FRACIONÁRIO
 * (sem arredondar) e ver se a parte fracionária "sobra" mais pro lado
 * do col ou do row -- isso já diz sozinho qual dos 4 lados do tile
 * mais próximo está mais perto do cursor, sem nenhuma trigonometria:
 *   fracCol/fracRow em [-0.5, 0.5] cada -- o maior valor absoluto entre
 *   os dois manda; o SINAL dele diz se é o lado "colPlus"/"rowPlus" do
 *   tile arredondado ou o do vizinho anterior (col-1 ou row-1), que por
 *   sua vez É o colPlus/rowPlus DESSE vizinho (ver comentário no topo
 *   do arquivo sobre os 2 lados sem nome próprio).
 */
export function nearestWallEdge(x: number, y: number, gridOriginX: number, gridOriginY: number): {
  col: number;
  row: number;
  side: WallSide;
} {
  const a = (x - gridOriginX) / (ISO_TILE_WIDTH / 2);
  const b = (y - gridOriginY) / (ISO_TILE_HEIGHT / 2);
  const colF = (a + b) / 2;
  const rowF = (b - a) / 2;
  const col = Math.round(colF);
  const row = Math.round(rowF);
  const fracCol = colF - col;
  const fracRow = rowF - row;

  if (Math.abs(fracCol) >= Math.abs(fracRow)) {
    return fracCol >= 0 ? { col, row, side: "colPlus" } : { col: col - 1, row, side: "colPlus" };
  }
  return fracRow >= 0 ? { col, row, side: "rowPlus" } : { col, row: row - 1, side: "rowPlus" };
}
