import { ISO_TILE_WIDTH, ISO_TILE_HEIGHT, tileToWorld } from "./grid";
import { Point } from "./iso";
// reaproveita a MESMA matemática de veio de madeira do piso (ver
// woodGrainShapesForPlank em game/floor.ts) -- ver wallPanelGrainShapes
// abaixo pro motivo de não chamar woodGrainShapesForPlank direto (ela
// devolve pontos já em coordenada de MUNDO, via rowAxis/colAxis
// rotacionados pro losango isométrico do piso; parede usa uma
// convenção LOCAL mais simples, (u,v) sem rotação nenhuma, igual
// WallBrickRect -- só a PARTE ALEATÓRIA/cor é reaproveitada, não a
// geometria).
import { darkenHex, lightenHex, grainHashPure } from "./floor";
import { luminance } from "./colorTint";

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
/**
 * Tipo de TEXTURA da face da frente de uma parede "padrão" (ver
 * WallPatternConfig abaixo) -- pedido do Douglas, com foto de
 * referência (parede de madeira com 3 painéis horizontais, separados
 * por 2 frisos/emendas visíveis): "quero deixar a parede com efeito de
 * paineis, direto nela" + "obviamente isso como opcao de textura né"
 * (ou seja, um SEGUNDO estilo de desenho, ao lado do tijolo "amarração"
 * que já existia -- nunca substituindo ele, as 2 opções convivem,
 * escolhidas por estilo cadastrado no formulário "Criar Parede").
 *
 * "brick" = tijolo em fileiras desencontradas (comportamento ORIGINAL,
 * ver wallBrickRects) -- "panel" = faixas horizontais de largura TOTAL
 * (sem subdivisão nenhuma, sem amarração -- ver wallPanelRects), cada
 * uma separada da vizinha por um friso (reaproveita mortarWidthPx/
 * mortarColor abaixo como largura/cor do friso -- não ganhou campo
 * próprio, mesma ideia de reaproveitar brickHeightPx como altura de UM
 * painel: menos campo novo no banco/formulário pra uma textura que é,
 * geometricamente, só "tijolo sem coluna nenhuma").
 *
 * Os 2 tipos compartilham a face da frente (wallFaceRects abaixo,
 * escolhe qual função de retângulo chamar, usada no MESMO lugar/ordem
 * de desenho que wallBrickRects sempre usou em
 * createWallPatternGraphics, MainScene.ts), espessura, cor do topo e
 * faces de PONTA -- MAS NÃO o RODAPÉ. 1ª pergunta do Douglas: "ele fica
 * por cima de tudo, ate do rodapé, voce consegue?" -- resposta inicial
 * foi manter o rodapé de sempre (desenhado por CIMA, como sempre foi
 * pro tijolo, cobrindo a base do painel); testando ao vivo ele corrigiu
 * o pedido: "quero por cima do rodape, quando tem painel, tira o
 * rodapé" -- ou seja, pra textura "panel" o rodapé não é só desenhado
 * ANTES (escondido atrás do painel) nem DEPOIS (por cima) -- ele
 * simplesmente NÃO EXISTE (gate `pattern.textureKind !== "panel"` em
 * volta de todo o bloco RODAPÉ, nas 3 faces que o desenham -- frente e
 * as 2 de PONTA -- ver createWallPatternGraphics). Tijolo continua com
 * o rodapé de sempre, sem mudança nenhuma. O LED (ver LedSegmentDef
 * abaixo) também "só funciona" em paredes com painel, sem nenhuma
 * mudança de código nele, porque ele já lia a geometria genérica da
 * parede (wallJunctionAt/wallPatternFrontFloorPoints em MainScene.ts),
 * nunca o tipo de textura nem o rodapé -- exatamente o que o Douglas
 * pediu: "eu queroa gora adicionar painel como opcao de textura de
 * parede, justamente pra tambem aparecer o led".
 */
export type WallTextureKind = "brick" | "panel";

export interface WallPatternConfig {
  /** Altura do painel em px "de tela" -- sem imagem pra "ditar" isso
   * (diferente do estilo com arte, ver wallWorldAnchor abaixo), esse
   * número decide o tanto que a parede sobe. Ajusta por olho no preview
   * ao vivo do Editor de Itens. */
  heightPx: number;
  /** "brick" (tijolo, comportamento de sempre) ou "panel" (ripas/
   * painéis horizontais, ver comentário grande de WallTextureKind
   * acima). Decide só a face da FRENTE (wallFaceRects) -- todo o resto
   * do desenho (topo, pontas, rodapé) é idêntico pros 2 tipos. */
  textureKind: WallTextureKind;
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
  /** Só pra textura "panel" (ver WallTextureKind acima) -- liga o
   * efeito de veio de madeira (riscos finos e semitransparentes, ver
   * wallPanelGrainShapes abaixo) por cima de cada painel. Pedido do
   * Douglas, depois de ver o primeiro painel "liso" demais: "cade a
   * madeira os veios? kkk", esclarecido como 2 opções de verdade --
   * "paineis de madeira, paineis normal liso" -- então virou TOGGLE
   * (não automático), mesma ideia/nome de FloorPatternConfig.woodGrain
   * em game/floor.ts (o piso já tinha exatamente essa escolha: tábua
   * lisa vs. com veio). Ausente/false = liso (default, mesmo default
   * do piso). Ignorado pra textura "brick" (tijolo nunca teve veio,
   * não foi pedido). */
  woodGrain?: boolean;
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
  /** Índice da FILEIRA (de baixo pra cima, 0 = encostada no chão) --
   * só preenchido por wallPanelRects (undefined em wallBrickRects, que
   * não precisa: tijolo não tem veio, ver woodGrain em
   * WallPatternConfig acima). Usado só como semente determinística do
   * veio de madeira de CADA painel (ver wallPanelGrainShapes abaixo),
   * pra 2 painéis vizinhos (fileiras diferentes) nunca sortearem o
   * mesmo veio. */
  rowIndex?: number;
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

/**
 * Mesma ideia de wallBrickRects acima, pro tipo de textura "panel" (ver
 * WallTextureKind) -- faixas horizontais (sem loop em u, sem
 * amarração/offset -- um painel não se subdivide horizontalmente igual
 * tijolo), cada uma com altura ~`pattern.brickHeightPx` (reaproveitado
 * como "altura do painel" -- ver comentário grande de WallTextureKind
 * pro motivo de não ter ganhado campo próprio; só ALVO aproximado --
 * ver ACHADO dentro da função pro motivo de toda fileira sair com a
 * MESMA altura exata, sem resto nenhum sobrando) e emoldurada por um
 * friso de `pattern.mortarWidthPx` (idem, reaproveitado como "largura
 * do friso") nos 4 lados -- horizontal ENTRE fileiras (v, condicional:
 * nunca no chão/topo da parede, ver comentário dentro da função -- "a
 * linha da borda nao pode passar no topo") E vertical nas 2 pontas do
 * painel (u, incondicional -- "espessura do friso so muda do friso
 * horizontal nao vertical", Douglas pedindo o friso vertical que
 * faltava). O LOOP em j (fileira) é o mesmo de wallBrickRects -- só o
 * loop interno em u (que fazia a amarração de tijolo) que não existe
 * aqui. Função PURA (sem Phaser/DOM), mesmo contrato de wallBrickRects
 * -- ver wallFaceRects abaixo, que escolhe entre as 2.
 */
export function wallPanelRects(pattern: WallPatternConfig, edgeLengthPx: number): WallBrickRect[] {
  const rects: WallBrickRect[] = [];
  const gap = Math.max(0, pattern.mortarWidthPx);
  // ACHADO (Douglas testando ao vivo, 2ª rodada -- "o frizo na borda
  // ainda ta ali sem a espessura pra eu editar" + "ele continua
  // cortando o topo"): a versão anterior usava rowH FIXO
  // (brickHeightPx) e cortava a ÚLTIMA fileira (a mais perto do topo)
  // no que sobrava (heightPx % rowH) -- quando esse resto era menor
  // que o friso (gap), a fileira de cima virava uma TIRA minúscula (ou
  // suficiente curta que o IF de baixo descartava ela de vez), expondo
  // o fundo (mortarColor) puro bem debaixo do topo -- uma "linha" cuja
  // espessura era na verdade o RESTO da divisão, não a "Espessura do
  // friso" nenhuma (por isso parecia "sem espessura pra editar": mudar
  // o campo de verdade não mudava aquilo). Fix: em vez de um rowH fixo
  // com resto, divide heightPx em rowCount fileiras de altura IGUAL
  // (sem resto nenhum sobrando) -- brickHeightPx vira só o ALVO
  // aproximado (arredonda pro número de fileiras mais perto que cabe
  // inteiro), mesma ideia de "Travar tábuas na grade do tile" do piso
  // (FloorPatternConfig, ItemEditor.tsx) aplicada aqui sem precisar de
  // toggle (painel sempre tranca, não tem motivo pra deixar sobra).
  const targetRowH = Math.max(4, pattern.brickHeightPx);
  const rowCount = Math.max(1, Math.round(pattern.heightPx / targetRowH));
  const rowH = pattern.heightPx / rowCount;
  for (let j = 0; j < rowCount; j++) {
    const v0Full = j * rowH;
    const v1Full = j === rowCount - 1 ? pattern.heightPx : v0Full + rowH;
    if (v1Full <= v0Full) continue;
    // só desconta a folga do friso no lado que É uma emenda de
    // verdade ENTRE 2 painéis -- nunca no chão (v=0) nem no topo
    // (v=heightPx, onde a parede encontra a face de CIMA/topColor).
    // ACHADO (Douglas testando ao vivo): a 1ª versão descontava dos 2
    // lados sempre (cópia direta do loop de fileira de wallBrickRects,
    // que É sempre incondicional ali -- só o loop INTERNO em u, que
    // não existe aqui, que tinha esse cuidado condicional pro tijolo),
    // o que deixava uma friesta/linha de friso bem na beira de cima do
    // painel, cortando contra o topo da parede: "a linha da borda nao
    // pode passar no topo". Fix: mesma condição que wallBrickRects já
    // usa no eixo horizontal (só desconta no lado que É junta de
    // verdade), aplicada aqui no eixo vertical.
    const v0 = v0Full + (v0Full > 0 ? gap / 2 : 0);
    const v1 = v1Full - (v1Full < pattern.heightPx ? gap / 2 : 0);
    if (v1 <= v0) continue;
    // friso VERTICAL -- pedido do Douglas, depois de testar ao vivo:
    // "espessura do friso so muda do friso horizontal nao vertical"
    // (ou seja, a largura do friso de verdade SÓ aparecia nas linhas
    // horizontais entre fileiras -- u0/u1 iam sempre de 0 a
    // edgeLengthPx cheio, sem desconto nenhum, então não existia friso
    // vertical NENHUM, em lugar nenhum). Diferente do v acima (onde o
    // desconto é CONDICIONAL -- nunca no chão/topo, só confirmado:
    // "a linha da borda nao pode passar no topo"), aqui é
    // INCONDICIONAL nos 2 lados -- u=0/u=edgeLengthPx são sempre a
    // ponta física do SEGMENTO de parede (nunca existe um "meio" do
    // jeito que v=0/v=heightPx são sempre chão/topo da parede inteira),
    // e é exatamente ali (nas pontas) que o friso vertical precisa
    // aparecer: tanto numa emenda reta entre 2 segmentos vizinhos
    // (metade do friso de cada lado, somando a largura cheia bem na
    // emenda -- MESMA emenda onde o LED é plantado, ver
    // LedSegmentDef/ledJunctionPoint em MainScene.ts) quanto numa
    // ponta solta (sobra só como uma margem da cor do friso, sem
    // vizinho do outro lado).
    const u0 = Math.min(edgeLengthPx / 2, gap / 2);
    const u1 = Math.max(edgeLengthPx / 2, edgeLengthPx - gap / 2);
    if (u1 <= u0) continue;
    rects.push({ u0, u1, v0, v1, rowIndex: j });
  }
  return rects;
}

/** Um polígono de veio de madeira, em coordenada LOCAL do painel (u,v --
 * MESMO espaço de WallBrickRect acima, nunca coordenada de mundo) --
 * `fillColor` já vem o hex NUMÉRICO (não CSS: quem desenha de verdade
 * decide o formato -- Phaser.Graphics.fillStyle quer número direto,
 * SVG quer string, ver hexToCss em WallPatternSwatch.tsx). */
export interface WallGrainShape {
  points: { u: number; v: number }[];
  fillColor: number;
  opacity: number;
}

/**
 * Os riscos de veio de madeira de UM painel de parede -- recebe TODAS
 * as fileiras (`rows`, cada uma um WallBrickRect com `rowIndex`
 * preenchido, ver wallPanelRects acima) de UM segmento de parede de
 * uma vez, não uma por uma.
 *
 * 2 correções grandes, as 2 testando com foto de painel de madeira de
 * verdade ao lado do resultado no jogo:
 *
 * 1) ORIENTAÇÃO -- "os veios e na vertical": a 1ª versão corria o veio
 * ao longo de U (largura), reaproveitando sem ajuste a orientação de
 * woodGrainShapesForPlank (game/floor.ts), onde o veio corre ao longo
 * do COMPRIMENTO da tábua DEITADA -- certo pro piso, errado pra um
 * painel de parede EM PÉ (madeira de verdade é serrada/montada com o
 * veio correndo na vertical). Agora o risco corre ao longo de V
 * (altura), com a onda/distribuição lado a lado em U (largura).
 *
 * 2) COMPRIMENTO/CONTINUIDADE -- "tem que ser mais realista essas
 * linha ai ficou uma bosta, esconde no piso porque tem as emendas": no
 * piso, cada risco é curto (cabe DENTRO de uma tábua só) e as juntas
 * entre várias tábuas pequenas escondem a repetição; na parede, um
 * painel é uma faixa ÚNICA e grande -- um risco igualmente curto (preso
 * dentro de só UMA fileira do friso horizontal, ~altura do painel)
 * ficava visivelmente picotado/artificial, sem nada pra "esconder" o
 * padrão. Fix: `rows` entra INTEIRO (todas as fileiras do segmento, do
 * chão até o topo) e o risco corre pela ALTURA TOTAL do painel (quase
 * de ponta a ponta, `segHalfLen` perto de `halfAlong` inteiro),
 * contínuo por trás dos frisos horizontais -- só fica de fora
 * (`insideRow`, abaixo) o pedacinho que cairia bem EM CIMA de um friso
 * de verdade (senão o veio "vazaria" por cima da linha que separa 2
 * painéis).
 *
 * Onda mais suave (menos ciclos, menos amplitude) e mais riscos, mais
 * finos -- madeira de verdade tem MUITOS veios finos quase retos, não
 * poucos bem ondulados.
 *
 * Função PURA -- usada tanto pelo preview ao vivo
 * (WallPatternSwatch.tsx) quanto pelo desenho de verdade
 * (createWallPatternGraphics em MainScene.ts), mesma garantia de
 * sempre (preview == jogo).
 *
 * `segmentSeed` diferencia o veio de UM segmento de parede do vizinho
 * (2 segmentos diferentes não sorteiam o mesmo veio) -- quem chama
 * deriva de (col,row,side) do segmento (ver createWallPatternGraphics)
 * ou usa uma constante fixa no preview (o formulário não representa um
 * segmento de verdade, só o ESTILO).
 */
/** Luminância 0..1 de uma cor hex -- reaproveita luminance(r,g,b) de
 * colorTint.ts (mesma fórmula perceptual, já usada no gerador de cor)
 * em vez de duplicar a conta aqui. */
function hexLuminance(hex: number): number {
  return luminance((hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff);
}

export function wallPanelGrainShapes(rows: WallBrickRect[], segmentSeed: number, baseColor: number): WallGrainShape[] {
  if (rows.length === 0) return [];
  const u0 = rows[0].u0;
  const u1 = rows[0].u1;
  const vBottom = Math.min(...rows.map((r) => r.v0));
  const vTop = Math.max(...rows.map((r) => r.v1));
  const halfAlong = (vTop - vBottom) / 2;
  const halfAcross = (u1 - u0) / 2;
  const cAlong = (vTop + vBottom) / 2;
  const cAcross = (u0 + u1) / 2;
  if (halfAlong <= 0 || halfAcross <= 0) return [];
  // só deixa passar o pedaço do veio que cai DENTRO de uma fileira de
  // verdade -- o que cairia num vão de friso (horizontal, entre
  // fileiras, ou vertical já recortado nas próprias rows) fica de fora.
  const insideRow = (v: number) => rows.some((r) => v >= r.v0 - 0.01 && v <= r.v1 + 0.01);
  // "mais linhas, mais finas e mais quantidade" -- Douglas testando ao
  // vivo a 1ª leva (pós-correção de orientação/continuidade, ver
  // comentário grande acima): poucos riscos grossos não lia como
  // madeira de verdade. Bem mais riscos que antes.
  const count = halfAcross * 2 < 40 ? 8 : halfAcross * 2 < 80 ? 12 : 17;
  const SEGMENTS = 16;
  const shapes: WallGrainShape[] = [];

  // NÓ da madeira -- "nó da madeira, escurecida" -- ACHADO (Douglas
  // testando ao vivo, 3ª rodada: "nem nó tem, quase nao da de ver, e
  // nao parece veio de madeira"): a 1ª leva de "mais fino" tinha
  // passado do ponto -- halfThick/opacity ficaram tão baixos que o
  // veio quase sumia (pior ainda: um risco fino o bastante pode cair
  // abaixo de 1px de verdade na tela, e a antialiasing do WebGL
  // "dilui" ele ainda mais sozinha, ficando praticamente invisível) --
  // e a chance de 60% do nó (pra "nem todo painel ter um", realista)
  // significa que é bem comum simplesmente não sair nenhum, o que lido
  // como "nem nó tem" quando cai do lado errado da moeda. Fix: chão
  // mínimo de espessura em PIXEL de verdade (Math.max abaixo, nunca
  // sub-pixel), opacidade bem mais alta, contraste de cor mais forte
  // (clareia/escurece mais), e o nó agora SEMPRE aparece (painel alto
  // o bastante), bem maior e mais escuro/opaco.
  const hasKnot = halfAlong > 24;
  const knotAlong = (grainHashPure(segmentSeed, 31, 0, 2) * 2 - 1) * halfAlong * 0.5;
  const knotAcross = (grainHashPure(segmentSeed, 31, 0, 3) * 2 - 1) * halfAcross * 0.4;
  const knotRAlong = halfAlong * (0.09 + grainHashPure(segmentSeed, 31, 0, 4) * 0.05);
  const knotRAcross = halfAcross * (0.2 + grainHashPure(segmentSeed, 31, 0, 5) * 0.12);
  // ACHADO (Douglas testando ao vivo): "em paineis escuros nao aparecem
  // os veios" -- darkenHex MULTIPLICA cada canal por um fator (<1): numa
  // cor já escura (pouco "estoque" de luz sobrando pra tirar), o
  // resultado fica quase idêntico à própria baseColor (ex: rgb(20,15,10)
  // * 0.5 ainda é quase preto, invisível contra o próprio fundo), enquanto
  // lightenHex SOMA luz na direção do branco (sempre tem "estoque" de
  // escuro sobrando pra clarear) -- por isso metade dos riscos (os que
  // caíam no lado "escurece" da moeda 50/50) e o nó inteiro (sempre
  // escurecido, nunca clareado, ver abaixo) praticamente desapareciam
  // num painel escuro. Fix: em vez de sortear clarear/escurecer 50/50
  // fixo, pesa a moeda pela luminância da própria baseColor -- painel
  // escuro sorteia MUITO mais risco "clareia" (o lado que de fato rende
  // contraste ali), painel claro sorteia mais risco "escurece" (mesma
  // lógica espelhada, pro caso oposto), e o nó troca de escurecido pra
  // clareado quando a base já é escura o bastante pra escurecer virar
  // nada.
  const baseLum = hexLuminance(baseColor);
  const lightenProb = Math.min(0.85, Math.max(0.15, 0.85 - baseLum * 0.7));

  for (let k = 0; k < count; k++) {
    const baseAcross = (grainHashPure(segmentSeed, 11, k, 1) * 2 - 1) * halfAcross * 0.8;
    const amplitude = halfAcross * (0.025 + grainHashPure(segmentSeed, 11, k, 2) * 0.05);
    const cycles = 0.3 + grainHashPure(segmentSeed, 11, k, 3) * 0.5;
    const phase = grainHashPure(segmentSeed, 11, k, 4) * Math.PI * 2;
    // chão de 1.3px DE VERDADE (não relativo) -- um risco mais fino que
    // isso vira quase nada depois da antialiasing (ver ACHADO acima).
    const halfThick = Math.max(1.3, halfAcross * (0.02 + grainHashPure(segmentSeed, 11, k, 5) * 0.025));
    const segHalfLen = halfAlong * (0.92 + grainHashPure(segmentSeed, 11, k, 6) * 0.08);
    const alongOffset = (grainHashPure(segmentSeed, 11, k, 7) * 2 - 1) * (halfAlong - segHalfLen);
    const lighten = grainHashPure(segmentSeed, 11, k, 8) < lightenProb;
    const shade = lighten
      ? lightenHex(baseColor, 0.22 + grainHashPure(segmentSeed, 11, k, 9) * 0.2)
      : darkenHex(baseColor, 0.45 + grainHashPure(segmentSeed, 11, k, 9) * 0.25);
    const opacity = 0.5 + grainHashPure(segmentSeed, 11, k, 10) * 0.3;

    const alongMin = alongOffset - segHalfLen;
    const alongMax = alongOffset + segHalfLen;
    // desvio em volta do nó -- quanto mais perto o risco passa do nó
    // (no eixo along, o "longo" do painel), mais ele é empurrado pra
    // LONGE do centro do nó (no eixo across) -- um "sino" (gaussiana)
    // centrado em knotAlong, com alcance proporcional ao raio do nó.
    // Mesmo pro painel SEM nó (hasKnot=false): a influência dá 0 sozinha
    // (nunca é chamada, ver condicional abaixo).
    const deflectAcross = (alongPos: number): number => {
      if (!hasKnot) return 0;
      const dAlong = alongPos - knotAlong;
      const spread = knotRAlong * 2.2;
      const influence = Math.exp(-(dAlong * dAlong) / (2 * spread * spread));
      const side = baseAcross >= knotAcross ? 1 : -1;
      return side * influence * knotRAcross * 1.6;
    };
    const acrossAt = (t: number) => {
      const alongPos = alongMin + (alongMax - alongMin) * t;
      return baseAcross + amplitude * Math.sin(t * Math.PI * cycles + phase) + deflectAcross(alongPos);
    };

    for (let s = 0; s < SEGMENTS; s++) {
      const t0 = s / SEGMENTS;
      const t1 = (s + 1) / SEGMENTS;
      const along0 = alongMin + (alongMax - alongMin) * t0;
      const along1 = alongMin + (alongMax - alongMin) * t1;
      const vMid = cAlong + (along0 + along1) / 2;
      if (!insideRow(vMid)) continue;
      const across0 = acrossAt(t0);
      const across1 = acrossAt(t1);
      shapes.push({
        points: [
          { u: cAcross + across0 - halfThick, v: cAlong + along0 },
          { u: cAcross + across1 - halfThick, v: cAlong + along1 },
          { u: cAcross + across1 + halfThick, v: cAlong + along1 },
          { u: cAcross + across0 + halfThick, v: cAlong + along0 },
        ],
        fillColor: shade,
        opacity,
      });
    }
  }

  // Desenha o nó em si -- anéis ovais concêntricos (de fora pra dentro).
  // ACHADO (Douglas, com foto de referência de painel de verdade: "os
  // nós nao sao tao marcados, olha essa imagem e veja oq da pra
  // chegar"): a leva anterior (contraste forte, 4 anéis bem opacos)
  // tinha ido longe demais -- virou um alvo/bullseye chamativo, quando
  // madeira de verdade tem só uma marca BEM sutil, quase lida mais como
  // uma variação de tom do que uma forma desenhada. Contraste e
  // opacidade bem mais baixos (mais perto da própria baseColor em vez
  // de longe dela), 3 anéis em vez de 4 -- ainda escurecida como pedido
  // ("escurecida"), só que de um jeito discreto -- mas com a MESMA
  // troca pra clarear (ver lightenProb acima) quando a base já é escura
  // o bastante pra escurecer virar invisível de novo.
  if (hasKnot) {
    const knotDark = baseLum >= 0.32;
    const ringCount = 3;
    const ringSegs = 20;
    for (let r = 0; r < ringCount; r++) {
      const t = r / (ringCount - 1);
      const rAlong = knotRAlong * (1 - t * 0.78);
      const rAcross = knotRAcross * (1 - t * 0.78);
      const points: { u: number; v: number }[] = [];
      for (let i = 0; i < ringSegs; i++) {
        const ang = (i / ringSegs) * Math.PI * 2;
        // oval levemente irregular (raio variando um pouco por ângulo)
        // em vez de elipse perfeita -- nó de verdade nunca é redondo
        // certinho.
        const wobble = 1 + 0.12 * Math.sin(ang * 3 + segmentSeed);
        points.push({
          u: cAcross + knotAcross + Math.cos(ang) * rAcross * wobble,
          v: cAlong + knotAlong + Math.sin(ang) * rAlong * wobble,
        });
      }
      if (!insideRow(cAlong + knotAlong)) continue;
      shapes.push({
        points,
        fillColor: knotDark ? darkenHex(baseColor, 0.8 - t * 0.2) : lightenHex(baseColor, 0.14 + t * 0.14),
        opacity: 0.3 + t * 0.14,
      });
    }
  }

  return shapes;
}

/**
 * Dispatcher -- escolhe wallBrickRects ou wallPanelRects conforme
 * pattern.textureKind (ver WallTextureKind acima). Ponto ÚNICO chamado
 * tanto pelo preview ao vivo (WallPatternSwatch.tsx) quanto pelo
 * desenho de verdade no jogo (createWallPatternGraphics, MainScene.ts)
 * -- mesma garantia de sempre (preview == jogo) que wallBrickRects já
 * dava sozinha antes de existir um segundo tipo de textura.
 */
export function wallFaceRects(pattern: WallPatternConfig, edgeLengthPx: number): WallBrickRect[] {
  return pattern.textureKind === "panel" ? wallPanelRects(pattern, edgeLengthPx) : wallBrickRects(pattern, edgeLengthPx);
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

export const WALL_CATALOG: WallCatalogEntry[] = [...GENERATED_WALL_CATALOG];

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

/** Ponta A ou B de um segmento de parede (ver wallJunctionAt em
 * MainScene.ts) -- qual dos 2 lados da aresta. */
export type WallEnd = "A" | "B";

/**
 * LED de parede -- pedido do Douglas: "efeito de led... led de parede",
 * esclarecido depois ("chat" ali era só forma de falar comigo, não
 * sobre o chat da Sala) como uma fita colorida na EMENDA entre 2
 * painéis de parede do MESMO estilo colocados lado a lado ("poe o led
 * na emenda deles", confirmado como "Entre dois paineis colocados lado
 * a lado" -- NÃO um recorte dentro de uma imagem só, pra valer com
 * QUALQUER estilo de parede, imagem ou "padrão"). "eu queria faer algo
 * simples pra usarem, como, adicioanr o led, e escolher a cor" -- sem
 * redimensionamento livre nenhum (isso travava o Douglas): o
 * tamanho/posição vêm de graça da geometria da própria emenda (ver
 * wallJunctionAt/ledJunctionPoint em MainScene.ts), só a COR é
 * escolhida.
 *
 * Mora na MESMA identidade de aresta que WallSegmentDef (col/row/side),
 * com `end` a mais (ver WallEnd acima) pra dizer qual das 2 pontas da
 * aresta é a emenda -- só faz sentido existir numa ponta classificada
 * "straight" por wallJunctionAt (2 segmentos do MESMO estilo se
 * encostando ali), nunca numa quina ou ponta solta (a ferramenta de
 * colocar, em MainScene.ts, só deixa clicar numa ponta "straight" de
 * verdade, então um LED salvo sempre deveria estar numa -- mas se o
 * segmento vizinho for apagado depois, a ponta deixa de ser "straight"
 * e o LED simplesmente para de ser desenhado, sem precisar apagar o
 * dado -- ver loadSavedLed/revalidateLedsTouching em MainScene.ts).
 *
 * CANÔNICO: uma emenda reta entre 2 segmentos é o MESMO ponto físico
 * visto de 2 jeitos (ex.: colPlus(c,r).B é o MESMO ponto que
 * colPlus(c,r+1).A, ver wallJunctionAt) -- pra nunca existirem 2 LEDs
 * "duplicados" representando a mesma emenda, SEMPRE se guarda pelo
 * lado de índice MENOR com end="B" (ver canonicalLedEnd em
 * MainScene.ts, que resolve isso ANTES de salvar/desenhar).
 */
export interface LedSegmentDef {
  col: number;
  row: number;
  side: WallSide;
  end: WallEnd;
  /** cor hex (#rrggbb) escolhida pelo jogador. */
  color: string;
}

/** Mesma ideia de wallSegmentId acima, com `end` a mais (ver
 * LedSegmentDef). */
export function ledSegmentId(col: number, row: number, side: WallSide, end: WallEnd): string {
  return `${col}_${row}_${side}_${end}`;
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
