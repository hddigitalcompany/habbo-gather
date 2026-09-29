"use client";

// "Editor de Itens" -- pedido do Douglas: cadastrar móvel novo direto
// pela tela (upload de imagem), sem precisar organizar pasta local nem
// rodar `npm run sync-assets`, e sem ficar salvo só no computador dele
// -- guardado no Supabase (Storage + tabela room_items, ver
// supabase/migrations/0002_room_items.sql). Só aparece pro admin da
// PLATAFORMA (tabela platform_admins, ver isPlatformAdmin em
// GameRoom.tsx / supabase/migrations/0031_platform_admins.sql) -- NÃO
// é o mesmo gate do painel de membros (isso é dono de SALA, gente
// diferente a partir de quando cada empresa tiver seu próprio dono).
//
// Upload vai DIRETO do navegador pro Storage (usa o token da própria
// pessoa -- a policy do bucket confere "é admin da plataforma?" no
// banco, ver 0031_platform_admins.sql) -- só os METADADOS (nome/
// categoria/URLs já prontas) vão pro nosso servidor (POST /api/items,
// PATCH /api/items/[id]), que confere de novo antes de gravar.
import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { CUSTOM_ITEM_TARGET_WIDTH, SEAT_X_LADO, SEAT_Y_LADO } from "@/game/furniture";
import type { FurnitureModelColorOption } from "@/game/furniture";
import { ISO_TILE_WIDTH, ISO_TILE_HEIGHT } from "@/game/grid";
import { FLOOR_CATEGORIES, FloorCategory, TILE_SIZED_PLANK_PX } from "@/game/floor";
import { FloorPatternSwatch } from "@/components/FloorPatternSwatch";
import { wallEdgeLengthPx } from "@/game/wall";
import { DOOR_KINDS, DoorKind, doorEdgeLengthPx } from "@/game/door";
import { WallPatternSwatch } from "@/components/WallPatternSwatch";
import { ColorPickerField } from "@/components/ColorPickerField";
import { FRAME_W, FRAME_H, AVATAR_SCALE, AVATAR_FOOT_OFFSET_Y } from "@/game/MainScene";
import {
  HAIR_CATALOG,
  DEFAULT_HAIR_ID,
  SKIN_CATALOG,
  DEFAULT_SKIN_ID,
  OUTFIT_CATALOG,
  DEFAULT_OUTFIT_ID,
  outfitFileForSkin,
  AvatarGender,
  ColorOption,
} from "@/game/customization";
import ColorZoneTool from "@/components/ColorZoneTool";
import FurnitureColorZoneTool from "@/components/FurnitureColorZoneTool";

type CategoryId = "poltrona" | "divisoria" | "sofa" | "mesa" | "planta" | "computador";
type DirectionKey = "down" | "left" | "right" | "up";
/** Facing de MOBI/PAREDE -- superset de DirectionKey com 2 posições
 * EXTRAS só pra parede/divisória: "cornerTop"/"cornerBottom" ("quina de
 * cima"/"quina de baixo", pedido do Douglas: "nas paredes adicione mais
 * duas posicoes, quina de cima, quina de baixo" -- depois de já ter
 * "quina esquerda"/"quina direita", que reaproveitam left/up de
 * DirectionKey, ver WALL_DIRECTION_FIELDS abaixo). Fica SEPARADO de
 * DirectionKey de propósito: esse tipo aqui também é usado pro Avatar/
 * traje/cabelo/pele neste mesmo arquivo, sempre travado nas 4 direções
 * de sempre (o boneco não tem sprite pras quinas extras, ver
 * SENTADO_FRAMES/playWalk em MainScene.ts) -- só o formulário de Mobi/
 * Parede (files/existingArt/direction_offsets/direction_display_width/
 * activeMobiDirection) usa esse tipo mais largo, pra não arriscar
 * quebrar nada do editor de avatar. Mesmo tipo de game/furniture.ts
 * (FurnitureFacing) -- ver comentário lá pro porquê de NÃO ser o mesmo
 * Direction usado pro andar do avatar (game/grid.ts). */
type MobiFacing = DirectionKey | "cornerTop" | "cornerBottom";

// múltiplo de folga acima do tamanho que o item aparece no jogo (ver
// CUSTOM_ITEM_TARGET_WIDTH em game/furniture.ts) -- pedido do Douglas:
// gera no ChatGPT, monta no Canva, redimensiona pro tamanho final e só
// depois sobe aqui. Isso custava um tanto de qualidade nesse
// redimensionamento manual (e ida-e-volta pra eu ajudar a acertar o
// tamanho), e além disso ele notou que de LONGE (zoom afastado) o móvel
// borra mesmo de perto tendo qualidade -- isso é o efeito clássico de
// encolher demais uma textura no WebGL sem ela ter uma versão
// intermediária: quanto maior a diferença entre o tamanho do arquivo e o
// tamanho exibido, mais a GPU "erra a média" dos pixels ao amostrar pra
// baixo, e borra. Por isso a imagem AGORA é redimensionada aqui no
// navegador (resizeImageForUpload, logo abaixo) pra um teto de ~3x o
// tamanho final -- folga o suficiente pra ficar nítido em qualquer
// zoom (a mesma técnica de "arte em alta, exibida menor" que sites/apps
// bons usam pra tela Retina), sem sobrar tanta diferença que borre. A
// pessoa não precisa mais encolher NADA à mão -- sobe do jeito que
// gerou/montou, em qualquer resolução, e esse teto só corta o excesso.
const UPLOAD_SUPERSAMPLE = 3;

// pedido do Douglas: as imagens que ele gera não vêm num padrão de
// proporção (uma poltrona pode sair "quadrada", outra "alongada"), então
// o mesmo alvo de largura por CATEGORIA (CUSTOM_ITEM_TARGET_WIDTH) dava
// resultado de tamanho bem diferente de item pra item -- precisa ajustar
// cada um à mão, olhando o resultado. displayWidth (abaixo) é esse
// ajuste, mostrado ao vivo no preview grande (ver item-stage) antes de
// cadastrar -- persistido por ITEM (não por categoria, ver
// display_width em supabase/migrations/0003_room_items_display_width.sql
// e o uso em addFurnitureSprite, MainScene.ts). Min/max/step escalados
// 1.5x junto com a resolução interna do jogo (mesma proporção de antes).
// Teto subido de 600 pra 1200 (ver supabase/migrations/
// 0020_room_items_display_width_max.sql) -- pedido do Douglas
// trabalhando nas paredes ("Criar Parede"): "vou precisar de mais
// opcoes de escala no redimensionamento ali dentro do editar, mais uma
// linha ja bate" -- uma parede cobrindo boa parte do fundo da sala
// precisa de bem mais que qualquer móvel, e 600px já batia no teto.
const DISPLAY_WIDTH_MIN = 60;
const DISPLAY_WIDTH_MAX = 1200;
const DISPLAY_WIDTH_STEP = 8;

// mesmo teto -300..300 da constraint no banco (ver
// supabase/migrations/0004_room_items_icon_offset.sql).
const OFFSET_LIMIT = 300;

// tamanho alvo (px, na TELA -- não no jogo) do botão do catálogo (ver
// .palette-btn em app/globals.css) -- usado só pra calcular o teto de
// upload do ÍCONE (mesma ideia do UPLOAD_SUPERSAMPLE acima, aplicado a
// um alvo bem menor que o dos uploads de direção).
const ICON_BUTTON_SIZE = 48;

// fator só pra deixar o card GRANDE o suficiente pra enxergar bem
// (pedido do Douglas: "preciso disso num card maior, com a imagem
// maior") -- multiplica avatar, item E tile pelo MESMO número, então a
// PROPORÇÃO entre os três continua idêntica à do jogo de verdade, só
// maior na tela.
const PREVIEW_SCALE = 2.5;

// altura do "boneco real" no preview (pedido do Douglas: "quero boneco
// real ali dentro em perspectiva certa, e o quadrado também", ver
// item-stage-avatar abaixo) -- FRAME_H/AVATAR_SCALE vêm de
// game/MainScene.ts (exportados só pra isso, ver comentário lá) em vez
// de duplicados à mão aqui: single source of truth, sem risco de
// desalinhar numa próxima mudança de escala do jogo (quase aconteceu
// antes com um AVATAR_REF_HEIGHT calculado à mão que esse preview
// substituiu).
const AVATAR_DISPLAY_H = FRAME_H * AVATAR_SCALE * PREVIEW_SCALE;
const AVATAR_DISPLAY_W = FRAME_W * AVATAR_SCALE * PREVIEW_SCALE;
// distância (px, na tela) do pé do boneco até o vértice de BAIXO do
// losango do tile (grade isométrica, ver game/grid.ts -- era a borda de
// baixo de um quadrado, virou a ponta da frente de um losango) -- o
// boneco ancora no CENTRO do tile (+ AVATAR_FOOT_OFFSET_Y pra baixo, só
// visual, ver comentário em MainScene.ts), o móvel ancora nesse vértice
// de baixo (ver furnitureWorldPos, game/furniture.ts) -- são pontos
// DIFERENTES do mesmo tile, por isso o boneco "flutua" um pouco acima
// da base no preview -- é assim no jogo de verdade também.
const AVATAR_FOOT_FROM_TILE_BOTTOM = (ISO_TILE_HEIGHT / 2 - AVATAR_FOOT_OFFSET_Y) * PREVIEW_SCALE;
// largura/altura (px, na tela) do losango de referência -- era um
// quadrado único (TILE_SIZE_PX); agora largura e altura do tile são
// DIFERENTES (proporção 2:1, ver ISO_TILE_WIDTH/ISO_TILE_HEIGHT), então
// viraram duas constantes.
const TILE_WIDTH_PX = ISO_TILE_WIDTH * PREVIEW_SCALE;
const TILE_HEIGHT_PX = ISO_TILE_HEIGHT * PREVIEW_SCALE;
// margem abaixo da base do tile -- espaço pra arrastar o item pra baixo
// (offsetY positivo) e pro quadrado continuar visível inteiro.
const STAGE_BASELINE_PAD = 70;
// margem ACIMA da cabeça do boneco -- pedido do Douglas: "aumente essa
// area de exibicao eu preciso ver a cabeca toda dele, nao mude a
// dimensao do boneco nem posicionamento". Cabelo alto/grande (ex:
// gerado por IA, penteados enrolados/compridos) passa da altura da
// própria cabeça e ficava cortado (overflow-y:hidden do .item-stage) --
// era só 24px de sobra ali em cima. O boneco em si é ancorado pela
// BASE (bottom:STAGE_BASELINE_PAD+AVATAR_FOOT_FROM_TILE_BOTTOM, ver
// item-stage-avatar no JSX), então aumentar só essa margem do TOPO
// cresce o card SEM mexer no tamanho/posição do boneco -- ele continua
// exatamente onde estava, só sobra mais espaço vazio acima dele agora.
const STAGE_TOP_PAD = 160;
const STAGE_HEIGHT = Math.ceil(STAGE_BASELINE_PAD + AVATAR_FOOT_FROM_TILE_BOTTOM + AVATAR_DISPLAY_H + STAGE_TOP_PAD);
// grade de footprint CLICÁVEL (ver mobiFootprintTiles/isFootprintTileSelected
// mais abaixo) -- pedido do Douglas: "nao tem como a grande ja vir
// aberta, com a insersao no meio?? 2 pra cada lado da insercao". Antes
// crescia só pra baixo-direita a partir da âncora (0..footprintCols-1,
// 0..footprintRows-1, IGUAL o retângulo cego de sempre) -- sem dar pra
// marcar bloqueio nos outros 2 quadrantes (acima/à esquerda da âncora),
// que é exatamente onde uma peça precisa travar quando vira de lado
// (rotaciona). Agora é uma grade FIXA (sempre a mesma, não depende mais
// de "Ocupa (tiles)"), N tiles pra CADA lado da âncora nas 2 direções
// (dCol/dRow de -N a N, âncora bem no meio) -- sempre visível de cara,
// sem precisar digitar um tamanho antes de poder clicar. Baixado de 2
// pra 1 (3x3 em vez de 5x5) -- pedido do Douglas: "pode diminuir, apenas
// um pra cada lado do tile de insersao" (5x5 era grade demais pra maioria
// dos móveis).
const FOOTPRINT_GRID_RADIUS = 1;
// card menor só na aba Avatar (pedido do Douglas: "esse espaco do
// editor em avatar ta mt grande" -- e depois "você não consegue cortar
// a janela ao invés de tirar zoom?", recusando a ideia de encolher via
// zoom, ver comentário grande onde `zoom` é declarado). Primeira
// tentativa (60px de folga) tinha voltado o STAGE_TOP_PAD cheio porque
// ".item-stage" tem overflow-y:hidden -- cabelo/traje que já tivesse
// sido arrastado pra cima contando com os 160px originais sumia,
// cortado pelo overflow (ver revert no commit 08cc428). Dessa vez o
// overflow-y vira "visible" (ver .item-stage em globals.css) junto com
// esse pad menor: um item com offset extremo (de antes de existir essa
// folga menor, ou arrastado além dela) passa a só ESPIRRAR pra fora do
// card por cima em vez de desaparecer -- nunca mais fica invisível/
// impossível de arrastar, só eventualmente maior que a moldura branca
// num caso extremo (raro -- a maioria fica bem dentro do pad).
// Segunda rodada ("ta dificil ein kkkk corta logo essa janela, eu
// quero ela menor em relacao ao meu monitor"): 60px ainda não bastava
// -- com overflow já seguro (visible), dá pra cortar mais ainda, volta
// pro valor mínimo original de antes do Douglas pedir mais espaço em
// cima ("aumente essa area de exibicao eu preciso ver a cabeca toda
// dele"). .items-panel também ganhou max-height menor (ver globals.css)
// pra janela toda ficar menor em relação ao monitor, não só esse card.
const AVATAR_STAGE_TOP_PAD = 24;
const AVATAR_STAGE_HEIGHT = Math.ceil(
  STAGE_BASELINE_PAD + AVATAR_FOOT_FROM_TILE_BOTTOM + AVATAR_DISPLAY_H + AVATAR_STAGE_TOP_PAD
);
// TENTATIVA REVERTIDA: pedido do Douglas ("esse espaco do editor em
// avatar ta mt grande") levou a um AVATAR_STAGE_HEIGHT menor (só a aba
// Avatar), mas isso quebrou de verdade: ".item-stage" tem
// overflow-y:hidden (ver globals.css), e o placement (offsetX/offsetY)
// de cabelo/traje já cadastrado foi ajustado no passado CONTANDO com os
// 160px de STAGE_TOP_PAD de folga acima do boneco -- com só 60px, um
// item arrastado mais pra cima que isso ficava cortado pelo
// overflow:hidden (Douglas: "em avatar aparece mas nao me deixa
// arrastar mexer / em traje nem aparece mais"). Revertido pra
// STAGE_HEIGHT cheio nas duas abas até ter uma forma de encolher o
// card sem cortar posição já salva (ex: permitir scroll em vez de
// overflow:hidden, ou reduzir SÓ o `zoom` inicial do preview).

// Réguas de medida no preview (pedido do Douglas: "coloca umas linhas de
// medida, a partir do tile, pra eu conseguir me posicionar melhor") --
// mesma unidade "real" que os offsetX/offsetY mostrados no texto embaixo
// do preview (ex: "x: 20px"), só multiplicada por PREVIEW_SCALE pra virar
// posição de tela, igual todo o resto dos preview (item-stage-avatar,
// avatar-art-drag-box etc). RULER_UNIT = espaçamento entre marcações;
// RULER_X_RANGE/RULER_Y_RANGE = até onde iso (o excesso é cortado de
// graça pelo overflow do .item-stage, não precisa ser exato).
const RULER_UNIT = 10;
const RULER_X_RANGE: [number, number] = [-100, 100];
// -180 -> -240: acompanha o STAGE_TOP_PAD maior acima (senão a grade
// parava de desenhar antes do topo novo do card, deixando uma faixa em
// branco sem régua ali).
const RULER_Y_RANGE: [number, number] = [-240, 60];

// ACHADO no print do Douglas ("continua ocupando toda a tela, corta essa
// janela"): o card tinha MESMO encolhido (AVATAR_STAGE_TOP_PAD 60->24,
// ver acima), só que a RÉGUA continuava desenhando o RULER_Y_RANGE
// inteiro de cima (-240 até 60), dimensionado pro STAGE_TOP_PAD GRANDE
// de antes (160px -- é literalmente o que o comentário ali em cima já
// avisava: "o excesso é cortado de graça pelo overflow do .item-stage").
// Isso só funcionava de graça enquanto ".item-stage"/".item-stage-compact"
// tinha overflow-y:hidden -- na rodada anterior esse overflow virou
// "visible" (pra parar de sumir traje arrastado pro alto), e sem aquele
// corte de graça a régua passou a esticar o card de VERDADE pra fora dos
// 24px novos, voltando a ocupar quase a régua TODA de novo -- por isso
// encolher só o pad não bastou, o print do Douglas ainda mostrava -240
// até 60 do mesmo jeito de antes. Esse range compacto acompanha o
// AVATAR_STAGE_TOP_PAD de verdade (deriva dele em vez de número fixo
// escolhido à mão, pra nunca mais desalinhar se o pad mudar de novo) --
// só usado na aba Avatar (ver AVATAR_STAGE_HEIGHT); a aba Mobi continua
// com o RULER_Y_RANGE grande de cima, que combina com o STAGE_HEIGHT
// grande dela (não encolhida).
const AVATAR_RULER_Y_RANGE: [number, number] = [
  -Math.ceil((AVATAR_DISPLAY_H + AVATAR_STAGE_TOP_PAD) / (AVATAR_SCALE * PREVIEW_SCALE) / RULER_UNIT) * RULER_UNIT,
  60,
];

function rulerTicks(range: [number, number], unit: number): number[] {
  const ticks: number[] = [];
  for (let v = 0; v >= range[0]; v -= unit) ticks.push(v);
  for (let v = unit; v <= range[1]; v += unit) ticks.push(v);
  return ticks;
}

/**
 * Cruz de referência (x=0/y=0 -- o mesmo ponto de ancoragem que
 * offsetX/offsetY=0 usa em cada preview, "a partir do tile") + marcações
 * a cada RULER_UNIT px reais, com o valor escrito do lado. Só leitura
 * (pointer-events: none) -- não atrapalha o arraste de quem tá por
 * baixo. `anchorBottomPx` é o "bottom" (em px de tela, já com
 * PREVIEW_SCALE aplicado) onde y=0 cai nesse preview específico --
 * cada chamador passa o seu (ver STAGE_BASELINE_PAD/
 * AVATAR_FOOT_FROM_TILE_BOTTOM nos usos abaixo).
 */
function StageRuler({
  anchorBottomPx,
  pxPerUnit = PREVIEW_SCALE,
  yRange = RULER_Y_RANGE,
}: {
  anchorBottomPx: number;
  pxPerUnit?: number;
  yRange?: [number, number];
}) {
  const xTicks = rulerTicks(RULER_X_RANGE, RULER_UNIT);
  const yTicks = rulerTicks(yRange, RULER_UNIT);
  return (
    <div className="stage-ruler">
      {/* linhas VERTICAIS inteiras (uma por marcação de x) -- pedido do
          Douglas: "faz elas em grade" (antes só tinha tracinho curto em
          cada marcação, agora atravessa o preview inteiro, formando uma
          grade de verdade). A de x=0 fica destacada (mesmo eixo
          principal de antes). pxPerUnit converte "px reais" (mesma
          unidade de offsetX/offsetY) pra "px de tela" -- PREVIEW_SCALE
          sozinho pro móvel (sem fator de escala próprio), mas
          AVATAR_SCALE*PREVIEW_SCALE pro avatar (ver comentário grande
          sobre avatar-art-drag-box logo abaixo -- tem que bater com a
          MESMA conversão que a caixa de arrastar usa, senão a régua
          mente sobre onde as coisas vão parar). */}
      {xTicks.map((v) => (
        <div
          key={`rx${v}`}
          className={v === 0 ? "stage-ruler-line stage-ruler-line-v stage-ruler-line-zero" : "stage-ruler-line stage-ruler-line-v"}
          style={{ left: `calc(50% + ${v * pxPerUnit}px)` }}
        >
          <span className="stage-ruler-label stage-ruler-label-x">{v}</span>
        </div>
      ))}
      {/* linhas HORIZONTAIS inteiras (uma por marcação de y), mesma
          ideia. A de y=0 (anchorBottomPx -- o ponto que offsetY=0 usa,
          "a partir do tile") fica destacada. */}
      {yTicks.map((v) => (
        <div
          key={`ry${v}`}
          className={v === 0 ? "stage-ruler-line stage-ruler-line-h stage-ruler-line-zero" : "stage-ruler-line stage-ruler-line-h"}
          style={{ bottom: anchorBottomPx - v * pxPerUnit }}
        >
          <span className="stage-ruler-label stage-ruler-label-y">{v}</span>
        </div>
      ))}
    </div>
  );
}

// "boneco de referência" pro preview -- SEMPRE o penteado/tom/traje
// PADRÃO (não é o boneco de verdade de ninguém, é só uma régua visual),
// igual o resto do editor já fazia com a silhueta antiga. Traje
// PRECISA ser um de verdade (não "Nenhum"/DEFAULT_OUTFIT_ID, que é um
// arquivo transparente): desde que a camada base virou só cabeça (ver
// scripts/syncSkinAssets.mjs), o boneco de referência ficaria sem corpo
// nenhum com o traje padrão.
// "boneco de referência" do editor de MOBI (cabelo/tom/traje padrão pra
// posicionar item/assento por cima, ver referenceHair/referenceSkin/
// referenceOutfit dentro do componente ItemEditor, perto de
// mobiFrameOffsetXPx) -- NÃO são mais `const` fixas aqui no topo do
// módulo (congeladas na primeira vez que o arquivo carrega): SKIN_CATALOG
// começa VAZIO e HAIR/OUTFIT_CATALOG só ganham os itens CUSTOM depois de
// um fetch assíncrono (ver fetchAndRegisterCustomAvatarItems em
// GameRoom.tsx), que roda DEPOIS do módulo já ter sido avaliado -- uma
// `const` no topo do arquivo ficava pra sempre travada no que o catálogo
// tinha nesse instante zero. Pedido do Douglas: "ja subi um traje
// sentado, adiciona na edicao de mobi pra eu posicionar" -- o traje que
// ele acabou de subir (com pose "Sentado" de verdade) nunca aparecia no
// boneco arrastável aqui, mesmo depois do upload terminar. Recalculado a
// cada render (dentro do componente, array `.find`/`.filter` simples,
// sem custo real) acompanha o catálogo sempre que ele muda.

const CATEGORIES: { id: CategoryId; label: string }[] = [
  { id: "poltrona", label: "Poltrona" },
  { id: "divisoria", label: "Divisória" },
  { id: "sofa", label: "Sofá" },
  { id: "mesa", label: "Mesa" },
  { id: "planta", label: "Planta" },
  { id: "computador", label: "Computador" },
];

// palpite inicial de "Tem interação?" a partir da categoria escolhida
// (mesmo critério de sempre -- ver isSittableFurnitureType em
// game/furniture.ts) -- só o ponto de partida no formulário de item
// NOVO, o Douglas pode mudar à mão (ver seletor "Tem interação?").
const DEFAULT_SITTABLE_BY_CATEGORY: Record<CategoryId, boolean> = {
  poltrona: true,
  sofa: true,
  divisoria: false,
  mesa: false,
  planta: false,
  computador: false,
};

// "down/left/right/up" = mesma convenção de direção do resto do jogo
// (ver game/grid.ts) -- rótulo em português só pro formulário.
// Rótulos "Frente esquerda/direita" e "Costas esquerda/direita" (pedido
// do Douglas: "muda os nomes pra isso pra mim") em vez de "Frente/Lado
// esquerdo/Lado direito/Costas" -- na grade ISOMÉTRICA (ver game/grid.ts),
// cada uma das 4 direções lógicas (down/left/right/up, que NÃO mudaram --
// só o texto exibido) sai numa diagonal da tela, não num lado reto: down
// anda pra baixo-ESQUERDA da tela (frente esquerda), right anda pra
// baixo-DIREITA (frente direita), up anda pra cima-DIREITA (costas
// direita), left anda pra cima-ESQUERDA (costas esquerda) -- conta feita
// em cima do delta de col/row de cada direção (ver startStep em
// MainScene.ts) contra tileToWorld. Os nomes antigos (retos) não
// combinavam mais com o ângulo de verdade da arte isométrica.
const DIRECTION_FIELDS: { key: DirectionKey; label: string; required: boolean }[] = [
  { key: "down", label: "Frente esquerda", required: true },
  { key: "left", label: "Costas esquerda", required: false },
  { key: "right", label: "Frente direita", required: false },
  { key: "up", label: "Costas direita", required: false },
];

// parede (mode "parede", categoria "divisoria") NÃO usa "Costas
// esquerda/direita" -- painel fixo na borda de trás da sala, ninguém
// nunca vê o "de trás" dele. Primeiro pedido do Douglas foi só 2 lados
// ("parede so tem dois lados, lado direita e lado esquerda"), mas ele
// corrigiu na sequência: "na vdd, parede tem Quina, adiciona quina
// esquerda, quina direita" -- a peça de CANTO (onde as duas paredes se
// encontram no fundo da sala) é uma 3ª/4ª peça, não uma direção comum.
// Reaproveita os MESMOS 2 slots que sobrariam sem uso pra parede
// (left/up -- ver DIRECTION_FIELDS acima) só trocando o RÓTULO, em vez
// de esconder ou criar uma chave nova: down/right continuam "Frente
// esquerda/direita" (peça reta), left/up viram "Quina esquerda/direita"
// (peça de canto) -- mesmo mecanismo de sempre (rotação com as setinhas
// na sala, canRotate etc. em GameRoom.tsx) continua funcionando sem
// nenhuma mudança lá, já que pra ele é só mais uma "direção" com arte
// cadastrada.
//
// Rodada seguinte, Douglas pediu mais 2: "nas paredes adicione mais
// duas posicoes, quina de cima, quina de baixo". Dessa vez NÃO tem
// slot sobrando pra reaproveitar (down/left/right/up já usados todos) --
// precisou de 2 chaves NOVAS de verdade ("cornerTop"/"cornerBottom",
// fora de DirectionKey, ver MobiFacing acima), por isso essa lista
// deixou de ser um .map() em cima de DIRECTION_FIELDS (só trocava
// rótulo) e virou uma lista PRÓPRIA, com os 4 slots de sempre + 2
// novos no fim.
const WALL_DIRECTION_FIELDS: { key: MobiFacing; label: string; required: boolean }[] = [
  { key: "down", label: "Frente esquerda", required: true },
  { key: "left", label: "Quina esquerda", required: false },
  { key: "right", label: "Frente direita", required: false },
  { key: "up", label: "Quina direita", required: false },
  { key: "cornerTop", label: "Quina de cima", required: false },
  { key: "cornerBottom", label: "Quina de baixo", required: false },
];

type CustomItemRow = {
  id: string;
  label: string;
  category: CategoryId;
  art: Partial<Record<MobiFacing, string>>;
  icon_url: string | null;
  display_width: number | null;
  offset_x: number | null;
  offset_y: number | null;
  direction_offsets: Partial<Record<Exclude<MobiFacing, "down">, { x: number; y: number }>> | null;
  direction_display_width: Partial<Record<Exclude<MobiFacing, "down">, number>> | null;
  sittable: boolean | null;
  seat_offset_x: number | null;
  seat_offset_y: number | null;
  seat_direction_offsets: Partial<Record<Exclude<MobiFacing, "down">, { x: number; y: number }>> | null;
  colors: FurnitureModelColorOption[] | null;
  footprint_cols: number | null;
  footprint_rows: number | null;
  footprint_by_direction: Partial<Record<"down" | "left" | "right" | "up", { dCol: number; dRow: number }[]>> | null;
  stackable: boolean | null;
  stack_surface_offset_y: number | null;
  extra_seats: ExtraSeatRow[] | null;
};

/** Um assento EXTRA (ver comentário grande em FurnitureExtraSeat,
 * game/furniture.ts, e supabase/migrations/0014_room_items_extra_seats.sql)
 * -- dCol/dRow (tile, offset a partir da âncora) + x/y (px, deslocamento
 * FIXO de onde o boneco senta ali, sem ajuste ao vivo no jogo). */
type ExtraSeatRow = { dCol: number; dRow: number; x: number; y: number };

// mesma faixa -100..100 da constraint em supabase/migrations/
// 0007_room_items_direction_offsets_seat.sql -- ajuste de assento é
// sempre um nudge pequeno, não precisa da faixa toda do offset de
// posição (OFFSET_LIMIT acima).
const SEAT_OFFSET_LIMIT = 100;

/**
 * Encolhe (só encolhe, nunca aumenta) a imagem pra no máximo maxWidth
 * de largura ANTES de subir pro Storage -- ver UPLOAD_SUPERSAMPLE acima
 * pro porquê. Usa createImageBitmap + canvas (2D, com suavização "high")
 * em vez de mandar o arquivo cru: mais barato que mandar o arquivo
 * gigante e o navegador aguenta tranquilo (é só um redimensionamento,
 * roda na hora, sem travar a tela). Se alguma etapa falhar (formato
 * exótico, navegador antigo) devolve o arquivo ORIGINAL sem esse corte
 * -- upload continua funcionando, só sem o benefício do teto de tamanho.
 */
async function resizeImageForUpload(file: File, maxWidth: number): Promise<File> {
  if (typeof createImageBitmap !== "function") return file;
  try {
    const bitmap = await createImageBitmap(file);
    if (bitmap.width <= maxWidth) {
      bitmap.close?.();
      return file;
    }
    const scale = maxWidth / bitmap.width;
    const targetW = Math.max(1, Math.round(bitmap.width * scale));
    const targetH = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close?.();
      return file;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    bitmap.close?.();
    const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.\w+$/, ".png"), { type: "image/png" });
  } catch (e) {
    console.warn("Não deu pra redimensionar a imagem antes de subir, mandando original", e);
    return file;
  }
}

// Correção automática de ângulo isométrico (PixelLab), ligada por
// padrão -- REMOVIDA. Pedido do Douglas: "remova o seu corretor de
// angulo, ele nao funciona". Era um esticamento fixo (1.45x na
// vertical) calibrado em só 2 peças de exemplo -- não generalizava bem
// pra toda peça nova, esticando errado com frequência. O ajuste fino
// MANUAL de rotação/cisalhamento no recorte (rotationDeg/shearDeg, ver
// ImageCropModal mais abaixo) continua existindo -- esse aqui era só o
// automático, aplicado sem o Douglas olhar antes.

function slugify(text: string): string {
  return (
    text
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "item"
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

type CustomSkinRow = {
  id: string;
  label: string;
  gender: AvatarGender;
  sheet_url: string;
  hex: string | null;
  // variantes de cor GERADAS pelo ColorZoneTool.tsx (botão "Gerar cor" na
  // lista de "Tons cadastrados" abaixo -- pedido do Douglas: "adicionar
  // cores pra avatar tambem" / "edicao encima do ja subido"). Ausente/
  // null em quem ainda não rodou
  // supabase/migrations/0010_avatar_skins_colors.sql. Mesmo formato de
  // ColorOption usado em CustomAvatarItemRow.colors abaixo.
  colors?: ColorOption[] | null;
};

type CustomAvatarItemRow = {
  id: string;
  category: "cabelo" | "acessorio" | "barba" | "traje";
  gender: AvatarGender;
  label: string;
  skin_ids: string[] | null;
  sheet_url: string;
  // variantes de cor GERADAS pelo ColorZoneTool.tsx (ver comentário lá
  // e supabase/migrations/0009_avatar_items_colors.sql) -- mesmo
  // formato de ColorOption em game/customization.ts.
  colors: ColorOption[] | null;
};

// qual direção (ver DIRECTION_FIELDS acima) cada um dos 15 quadros da
// folha usa -- MESMA ordem/esquema de FRAME_SLOTS/SLOTS_BY_DIRECTION em
// scripts/syncSkinAssets.mjs (duplicado aqui de propósito: é o FORMATO
// do arquivo que o jogo espera, não muda, e importar um script .mjs de
// Node dentro de um componente React não rola). A cabeça de cada direção
// é reaproveitada nos 3-4 quadros dela (parado/passoA/passoB/sentado) --
// só "up" (costas) não tem quadro de sentado, mesma observação de sempre
// (reusa o quadro 9 direto em MainScene.ts).
const SKIN_SHEET_SLOT_DIRECTIONS: DirectionKey[] = [
  "down", "down", "down",
  "left", "left", "left",
  "right", "right", "right",
  "up", "up", "up",
  "down", "left", "right",
];
const SKIN_SHEET_COLS = 8;
const SKIN_SHEET_SPACING = 2;

// "somente o traje vai ter o movimento de andar e sentar" (pedido do
// Douglas, depois de notar "os trajes nao tem os movimentos, andando,
// sentado") -- até aqui, TODA categoria (inclusive traje) só aceitava 1
// foto por direção, reaproveitada nos 3-4 quadros dela (ver comentário
// de SKIN_SHEET_SLOT_DIRECTIONS acima) -- MainScene.ts (WALK_FRAMES/
// SENTADO_FRAMES) já sabia tocar passoA/passoB alternados e uma pose
// sentada de verdade, a folha 8x2 já tem os 15 quadros certos pra isso
// (não precisou mudar NADA do lado do jogo) -- só faltava o EDITOR
// aceitar fotos diferentes por quadro. Isso agora existe só pro TRAJE
// (cabeça/cabelo/acessório/barba continuam 1 foto por direção, pedido
// explícito: "a cabeca apenas lados, cabelos acessorios enfim").
// SKIN_SHEET_SLOT_POSES casa índice-a-índice com SKIN_SHEET_SLOT_DIRECTIONS/
// FOUR_DIR_SHEET_SLOTS acima -- qual POSE cada um dos 15 quadros é,
// dentro da direção dele (ver composeAvatarArtSheetMultiPose mais
// abaixo). "up" (costas) não tem quadro de sentado próprio (mesma
// observação de SENTADO_FRAMES.up em MainScene.ts -- o móvel cobre o
// corpo por trás, não faz diferença visual), por isso a aba "Sentado" do
// traje esconde a direção "Costas" (ver activeDirectionFields).
type PosePart = "passoA" | "passoB" | "sentado";
type PoseKey = "parado" | PosePart;
const SKIN_SHEET_SLOT_POSES: PoseKey[] = [
  "parado", "passoA", "passoB",
  "parado", "passoA", "passoB",
  "parado", "passoA", "passoB",
  "parado", "passoA", "passoB",
  "sentado", "sentado", "sentado",
];
const TRAJE_POSE_PARTS: { id: PosePart; label: string }[] = [
  { id: "passoA", label: "Passo A" },
  { id: "passoB", label: "Passo B" },
  { id: "sentado", label: "Sentado" },
];

// "avatar" (tom de pele -- pedido do Douglas: "esse 'tom' é a cabeça")
// vira a primeira categoria do fluxo, irmã de cabelo/acessório/barba/
// traje -- MESMO formulário, botões acima ("sexo/avatar-cabelo-etc/cor")
// -- ver pedido do Douglas: "ordem de seleção, tudo em botões: Masculino/
// feminino, avatar/cabelo/acessório/barba/traje". Continua indo pra
// tabela avatar_skins (não avatar_items -- ver comentário na migration
// 0006_avatar_items.sql) por ser a definição de um TOM, não algo que
// "aplica pra" um tom.
type AvatarCreatorCategory = "avatar" | "avatar_padrao" | "cabelo" | "acessorio" | "barba" | "traje";

const AVATAR_CREATOR_CATEGORIES: { id: AvatarCreatorCategory; label: string }[] = [
  { id: "avatar", label: "Avatar" },
  { id: "avatar_padrao", label: "Avatar Padrão" },
  { id: "cabelo", label: "Cabelo" },
  { id: "acessorio", label: "Acessório" },
  { id: "barba", label: "Barba" },
  { id: "traje", label: "Traje" },
];

// "Avatar Padrão" (pedido do Douglas: "cria uma opcao ao lado de avatar,
// que só pode ter UMA em cada um deles... esse avatar eu vou subir:
// cabeca e traje apenas, o traje na vdd vai ser o corpo limpo... esse
// padrao voce coloca ele inteiro montado no editor quando eu for criar
// outros... ai eu uso ele exatamente de referencia sempre") -- ATÉ
// AGORA o boneco de referência do editor (ver referenceSkin abaixo) era
// só o tom de pele CRU, que por convenção é só a CABEÇA (ver comentário
// em supabase/migrations/0005_avatar_skins.sql) -- então editar
// cabelo/traje/etc contra ele mostrava uma cabeça flutuando, sem corpo
// nenhum de referência. "Avatar Padrão" resolve isso: UM tom de pele
// (cabeça) + UM traje (corpo limpo, sem roupa de verdade) marcados como
// "o padrão" daquele sexo -- só 1 por sexo (upsert por gender na tabela
// nova, ver app/api/avatar-default-reference), meio ortogonal ao
// catálogo normal de tons/trajes (não aparece nos seletores de jogo,
// serve só de referência fixa aqui no editor). Empilha os dois (traje
// embaixo, base/cabeça em cima -- mesma ordem de LAYER_DRAW_ORDER em
// MainScene.ts) no lugar do referenceSkin sozinho pras outras 4
// categorias (cabelo/acessório/barba/traje), ver defaultReference mais
// abaixo.
type DefaultReferenceRow = { gender: AvatarGender; head_sheet_url: string; body_sheet_url: string };

// barba/acessório só têm 3 poses de verdade (sem "costas" -- não dá pra
// ver de trás da cabeça mesmo, ver scripts/syncBeardAssets.mjs/
// syncAccessoryAssets.mjs) -- essas duas categorias escondem o upload
// de "Costas" e deixam o quadro de "up" transparente na folha final.
const THREE_POSE_CATEGORIES = new Set<AvatarCreatorCategory>(["barba", "acessorio"]);

// categorias cuja arte precisa combinar com o TOM DE PELE escolhido (a
// mão/pescoço ficam expostos -- ver bySkin em game/customization.ts).
// Cabelo/acessório não têm bySkin (mesma arte serve em qualquer tom),
// então não mostram o seletor "aplica pra qual tom" abaixo.
const BY_SKIN_CATEGORIES = new Set<AvatarCreatorCategory>(["barba", "traje"]);

type SheetSlot = DirectionKey | "blank";

const FOUR_DIR_SHEET_SLOTS: SheetSlot[] = SKIN_SHEET_SLOT_DIRECTIONS;
// mesmo layout de FRAME_SLOTS em scripts/syncBeardAssets.mjs/
// syncAccessoryAssets.mjs -- "up" (índices 9-11) fica em branco.
const THREE_DIR_SHEET_SLOTS: SheetSlot[] = [
  "down", "down", "down",
  "left", "left", "left",
  "right", "right", "right",
  "blank", "blank", "blank",
  "down", "left", "right",
];

// primeiro quadro (índice 0-based na folha 8x2) de cada direção -- usado
// só pra mostrar o boneco de referência na POSE certa no editor de
// posição (ver frameOffsetXPx/frameOffsetYPx mais abaixo), mesmos
// índices de SKIN_SHEET_SLOT_DIRECTIONS acima.
const DIRECTION_FIRST_FRAME_INDEX: Record<DirectionKey, number> = { down: 0, left: 3, right: 6, up: 9 };

// pose SENTADO por direção (mesmo índice de frame que SENTADO_FRAMES em
// game/MainScene.ts -- não dá pra importar de lá porque é um const
// privado do módulo, não exportado, então replica aqui como o resto
// desse arquivo já faz com DIRECTION_FIRST_FRAME_INDEX acima). "up" não
// tem arte sentado-de-costas própria ainda, cai na mesma pose em pé
// virado pra trás (frame 9), igual o jogo faz.
const SEAT_FRAME_INDEX: Record<DirectionKey, number> = { down: 12, left: 13, right: 14, up: 9 };

// posição/tamanho de UMA foto de direção dentro do quadro 200x260 --
// pedido do Douglas: "preciso posicionar e redimensionar" -- ajustado
// arrastando/com slider no editor (ver handleArtPointerDown mais
// abaixo). offsetX/offsetY em px de JOGO (mesma unidade do offset do
// mobi), scale MULTIPLICA o "contido" automático (1 = exatamente
// fit:"contain" centralizado, igual ao comportamento de antes).
type DirectionPlacement = { offsetX: number; offsetY: number; scale: number };
const DEFAULT_PLACEMENT: DirectionPlacement = { offsetX: 0, offsetY: 0, scale: 1 };
const PLACEMENT_OFFSET_LIMIT = 150;

// nomes canônicos de tom (pedido do Douglas: "branco pardo negro") --
// só pra categoria "Avatar" (criar um TOM novo): diferente das outras 4
// categorias (que escolhem quais tons JÁ EXISTENTES a peça cobre, ver
// BY_SKIN_CATEGORIES acima e genderSkins mais abaixo), aqui a pessoa tá
// DEFININDO o tom, não aplicando numa lista -- por isso fixo em 3
// botões (não vem do catálogo), com a cor de botão já sugerida (mesmo
// hex que SKIN_HEX_BY_NAME em scripts/syncSkinAssets.mjs usa).
const AVATAR_TONE_NAMES: { label: string; hex: string }[] = [
  { label: "Branco", hex: "#fde6b5" },
  { label: "Pardo", hex: "#d1a276" },
  { label: "Negro", hex: "#765e48" },
];

/**
 * Resolve a URL de uma arte de camada de avatar -- local (public/assets/)
 * ou CUSTOM (URL completa do Supabase Storage, ver SkinOption.file em
 * game/customization.ts). Mesmo helper que GameRoom.tsx já tem
 * (furnitureAssetUrl), duplicado aqui de propósito -- GameRoom já
 * importa ItemEditor, importar de volta criaria ciclo.
 */
function avatarAssetUrl(file: string): string {
  return file.startsWith("http") ? file : `/assets/${file}`;
}

/** Carrega uma URL (folha já composta de um item existente) como
 * ImageBitmap -- usado só como `fallback` de composeAvatarArtSheet/
 * composeAvatarArtSheetMultiPose ao EDITAR (ver comentário grande lá).
 * `fetch` + Blob em vez de `new Image()`/canvas (mesma ideia de
 * ColorZoneTool.tsx, só que sem precisar de crossOrigin: createImageBitmap
 * a partir de um Blob nunca "tainta" o canvas, o bucket já é público de
 * qualquer forma). null se a folha antiga não carregar por qualquer
 * motivo -- editar continua funcionando, só sem o fallback (quadro sem
 * foto nova fica em branco, mesmo comportamento de criar um item novo). */
async function loadImageBitmapFromUrl(url: string): Promise<ImageBitmap | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

/**
 * Monta a folha de sprites (8x2, 200x260 por quadro -- mesmo formato de
 * public/assets/avatar_<tom>.png, ver scripts/syncSkinAssets.mjs) DIRETO
 * NO NAVEGADOR pra QUALQUER camada de avatar (tom de pele, cabelo,
 * acessório, barba, traje) a partir das fotos por direção, cada uma com
 * seu PRÓPRIO posicionamento (ver DirectionPlacement acima -- pedido do
 * Douglas: "preciso posicionar e redimensionar"). Sem posicionamento
 * ajustado pra uma direção, cai no "contido" centralizado de sempre
 * (mesma ideia do `fit:"contain"` que o pipeline local usa via sharp).
 * `slots` decide o layout das 15 posições (ver FOUR_DIR_SHEET_SLOTS/
 * THREE_DIR_SHEET_SLOTS acima) -- "blank" fica transparente (barba/
 * acessório não têm arte de costas).
 *
 * `fallback` (opcional) -- pedido do Douglas: "quero editar as coisas
 * ja criadas, fotos etc". A folha de um item já cadastrado é só o PNG
 * final composto (nunca guardamos as fotos cruas por direção/pose
 * separadas), então "editar só a foto que trocou" não dá pra fazer
 * recompondo do zero -- em vez disso, quando um quadro não tem foto
 * NOVA nenhuma (nem no fallback do multi-pose, ver
 * composeAvatarArtSheetMultiPose abaixo), copia o quadro JÁ PRONTO
 * direto da folha antiga (mesma célula x/y, sem reaplicar
 * posicionamento -- já está com o posicionamento certo, seja lá qual
 * foi, queimado nos pixels). Resultado: só quem reenviou foto nova
 * muda, o resto continua pixel-a-pixel igual ao que já estava salvo.
 */
async function composeAvatarArtSheet(
  filesByDirection: Partial<Record<DirectionKey, File>>,
  placements: Partial<Record<DirectionKey, DirectionPlacement>>,
  slots: SheetSlot[],
  fallback?: ImageBitmap | null
): Promise<Blob> {
  const neededDirs = Array.from(new Set(slots.filter((s): s is DirectionKey => s !== "blank")));
  const bitmaps: Partial<Record<DirectionKey, ImageBitmap>> = {};
  for (const dir of neededDirs) {
    const file = filesByDirection[dir];
    if (file) bitmaps[dir] = await createImageBitmap(file);
  }

  const canvas = document.createElement("canvas");
  canvas.width = SKIN_SHEET_COLS * (FRAME_W + SKIN_SHEET_SPACING) - SKIN_SHEET_SPACING;
  canvas.height = 2 * (FRAME_H + SKIN_SHEET_SPACING) - SKIN_SHEET_SPACING;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("navegador sem suporte a canvas 2D");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  slots.forEach((slot, i) => {
    if (slot === "blank") return;
    const col = i % SKIN_SHEET_COLS;
    const row = Math.floor(i / SKIN_SHEET_COLS);
    const cellX = col * (FRAME_W + SKIN_SHEET_SPACING);
    const cellY = row * (FRAME_H + SKIN_SHEET_SPACING);
    const bitmap = bitmaps[slot];
    if (!bitmap) {
      // sem foto nova pra esse quadro -- copia o que já tinha (ver
      // comentário de `fallback` acima), ou deixa em branco (criação
      // nova, sem fallback nenhum -- comportamento de sempre).
      if (fallback) ctx.drawImage(fallback, cellX, cellY, FRAME_W, FRAME_H, cellX, cellY, FRAME_W, FRAME_H);
      return;
    }
    const placement = placements[slot] ?? DEFAULT_PLACEMENT;
    const baseScale = Math.min(FRAME_W / bitmap.width, FRAME_H / bitmap.height);
    const scale = baseScale * placement.scale;
    const drawW = bitmap.width * scale;
    const drawH = bitmap.height * scale;
    const centerX = cellX + FRAME_W / 2 + placement.offsetX;
    const centerY = cellY + FRAME_H / 2 + placement.offsetY;
    ctx.drawImage(bitmap, centerX - drawW / 2, centerY - drawH / 2, drawW, drawH);
  });
  for (const bitmap of Object.values(bitmaps)) bitmap?.close?.();

  const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("erro ao montar a folha de sprites");
  return blob;
}

/**
 * Mesma ideia de composeAvatarArtSheet acima, só que por POSE além de
 * direção -- usada só pelo TRAJE (ver comentário de SKIN_SHEET_SLOT_POSES/
 * TRAJE_POSE_PARTS acima, pedido do Douglas: "somente o traje vai ter o
 * movimento de andar e sentar"). `filesByPose`/`placementsByPose` trazem
 * um pacote files/placements PARA CADA pose ("parado" é sempre o de
 * sempre -- rawFiles/rawPlacements -- passoA/passoB/sentado são os novos,
 * opcionais). Pra cada um dos 15 quadros da folha, `poses[i]` diz qual
 * pose ele quer: se essa pose não tiver foto própria PRA AQUELA direção,
 * cai na foto "parado" da MESMA direção (exatamente o reaproveitamento
 * de sempre quando só sobe 1 foto -- zero regressão pra quem não usa
 * passoA/passoB/sentado); só fica em branco se nem "parado" daquela
 * direção tiver foto (mesmo caso de hoje).
 */
async function composeAvatarArtSheetMultiPose(
  filesByPose: Record<PoseKey, Partial<Record<DirectionKey, File>>>,
  placementsByPose: Record<PoseKey, Partial<Record<DirectionKey, DirectionPlacement>>>,
  slots: SheetSlot[],
  poses: PoseKey[],
  fallback?: ImageBitmap | null
): Promise<Blob> {
  const bitmapCache = new Map<string, ImageBitmap>();

  async function bitmapFor(dir: DirectionKey, pose: PoseKey): Promise<ImageBitmap | null> {
    const specific = filesByPose[pose]?.[dir];
    const file = specific ?? filesByPose.parado[dir];
    if (!file) return null;
    const cacheKey = specific ? `${pose}:${dir}` : `parado:${dir}`;
    let bitmap = bitmapCache.get(cacheKey);
    if (!bitmap) {
      bitmap = await createImageBitmap(file);
      bitmapCache.set(cacheKey, bitmap);
    }
    return bitmap;
  }

  function placementFor(dir: DirectionKey, pose: PoseKey): DirectionPlacement {
    const specific = filesByPose[pose]?.[dir];
    return (specific ? placementsByPose[pose]?.[dir] : placementsByPose.parado[dir]) ?? DEFAULT_PLACEMENT;
  }

  const canvas = document.createElement("canvas");
  canvas.width = SKIN_SHEET_COLS * (FRAME_W + SKIN_SHEET_SPACING) - SKIN_SHEET_SPACING;
  canvas.height = 2 * (FRAME_H + SKIN_SHEET_SPACING) - SKIN_SHEET_SPACING;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("navegador sem suporte a canvas 2D");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (slot === "blank") continue;
    const dir = slot;
    const pose = poses[i] ?? "parado";
    const col = i % SKIN_SHEET_COLS;
    const row = Math.floor(i / SKIN_SHEET_COLS);
    const cellX = col * (FRAME_W + SKIN_SHEET_SPACING);
    const cellY = row * (FRAME_H + SKIN_SHEET_SPACING);
    const bitmap = await bitmapFor(dir, pose);
    if (!bitmap) {
      // nem foto nova PRA ESSA pose nem pro "parado" da mesma direção
      // (ver bitmapFor acima) -- mesma ideia de composeAvatarArtSheet:
      // copia o quadro já pronto da folha antiga em vez de deixar em
      // branco, ver comentário de `fallback` lá.
      if (fallback) ctx.drawImage(fallback, cellX, cellY, FRAME_W, FRAME_H, cellX, cellY, FRAME_W, FRAME_H);
      continue;
    }
    const placement = placementFor(dir, pose);
    const baseScale = Math.min(FRAME_W / bitmap.width, FRAME_H / bitmap.height);
    const scale = baseScale * placement.scale;
    const drawW = bitmap.width * scale;
    const drawH = bitmap.height * scale;
    const centerX = cellX + FRAME_W / 2 + placement.offsetX;
    const centerY = cellY + FRAME_H / 2 + placement.offsetY;
    ctx.drawImage(bitmap, centerX - drawW / 2, centerY - drawH / 2, drawW, drawH);
  }
  for (const bitmap of bitmapCache.values()) bitmap.close?.();

  const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("erro ao montar a folha de sprites");
  return blob;
}

// tamanho MÁXIMO (em px de TELA) do preview dentro do modal de recorte
// (ver ImageCropModal abaixo) -- a foto só é EXIBIDA reduzida a esse
// teto (nunca ampliada -- min(..., 1)), o corte de verdade sempre usa a
// imagem em resolução NATIVA (naturalWidth/Height), convertendo o
// retângulo arrastado na tela pra essa escala (ver handleConfirm).
const CROP_MODAL_MAX_W = 520;
const CROP_MODAL_MAX_H = 520;
const CROP_MIN_SIZE = 24;
type CropRect = { x: number; y: number; w: number; h: number };
type CropCorner = "nw" | "ne" | "sw" | "se";

/**
 * Modal de recorte LIVRE (sem proporção fixa -- pedido do Douglas:
 * "Adicione uma opcao de recorte da imagem ali dentro, o pixelart me
 * gera varios cabelos na mesma foto se eu cortar em outra plataforma
 * ele vai perder qualidade, entao quero cortar ali dentro do editor
 * mesmo" + depois, confirmando o escopo: "cortar em mobis tambem,
 * livre"). Abre em cima de QUALQUER foto recém-escolhida num <input
 * type="file"> do editor (avatar/item E mobi, ver os 3 usos: upload de
 * direção do AvatarCreatorPanel, upload de direção do mobi, ícone do
 * catálogo do mobi) -- ANTES dela virar o File "de verdade" que o
 * resto do formulário usa, pra não perder qualidade cortando fora
 * daqui (Canva/etc) e subindo nas duas etapas. O retângulo é
 * arrastado/redimensionado numa PRÉVIA reduzida (CROP_MODAL_MAX_W/H),
 * mas o corte em si sempre lê a imagem na resolução NATIVA (ver
 * handleConfirm) -- não perde nenhuma qualidade por causa da prévia
 * menor. "Usar sem cortar" segue com a foto original, sem nenhum
 * corte -- é OPÇÃO, não obrigatório.
 */
function ImageCropModal({
  file,
  onConfirm,
  onSkip,
  onCancel,
}: {
  file: File;
  onConfirm: (cropped: File) => void;
  onSkip: (file: File) => void;
  onCancel: () => void;
}) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [display, setDisplay] = useState<{ w: number; h: number } | null>(null);
  const [rect, setRect] = useState<CropRect | null>(null);
  // espelhar (pedido do Douglas: "opcao de espelhar tambem, espelhar a
  // imagem em editar mobis/avatar") -- flip HORIZONTAL, junto com o
  // recorte nesse mesmo modal (não é um ajuste à parte no editor de
  // posição). Só vira um `transform: scaleX(-1)` na PRÉVIA (ver <img>
  // abaixo) -- o espelhamento de verdade, em pixel, só acontece na hora
  // de gerar o resultado (ver produceResult), tanto cortando quanto
  // "sem cortar".
  const [flipped, setFlipped] = useState(false);
  // ajuste fino de rotação (graus, -10 a +10) -- pedido do Douglas depois
  // que a correção automática de ângulo (esticar só na VERTICAL, um fator
  // fixo calibrado em 2 peças de exemplo -- REMOVIDA depois, ver
  // comentário perto de slugify: "remova o seu corretor de angulo, ele
  // nao funciona") não bastou pra uma poltrona específica ("ta deixando
  // torto ainda", com print mostrando a perna fora do centro da régua/
  // losango de referência): esse esticamento só corrigia o ACHATAMENTO
  // da câmera do PixelLab (inclinação), não uma eventual leve
  // ROTAÇÃO/torção da peça em si, que varia de geração pra geração. Esse
  // ajuste MANUAL continua aqui -- só o automático que saiu.
  const [rotationDeg, setRotationDeg] = useState(0);
  // cisalhamento (graus, -30 a +30) -- pedido do Douglas depois de testar
  // só a rotação acima: "ele so gira a imagem, nao faz aquela torcao...
  // eu vi voce identificando as linhas e meio que torcendo a imagem ate
  // ela bater as linhas". ROTAÇÃO sozinha só corrige um desalinhamento
  // de ângulo UNIFORME (a peça inteira girada); quando o problema é a
  // câmera do PixelLab olhando de uma ROTAÇÃO (azimute) levemente
  // diferente da do jogo -- não só uma inclinação (elevação) diferente --
  // o resultado é mais parecido com um efeito "keystone"/paralelogramo
  // (um lado da peça "puxado" em relação ao outro), que rotação NENHUMA
  // consegue desfazer (rotacionar só muda a ORIENTAÇÃO do erro, nunca o
  // formato dele). Cisalhamento (shear) é a ferramenta certa pra isso -- inclina linhas
  // verticais em diagonais sem mexer nas horizontais, exatamente a
  // "torção" que dá pra fazer uma perna que tá saindo pro lado errado
  // bater na linha-guia.
  const [shearDeg, setShearDeg] = useState(0);
  // versão TRANSFORMADA (rotação + cisalhamento) do arquivo original
  // (null = sem ajuste nenhum, usa `file` direto) -- gerada pelo
  // useEffect logo abaixo sempre que rotationDeg/shearDeg mudam. O
  // recorte (rect/display/natural) e a prévia sempre operam em cima de
  // `effectiveFile` (transformado ou não), nunca do `file` original
  // direto, pra prévia e resultado final baterem sempre.
  const [transformedSource, setTransformedSource] = useState<File | null>(null);
  // guia visual do losango do tile (pedido do Douglas: "mas sem o tile
  // ali como eu vou saber kkkkk" -- o ajuste fino de rotação acima é
  // inútil sem uma referência do ângulo/formato do tile pra comparar
  // contra) -- puramente ILUSTRATIVO (não sabe a escala/posição real que
  // a peça vai ocupar na sala, isso é ajustado DEPOIS, na tela de
  // posição/âncora), só dá um losango no ângulo/proporção CERTOS (2:1,
  // mesma conta de ISO_TILE_WIDTH/HEIGHT) + 2 linhas-guia no mesmo
  // ângulo esticadas pela imagem inteira, pra comparar contra as bordas/
  // pernas da peça em qualquer altura da imagem, não só onde o losango
  // tá desenhado. guideY é a posição vertical do CENTRO do losango (%
  // da altura da imagem) -- ajustável porque cada peça tem uma folga
  // diferente embaixo dos "pés" na foto.
  const [showTileGuide, setShowTileGuide] = useState(true);
  const [guideY, setGuideY] = useState(78);
  const imgRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    setFlipped(false);
    setRotationDeg(0);
    setShearDeg(0);
    setTransformedSource(null);
  }, [file]);

  // canvas NOVO, maior que o original (cabe a imagem inteira rotacionada
  // E cisalhada sem cortar os cantos -- calcula a bounding box de
  // verdade transformando os 4 cantos originais, não só a fórmula de
  // rotação pura), vira um File novo. Roda de novo toda vez que
  // rotationDeg/shearDeg mudam (inclusive voltando os dois pra 0, aí só
  // limpa transformedSource e volta a usar `file` original sem gerar
  // canvas à toa). Ordem da transformação (cisalha primeiro, gira
  // depois -- ver comentário grande em shearDeg acima) é a MESMA nos
  // cantos (pra calcular o tamanho do canvas) e no desenho de verdade
  // logo abaixo, senão a bounding box calculada não bate com o
  // resultado.
  useEffect(() => {
    if (rotationDeg === 0 && shearDeg === 0) {
      setTransformedSource(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const bitmap = await createImageBitmap(file);
        const w = bitmap.width;
        const h = bitmap.height;
        const rad = (rotationDeg * Math.PI) / 180;
        const shear = Math.tan((shearDeg * Math.PI) / 180);
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        function transformPoint(x: number, y: number): [number, number] {
          // cisalha (x' = x + y*shear, y'=y) e DEPOIS gira -- mesma ordem
          // das chamadas ctx.rotate/ctx.transform no desenho abaixo (uma
          // chamada de canvas afeta o desenho seguinte, então a ÚLTIMA
          // chamada antes do drawImage é a transformação mais "interna",
          // aplicada primeiro ao ponto -- por isso ctx.rotate vem ANTES
          // de ctx.transform(shear) no código: cisalha primeiro, gira
          // depois, igual aqui).
          const sx = x + y * shear;
          const sy = y;
          return [sx * cos - sy * sin, sx * sin + sy * cos];
        }
        const corners = [
          transformPoint(-w / 2, -h / 2),
          transformPoint(w / 2, -h / 2),
          transformPoint(-w / 2, h / 2),
          transformPoint(w / 2, h / 2),
        ];
        const xs = corners.map((p) => p[0]);
        const ys = corners.map((p) => p[1]);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);
        const newW = Math.max(1, Math.ceil(maxX - minX));
        const newH = Math.max(1, Math.ceil(maxY - minY));
        const canvas = document.createElement("canvas");
        canvas.width = newW;
        canvas.height = newH;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          bitmap.close?.();
          return;
        }
        ctx.translate(-minX, -minY);
        ctx.rotate(rad);
        ctx.transform(1, 0, shear, 1, 0, 0);
        ctx.drawImage(bitmap, -w / 2, -h / 2, w, h);
        bitmap.close?.();
        const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
        if (!blob || cancelled) return;
        setTransformedSource(new File([blob], file.name.replace(/\.\w+$/, ".png"), { type: "image/png" }));
      } catch (e) {
        console.warn("Não deu pra girar/cisalhar a imagem pro ajuste fino, mantendo sem ajuste", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file, rotationDeg, shearDeg]);

  const effectiveFile = transformedSource ?? file;

  useEffect(() => {
    const url = URL.createObjectURL(effectiveFile);
    setImgUrl(url);
    setNatural(null);
    setDisplay(null);
    setRect(null);
    return () => URL.revokeObjectURL(url);
  }, [effectiveFile]);

  function handleImgLoad() {
    const img = imgRef.current;
    if (!img) return;
    const nw = img.naturalWidth || 1;
    const nh = img.naturalHeight || 1;
    const scale = Math.min(CROP_MODAL_MAX_W / nw, CROP_MODAL_MAX_H / nh, 1);
    const dw = Math.max(1, Math.round(nw * scale));
    const dh = Math.max(1, Math.round(nh * scale));
    setNatural({ w: nw, h: nh });
    setDisplay({ w: dw, h: dh });
    // começa cobrindo a imagem INTEIRA -- pedido "livre", a pessoa
    // ajusta a partir daí arrastando os 4 cantos (ou move arrastando o
    // miolo do retângulo).
    setRect({ x: 0, y: 0, w: dw, h: dh });
  }

  function startDrag(e: ReactPointerEvent<HTMLDivElement>, mode: "move" | CropCorner) {
    e.preventDefault();
    e.stopPropagation();
    if (!rect || !display) return;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const start = rect;
    const bounds = display;

    function onMove(ev: PointerEvent) {
      const dx = ev.clientX - startClientX;
      const dy = ev.clientY - startClientY;
      if (mode === "move") {
        setRect({
          x: clamp(start.x + dx, 0, bounds.w - start.w),
          y: clamp(start.y + dy, 0, bounds.h - start.h),
          w: start.w,
          h: start.h,
        });
        return;
      }
      let x1 = start.x;
      let y1 = start.y;
      let x2 = start.x + start.w;
      let y2 = start.y + start.h;
      if (mode.includes("w")) x1 = clamp(start.x + dx, 0, x2 - CROP_MIN_SIZE);
      if (mode.includes("e")) x2 = clamp(x2 + dx, x1 + CROP_MIN_SIZE, bounds.w);
      if (mode.includes("n")) y1 = clamp(start.y + dy, 0, y2 - CROP_MIN_SIZE);
      if (mode.includes("s")) y2 = clamp(y2 + dy, y1 + CROP_MIN_SIZE, bounds.h);
      setRect({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
    }
    function onUp(ev: PointerEvent) {
      target.releasePointerCapture(ev.pointerId);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
    }
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
  }

  /**
   * Gera o resultado final (recorte + espelhar, ver comentário de
   * `flipped` acima) -- usada tanto por "Cortar" (useCrop=true) quanto
   * por "Usar sem cortar" (useCrop=false, só aplica o espelhar se tiver
   * -- pedido do Douglas: espelhar também vale sem cortar). Espelha
   * PRIMEIRO (a imagem inteira, resolução nativa, numa tela separada) e
   * SÓ DEPOIS recorta dessa versão já espelhada -- assim o retângulo
   * (desenhado em cima da PRÉVIA, que já mostra a imagem espelhada, ver
   * <img style={transform}>) bate certinho com o que sai, sem precisar
   * espelhar a matemática do recorte também. `null` = deu erro (canvas
   * sem suporte, etc) -- quem chama cai pra foto original sem processar
   * nenhuma (nunca trava o upload por causa disso).
   */
  async function produceResult(useCrop: boolean): Promise<File | null> {
    try {
      const bitmap = await createImageBitmap(effectiveFile);
      let source: CanvasImageSource = bitmap;
      if (flipped) {
        const flipCanvas = document.createElement("canvas");
        flipCanvas.width = bitmap.width;
        flipCanvas.height = bitmap.height;
        const fctx = flipCanvas.getContext("2d");
        if (fctx) {
          fctx.translate(bitmap.width, 0);
          fctx.scale(-1, 1);
          fctx.drawImage(bitmap, 0, 0);
          source = flipCanvas;
        }
      }
      let sx = 0;
      let sy = 0;
      let sw = bitmap.width;
      let sh = bitmap.height;
      if (useCrop && rect && display && natural) {
        const scaleX = natural.w / display.w;
        const scaleY = natural.h / display.h;
        sx = Math.round(rect.x * scaleX);
        sy = Math.round(rect.y * scaleY);
        sw = Math.max(1, Math.round(rect.w * scaleX));
        sh = Math.max(1, Math.round(rect.h * scaleY));
      }
      const canvas = document.createElement("canvas");
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        bitmap.close?.();
        return null;
      }
      ctx.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
      bitmap.close?.();
      const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) return null;
      return new File([blob], file.name.replace(/\.\w+$/, ".png"), { type: "image/png" });
    } catch (e) {
      console.warn("Não deu pra recortar/espelhar a imagem, usando original", e);
      return null;
    }
  }

  async function handleConfirm() {
    const result = await produceResult(true);
    onConfirm(result ?? file);
  }

  async function handleSkip() {
    const result = await produceResult(false);
    onSkip(result ?? file);
  }

  return (
    <div className="crop-modal-backdrop" onClick={onCancel}>
      <div className="crop-modal" onClick={(e) => e.stopPropagation()}>
        <p className="crop-modal-title">Recortar imagem</p>
        <p className="settings-hint">Arraste os cantos pra ajustar o recorte -- livre, sem proporção fixa.</p>
        <div className="crop-modal-tools">
          <button
            type="button"
            className={flipped ? "crop-modal-flip-btn selected" : "crop-modal-flip-btn"}
            onClick={() => setFlipped((v) => !v)}
          >
            Espelhar
          </button>
          {/* ajuste fino de rotação -- ver comentário grande no state
              rotationDeg acima (peça saindo torta; a correção
              automática que existia foi removida). */}
          <label className="crop-modal-rotate">
            <span>Ajuste fino de ângulo: {rotationDeg}°</span>
            <input
              type="range"
              min={-10}
              max={10}
              step={0.5}
              value={rotationDeg}
              onChange={(e) => setRotationDeg(Number(e.target.value))}
            />
            {rotationDeg !== 0 && (
              <button type="button" className="crop-modal-rotate-reset" onClick={() => setRotationDeg(0)}>
                Resetar
              </button>
            )}
          </label>
          {/* cisalhamento ("torção") -- ver comentário grande no state
              shearDeg acima (rotação sozinha não resolve um
              desalinhamento tipo keystone/paralelogramo). */}
          <label className="crop-modal-rotate">
            <span>Torção: {shearDeg}°</span>
            <input
              type="range"
              min={-30}
              max={30}
              step={0.5}
              value={shearDeg}
              onChange={(e) => setShearDeg(Number(e.target.value))}
            />
            {shearDeg !== 0 && (
              <button type="button" className="crop-modal-rotate-reset" onClick={() => setShearDeg(0)}>
                Resetar
              </button>
            )}
          </label>
          {/* guia do losango -- ver comentário grande no state
              showTileGuide/guideY acima. */}
          <label className="crop-modal-guide-toggle">
            <input type="checkbox" checked={showTileGuide} onChange={(e) => setShowTileGuide(e.target.checked)} />
            Guia do tile
          </label>
          {showTileGuide && (
            <label className="crop-modal-rotate">
              <span>Altura da guia</span>
              <input
                type="range"
                min={20}
                max={95}
                step={1}
                value={guideY}
                onChange={(e) => setGuideY(Number(e.target.value))}
              />
            </label>
          )}
        </div>
        {imgUrl && (
          <div
            className="crop-modal-stage"
            style={display ? { width: display.w, height: display.h } : undefined}
          >
            <img
              ref={imgRef}
              src={imgUrl}
              alt="Foto pra recortar"
              onLoad={handleImgLoad}
              draggable={false}
              style={flipped ? { transform: "scaleX(-1)" } : undefined}
            />
            {rect && display && (
              <>
                <div className="crop-modal-shade" style={{ left: 0, top: 0, right: 0, height: rect.y }} />
                <div
                  className="crop-modal-shade"
                  style={{ left: 0, top: rect.y + rect.h, right: 0, bottom: 0 }}
                />
                <div className="crop-modal-shade" style={{ left: 0, top: rect.y, width: rect.x, height: rect.h }} />
                <div
                  className="crop-modal-shade"
                  style={{ left: rect.x + rect.w, top: rect.y, right: 0, height: rect.h }}
                />
                <div
                  className="crop-modal-rect"
                  style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
                  onPointerDown={(e) => startDrag(e, "move")}
                >
                  {(["nw", "ne", "sw", "se"] as const).map((corner) => (
                    <div
                      key={corner}
                      className={`crop-modal-handle crop-modal-handle-${corner}`}
                      onPointerDown={(e) => startDrag(e, corner)}
                    />
                  ))}
                </div>
              </>
            )}
            {showTileGuide && display && (
              <svg
                className="crop-modal-guide"
                width={display.w}
                height={display.h}
                viewBox={`0 0 ${display.w} ${display.h}`}
              >
                {(() => {
                  const cx = display.w / 2;
                  const cy = (display.h * guideY) / 100;
                  const halfW = Math.min(display.w, display.h * 2.2) * 0.32;
                  const halfH = halfW / 2;
                  const big = Math.max(display.w, display.h) * 2;
                  return (
                    <>
                      <line x1={cx - big} y1={cy - big / 2} x2={cx + big} y2={cy + big / 2} />
                      <line x1={cx - big} y1={cy + big / 2} x2={cx + big} y2={cy - big / 2} />
                      <polygon
                        points={`${cx},${cy - halfH} ${cx + halfW},${cy} ${cx},${cy + halfH} ${cx - halfW},${cy}`}
                      />
                    </>
                  );
                })()}
              </svg>
            )}
          </div>
        )}
        <div className="crop-modal-actions">
          <button type="button" className="clear-btn" onClick={onCancel}>
            Cancelar
          </button>
          <button type="button" className="clear-btn" onClick={handleSkip}>
            Usar sem cortar
          </button>
          <button type="button" className="items-panel-submit" onClick={handleConfirm} disabled={!rect}>
            Cortar
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Botão "Criar Avatar" do Editor de Itens (pedido do Douglas: "quero
 * subir os personagens DENTRO da plataforma"). Fluxo em 4 passos, tudo
 * em botões (pedido do Douglas: "ordem de seleção, tudo em botões"):
 * 1) sexo (masculino/feminino), 2) categoria (avatar/cabelo/acessório/
 * barba/traje), 3) pra categoria com bySkin (barba/traje), pra qual(is)
 * tom(ns) de pele já cadastrado(s) isso vale (pedido: "selecionar pra
 * qual cor vai... podendo selecionar todos") -- pra "avatar" em vez
 * disso escolhe QUAL tom novo tá criando (Branco/Pardo/Negro); cabelo/
 * acessório pulam esse passo (não dependem de tom, ver
 * BY_SKIN_CATEGORIES acima); 4) fotos por direção + editor de posição/
 * tamanho (arrastar + slider, pedido do Douglas: "preciso posicionar e
 * redimensionar"), reaproveitando o boneco de referência JÁ na pose da
 * direção escolhida.
 *
 * "Avatar" continua indo pra tabela avatar_skins (POST /api/avatar-skins,
 * já existia); as outras 4 categorias vão pra tabela nova avatar_items
 * (POST /api/avatar-items, ver supabase/migrations/0006_avatar_items.sql
 * -- PRECISA rodar essa migration antes de usar). Mesmo esquema de
 * upload direto pro Storage que o resto do Editor de Itens já usa. Sem
 * editar/apagar ainda (nenhuma das duas APIs tem PATCH/DELETE -- só
 * criar, fica pra depois se o Douglas pedir).
 */
// chave do localStorage que guarda qual TRAJE foi tocado por último
// (criado OU editado) -- ver comentário grande perto de "referenceOutfit"
// no editor de Mobi, mais abaixo, pro porquê disso existir. Módulo (não
// dentro de um componente) porque tanto AvatarCreatorPanel (quem grava,
// no fim de handleAvatarSubmit) quanto o corpo principal de ItemEditor
// (quem lê, calculando referenceOutfit) precisam dela.
const MOBI_REFERENCE_OUTFIT_STORAGE_KEY = "habbo-gather:mobi-reference-outfit-id";

function AvatarCreatorPanel({ accessToken, onChanged }: { accessToken: string; onChanged: () => void }) {
  const [category, setCategory] = useState<AvatarCreatorCategory>("avatar");
  const [gender, setGender] = useState<AvatarGender>("masculino");
  const [label, setLabel] = useState("");
  const [hex, setHex] = useState(AVATAR_TONE_NAMES[0].hex);
  const [selectedSkinIds, setSelectedSkinIds] = useState<string[]>([]);
  // nome "raw" de propósito -- ver files/setFiles computados mais abaixo
  // (indireção pra "Avatar Padrão" reusar a mesma UI com 2 pares
  // separados de arquivo/posição, um pra cabeça e outro pro traje).
  const [rawFiles, setRawFiles] = useState<Partial<Record<DirectionKey, File>>>({});
  const [rawPlacements, setRawPlacements] = useState<Partial<Record<DirectionKey, DirectionPlacement>>>({});
  const [activeDirection, setActiveDirection] = useState<DirectionKey>("down");
  // zoom do preview (ver .item-stage no JSX) -- pedido do Douglas: "tem
  // como eu dar zoom nesse editor? ta mt longe". Usa a propriedade CSS
  // `zoom` (não `transform: scale`) de propósito: `zoom` reflui o
  // layout (o card cresce de verdade, empurra o slider/texto/botões
  // pra baixo, sem cortar nem sobrepor nada) -- `transform` só
  // redesenha por cima sem mudar o espaço ocupado, e ia exigir um
  // wrapper com overflow pra não cortar o preview ampliado. Suportado
  // no Chrome (que é o que o Douglas usa, ver screenshots).
  // Tentativa de diminuir o card via `zoom` (achava mais seguro que
  // mexer em STAGE_HEIGHT, ver AVATAR_STAGE_TOP_PAD/AVATAR_STAGE_HEIGHT
  // abaixo pro motivo de terem sido abandonados uma vez) foi revertida a
  // pedido do Douglas: "você não consegue cortar a janela ao invés de
  // tirar zoom?" -- zoom encolhe o BONECO junto com o espaço vazio, o
  // Douglas quer o espaço vazio cortado, boneco do tamanho normal. Zoom
  // volta pro padrão de sempre (150%).
  const [zoom, setZoom] = useState(1.5);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skins, setSkins] = useState<CustomSkinRow[] | null>(null);
  const [avatarItems, setAvatarItems] = useState<CustomAvatarItemRow[] | null>(null);
  // id do item custom sendo apagado agora (desabilita o botão dele
  // enquanto a chamada roda) -- ver handleDeleteAvatarItem abaixo.
  const [deletingAvatarItemId, setDeletingAvatarItemId] = useState<string | null>(null);
  // mesma ideia, só que pro tom de pele ("Tons cadastrados") -- ver
  // handleDeleteSkin abaixo.
  const [deletingSkinId, setDeletingSkinId] = useState<string | null>(null);
  // id do item (cabelo/acessório/traje) OU tom de pele com o
  // ColorZoneTool.tsx aberto embaixo da linha dele agora -- só 1 por vez
  // (ver "Gerar cor" no JSX abaixo). Um estado só pros dois tipos: os
  // ids vêm de tabelas diferentes (avatar_items/avatar_skins, sempre
  // uuid), então nunca colidem -- abrir um fecha o outro sozinho.
  const [colorToolItemId, setColorToolItemId] = useState<string | null>(null);
  // "Editar" pro item de avatar CUSTOM (cabelo/acessório/barba/traje) --
  // pedido do Douglas: "quero editar as coisas ja criadas, fotos etc".
  // null = formulário em modo "cadastrar item novo" (de sempre), igual
  // editingId do ItemEditor de Mobi mais abaixo -- reusa o MESMO
  // formulário (label/gender/category/selectedSkinIds/rawFiles/etc já
  // existentes), só troca o botão final e o destino do submit (PATCH em
  // vez de POST, ver handleAvatarCreatorSubmit). editingAvatarItemSheetUrl
  // guarda a folha JÁ salva desse item -- usada como `fallback` na hora
  // de recompor (ver comentário grande em composeAvatarArtSheet), pra
  // reenviar só a(s) foto(s) da direção/pose que quiser trocar e manter
  // o resto igual, mesma ideia do "Editar" de Mobi.
  const [editingAvatarItemId, setEditingAvatarItemId] = useState<string | null>(null);
  const [editingAvatarItemSheetUrl, setEditingAvatarItemSheetUrl] = useState<string | null>(null);
  // Mesma ideia, só que pro TOM DE PELE ("Tons cadastrados") -- pedido
  // do Douglas: "quero editar o Avatar tambem" (continuação direta do
  // pedido acima, que só cobria cabelo/acessório/barba/traje). Estado
  // SEPARADO de propósito (não reaproveita editingAvatarItemId): tom de
  // pele salva na tabela avatar_skins (PATCH /api/avatar-skins/[id]),
  // não avatar_items -- categorias diferentes nunca ficam "editando" as
  // duas ao mesmo tempo (só uma aba fica ativa por vez), mas manter os
  // dois PATCHs decididos por ids distintos evita depender dessa
  // premissa pra não disparar o endpoint errado.
  const [editingSkinId, setEditingSkinId] = useState<string | null>(null);
  const [editingSkinSheetUrl, setEditingSkinSheetUrl] = useState<string | null>(null);
  // "Avatar Padrão" (ver DefaultReferenceRow/comentário acima) -- duas
  // fotos por direção SEPARADAS (cabeça e traje/corpo limpo), cada uma
  // com o próprio estado de arquivo/posição, chaveadas por
  // padraoPart. defaultReference guarda o que JÁ está salvo (1 por
  // sexo), buscado à parte de skins/avatarItems porque não é um item
  // "normal" (não aparece em nenhum seletor de jogo).
  const [padraoPart, setPadraoPart] = useState<"cabeca" | "traje">("cabeca");
  const [padraoHeadFiles, setPadraoHeadFiles] = useState<Partial<Record<DirectionKey, File>>>({});
  const [padraoHeadPlacements, setPadraoHeadPlacements] = useState<Partial<Record<DirectionKey, DirectionPlacement>>>(
    {}
  );
  const [padraoBodyFiles, setPadraoBodyFiles] = useState<Partial<Record<DirectionKey, File>>>({});
  const [padraoBodyPlacements, setPadraoBodyPlacements] = useState<Partial<Record<DirectionKey, DirectionPlacement>>>(
    {}
  );
  const [defaultReference, setDefaultReference] = useState<Record<AvatarGender, DefaultReferenceRow | null>>({
    masculino: null,
    feminino: null,
  });
  // TRAJE com movimento de verdade (pedido do Douglas: "somente o traje
  // vai ter o movimento de andar e sentar") -- "parado" continua usando
  // rawFiles/rawPlacements de sempre (mesmo campo que toda categoria já
  // usa, zero mudança pra quem só sobe 1 foto por direção); passoA/
  // passoB/sentado são OPCIONAIS, cada um com seu próprio conjunto de
  // fotos/posições por direção (mesma ideia de padraoHeadFiles/
  // padraoBodyFiles acima, só que 3 baldes em vez de 2), escolhidos pelo
  // toggle "activePose" (ver JSX). Só existe/aparece quando
  // category === "traje" -- as outras categorias nunca tocam nisso.
  const [trajePoseFiles, setTrajePoseFiles] = useState<Record<PosePart, Partial<Record<DirectionKey, File>>>>({
    passoA: {},
    passoB: {},
    sentado: {},
  });
  const [trajePosePlacements, setTrajePosePlacements] = useState<
    Record<PosePart, Partial<Record<DirectionKey, DirectionPlacement>>>
  >({
    passoA: {},
    passoB: {},
    sentado: {},
  });
  const [activePose, setActivePose] = useState<PoseKey>("parado");
  const fileInputRefs = useRef<Partial<Record<string, HTMLInputElement | null>>>({});
  // foto recém-escolhida esperando passar pelo modal de recorte (ver
  // ImageCropModal acima) antes de virar o File de verdade -- `apply`
  // guarda o que fazer com o resultado (sempre o MESMO setFiles/
  // setActiveDirection que rodava direto no onChange antes disso
  // existir), `inputKey` é a chave em fileInputRefs pra limpar o
  // <input> se a pessoa cancelar.
  const [pendingCrop, setPendingCrop] = useState<{ file: File; inputKey: string; apply: (f: File) => void } | null>(
    null
  );
  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  const isAvatarPadrao = category === "avatar_padrao";
  const isTrajeExtraPose = category === "traje" && activePose !== "parado";
  const isThreePose = THREE_POSE_CATEGORIES.has(category);
  // "Sentado" do traje não tem quadro de "Costas" (ver comentário de
  // SKIN_SHEET_SLOT_POSES acima) -- some a direção da lista igual
  // barba/acessório já fazem por outro motivo.
  const activeDirectionFields =
    isThreePose || (category === "traje" && activePose === "sentado")
      ? DIRECTION_FIELDS.filter((f) => f.key !== "up")
      : DIRECTION_FIELDS;
  const activeSlots = isThreePose ? THREE_DIR_SHEET_SLOTS : FOUR_DIR_SHEET_SLOTS;
  const usesBySkin = BY_SKIN_CATEGORIES.has(category);
  // tons já cadastrados (pasta local + "Avatar" acima) do SEXO
  // escolhido -- é a partir daqui que barba/traje escolhem "pra qual
  // tom vale" (ver comentário no tipo AvatarCreatorCategory acima).
  const genderSkins = SKIN_CATALOG.filter((s) => (s.gender ?? "masculino") === gender);

  function setTrajePoseFilesFor(pose: PosePart, updater: React.SetStateAction<Partial<Record<DirectionKey, File>>>) {
    setTrajePoseFiles((prev) => ({
      ...prev,
      [pose]: typeof updater === "function" ? updater(prev[pose]) : updater,
    }));
  }
  function setTrajePosePlacementsFor(
    pose: PosePart,
    updater: React.SetStateAction<Partial<Record<DirectionKey, DirectionPlacement>>>
  ) {
    setTrajePosePlacements((prev) => ({
      ...prev,
      [pose]: typeof updater === "function" ? updater(prev[pose]) : updater,
    }));
  }

  // "Avatar Padrão" usa os MESMOS campos de upload/prévia/arraste que
  // as outras categorias (files/placements), só que apontando pro par
  // certo (cabeça ou traje) em vez do estado único -- assim não precisa
  // duplicar toda a UI de baixo, só trocar pra onde ela lê/escreve.
  // TRAJE com uma pose extra ativa (passoA/passoB/sentado, ver
  // trajePoseFiles acima) segue a MESMA ideia, apontando pro balde
  // daquela pose em vez do rawFiles de sempre. Isso é só pra alimentar a
  // UI de upload/arraste/posição (abaixo) -- na hora de montar a folha
  // de verdade (handleAvatarCreatorSubmit), o traje lê os 4 baldes
  // direto (rawFiles + trajePoseFiles), não por essa indireção.
  const files = isAvatarPadrao
    ? padraoPart === "cabeca"
      ? padraoHeadFiles
      : padraoBodyFiles
    : isTrajeExtraPose
      ? trajePoseFiles[activePose as PosePart]
      : rawFiles;
  const setFiles = isAvatarPadrao
    ? padraoPart === "cabeca"
      ? setPadraoHeadFiles
      : setPadraoBodyFiles
    : isTrajeExtraPose
      ? (updater: React.SetStateAction<Partial<Record<DirectionKey, File>>>) =>
          setTrajePoseFilesFor(activePose as PosePart, updater)
      : setRawFiles;
  const placements = isAvatarPadrao
    ? padraoPart === "cabeca"
      ? padraoHeadPlacements
      : padraoBodyPlacements
    : isTrajeExtraPose
      ? trajePosePlacements[activePose as PosePart]
      : rawPlacements;
  const setPlacements = isAvatarPadrao
    ? padraoPart === "cabeca"
      ? setPadraoHeadPlacements
      : setPadraoBodyPlacements
    : isTrajeExtraPose
      ? (updater: React.SetStateAction<Partial<Record<DirectionKey, DirectionPlacement>>>) =>
          setTrajePosePlacementsFor(activePose as PosePart, updater)
      : setRawPlacements;

  async function loadSkins() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data, error: fetchError } = await supabase
      .from("avatar_skins")
      .select("id, label, gender, sheet_url, hex, colors");
    if (fetchError) {
      setError(fetchError.message);
      return;
    }
    setSkins((data ?? []) as CustomSkinRow[]);
  }

  // pedido do Douglas: "deixar apenas branco/pardo/negro" -- apaga um
  // TOM DE PELE custom da lista "Tons cadastrados" (tinha lixo de teste,
  // nome errado "Ela" e "Pardo" duplicado por sexo). Mesmo padrão de
  // handleDeleteAvatarItem acima.
  async function handleDeleteSkin(skin: CustomSkinRow) {
    const ok = window.confirm(`Apagar o tom "${skin.label}" (${skin.gender}) de vez? Não tem como desfazer.`);
    if (!ok) return;
    setDeletingSkinId(skin.id);
    setError(null);
    try {
      const res = await fetch(`/api/avatar-skins/${skin.id}`, { method: "DELETE", headers: authHeaders });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "erro ao apagar tom");
      await loadSkins();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "erro ao apagar tom");
    } finally {
      setDeletingSkinId(null);
    }
  }

  async function loadAvatarItems() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    // sem `error` aqui de propósito: a tabela só existe depois que o
    // Douglas rodar 0006_avatar_items.sql -- até lá, essa consulta falha
    // (tabela não existe) e a lista fica vazia em silêncio, sem travar o
    // resto do painel (ver mesmo cuidado em fetchAndRegisterCustomAvatarItems,
    // GameRoom.tsx).
    const { data } = await supabase
      .from("avatar_items")
      .select("id, category, gender, label, skin_ids, sheet_url, colors");
    setAvatarItems((data ?? []) as CustomAvatarItemRow[]);
  }

  // pedido do Douglas: "coloca la nos itens eles pra eu apagar por la" --
  // apaga um item CUSTOM de cabelo/acessório/barba/traje (não mexe nos
  // tons de pele/"Avatar", que não foi pedido). Mesmo padrão de confirm()
  // do handleClearPadrao acima. NOTA: isso só tira da lista/tabela --
  // quem já está numa sala com o navegador aberto só vê sumir do
  // catálogo do jogo depois de um F5 (registerCustomHair/Beard/etc só
  // ADICIONA no catálogo em memória, não existe "desregistrar" ainda).
  async function handleDeleteAvatarItem(item: CustomAvatarItemRow) {
    const ok = window.confirm(`Apagar "${item.label}" de vez? Não tem como desfazer.`);
    if (!ok) return;
    setDeletingAvatarItemId(item.id);
    setError(null);
    try {
      const res = await fetch(`/api/avatar-items/${item.id}`, { method: "DELETE", headers: authHeaders });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "erro ao apagar item");
      await loadAvatarItems();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "erro ao apagar item");
    } finally {
      setDeletingAvatarItemId(null);
    }
  }

  // "Avatar Padrão" (ver DefaultReferenceRow acima) -- tabela própria,
  // só 1 linha por sexo, sem PATCH/DELETE ainda (mesmo estágio de
  // skins/avatarItems -- o POST já faz upsert por gender, ver
  // app/api/avatar-default-reference). Ausente/tabela não criada ainda
  // = fica null em silêncio (mesmo cuidado de loadAvatarItems acima),
  // as outras categorias então caem no referenceSkin cru de sempre.
  async function loadDefaultReference() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data } = await supabase.from("avatar_default_reference").select("gender, head_sheet_url, body_sheet_url");
    const next: Record<AvatarGender, DefaultReferenceRow | null> = { masculino: null, feminino: null };
    for (const row of (data ?? []) as DefaultReferenceRow[]) {
      if (row.gender === "masculino" || row.gender === "feminino") next[row.gender] = row;
    }
    setDefaultReference(next);
  }

  useEffect(() => {
    loadSkins();
    loadAvatarItems();
    loadDefaultReference();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // preview da foto ATIVA (aba de direção escolhida) -- se essa direção
  // ainda não tem foto própria, cai na de "frente" só pra mostrar (mesma
  // prévia rápida de sempre), mas SEM deixar arrastar (ver hasOwnFile no
  // JSX) -- não faz sentido ajustar posição de uma direção que nem tem
  // arte própria ainda.
  const hasOwnFile = Boolean(files[activeDirection]);
  const activeFile = files[activeDirection] ?? files.down;
  const activePlacement = hasOwnFile ? placements[activeDirection] ?? DEFAULT_PLACEMENT : DEFAULT_PLACEMENT;

  const [activeArtUrl, setActiveArtUrl] = useState<string | null>(null);
  const activeArtUrlRef = useRef<string | null>(null);
  activeArtUrlRef.current = activeArtUrl;

  useEffect(() => {
    setActiveArtUrl((prevUrl) => {
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      return activeFile ? URL.createObjectURL(activeFile) : null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFile]);

  // "Avatar Padrão": pedido do Douglas: "eu tenho que subir a cabeca
  // aqui, e o corpo junto, vendo a cabeca, se nao eu nao acerto, isso so
  // no nosso padrao" -- enquanto ele ajusta uma parte (cabeça OU traje),
  // mostra a OUTRA parte já upada NESSA MESMA sessão (mesmo antes de
  // clicar Cadastrar) como camada FIXA, só de referência (sem arrastar
  // -- pra ajustar ELA, ele troca de aba com o toggle Cabeça/Traje). Sem
  // isso não tem como alinhar cabeça x corpo entre si, já que os dois
  // ainda não existem cadastrados em lugar nenhum.
  const otherPadraoFiles = isAvatarPadrao ? (padraoPart === "cabeca" ? padraoBodyFiles : padraoHeadFiles) : null;
  const otherPadraoPlacements = isAvatarPadrao
    ? padraoPart === "cabeca"
      ? padraoBodyPlacements
      : padraoHeadPlacements
    : null;
  const otherPadraoHasOwnFile = Boolean(otherPadraoFiles?.[activeDirection]);
  const otherPadraoFile = otherPadraoFiles ? otherPadraoFiles[activeDirection] ?? otherPadraoFiles.down : undefined;
  const otherPadraoPlacement = otherPadraoHasOwnFile
    ? otherPadraoPlacements?.[activeDirection] ?? DEFAULT_PLACEMENT
    : DEFAULT_PLACEMENT;

  const [otherPadraoArtUrl, setOtherPadraoArtUrl] = useState<string | null>(null);
  const otherPadraoArtUrlRef = useRef<string | null>(null);
  otherPadraoArtUrlRef.current = otherPadraoArtUrl;

  useEffect(() => {
    setOtherPadraoArtUrl((prevUrl) => {
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      return otherPadraoFile ? URL.createObjectURL(otherPadraoFile) : null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [otherPadraoFile]);

  useEffect(() => {
    return () => {
      if (otherPadraoArtUrlRef.current) URL.revokeObjectURL(otherPadraoArtUrlRef.current);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (activeArtUrlRef.current) URL.revokeObjectURL(activeArtUrlRef.current);
    };
  }, []);

  function resetCreatorForm() {
    setLabel("");
    setHex(AVATAR_TONE_NAMES[0].hex);
    setSelectedSkinIds([]);
    setRawFiles({});
    setRawPlacements({});
    setPadraoHeadFiles({});
    setPadraoHeadPlacements({});
    setPadraoBodyFiles({});
    setPadraoBodyPlacements({});
    setPadraoPart("cabeca");
    setTrajePoseFiles({ passoA: {}, passoB: {}, sentado: {} });
    setTrajePosePlacements({ passoA: {}, passoB: {}, sentado: {} });
    setActivePose("parado");
    setActiveDirection("down");
    setEditingAvatarItemId(null);
    setEditingAvatarItemSheetUrl(null);
    setEditingSkinId(null);
    setEditingSkinSheetUrl(null);
    for (const key of Object.keys(fileInputRefs.current)) {
      const input = fileInputRefs.current[key];
      if (input) input.value = "";
    }
  }

  function handleCategoryChange(next: AvatarCreatorCategory) {
    setCategory(next);
    resetCreatorForm();
  }

  /** Botão "Editar" na lista "X cadastrados" -- carrega o item CUSTOM
   * inteiro (cabelo/acessório/barba/traje -- tom de pele usa
   * startEditSkin logo abaixo, mesma ideia) de volta pro formulário
   * (mesmos campos de sempre) e liga o modo "editando" (troca o botão
   * final e o destino do submit pra PATCH, ver handleAvatarCreatorSubmit).
   * setCategory DIRETO (não handleCategoryChange) de propósito -- esse
   * já dispara resetCreatorForm, que ia apagar o editingAvatarItemId que
   * a gente TÁ tentando ligar agora. rawFiles/rawPlacements/
   * trajePoseFiles/etc ficam VAZIOS -- a pessoa só re-envia a(s) foto(s)
   * que quiser trocar, o resto vem da folha já salva (ver
   * editingAvatarItemSheetUrl, usado como fallback no submit). */
  function startEditAvatarItem(item: CustomAvatarItemRow) {
    setCategory(item.category);
    setGender(item.gender);
    setLabel(item.label);
    setSelectedSkinIds(item.skin_ids ?? []);
    setRawFiles({});
    setRawPlacements({});
    setTrajePoseFiles({ passoA: {}, passoB: {}, sentado: {} });
    setTrajePosePlacements({ passoA: {}, passoB: {}, sentado: {} });
    setActivePose("parado");
    setActiveDirection("down");
    setEditingAvatarItemId(item.id);
    setEditingAvatarItemSheetUrl(item.sheet_url);
    setEditingSkinId(null);
    setEditingSkinSheetUrl(null);
    setColorToolItemId(null);
    setError(null);
    for (const key of Object.keys(fileInputRefs.current)) {
      const input = fileInputRefs.current[key];
      if (input) input.value = "";
    }
  }

  /** Mesma ideia de startEditAvatarItem acima, só que pro TOM DE PELE
   * ("Tons cadastrados") -- pedido do Douglas: "quero editar o Avatar
   * tambem". setHex vem do que JÁ tava salvo (não do preset do
   * tone-chip -- ver AVATAR_TONE_NAMES/tone-select no JSX, que
   * SOBRESCREVE hex pro preset padrão da label ao clicar; aqui a gente
   * quer preservar o hex de verdade que o tom já tinha, mesmo que o
   * Douglas tenha ajustado manualmente no color picker na hora de
   * criar). Sem foto nova nenhuma (rawFiles vazio, igual
   * startEditAvatarItem) -- fallback cobre com o que já tava salvo. */
  function startEditSkin(skin: CustomSkinRow) {
    setCategory("avatar");
    setGender(skin.gender);
    setLabel(skin.label);
    setHex(skin.hex ?? AVATAR_TONE_NAMES[0].hex);
    setRawFiles({});
    setRawPlacements({});
    setActiveDirection("down");
    setEditingSkinId(skin.id);
    setEditingSkinSheetUrl(skin.sheet_url);
    setEditingAvatarItemId(null);
    setEditingAvatarItemSheetUrl(null);
    setColorToolItemId(null);
    setError(null);
    for (const key of Object.keys(fileInputRefs.current)) {
      const input = fileInputRefs.current[key];
      if (input) input.value = "";
    }
  }

  function cancelEditAvatarItem() {
    resetCreatorForm();
  }

  function handleGenderChange(next: AvatarGender) {
    setGender(next);
    setSelectedSkinIds([]);
  }

  // arrastar a foto ativa em cima do boneco de referência (mesmo esquema
  // de handleItemPointerDown do mobi, mais abaixo) -- offsetX/offsetY em
  // px de JOGO, convertidos do delta de tela pelo PREVIEW_SCALE.
  function handleArtPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const dir = activeDirection;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const start = placements[dir] ?? DEFAULT_PLACEMENT;
    const startOffsetX = start.offsetX;
    const startOffsetY = start.offsetY;

    function onMove(ev: PointerEvent) {
      const dx = (ev.clientX - startClientX) / PREVIEW_SCALE;
      const dy = (ev.clientY - startClientY) / PREVIEW_SCALE;
      setPlacements((prev) => ({
        ...prev,
        [dir]: {
          ...(prev[dir] ?? DEFAULT_PLACEMENT),
          offsetX: clamp(Math.round(startOffsetX + dx), -PLACEMENT_OFFSET_LIMIT, PLACEMENT_OFFSET_LIMIT),
          offsetY: clamp(Math.round(startOffsetY + dy), -PLACEMENT_OFFSET_LIMIT, PLACEMENT_OFFSET_LIMIT),
        },
      }));
    }
    function onUp(ev: PointerEvent) {
      target.releasePointerCapture(ev.pointerId);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
    }
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
  }

  // "Avatar Padrão" salva DIFERENTE do resto: 2 folhas (cabeça + traje,
  // ver padraoHeadFiles/padraoBodyFiles acima) numa tabela própria com
  // upsert por gender (só 1 por sexo, ver app/api/avatar-default-reference)
  // -- sem nome/tom pra escolher, então nem usa trimmedLabel/usesBySkin
  // do fluxo normal abaixo.
  async function handleAvatarPadraoSubmit() {
    if (!padraoHeadFiles.down) {
      setError("A foto de frente da CABEÇA é obrigatória.");
      return;
    }
    if (!padraoBodyFiles.down) {
      setError("A foto de frente do TRAJE (corpo limpo) é obrigatória.");
      return;
    }
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setSubmitting(true);
    try {
      const headBlob = await composeAvatarArtSheet(padraoHeadFiles, padraoHeadPlacements, FOUR_DIR_SHEET_SLOTS);
      const bodyBlob = await composeAvatarArtSheet(padraoBodyFiles, padraoBodyPlacements, FOUR_DIR_SHEET_SLOTS);
      const stamp = Date.now();
      const headPath = `avatar-default-reference/${gender}-cabeca-${stamp}.png`;
      const bodyPath = `avatar-default-reference/${gender}-traje-${stamp}.png`;
      const { error: headUploadError } = await supabase.storage
        .from("room-items")
        .upload(headPath, headBlob, { upsert: false, contentType: "image/png" });
      if (headUploadError) throw headUploadError;
      const { error: bodyUploadError } = await supabase.storage
        .from("room-items")
        .upload(bodyPath, bodyBlob, { upsert: false, contentType: "image/png" });
      if (bodyUploadError) throw bodyUploadError;
      const { data: headUrlData } = supabase.storage.from("room-items").getPublicUrl(headPath);
      const { data: bodyUrlData } = supabase.storage.from("room-items").getPublicUrl(bodyPath);
      const res = await fetch("/api/avatar-default-reference", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({
          gender,
          headSheetUrl: headUrlData.publicUrl,
          bodySheetUrl: bodyUrlData.publicUrl,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "erro ao salvar avatar padrão");
      await loadDefaultReference();
      // SEM resetCreatorForm() aqui de propósito -- pedido do Douglas:
      // "opcao de editar o avatar padrao e interessante tbm". Diferente
      // das outras categorias (onde salvar e limpar faz sentido, cada
      // "Cadastrar" é um item NOVO), o Avatar Padrão é só 1 por sexo e
      // ele vai voltar a mexer na posição várias vezes -- resetar aqui
      // forçava reescolher os 4 arquivos do zero a cada ajuste. Mantém
      // as fotos/posições como estão (upload continua no navegador),
      // então ele pode nudgear e clicar Cadastrar de novo (upsert já
      // substitui). Pra recomeçar com fotos diferentes, ver
      // handleClearPadrao/botão "Começar do zero" no JSX abaixo.
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "erro ao salvar");
    } finally {
      setSubmitting(false);
    }
  }

  // "Começar do zero" (ver JSX abaixo) -- limpa as fotos/posições do
  // Avatar Padrão (as duas partes) E, se já existir um salvo pro sexo
  // atual, apaga ele de vez (DELETE /api/avatar-default-reference) --
  // pedido do Douglas: "o botao comecar do zero nao apaga o avatar
  // antigo" (antes só limpava o upload em andamento; o registro salvo
  // continuava valendo como fallback -- ver avatarPadraoSaved acima --
  // então na prática nada parecia mudar). Confirma antes de apagar
  // porque não tem como desfazer (sem soft-delete/lixeira ainda). Não
  // mexe no resto do formulário (label/categoria/etc de outras abas) --
  // por isso separado do resetCreatorForm de sempre.
  async function handleClearPadrao() {
    const hadSaved = defaultReference[gender];
    if (hadSaved) {
      const ok = window.confirm(`Apagar de vez o Avatar Padrão ${gender} salvo? Não tem como desfazer.`);
      if (!ok) return;
      setSubmitting(true);
      setError(null);
      try {
        const res = await fetch(`/api/avatar-default-reference?gender=${gender}`, {
          method: "DELETE",
          headers: authHeaders,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "erro ao apagar avatar padrão");
        await loadDefaultReference();
      } catch (err) {
        setError(err instanceof Error ? err.message : "erro ao apagar");
        setSubmitting(false);
        return;
      }
      setSubmitting(false);
    }
    setPadraoHeadFiles({});
    setPadraoHeadPlacements({});
    setPadraoBodyFiles({});
    setPadraoBodyPlacements({});
    setPadraoPart("cabeca");
    for (const key of Object.keys(fileInputRefs.current)) {
      const input = fileInputRefs.current[key];
      if (input) input.value = "";
    }
  }

  async function handleAvatarCreatorSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (isAvatarPadrao) {
      await handleAvatarPadraoSubmit();
      return;
    }
    const trimmedLabel = label.trim();
    if (!trimmedLabel) {
      setError(category === "avatar" ? "Escolha um tom (Branco/Pardo/Negro)." : "Dá um nome pro item.");
      return;
    }
    // pedido "parado" continua vindo de rawFiles/rawPlacements SEMPRE
    // (mesmo campo de sempre) -- valida contra ele direto (não contra o
    // `files` computado acima, que no TRAJE pode estar apontando pra
    // aba Passo A/Passo B/Sentado no momento do clique em Cadastrar; nas
    // outras categorias `files === rawFiles` sempre, então não muda
    // nada pra elas). EDITANDO (editingAvatarItemId OU editingSkinId)
    // isso deixa de ser obrigatório -- sem foto nova de frente, o
    // fallback (folha já salva, ver composeAvatarArtSheet) cobre esse
    // quadro igual aos outros, mesma ideia do Mobi ("Editar" não exige
    // reenviar tudo).
    if (!editingAvatarItemId && !editingSkinId && !rawFiles.down) {
      setError("A imagem de frente (pose Parado) é obrigatória.");
      return;
    }
    if (usesBySkin && selectedSkinIds.length === 0) {
      setError("Selecione pra qual tom de pele isso vale.");
      return;
    }
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setSubmitting(true);
    let fallbackBitmap: ImageBitmap | null = null;
    try {
      // EDITANDO -- carrega a folha JÁ salva desse item OU tom de pele
      // como fallback (ver comentário grande em composeAvatarArtSheet):
      // qualquer quadro sem foto nova reaproveita o pixel já salvo em
      // vez de ficar em branco. Não bloqueia o save se não conseguir
      // carregar (fica null -- os dois *SheetUrl só existem em modo
      // edição, então isso nunca roda numa criação nova).
      if (editingAvatarItemId && editingAvatarItemSheetUrl) {
        fallbackBitmap = await loadImageBitmapFromUrl(avatarAssetUrl(editingAvatarItemSheetUrl));
      } else if (editingSkinId && editingSkinSheetUrl) {
        fallbackBitmap = await loadImageBitmapFromUrl(avatarAssetUrl(editingSkinSheetUrl));
      }
      // TRAJE monta a folha combinando as 4 poses (parado + opcional
      // passoA/passoB/sentado, ver composeAvatarArtSheetMultiPose e
      // trajePoseFiles acima) -- as outras categorias continuam com 1
      // foto por direção de sempre (composeAvatarArtSheet).
      const sheetBlob =
        category === "traje"
          ? await composeAvatarArtSheetMultiPose(
              {
                parado: rawFiles,
                passoA: trajePoseFiles.passoA,
                passoB: trajePoseFiles.passoB,
                sentado: trajePoseFiles.sentado,
              },
              {
                parado: rawPlacements,
                passoA: trajePosePlacements.passoA,
                passoB: trajePosePlacements.passoB,
                sentado: trajePosePlacements.sentado,
              },
              activeSlots,
              SKIN_SHEET_SLOT_POSES,
              fallbackBitmap
            )
          : await composeAvatarArtSheet(files, placements, activeSlots, fallbackBitmap);
      fallbackBitmap?.close?.();
      const slug = slugify(trimmedLabel);
      const pathPrefix = category === "avatar" ? "avatar-skins" : "avatar-items";
      const path = `${pathPrefix}/${category}-${gender}-${slug}-${Date.now()}.png`;
      const { error: uploadError } = await supabase.storage.from("room-items").upload(path, sheetBlob, {
        upsert: false,
        contentType: "image/png",
      });
      if (uploadError) throw uploadError;
      const { data: publicUrlData } = supabase.storage.from("room-items").getPublicUrl(path);

      // ver comentário grande mais abaixo, perto de MOBI_REFERENCE_OUTFIT_STORAGE_KEY
      // -- só as 2 ramificações de "traje" preenchem isso.
      let touchedOutfitId: string | undefined;

      if (category === "avatar" && editingSkinId) {
        // "Editar" (pedido do Douglas: "quero editar o Avatar tambem")
        // -- PATCH no lugar de POST, mesmo tom (não cria uma linha
        // nova). O PATCH também apaga a folha ANTIGA no Storage por
        // melhor esforço (ver app/api/avatar-skins/[id]/route.ts).
        const res = await fetch(`/api/avatar-skins/${editingSkinId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({ label: trimmedLabel, gender, sheetUrl: publicUrlData.publicUrl, hex }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "erro ao salvar alterações");
        await loadSkins();
      } else if (category === "avatar") {
        const res = await fetch("/api/avatar-skins", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({ label: trimmedLabel, gender, sheetUrl: publicUrlData.publicUrl, hex }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "erro ao salvar tom de pele");
        await loadSkins();
      } else if (editingAvatarItemId) {
        // "Editar" (pedido do Douglas: "quero editar as coisas ja
        // criadas, fotos etc") -- PATCH no lugar de POST, mesmo item
        // (não cria uma linha nova). O PATCH também apaga a folha
        // ANTIGA no Storage por melhor esforço (ver app/api/avatar-items/
        // [id]/route.ts) -- não precisa fazer isso aqui.
        const res = await fetch(`/api/avatar-items/${editingAvatarItemId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({
            category,
            gender,
            label: trimmedLabel,
            skinIds: selectedSkinIds,
            sheetUrl: publicUrlData.publicUrl,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "erro ao salvar alterações");
        await loadAvatarItems();
        touchedOutfitId = category === "traje" ? editingAvatarItemId : undefined;
      } else {
        const res = await fetch("/api/avatar-items", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({
            category,
            gender,
            label: trimmedLabel,
            skinIds: selectedSkinIds,
            sheetUrl: publicUrlData.publicUrl,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "erro ao salvar item");
        await loadAvatarItems();
        // resposta é { item: {...} } (ver POST /api/avatar-items),
        // não { id } direto.
        touchedOutfitId = category === "traje" ? data.item?.id : undefined;
      }

      // Douglas: "atualiza o carinha sentado no editor de mobi" / "eu
      // alterei ele, tem que atualizar" -- o boneco de referência do
      // Mobi (ver referenceOutfit mais abaixo) escolhia sempre o ÚLTIMO
      // traje do CATÁLOGO (upsertCatalogById mantém a posição de quem já
      // existia, só empurra item NOVO pro fim -- ver customization.ts).
      // Isso só reflete "o traje mais recente" quando é um traje
      // CRIADO agora; editar um traje mais ANTIGO (não o último da
      // lista) atualiza os dados dele certinho, mas o boneco de
      // referência continuava mostrando outro traje (o último criado,
      // não o que acabou de ser editado). Guarda qual foi o traje
      // tocado por ÚLTIMO (criado OU editado) no localStorage -- sobrevive
      // a fechar/reabrir o Editor de Itens, sem precisar de coluna nova
      // no banco (avatar_items não tem updated_at).
      if (touchedOutfitId) {
        try {
          window.localStorage.setItem(MOBI_REFERENCE_OUTFIT_STORAGE_KEY, touchedOutfitId);
        } catch {
          // localStorage indisponível (modo privado etc.) -- boneco de
          // referência só cai no fallback de sempre (último do catálogo)
        }
      }

      resetCreatorForm();
      onChanged();
    } catch (err) {
      fallbackBitmap?.close?.();
      setError(err instanceof Error ? err.message : "erro ao salvar");
    } finally {
      setSubmitting(false);
    }
  }

  // boneco de referência do editor de posição -- sexo-ciente (pega o
  // primeiro tom cadastrado do sexo escolhido, não sempre o masculino
  // padrão como o resto do editor faz pro móvel) e NA POSE da direção
  // ativa (ver DIRECTION_FIRST_FRAME_INDEX acima) -- pedido do Douglas:
  // "editor de posicionamento dos itens... em relação ao avatar". CRU
  // de propósito na ausência de Avatar Padrão (só o tom de pele -- SEM
  // cabelo/traje "de fábrica" em cima, pedido do Douglas: "nessa aba o
  // avatar tem que estar cru, pra adicionar os itens") -- cabelo/traje/
  // barba/acessório "de fábrica" só confundiriam a posição de quem tá
  // sendo cadastrado agora, inclusive quando a categoria É cabelo/traje
  // (arte de referência
  // diferente da que tá subindo, sobreposta/atrás sem sentido nenhum).
  // sem NENHUM tom cadastrado ainda pro sexo escolhido (pedido do
  // Douglas: "cadê o tile na rotação, tô sem referência pra subir
  // avatar" -- ficava sem boneco NENHUM nesse caso, só a foto subida
  // sozinha, sem nada atrás pra servir de referência de posição/
  // tamanho) -- cai num tom de QUALQUER sexo só pra não deixar o
  // preview vazio (proporção do corpo pode não bater exatamente, mas
  // ainda dá um boneco de verdade pra alinhar a foto por cima). Aviso
  // embaixo (ver referenceSkinIsFallback) quando isso acontece.
  // pedido do Douglas: "a cabeça selecionada deveria aparecer no editor,
  // na posição que eu setei ela, pra dai sim eu salvar o restante a
  // partir dela, e que fique travado nela" -- em categoria bySkin
  // (barba/traje), o boneco de referência tem que ser o(s) TOM(NS) que
  // a pessoa marcou nos chips acima (ver tone-chip mais abaixo), não
  // qualquer um do mesmo sexo -- senão a posição alinhada no editor
  // (contra um corpo) pode não bater com o corpo de verdade que a peça
  // vai vestir. Só cai no "qualquer um do sexo" (ou de outro sexo, ver
  // referenceSkinIsFallback) quando ainda não marcou nenhum tom, ou a
  // categoria nem usa bySkin (cabelo/acessório, onde não existe seleção
  // de tom pra começo de conversa).
  const selectedReferenceSkin =
    usesBySkin && selectedSkinIds.length > 0 ? SKIN_CATALOG.find((s) => s.id === selectedSkinIds[0]) : undefined;
  // "Avatar Padrão" do sexo (ver DefaultReferenceRow acima) -- entra em
  // TODAS as categorias, incluindo "avatar" (cadastro de tom de pele
  // novo) -- pedido do Douglas: "eu uso ele exatamente de referencia
  // sempre, pra tudo em avatares" (e depois, quando só aparecia nas
  // outras: "ele so nao aparece na opcao de avatar"). Só a própria aba
  // "avatar_padrao" fica de fora (ela É o cadastro do padrão, não faz
  // sentido usar ele de referência de si mesmo enquanto ainda não
  // existe -- ver avatarPadraoSaved mais abaixo, que cobre esse caso à
  // parte).
  const genderDefaultReference = !isAvatarPadrao ? defaultReference[gender] : null;
  const referenceSkin = selectedReferenceSkin ?? genderSkins[0] ?? SKIN_CATALOG[0];
  const referenceSkinIsFallback =
    Boolean(referenceSkin) && !selectedReferenceSkin && !genderDefaultReference && genderSkins.length === 0;
  // pedido do Douglas depois de cadastrar um Avatar Padrão: "eu acabei
  // de criar um avatar padrao e ele sumiu kkk ai e foda" -- ao clicar
  // Cadastrar, resetCreatorForm() limpa padraoHeadFiles/padraoBodyFiles
  // (upload consumido), e como essa aba não usava genderDefaultReference
  // (só o par AO VIVO, ver otherPadraoArtUrl), o boneco sumia por
  // completo sem confirmar que salvou. Fix: SEM nenhuma foto sendo
  // subida agora (upload em branco -- acabou de abrir a aba, ou acabou
  // de cadastrar), cai no Avatar Padrão JÁ SALVO desse sexo (se tiver)
  // em vez de ficar vazio; assim que ele sobe uma foto de novo (pra
  // trocar/atualizar), volta a mostrar só o par ao vivo de sempre.
  const avatarPadraoHasLiveUpload =
    isAvatarPadrao && (Object.keys(padraoHeadFiles).length > 0 || Object.keys(padraoBodyFiles).length > 0);
  const avatarPadraoSaved = isAvatarPadrao && !avatarPadraoHasLiveUpload ? defaultReference[gender] : null;
  // URL da CABEÇA mostrada no boneco: tom explicitamente selecionado (ver
  // selectedReferenceSkin acima) vence sempre que existir; senão, o
  // Avatar Padrão do sexo (mais estável/consistente que "qualquer tom
  // cadastrado"); senão cai no referenceSkin de sempre. Na própria aba
  // "Avatar Padrão", ENQUANTO tá subindo foto, isso fica DESLIGADO
  // (undefined) -- mostrar um tom qualquer ali só atrapalha (pedido do
  // Douglas: "essa cabeca ai" era confuso, sem relação com o que ele
  // tava subindo); nessa hora quem aparece é só o PRÓPRIO par cabeça/
  // traje que ele tá montando, ver otherPadraoArtUrl mais abaixo. SEM
  // upload em andamento, mostra o Avatar Padrão já salvo (avatarPadraoSaved
  // acima) em vez de ficar vazio.
  const referenceHeadUrl = isAvatarPadrao
    ? avatarPadraoSaved
      ? avatarAssetUrl(avatarPadraoSaved.head_sheet_url)
      : undefined
    : selectedReferenceSkin
      ? avatarAssetUrl(selectedReferenceSkin.file)
      : genderDefaultReference
        ? avatarAssetUrl(genderDefaultReference.head_sheet_url)
        : referenceSkin
          ? avatarAssetUrl(referenceSkin.file)
          : undefined;
  // corpo/traje "limpo" do Avatar Padrão, desenhado ATRÁS da cabeça
  // (mesma ordem de LAYER_DRAW_ORDER em MainScene.ts: traje antes de
  // base) -- independe de qual cabeça/tom tá sendo mostrada em cima.
  // Mesma lógica de fallback pro salvo na própria aba "Avatar Padrão".
  const referenceBodyUrl = isAvatarPadrao
    ? avatarPadraoSaved
      ? avatarAssetUrl(avatarPadraoSaved.body_sheet_url)
      : undefined
    : genderDefaultReference
      ? avatarAssetUrl(genderDefaultReference.body_sheet_url)
      : undefined;
  // pose-aware (pedido do Douglas: "sentou torto ai eu fui arrumar e
  // nao aparecia em editar") -- esse índice recortava SEMPRE o quadro
  // de "Parado" (DIRECTION_FIRST_FRAME_INDEX), mesmo com a aba
  // "Sentado"/"Passo A"/"Passo B" ativa (activePose) -- então abrir
  // "Editar" num traje, trocar pra "Sentado" pra ajustar a posição,
  // mostrava o quadro de PARADO daquela direção (às vezes vazio) em
  // vez do quadro sentado que realmente tinha a foto. Dentro de cada
  // direção a folha guarda parado/passoA/passoB em sequência (offset
  // 0/1/2, ver SKIN_SHEET_SLOT_POSES acima); sentado é um bloco à
  // parte (SEAT_FRAME_INDEX, "up" reaproveita o quadro de parado --
  // mesma observação de sempre, sem sentado-de-costas próprio).
  const activeFrameIndex =
    activePose === "sentado"
      ? SEAT_FRAME_INDEX[activeDirection]
      : activePose === "passoA"
        ? DIRECTION_FIRST_FRAME_INDEX[activeDirection] + 1
        : activePose === "passoB"
          ? DIRECTION_FIRST_FRAME_INDEX[activeDirection] + 2
          : DIRECTION_FIRST_FRAME_INDEX[activeDirection];
  const frameCol = activeFrameIndex % SKIN_SHEET_COLS;
  const frameRow = Math.floor(activeFrameIndex / SKIN_SHEET_COLS);
  const frameOffsetXPx = frameCol * (FRAME_W + SKIN_SHEET_SPACING) * AVATAR_SCALE * PREVIEW_SCALE;
  const frameOffsetYPx = frameRow * (FRAME_H + SKIN_SHEET_SPACING) * AVATAR_SCALE * PREVIEW_SCALE;

  const activeDirectionLabel = activeDirectionFields.find((f) => f.key === activeDirection)?.label ?? activeDirection;

  // pedido do Douglas: "editar traje"/"editar avatar" não tava
  // mostrando a foto já salva daquele item -- activeArtUrl (acima) só
  // existe pra arquivo NOVO escolhido nesta sessão (blob local), então
  // abrir "Editar" num traje/tom já cadastrado, sem reenviar nada, caía
  // direto no hint "Escolha a foto..." mesmo já tendo arte cadastrada
  // (a folha inteira, sheet_url, continua salva no servidor -- só não
  // tinha nenhum <img> mostrando ela aqui). Fallback: sem foto nova pra
  // NENHUMA direção (mesmo "sem própria" do activeFile acima, que já
  // cai em files.down) E editando um item existente, recorta a folha
  // JÁ SALVA no frame da direção ativa -- mesmo recorte de
  // referenceHeadUrl/referenceBodyUrl acima (activeFrameIndex/
  // frameOffsetXPx/frameOffsetYPx), só que aplicado na folha do
  // PRÓPRIO item em edição em vez da referência fixa.
  const editingArtSheetUrl = editingAvatarItemId
    ? editingAvatarItemSheetUrl
    : editingSkinId
      ? editingSkinSheetUrl
      : null;
  const existingFrameUrl = !activeFile && editingArtSheetUrl ? avatarAssetUrl(editingArtSheetUrl) : null;

  return (
    <>
      <div className="gender-switch">
        <button
          type="button"
          className={gender === "masculino" ? "gender-btn selected" : "gender-btn"}
          onClick={() => handleGenderChange("masculino")}
        >
          Masculino
        </button>
        <button
          type="button"
          className={gender === "feminino" ? "gender-btn selected" : "gender-btn"}
          onClick={() => handleGenderChange("feminino")}
        >
          Feminino
        </button>
      </div>

      <div className="edit-section-tabs">
        {AVATAR_CREATOR_CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            className={category === c.id ? "edit-section-tab selected" : "edit-section-tab"}
            onClick={() => handleCategoryChange(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>

      {/* nota de "editando" -- pedido do Douglas: "quero editar as
          coisas ja criadas, fotos etc" / "quero editar o Avatar
          tambem". Mesmo padrão do "Editar" de Mobi (texto extra
          encostado no hint de sempre, ver "Só reenvie a foto..." mais
          abaixo no form de Mobi) -- cobre tanto item CUSTOM (cabelo/
          acessório/barba/traje, editingAvatarItemId) quanto tom de pele
          (editingSkinId), ver os dois acima. */}
      <p className="settings-hint">
        {editingAvatarItemId || editingSkinId
          ? "Editando -- nenhuma foto é obrigatória aqui, reenvie só a(s) direção/pose que quiser TROCAR, o resto continua com a arte já salva."
          : 'Só a foto de "Frente esquerda" é obrigatória -- sem as outras, o jogo reaproveita a de frente virada nas outras direções (prévia rápida até você subir o resto).'}{" "}
        Arraste a foto em cima do boneco pra posicionar, e use o slider pra ajustar o tamanho -- cada direção guarda o
        próprio ajuste.
      </p>

      <form className="items-panel-form" onSubmit={handleAvatarCreatorSubmit}>
        {isAvatarPadrao ? (
          <>
            {/* "Avatar Padrão": sem nome/tom pra escolher (só 1 por
                sexo, ver DefaultReferenceRow acima) -- em vez disso,
                escolhe qual das 2 partes tá editando agora (cabeça ou
                traje/corpo limpo), cada uma com seu próprio conjunto de
                fotos por direção (ver padraoPart/files computado
                acima). */}
            <div className="gender-switch">
              <button
                type="button"
                className={padraoPart === "cabeca" ? "gender-btn selected" : "gender-btn"}
                onClick={() => setPadraoPart("cabeca")}
              >
                Cabeça {padraoHeadFiles.down ? "✓" : ""}
              </button>
              <button
                type="button"
                className={padraoPart === "traje" ? "gender-btn selected" : "gender-btn"}
                onClick={() => setPadraoPart("traje")}
              >
                Traje (corpo limpo) {padraoBodyFiles.down ? "✓" : ""}
              </button>
            </div>
            <p className="settings-hint">
              Sobe as duas partes (cabeça e traje/corpo limpo) e clica em Cadastrar UMA vez só no final -- as fotos
              ficam guardadas ao trocar de aba aqui em cima. Depois de cadastrar, as fotos CONTINUAM aqui -- pode
              seguir ajustando a posição e clicar em Cadastrar de novo quantas vezes quiser (substitui o anterior).
              {defaultReference[gender] ? " Já existe um Avatar Padrão " + gender + " salvo." : ""}
            </p>
          </>
        ) : category === "avatar" ? (
          <>
            <div className="tone-select">
              {AVATAR_TONE_NAMES.map((tone) => (
                <button
                  key={tone.label}
                  type="button"
                  className={label === tone.label ? "tone-chip selected" : "tone-chip"}
                  onClick={() => {
                    setLabel(tone.label);
                    setHex(tone.hex);
                  }}
                >
                  <span className="tone-chip-swatch" style={{ background: tone.hex }} />
                  {tone.label}
                </button>
              ))}
            </div>
            {/* CORRIGIDO (era "com corpo inteiro", pedido antigo errado --
                ver conversa no chat: "a gente criou pro jogo cabeça e
                traje, o corpo padrão não vai pro jogo"). Tom de pele é só
                a CABEÇA/busto (ver SKIN_CATALOG/MainScene.ts "base") --
                quem dá o corpo inteiro (tronco/braços/pernas) é o
                "Traje", desenhado ATRÁS da cabeça (ver LAYER_DRAW_ORDER em
                MainScene.ts). Mesmo enquadramento das fotos de cabeça do
                "Avatar Padrão". */}
            <p className="settings-hint">
              Cada foto de direção mostra só a CABEÇA/busto do personagem -- esse tom vira a cabeça do boneco no
              jogo (mesmo enquadramento da cabeça do "Avatar Padrão"). Quem dá o corpo inteiro (tronco, braços,
              pernas) é o "Traje", cadastrado à parte -- uma foto de corpo inteiro aqui vai ficar com o corpo
              errado, sobreposto pelo traje.
            </p>
          </>
        ) : (
          <input
            className="items-panel-input"
            type="text"
            placeholder="Nome do item"
            value={label}
            maxLength={40}
            onChange={(e) => setLabel(e.target.value)}
          />
        )}

        {category === "avatar" && (
          <div className="items-panel-upload-field">
            <span>Cor do botão (opcional)</span>
            <ColorPickerField value={hex} onChange={setHex} />
          </div>
        )}

        {usesBySkin && (
          <div className="items-panel-upload-field">
            <span>Aplica pra qual tom de pele</span>
            {genderSkins.length === 0 ? (
              <p className="settings-hint">
                Nenhum tom de pele "{gender}" cadastrado ainda -- cadastre um em "Avatar" primeiro.
              </p>
            ) : (
              <>
                <div className="tone-select">
                  {genderSkins.map((skin) => (
                    <button
                      key={skin.id}
                      type="button"
                      className={selectedSkinIds.includes(skin.id) ? "tone-chip selected" : "tone-chip"}
                      onClick={() =>
                        setSelectedSkinIds((prev) =>
                          prev.includes(skin.id) ? prev.filter((id) => id !== skin.id) : [...prev, skin.id]
                        )
                      }
                    >
                      <span className="tone-chip-swatch" style={{ background: skin.hex ?? "#8a7ca8" }} />
                      {skin.label}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="clear-btn"
                  onClick={() =>
                    setSelectedSkinIds(
                      selectedSkinIds.length === genderSkins.length ? [] : genderSkins.map((s) => s.id)
                    )
                  }
                >
                  {selectedSkinIds.length === genderSkins.length ? "Limpar seleção" : "Selecionar todos"}
                </button>
              </>
            )}
          </div>
        )}

        {/* TRAJE com movimento (pedido do Douglas: "somente o traje vai
            ter o movimento de andar e sentar") -- toggle Parado/Passo A/
            Passo B/Sentado, mesma ideia visual do toggle Cabeça/Traje do
            Avatar Padrão acima. Opcional: sem foto pra um passo/sentado,
            a peça continua reaproveitando a foto "Parado" daquela
            direção (comportamento de sempre). "Sentado" não tem "Costas"
            (ver activeDirectionFields/comentário de SKIN_SHEET_SLOT_POSES). */}
        {category === "traje" && (
          <div className="items-panel-upload-field">
            <span>Pose (movimento ao andar/sentar)</span>
            <div className="gender-switch">
              <button
                type="button"
                className={activePose === "parado" ? "gender-btn selected" : "gender-btn"}
                onClick={() => setActivePose("parado")}
              >
                Parado *
              </button>
              {TRAJE_POSE_PARTS.map((part) => (
                <button
                  key={part.id}
                  type="button"
                  className={activePose === part.id ? "gender-btn selected" : "gender-btn"}
                  onClick={() => setActivePose(part.id)}
                >
                  {part.label} {trajePoseFiles[part.id].down ? "✓" : ""}
                </button>
              ))}
            </div>
            <p className="settings-hint">
              "Passo A"/"Passo B" alternam a cada passo dado (dá a sensação de andar); "Sentado" é a pose enquanto
              sentado num móvel. Todas opcionais -- sem elas, reaproveita a foto "Parado" de cada direção, como
              sempre.
            </p>
          </div>
        )}

        <div className="items-panel-uploads">
          {activeDirectionFields.map((field) => (
            <label key={`${activePose}-${field.key}`} className="items-panel-upload-field">
              <span>
                {field.label}
                {field.key === "down" && activePose === "parado" ? " *" : ""}
              </span>
              <input
                ref={(el) => {
                  fileInputRefs.current[`${activePose}-${field.key}`] = el;
                }}
                type="file"
                accept="image/*"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  // recorte é OPCIONAL (ver ImageCropModal acima,
                  // "Usar sem cortar" mantém o mesmo comportamento de
                  // antes) -- só decide o File final depois que a
                  // pessoa fechar o modal, não aqui.
                  setPendingCrop({
                    file,
                    inputKey: `${activePose}-${field.key}`,
                    apply: (result) => {
                      setFiles((prev) => ({ ...prev, [field.key]: result }));
                      setActiveDirection(field.key);
                    },
                  });
                }}
              />
            </label>
          ))}
        </div>

        {/* editor de posição/tamanho -- pedido do Douglas: "preciso
            posicionar e redimensionar" -- abas de direção (só as que a
            categoria usa, ver activeDirectionFields) trocam qual foto
            tá sendo ajustada; o boneco de referência muda de POSE
            junto (ver frameOffsetXPx/frameOffsetYPx acima). */}
        <div className="edit-section-tabs">
          {activeDirectionFields.map((field) => (
            <button
              key={field.key}
              type="button"
              className={activeDirection === field.key ? "edit-section-tab selected" : "edit-section-tab"}
              onClick={() => setActiveDirection(field.key)}
            >
              {field.label}
            </button>
          ))}
        </div>

        {referenceSkinIsFallback && (
          <p className="settings-hint">
            Ainda não tem nenhum tom de pele "{gender}" cadastrado -- o boneco abaixo é de OUTRO sexo, só pra não
            deixar o preview vazio (o corpo pode não bater exatamente). Cadastre um tom de pele "{gender}" em
            "Avatar" primeiro pra ter a referência certa.
          </p>
        )}

        {/* confirma QUAL tom o boneco abaixo representa -- pedido do
            Douglas: "a cabeça selecionada deveria aparecer no editor...
            travado nela". Só aparece quando dá pra escolher mais de 1
            tom (usesBySkin) -- se marcou vários, o boneco mostra o
            PRIMEIRO da lista (selectedSkinIds[0]), então avisa qual é,
            já que os outros tons marcados podem ter proporção um pouco
            diferente (cada um foi alinhado/subido separado). */}
        {usesBySkin && selectedReferenceSkin && (
          <p className="settings-hint">
            Boneco de referência abaixo: <strong>{selectedReferenceSkin.label}</strong>
            {selectedSkinIds.length > 1
              ? ` (o 1º dos ${selectedSkinIds.length} tons marcados -- os outros podem ter o corpo levemente diferente, cada um foi cadastrado à parte)`
              : ""}
            .
          </p>
        )}

        {/* Avatar Padrão do sexo entrando como referência (pedido do
            Douglas: "esse padrao voce coloca ele inteiro montado no
            editor quando eu for criar outros... uso ele exatamente de
            referencia sempre, pra tudo em avatares"). Só avisa sobre o
            CORPO aqui -- a cabeça já tem seu próprio aviso acima quando
            vem de um tom selecionado. */}
        {referenceBodyUrl && (
          <p className="settings-hint">
            Corpo/traje do boneco abaixo: <strong>Avatar Padrão {gender}</strong> (cadastrado em "Avatar Padrão").
          </p>
        )}

        {/* zoom do preview -- pedido do Douglas: "tem como eu dar zoom
            nesse editor? ta mt longe". Mesmo padrão visual do slider de
            Tamanho mais abaixo, só que controla o preview inteiro (não
            entra no que é salvo -- é só visualização). */}
        <div className="settings-slider-row">
          <span className="settings-slider-name">Zoom do preview</span>
          <input
            type="range"
            min={0.75}
            max={3}
            step={0.25}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
          />
          <span className="settings-slider-value">{Math.round(zoom * 100)}%</span>
        </div>

        <div className="item-size-card">
          <div className="item-stage item-stage-compact" style={{ height: AVATAR_STAGE_HEIGHT, zoom }}>
            <div
              className="item-stage-avatar"
              style={{
                bottom: STAGE_BASELINE_PAD + AVATAR_FOOT_FROM_TILE_BOTTOM,
                width: AVATAR_DISPLAY_W,
                height: AVATAR_DISPLAY_H,
              }}
              title="Boneco de referência -- pose da direção escolhida acima"
            >
              <div
                className="item-stage-avatar-crop"
                style={{
                  width: FRAME_W,
                  height: FRAME_H,
                  marginLeft: -FRAME_W / 2,
                  transform: `translate(-${frameOffsetXPx}px, -${frameOffsetYPx}px) scale(${AVATAR_SCALE * PREVIEW_SCALE})`,
                }}
              >
                {/* corpo/traje do Avatar Padrão primeiro (embaixo), depois
                    a cabeça -- mesma ordem de LAYER_DRAW_ORDER em
                    MainScene.ts ("traje" antes de "base"). Sem Avatar
                    Padrão cadastrado ainda pro sexo, só mostra a cabeça
                    crua de sempre (referenceHeadUrl cai pro referenceSkin). */}
                {referenceBodyUrl && (
                  <img className="item-stage-avatar-layer" src={referenceBodyUrl} alt="" />
                )}
                {referenceHeadUrl && (
                  <img className="item-stage-avatar-layer" src={referenceHeadUrl} alt="" />
                )}
              </div>
            </div>

            {/* tile de referência embaixo do boneco (pedido do Douglas:
                "o tile continua nao aparecendo" -- faltava aqui, só o
                editor de mobi tinha, ver item-stage-tile no form
                principal mais abaixo). Mesmo tamanho/âncora ali. */}
            <div
              className="item-stage-tile"
              style={{ bottom: STAGE_BASELINE_PAD, width: TILE_WIDTH_PX, height: TILE_HEIGHT_PX }}
            />

            {/* pedido do Douglas: "eu salvei ela, e depois ela diminuiu
                bastante em relacao ao tile" -- a caixa que você arrasta
                aqui (foto CRUA, ainda sem compor) tava do tamanho
                FRAME_W*PREVIEW_SCALE (500x650px de tela), maior que o
                boneco de referência atrás dela (que já mostra o tamanho
                REAL do jogo, FRAME_W*AVATAR_SCALE*PREVIEW_SCALE =
                AVATAR_DISPLAY_W/H, ~322x419px -- AVATAR_SCALE=0.645 é o
                fator que o jogo usa pra desenhar o boneco, ver
                MainScene.ts). composeAvatarArtSheet queima a posição/
                escala que você ajusta aqui DENTRO da folha 200x260 (em
                pixels do frame, não de tela), e essa folha É desenhada
                depois no tamanho real (boneco de jogo/preview do
                editor) -- então alinhar contra uma caixa ~55% maior
                fazia o resultado final vir sistematicamente menor do
                que parecia no editor. Fix: caixa e translate (offsetX/
                offsetY) agora usam AVATAR_DISPLAY_W/H e
                AVATAR_SCALE*PREVIEW_SCALE, igual o boneco de referência
                -- WYSIWYG de verdade agora.

                "Avatar Padrão" editando a CABEÇA: mostra o TRAJE já
                upado (se tiver) por baixo, fixo -- pra alinhar a cabeça
                contra o corpo. Vem ANTES do boneco ativo no DOM de
                propósito (traje embaixo, cabeça em cima, mesma ordem de
                LAYER_DRAW_ORDER). */}
            {isAvatarPadrao && padraoPart === "cabeca" && otherPadraoArtUrl && (
              <div
                className="avatar-art-drag-box avatar-art-drag-box-other-part"
                style={{
                  width: AVATAR_DISPLAY_W,
                  height: AVATAR_DISPLAY_H,
                  bottom: STAGE_BASELINE_PAD + AVATAR_FOOT_FROM_TILE_BOTTOM,
                  transform: `translate(calc(-50% + ${otherPadraoPlacement.offsetX * AVATAR_SCALE * PREVIEW_SCALE}px), ${otherPadraoPlacement.offsetY * AVATAR_SCALE * PREVIEW_SCALE}px) scale(${otherPadraoPlacement.scale})`,
                }}
                title="Traje (corpo limpo) já upado -- só referência aqui, pra ajustar troque pra aba Traje"
              >
                <img className="avatar-art-drag-img" src={otherPadraoArtUrl} alt="" />
              </div>
            )}

            {activeArtUrl ? (
              <div
                className={hasOwnFile ? "avatar-art-drag-box" : "avatar-art-drag-box avatar-art-drag-box-ghost"}
                style={{
                  width: AVATAR_DISPLAY_W,
                  height: AVATAR_DISPLAY_H,
                  bottom: STAGE_BASELINE_PAD + AVATAR_FOOT_FROM_TILE_BOTTOM,
                  transform: `translate(calc(-50% + ${activePlacement.offsetX * AVATAR_SCALE * PREVIEW_SCALE}px), ${activePlacement.offsetY * AVATAR_SCALE * PREVIEW_SCALE}px) scale(${activePlacement.scale})`,
                }}
                onPointerDown={hasOwnFile ? handleArtPointerDown : undefined}
                title={hasOwnFile ? "Arraste pra posicionar" : "Foto de frente reaproveitada -- suba a foto própria pra ajustar"}
              >
                <img className="avatar-art-drag-img" src={activeArtUrl} alt="Preview" />
              </div>
            ) : existingFrameUrl ? (
              // "item-stage-avatar" (NÃO "avatar-art-drag-box") de
              // propósito -- é essa classe que tem o overflow:hidden que
              // corta a folha inteira num quadro só (ver comentário
              // grande dela em globals.css: o corte tem que ficar no
              // container SEM transform, com o translate/scale no FILHO
              // -- "avatar-art-drag-box" não corta nada, por isso a
              // folha inteira aparecia enorme/torta ao editar uma pose
              // que não fosse a primeira do quadro (bug reportado pelo
              // Douglas: "estranho" com Frente direita aberta).
              <div
                className="item-stage-avatar"
                style={{
                  width: AVATAR_DISPLAY_W,
                  height: AVATAR_DISPLAY_H,
                  bottom: STAGE_BASELINE_PAD + AVATAR_FOOT_FROM_TILE_BOTTOM,
                  opacity: 0.55,
                }}
                title="Foto já salva -- suba um arquivo novo pra trocar essa direção"
              >
                <div
                  className="item-stage-avatar-crop"
                  style={{
                    width: FRAME_W,
                    height: FRAME_H,
                    marginLeft: -FRAME_W / 2,
                    transform: `translate(-${frameOffsetXPx}px, -${frameOffsetYPx}px) scale(${AVATAR_SCALE * PREVIEW_SCALE})`,
                  }}
                >
                  <img className="item-stage-avatar-layer" src={existingFrameUrl} alt="Foto já salva" />
                </div>
              </div>
            ) : (
              <p className="edit-hint item-size-empty">Escolha a foto de "{activeDirectionLabel}" pra ver o preview aqui.</p>
            )}

            {/* "Avatar Padrão" editando o TRAJE: mostra a CABEÇA já upada
                por cima, fixa -- pra alinhar o corpo contra a cabeça.
                Vem DEPOIS do boneco ativo de propósito (cabeça sempre em
                cima do traje). */}
            {isAvatarPadrao && padraoPart === "traje" && otherPadraoArtUrl && (
              <div
                className="avatar-art-drag-box avatar-art-drag-box-other-part"
                style={{
                  width: AVATAR_DISPLAY_W,
                  height: AVATAR_DISPLAY_H,
                  bottom: STAGE_BASELINE_PAD + AVATAR_FOOT_FROM_TILE_BOTTOM,
                  transform: `translate(calc(-50% + ${otherPadraoPlacement.offsetX * AVATAR_SCALE * PREVIEW_SCALE}px), ${otherPadraoPlacement.offsetY * AVATAR_SCALE * PREVIEW_SCALE}px) scale(${otherPadraoPlacement.scale})`,
                }}
                title="Cabeça já upada -- só referência aqui, pra ajustar troque pra aba Cabeça"
              >
                <img className="avatar-art-drag-img" src={otherPadraoArtUrl} alt="" />
              </div>
            )}

            <StageRuler
              anchorBottomPx={STAGE_BASELINE_PAD + AVATAR_FOOT_FROM_TILE_BOTTOM}
              pxPerUnit={AVATAR_SCALE * PREVIEW_SCALE}
              yRange={AVATAR_RULER_Y_RANGE}
            />
          </div>

          <div className="settings-slider-row">
            <span className="settings-slider-name">Tamanho ({activeDirectionLabel})</span>
            <input
              type="range"
              min={0.3}
              max={2.5}
              step={0.05}
              disabled={!hasOwnFile}
              value={activePlacement.scale}
              onChange={(e) =>
                setPlacements((prev) => ({
                  ...prev,
                  [activeDirection]: { ...(prev[activeDirection] ?? DEFAULT_PLACEMENT), scale: Number(e.target.value) },
                }))
              }
            />
            <span className="settings-slider-value">{Math.round(activePlacement.scale * 100)}%</span>
          </div>

          <div className="item-stage-offset-row">
            <span>
              posição ({activeDirectionLabel}) -- x: {activePlacement.offsetX}px · y: {activePlacement.offsetY}px
            </span>
            {hasOwnFile && (activePlacement.offsetX !== 0 || activePlacement.offsetY !== 0 || activePlacement.scale !== 1) && (
              <button
                type="button"
                className="clear-btn"
                onClick={() => setPlacements((prev) => ({ ...prev, [activeDirection]: DEFAULT_PLACEMENT }))}
              >
                Resetar posição/tamanho
              </button>
            )}
          </div>
        </div>

        {error && <p className="items-panel-error">{error}</p>}

        <div className="items-panel-submit-row">
          <button type="submit" className="items-panel-submit" disabled={submitting}>
            {submitting ? "Enviando..." : editingAvatarItemId || editingSkinId ? "Salvar alterações" : "Cadastrar"}
          </button>
          {(editingAvatarItemId || editingSkinId) && (
            <button type="button" className="clear-btn" onClick={cancelEditAvatarItem} disabled={submitting}>
              Cancelar edição
            </button>
          )}
          {/* "Começar do zero" (Avatar Padrão) -- pedido do Douglas: "pore
              ele la embaixo, pra eu nao clicar errado, do lado direito
              de Cadastrar, mas encostado na borda lateral direita"
              (morava perto do toggle Cabeça/Traje antes, fácil de
              clicar sem querer). margin-left:auto empurra pra borda,
              ver .items-panel-submit-row .clear-btn em globals.css.
              SEMPRE visível nessa aba (antes só aparecia com upload em
              andamento -- Douglas: "cade o botao kkk", porque um
              reload da página some com os arquivos escolhidos (File do
              navegador, não sobrevive reload) e o botão sumia junto,
              parecendo bug). E de verdade apaga o Avatar Padrão salvo
              agora (com confirmação) -- Douglas: "o botao comecar do
              zero nao apaga o avatar antigo", ver handleClearPadrao. */}
          {isAvatarPadrao && (
            <button type="button" className="clear-btn" onClick={handleClearPadrao} disabled={submitting}>
              Começar do zero (trocar as fotos)
            </button>
          )}
        </div>
      </form>

      <section className="items-panel-section">
        {category === "avatar" ? (
          <>
            <h3>Tons cadastrados ({skins?.length ?? 0})</h3>
            {!skins ? (
              <p className="items-panel-loading">Carregando...</p>
            ) : skins.length === 0 ? (
              <p className="items-panel-loading">Nenhum tom custom ainda.</p>
            ) : (
              <ul className="items-panel-list">
                {skins.map((skin) => (
                  <li key={skin.id} className="items-panel-row-wrap">
                    <div className="items-panel-row">
                      <span className="skin-swatch" style={{ background: skin.hex ?? "#8a7ca8" }} />
                      <span className="items-panel-name">
                        {skin.label} <span className="items-panel-category">({skin.gender})</span>
                        {skin.colors && skin.colors.length > 0 && (
                          <span className="items-panel-category"> -- {skin.colors.length} cor(es)</span>
                        )}
                      </span>
                      {/* "Editar" -- pedido do Douglas: "quero editar o Avatar
                          tambem" (continuação de "quero editar as coisas ja
                          criadas, fotos etc", que já cobria cabelo/acessório/
                          barba/traje). Mesmo padrão de startEditAvatarItem, ver
                          startEditSkin acima. */}
                      <button type="button" onClick={() => startEditSkin(skin)}>
                        Editar
                      </button>
                      {/* "Gerar cor" pro TOM DE PELE, mesma ferramenta de
                          cabelo/acessório/traje (ver comentário grande em
                          ColorZoneTool.tsx) -- pedido do Douglas:
                          "adicionar cores pra avatar tambem" / "edicao
                          encima do ja subido". apiBase="avatar-skins"
                          troca o endpoint/pasta de Storage (ver prop
                          apiBase lá), resto do fluxo idêntico. */}
                      <button
                        type="button"
                        onClick={() => setColorToolItemId((prev) => (prev === skin.id ? null : skin.id))}
                      >
                        {colorToolItemId === skin.id ? "Fechar cor" : "Gerar cor"}
                      </button>
                      <button
                        type="button"
                        disabled={deletingSkinId === skin.id}
                        onClick={() => handleDeleteSkin(skin)}
                      >
                        {deletingSkinId === skin.id ? "Apagando..." : "Excluir"}
                      </button>
                    </div>
                    {colorToolItemId === skin.id && (
                      <ColorZoneTool
                        item={skin}
                        apiBase="avatar-skins"
                        accessToken={accessToken}
                        onClose={() => setColorToolItemId(null)}
                        onSaved={() => {
                          loadSkins();
                          onChanged();
                        }}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          (() => {
            const rows = (avatarItems ?? []).filter((it) => it.category === category);
            return (
              <>
                <h3>
                  {AVATAR_CREATOR_CATEGORIES.find((c) => c.id === category)?.label} cadastrados ({rows.length})
                </h3>
                {!avatarItems ? (
                  <p className="items-panel-loading">Carregando...</p>
                ) : rows.length === 0 ? (
                  <p className="items-panel-loading">
                    Nenhum ainda -- se a tabela não existir ainda, peça pro Douglas rodar
                    supabase/migrations/0006_avatar_items.sql.
                  </p>
                ) : (
                  <ul className="items-panel-list">
                    {rows.map((item) => (
                      <li key={item.id} className="items-panel-row-wrap">
                        <div className="items-panel-row">
                          <span className="items-panel-name">
                            {item.label} <span className="items-panel-category">({item.gender})</span>
                            {item.colors && item.colors.length > 0 && (
                              <span className="items-panel-category"> -- {item.colors.length} cor(es)</span>
                            )}
                          </span>
                          {/* "Editar" -- pedido do Douglas: "quero editar as coisas ja
                              criadas, fotos etc". Mesmo padrão do "Editar" de Mobi (ver
                              startEditItem mais abaixo): reabre o formulário inteiro
                              preenchido, reenviar foto é OPCIONAL (fallback pra folha já
                              salva, ver composeAvatarArtSheet). */}
                          <button type="button" onClick={() => startEditAvatarItem(item)}>
                            Editar
                          </button>
                          {/* "Gerar cor" (ColorZoneTool.tsx) -- cabelo/acessório/traje
                              (pedido do Douglas: "trajes eu edito tbm? adiciona").
                              Barba fica de fora: sem swatch "Cores de..." no
                              ProfileCard pra ela ainda (a arte já muda sozinha com o
                              tom de pele, nunca teve seletor de cor manual, ver
                              comentário em selectedBeardId, GameRoom.tsx) -- fica pra
                              quando o Douglas pedir. Traje usa a MESMA arte gerada (1
                              folha só) em todos os tons que o item cobre, igual o
                              traje base -- ver OutfitOption.colors em
                              game/customization.ts e fetchAndRegisterCustomAvatarItems
                              em GameRoom.tsx. */}
                          {(category === "cabelo" || category === "acessorio" || category === "traje") && (
                            <button
                              type="button"
                              onClick={() => setColorToolItemId((prev) => (prev === item.id ? null : item.id))}
                            >
                              {colorToolItemId === item.id ? "Fechar cor" : "Gerar cor"}
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={deletingAvatarItemId === item.id}
                            onClick={() => handleDeleteAvatarItem(item)}
                          >
                            {deletingAvatarItemId === item.id ? "Apagando..." : "Excluir"}
                          </button>
                        </div>
                        {colorToolItemId === item.id && (
                          <ColorZoneTool
                            item={item}
                            accessToken={accessToken}
                            onClose={() => setColorToolItemId(null)}
                            onSaved={() => {
                              loadAvatarItems();
                              onChanged();
                            }}
                          />
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            );
          })()
        )}
      </section>
      {pendingCrop && (
        <ImageCropModal
          file={pendingCrop.file}
          onConfirm={(result) => {
            pendingCrop.apply(result);
            setPendingCrop(null);
          }}
          onSkip={(result) => {
            pendingCrop.apply(result);
            setPendingCrop(null);
          }}
          onCancel={() => {
            const input = fileInputRefs.current[pendingCrop.inputKey];
            if (input) input.value = "";
            setPendingCrop(null);
          }}
        />
      )}
    </>
  );
}

// Um estilo de PADRÃO de parede de sistema (sem imagem, ver
// WallPatternConfig em game/wall.ts) já cadastrado -- formato da linha de
// room_wall_items (ver supabase/migrations/0024_room_wall_items.sql e
// 0026_room_wall_items_thickness_brick.sql).
type CustomWallRow = {
  id: string;
  label: string;
  height_px: number;
  thickness_px: number;
  brick_width_px: number;
  brick_height_px: number;
  brick_color: string;
  mortar_color: string;
  mortar_width_px: number;
  top_color: string;
};

// comprimento (px) de UMA aresta da grade, usado só pro PREVIEW ao vivo
// abaixo -- constante hoje (grade uniforme, ver comentário de
// wallEdgeLengthPx em game/wall.ts), calculado a partir de uma aresta
// qualquer (0,0,"colPlus") em vez de fixo à mão, por clareza.
const WALL_PREVIEW_EDGE_LENGTH_PX = wallEdgeLengthPx(0, 0, "colPlus");

/**
 * "Criar Parede" (aba NOVA, distinta da antiga "Criar Parede" -- ver
 * comentário grande na barra de abas mais abaixo) -- pedido do Douglas:
 * primeiro perguntou se dava pra criar uma "geometria" de parede igual o
 * piso "padrão", sem precisar de imagem feita fora ("a gente não
 * consegue criar uma geometria seguindo a mesma ideia de piso, algo
 * criado aqui, sem que seja feito fora?"), depois confirmou o formato:
 * "a gente cria uma nova aba la no criar pra configurar os padroes
 * dela". Componente à parte (mesma ideia de AvatarCreatorPanel acima),
 * já que o formulário/tabela (room_wall_items, ver
 * supabase/migrations/0024_room_wall_items.sql e app/api/wall-items/**)
 * não tem nada a ver com o de móvel/piso.
 *
 * Só cobre o tipo "padrão" (tijolo desenhado por código, ver
 * WallPatternConfig em game/wall.ts) -- parede com ARTE continua vindo
 * só da pasta local (scripts/syncWallAssets.mjs), sem upload por aqui
 * ainda (o Douglas não pediu isso, só o padrão).
 *
 * Espessura editável adicionada depois do Douglas testar ao vivo a
 * primeira versão (folha 2D encostada na linha da divisa): "voce ficou
 * ela na divisa, eu quero ela no meio do tile... com espessura de
 * parede, inclusive quero editar isso na criacao" (ver comentário grande
 * de WallPatternConfig em game/wall.ts pro motivo/geometria) -- o tijolo
 * continua igual, só ganhou volume.
 *
 * Cor do topo: teve ida e volta (ver 0027/0028_room_wall_items_*top_color*.sql
 * e comentário grande de WallPatternConfig em game/wall.ts) -- chegou a
 * virar campo próprio, voltou a ser CALCULADA (escurecendo brickColor)
 * depois do Douglas testar ao vivo com uma cor destoando do tijolo, e
 * agora voltou a ser campo próprio (0029_room_wall_items_top_color_v2.sql)
 * com o escopo esclarecido por ele: "a cor encima da parede eu quero
 * escolher" (só a face de CIMA/topo, plana) + "a cor da face na
 * espessura vertical é a cor que segue da parede" (as faces de PONTA/
 * lateral do jogo de verdade continuam calculadas, sem campo próprio --
 * ver createWallPatternGraphics em MainScene.ts).
 *
 * O modo de inserção "Centro do tile" (pedido do Douglas: "eu quero
 * tambem a opcao de inserir ela no centro do tile", que TRAVA passagem
 * ao contrário da parede de aresta -- ver WallSide em game/wall.ts) NÃO
 * mora aqui -- é um jeito de INSERIR a parede na sala (toggle "Borda"/
 * "Centro do tile" no painel de pintura de parede, GameRoom.tsx), não
 * uma propriedade do estilo cadastrado nesta aba.
 */
function WallPatternCreatorPanel({ accessToken, onChanged }: { accessToken: string; onChanged: () => void }) {
  const [wallItems, setWallItems] = useState<CustomWallRow[] | null>(null);
  const [wallLabel, setWallLabel] = useState("");
  const [wallHeight, setWallHeight] = useState(100);
  const [wallThickness, setWallThickness] = useState(10);
  const [wallBrickWidth, setWallBrickWidth] = useState(24);
  const [wallBrickHeight, setWallBrickHeight] = useState(14);
  const [wallBrickColor, setWallBrickColor] = useState("#b5502e");
  const [wallMortarColor, setWallMortarColor] = useState("#d9d2c8");
  const [wallMortarWidth, setWallMortarWidth] = useState(2);
  const [wallTopColor, setWallTopColor] = useState("#914025");
  const [wallEditingId, setWallEditingId] = useState<string | null>(null);
  const [wallSubmitting, setWallSubmitting] = useState(false);
  const [wallBusyId, setWallBusyId] = useState<string | null>(null);
  const [wallError, setWallError] = useState<string | null>(null);
  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  // "#rrggbb" -> número hex (o que WallPatternConfig/<WallPatternSwatch>
  // esperam, ver game/wall.ts) -- cópia pequena da MESMA função dentro do
  // componente ItemEditor mais abaixo (não dá pra chamar ela direto daqui
  // -- é local a outro componente -- e não vale a pena promover pra fora
  // só por uma conta de 1 linha).
  function parseHexColor(css: string): number {
    return parseInt(css.replace("#", ""), 16) || 0;
  }

  async function loadWallItems() {
    setWallError(null);
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data, error: fetchError } = await supabase
      .from("room_wall_items")
      .select(
        "id, label, height_px, thickness_px, brick_width_px, brick_height_px, brick_color, mortar_color, mortar_width_px, top_color"
      );
    if (fetchError) {
      setWallError(fetchError.message);
      return;
    }
    setWallItems((data ?? []) as CustomWallRow[]);
  }

  function resetWallForm() {
    setWallEditingId(null);
    setWallLabel("");
    setWallHeight(100);
    setWallThickness(10);
    setWallBrickWidth(24);
    setWallBrickHeight(14);
    setWallBrickColor("#b5502e");
    setWallMortarColor("#d9d2c8");
    setWallMortarWidth(2);
    setWallTopColor("#914025");
  }

  function startEditWallItem(item: CustomWallRow) {
    setWallEditingId(item.id);
    setWallLabel(item.label);
    setWallHeight(item.height_px);
    setWallThickness(item.thickness_px);
    setWallBrickWidth(item.brick_width_px);
    setWallBrickHeight(item.brick_height_px);
    setWallBrickColor(item.brick_color);
    setWallMortarColor(item.mortar_color);
    setWallMortarWidth(item.mortar_width_px);
    setWallTopColor(item.top_color);
  }

  async function handleWallSubmit(e: React.FormEvent) {
    e.preventDefault();
    setWallError(null);
    if (!wallLabel.trim()) {
      setWallError("Dá um nome pra parede.");
      return;
    }
    setWallSubmitting(true);
    try {
      const payload = {
        label: wallLabel.trim(),
        height_px: wallHeight,
        thickness_px: wallThickness,
        brick_width_px: wallBrickWidth,
        brick_height_px: wallBrickHeight,
        brick_color: wallBrickColor,
        mortar_color: wallMortarColor,
        mortar_width_px: wallMortarWidth,
        top_color: wallTopColor,
      };
      const res = await fetch(wallEditingId ? `/api/wall-items/${wallEditingId}` : "/api/wall-items", {
        method: wallEditingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "erro ao salvar parede");

      resetWallForm();
      await loadWallItems();
      onChanged();
    } catch (err) {
      setWallError(err instanceof Error ? err.message : "erro ao salvar parede");
    } finally {
      setWallSubmitting(false);
    }
  }

  async function handleWallDelete(id: string) {
    setWallBusyId(id);
    setWallError(null);
    try {
      const res = await fetch(`/api/wall-items/${id}`, { method: "DELETE", headers: authHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "erro ao apagar parede");
      if (wallEditingId === id) resetWallForm();
      await loadWallItems();
      onChanged();
    } catch (err) {
      setWallError(err instanceof Error ? err.message : "erro ao apagar parede");
    } finally {
      setWallBusyId(null);
    }
  }

  useEffect(() => {
    loadWallItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <form className="items-panel-form" onSubmit={handleWallSubmit}>
        <input
          className="items-panel-input"
          type="text"
          placeholder="Nome da parede"
          value={wallLabel}
          maxLength={40}
          onChange={(e) => setWallLabel(e.target.value)}
        />

        <p className="settings-hint">
          Sem imagem nenhuma -- o jogo desenha tijolos em fileiras (padrão "amarração", desencontradas uma da outra)
          num painel com espessura de verdade, centrado na divisa entre os 2 quadrados (metade da espessura pra cada
          lado), do jeito que você configurar abaixo.
        </p>

        <label className="items-panel-upload-field">
          <span>Altura da parede (px)</span>
          <input
            className="items-panel-input"
            type="number"
            min={20}
            max={400}
            value={wallHeight}
            onChange={(e) => setWallHeight(Number(e.target.value))}
          />
        </label>
        <label className="items-panel-upload-field">
          <span>Espessura da parede (px)</span>
          <input
            className="items-panel-input"
            type="number"
            min={1}
            max={60}
            value={wallThickness}
            onChange={(e) => setWallThickness(Number(e.target.value))}
          />
        </label>
        <label className="items-panel-upload-field">
          <span>Largura do tijolo (px)</span>
          <input
            className="items-panel-input"
            type="number"
            min={4}
            max={200}
            value={wallBrickWidth}
            onChange={(e) => setWallBrickWidth(Number(e.target.value))}
          />
        </label>
        <label className="items-panel-upload-field">
          <span>Altura do tijolo (px)</span>
          <input
            className="items-panel-input"
            type="number"
            min={4}
            max={100}
            value={wallBrickHeight}
            onChange={(e) => setWallBrickHeight(Number(e.target.value))}
          />
        </label>
        <label className="items-panel-upload-field">
          <span>Espessura da junta (px)</span>
          <input
            className="items-panel-input"
            type="number"
            min={0}
            max={20}
            value={wallMortarWidth}
            onChange={(e) => setWallMortarWidth(Number(e.target.value))}
          />
        </label>

        <div className="items-panel-submit-row">
          <div className="items-panel-upload-field">
            <span>Cor do tijolo</span>
            <ColorPickerField value={wallBrickColor} onChange={setWallBrickColor} />
          </div>
          <div className="items-panel-upload-field">
            <span>Cor da argamassa</span>
            <ColorPickerField value={wallMortarColor} onChange={setWallMortarColor} />
          </div>
          <div className="items-panel-upload-field">
            <span>Cor do topo</span>
            <ColorPickerField value={wallTopColor} onChange={setWallTopColor} />
          </div>
        </div>

        {/* preview ao vivo -- os MESMOS retângulos que
            createWallPatternGraphics desenha de verdade no jogo (ver
            wallBrickRects em game/wall.ts), com a tira de cima
            representando a espessura (ver WallPatternSwatch.tsx), num
            painel retangular (a parede é uma face plana/vertical, sem
            losango pra recortar feito o piso). */}
        <div className="wall-pattern-preview-wrap">
          <div className="wall-pattern-preview-tile" style={{ aspectRatio: `${WALL_PREVIEW_EDGE_LENGTH_PX} / ${wallHeight}` }}>
            <WallPatternSwatch
              pattern={{
                heightPx: wallHeight,
                thicknessPx: wallThickness,
                brickWidthPx: wallBrickWidth,
                brickHeightPx: wallBrickHeight,
                brickColor: parseHexColor(wallBrickColor),
                mortarColor: parseHexColor(wallMortarColor),
                mortarWidthPx: wallMortarWidth,
                topColor: parseHexColor(wallTopColor),
              }}
              edgeLengthPx={WALL_PREVIEW_EDGE_LENGTH_PX}
            />
          </div>
        </div>

        {wallError && <p className="items-panel-error">{wallError}</p>}

        <div className="items-panel-submit-row">
          <button type="submit" className="items-panel-submit" disabled={wallSubmitting}>
            {wallSubmitting ? "Enviando..." : wallEditingId ? "Salvar alterações" : "Cadastrar parede"}
          </button>
          {wallEditingId && (
            <button type="button" className="clear-btn" onClick={resetWallForm} disabled={wallSubmitting}>
              Cancelar edição
            </button>
          )}
        </div>
      </form>

      <section className="items-panel-section">
        <h3>Paredes cadastradas ({wallItems?.length ?? 0})</h3>
        {!wallItems ? (
          <p className="items-panel-loading">Carregando...</p>
        ) : wallItems.length === 0 ? (
          <p className="items-panel-loading">Nenhuma parede custom ainda.</p>
        ) : (
          <ul className="items-panel-list">
            {wallItems.map((item) => (
              <li key={item.id} className="items-panel-row-wrap">
                <div className="items-panel-row">
                  <div className="items-panel-thumb">
                    <WallPatternSwatch
                      pattern={{
                        heightPx: item.height_px,
                        thicknessPx: item.thickness_px,
                        brickWidthPx: item.brick_width_px,
                        brickHeightPx: item.brick_height_px,
                        brickColor: parseHexColor(item.brick_color),
                        mortarColor: parseHexColor(item.mortar_color),
                        mortarWidthPx: item.mortar_width_px,
                        topColor: parseHexColor(item.top_color),
                      }}
                      edgeLengthPx={WALL_PREVIEW_EDGE_LENGTH_PX}
                    />
                  </div>
                  <span className="items-panel-name">{item.label}</span>
                  <button type="button" disabled={wallBusyId === item.id} onClick={() => startEditWallItem(item)}>
                    Editar
                  </button>
                  <button type="button" disabled={wallBusyId === item.id} onClick={() => handleWallDelete(item.id)}>
                    Excluir
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

// comprimento (px) de UMA aresta da grade -- mesma ideia de
// WALL_PREVIEW_EDGE_LENGTH_PX acima, usado como TETO de redimensionamento
// do upload de arte de porta (ver resizeImageForUpload/UPLOAD_SUPERSAMPLE
// no topo do arquivo): a porta é exibida EXATAMENTE nessa largura no jogo
// (ver setDisplaySize em addDoorSprite, MainScene.ts), então não faz
// sentido guardar um arquivo muito maior que isso vezes a folga de
// nitidez de sempre.
// Largura de uma aresta da grade (px de tela, mesma unidade de
// DISPLAY_WIDTH_MIN/MAX) -- valor de sempre pro "Tamanho no jogo" da
// porta (ver DoorCatalogEntry.displayWidth em game/door.ts) antes desse
// campo existir, e a referência de "encaixa certinho no vão" mostrada
// no editor (ver DOOR_STAGE_*/doorStagePreviewSrc mais abaixo).
const DOOR_EDGE_WIDTH_PX = Math.round(doorEdgeLengthPx(0, 0, "colPlus"));
const DOOR_ART_MAX_UPLOAD_WIDTH = doorEdgeLengthPx(0, 0, "colPlus") * UPLOAD_SUPERSAMPLE;
// preview do "Tamanho no jogo" da porta (ver JSX em DoorCreatorPanel) --
// mesma ideia de STAGE_BASELINE_PAD pro mobi, só que num card MENOR (a
// porta não precisa do espaço todo reservado pro boneco de referência
// de mobi/avatar) -- folga em cima generosa (porta costuma ser uma
// imagem alta), pouca embaixo do tile.
const DOOR_STAGE_HEIGHT = 320;
const DOOR_STAGE_BASELINE = 30;

/** Um dos 4 campos de arte de UMA porta -- "left"/"right" é o `facing`
 * (ver DoorFacing em game/door.ts, escolhido como o resto do jogo faz
 * pra móvel/direção -- Douglas desenha os 2 lados à mão, sem espelhar
 * nada em código), "Closed"/"Open" é o estado (ver DoorArtSet). Só os 2
 * de "left" são obrigatórios (ver POST /api/door-items) -- "right" cai
 * pro fallback de "left" enquanto não for enviado (ver
 * resolveDoorTextureKey em MainScene.ts). */
type DoorArtField = "leftClosed" | "leftOpen" | "rightClosed" | "rightOpen";

const DOOR_ART_FIELDS: { key: DoorArtField; label: string; payloadKey: string; required: boolean }[] = [
  { key: "leftClosed", label: "Fechada -- lado esquerdo", payloadKey: "art_left_closed", required: true },
  { key: "leftOpen", label: "Aberta -- lado esquerdo", payloadKey: "art_left_open", required: true },
  { key: "rightClosed", label: "Fechada -- lado direito (opcional)", payloadKey: "art_right_closed", required: false },
  { key: "rightOpen", label: "Aberta -- lado direito (opcional)", payloadKey: "art_right_open", required: false },
];

// Uma porta já cadastrada (ver supabase/migrations/0030_room_door_items.sql
// e app/api/door-items/**) -- art_right_* pode vir null (fallback pro
// lado esquerdo, ver comentário de DoorArtField acima).
type CustomDoorRow = {
  id: string;
  label: string;
  kind: DoorKind;
  art_left_closed: string;
  art_left_open: string;
  art_right_closed: string | null;
  art_right_open: string | null;
  display_width_px: number | null;
};

/**
 * "Criar Porta" -- pedido do Douglas: "vamos criar uma nova categoria
 * 'porta'... por enquanto, so terá porta de correr... eu subirei a
 * arte. frete esq, frente dir, mesma coisa". Componente à parte (mesma
 * ideia de WallPatternCreatorPanel acima), tabela própria
 * (room_door_items) -- diferente da parede "padrão" (sem imagem
 * nenhuma), porta é SEMPRE imagem (4 arquivos possíveis: aberta/fechada
 * x esquerda/direita, ver DOOR_ART_FIELDS acima), então o
 * formulário/upload segue mais perto do de "Criar Mobi"/"Criar Piso"
 * (sobe pro Storage primeiro, some com upload órfão se o cadastro
 * falhar depois -- ver comentário grande no handleSubmit de mobi).
 */
function DoorCreatorPanel({ accessToken, onChanged }: { accessToken: string; onChanged: () => void }) {
  const [doorItems, setDoorItems] = useState<CustomDoorRow[] | null>(null);
  const [doorLabel, setDoorLabel] = useState("");
  const [doorKind, setDoorKind] = useState<DoorKind>(DOOR_KINDS[0].id);
  const [doorFiles, setDoorFiles] = useState<Partial<Record<DoorArtField, File>>>({});
  const [doorPreviews, setDoorPreviews] = useState<Partial<Record<DoorArtField, string>>>({});
  const [doorExisting, setDoorExisting] = useState<Partial<Record<DoorArtField, string>>>({});
  // "Tamanho no jogo" (pedido do Douglas: "quero editar a dimensao dos
  // arquivos que subo nelas tambem, com tile e ta; igual os mobis
  // normais" -- ver comentário grande em DoorCatalogEntry.displayWidth,
  // game/door.ts). Começa no valor que SEMPRE foi usado até agora (a
  // largura exata de uma aresta da grade) -- editar sem nunca mexer no
  // slider salva esse mesmo valor de sempre, então nada muda pra porta
  // já cadastrada até o Douglas realmente arrastar. Um valor só (não
  // por lado esq/dir, diferente de tamanho de móvel por direção): os 2
  // lados são a MESMA porta física, não faz sentido o vão parecer mais
  // largo de um lado que do outro.
  const [doorDisplayWidth, setDoorDisplayWidth] = useState<number>(DOOR_EDGE_WIDTH_PX);
  const [doorEditingId, setDoorEditingId] = useState<string | null>(null);
  const [doorSubmitting, setDoorSubmitting] = useState(false);
  const [doorBusyId, setDoorBusyId] = useState<string | null>(null);
  const [doorError, setDoorError] = useState<string | null>(null);
  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  async function loadDoorItems() {
    setDoorError(null);
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data, error: fetchError } = await supabase
      .from("room_door_items")
      .select("id, label, kind, art_left_closed, art_left_open, art_right_closed, art_right_open, display_width_px");
    if (fetchError) {
      setDoorError(fetchError.message);
      return;
    }
    setDoorItems((data ?? []) as CustomDoorRow[]);
  }

  function resetDoorForm() {
    setDoorEditingId(null);
    setDoorLabel("");
    setDoorKind(DOOR_KINDS[0].id);
    setDoorFiles({});
    setDoorPreviews((prev) => {
      for (const url of Object.values(prev)) if (url) URL.revokeObjectURL(url);
      return {};
    });
    setDoorExisting({});
    setDoorDisplayWidth(DOOR_EDGE_WIDTH_PX);
  }

  function startEditDoorItem(item: CustomDoorRow) {
    setDoorEditingId(item.id);
    setDoorLabel(item.label);
    setDoorKind(item.kind);
    setDoorFiles({});
    setDoorPreviews((prev) => {
      for (const url of Object.values(prev)) if (url) URL.revokeObjectURL(url);
      return {};
    });
    setDoorExisting({
      leftClosed: item.art_left_closed,
      leftOpen: item.art_left_open,
      rightClosed: item.art_right_closed ?? undefined,
      rightOpen: item.art_right_open ?? undefined,
    });
    setDoorDisplayWidth(typeof item.display_width_px === "number" ? item.display_width_px : DOOR_EDGE_WIDTH_PX);
  }

  // preview de referência no stage do "Tamanho no jogo" -- sempre
  // "Fechada -- lado esquerdo" (o único campo garantido de existir,
  // obrigatório desde a criação), mesma prioridade de sempre (arquivo
  // recém-escolhido > URL já salva).
  const doorStagePreviewSrc = doorPreviews.leftClosed ?? doorExisting.leftClosed;

  function handleDoorFileChange(field: DoorArtField, file: File | undefined) {
    setDoorFiles((prev) => ({ ...prev, [field]: file }));
    setDoorPreviews((prev) => {
      const prevUrl = prev[field];
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      return { ...prev, [field]: file ? URL.createObjectURL(file) : undefined };
    });
  }

  async function handleDoorSubmit(e: React.FormEvent) {
    e.preventDefault();
    setDoorError(null);
    if (!doorLabel.trim()) {
      setDoorError("Dá um nome pra porta.");
      return;
    }
    if (!doorEditingId && (!doorFiles.leftClosed || !doorFiles.leftOpen)) {
      setDoorError("As imagens fechada/aberta do lado esquerdo são obrigatórias.");
      return;
    }
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setDoorSubmitting(true);
    // mesma cautela de handleSubmit (mobi)/handleFloorSubmit acima: sobe
    // pro Storage PRIMEIRO, só depois grava o cadastro -- desfaz upload
    // órfão no catch se o cadastro final falhar.
    const uploadedPaths: string[] = [];
    try {
      const slug = slugify(doorLabel);
      const payload: Record<string, unknown> = {
        label: doorLabel.trim(),
        display_width_px: Math.round(doorDisplayWidth),
      };
      if (!doorEditingId) payload.kind = doorKind;
      for (const field of DOOR_ART_FIELDS) {
        const rawFile = doorFiles[field.key];
        if (!rawFile) continue; // editando: campo não reenviado mantém a URL antiga
        const resized = await resizeImageForUpload(rawFile, DOOR_ART_MAX_UPLOAD_WIDTH);
        const ext = resized.name.split(".").pop() || "png";
        const path = `porta/${slug}-${Date.now()}-${field.key}.${ext}`;
        const { error: uploadError } = await supabase.storage.from("room-items").upload(path, resized, {
          upsert: false,
          contentType: resized.type || "image/png",
        });
        if (uploadError) throw uploadError;
        uploadedPaths.push(path);
        const { data: publicUrlData } = supabase.storage.from("room-items").getPublicUrl(path);
        payload[field.payloadKey] = publicUrlData.publicUrl;
      }

      const res = await fetch(doorEditingId ? `/api/door-items/${doorEditingId}` : "/api/door-items", {
        method: doorEditingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "erro ao salvar porta");

      resetDoorForm();
      await loadDoorItems();
      onChanged();
    } catch (err) {
      if (uploadedPaths.length > 0) {
        await supabase.storage.from("room-items").remove(uploadedPaths).catch(() => null);
      }
      setDoorError(err instanceof Error ? err.message : "erro ao salvar porta");
    } finally {
      setDoorSubmitting(false);
    }
  }

  async function handleDoorDelete(id: string) {
    setDoorBusyId(id);
    setDoorError(null);
    try {
      const res = await fetch(`/api/door-items/${id}`, { method: "DELETE", headers: authHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "erro ao apagar porta");
      if (doorEditingId === id) resetDoorForm();
      await loadDoorItems();
      onChanged();
    } catch (err) {
      setDoorError(err instanceof Error ? err.message : "erro ao apagar porta");
    } finally {
      setDoorBusyId(null);
    }
  }

  useEffect(() => {
    loadDoorItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <form className="items-panel-form" onSubmit={handleDoorSubmit}>
        <input
          className="items-panel-input"
          type="text"
          placeholder="Nome da porta"
          value={doorLabel}
          maxLength={40}
          onChange={(e) => setDoorLabel(e.target.value)}
        />

        {!doorEditingId && (
          <select className="items-panel-input" value={doorKind} onChange={(e) => setDoorKind(e.target.value as DoorKind)}>
            {DOOR_KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
        )}

        <p className="settings-hint">
          Só de correr por enquanto -- 2 posições (aberta/fechada), sem quadro de animação no meio. "Tipo" muda só o
          NOME/organização (1 ou 2 folhas na imagem) -- o jogo trata as duas exatamente igual.
          {doorEditingId ? " Só reenvie uma imagem se quiser TROCAR -- senão continua com a de antes." : ""}
        </p>

        {DOOR_ART_FIELDS.map((field) => (
          <label key={field.key} className="items-panel-upload-field">
            <span>
              {field.label}
              {field.required && !doorEditingId ? " *" : ""}
            </span>
            {(doorPreviews[field.key] || doorExisting[field.key]) && (
              <img
                className="items-panel-upload-existing"
                src={doorPreviews[field.key] ?? doorExisting[field.key]}
                alt={field.label}
              />
            )}
            <input
              type="file"
              accept="image/png,image/webp,image/jpeg"
              onChange={(e) => handleDoorFileChange(field.key, e.target.files?.[0])}
            />
          </label>
        ))}

        {/* "Tamanho no jogo" -- pedido do Douglas: "quero editar a
            dimensao dos arquivos que subo nelas tambem, com tile e ta;
            igual os mobis normais" (ver comentário grande em
            DoorCatalogEntry.displayWidth, game/door.ts). ANTES a
            largura de exibição era SEMPRE travada exatamente na largura
            de uma aresta (doorEdgeLengthPx), sem editor nenhum. Mesmo
            padrão visual do "Tamanho no jogo" de móvel (slider +
            digitável + preview num tile de referência com régua), só
            que sem arraste de posição (porta não tem "posição no tile"
            pra ajustar -- ela é sempre centralizada na aresta) e um
            valor SÓ (não por lado esq/dir -- os 2 lados são a MESMA
            porta física, não faz sentido o vão parecer mais largo de um
            lado que do outro). Preview usa sempre "Fechada -- lado
            esquerdo" (o único campo obrigatório, garantido de existir)
            como referência. */}
        <div className="item-size-card">
          <div className="item-stage" style={{ height: DOOR_STAGE_HEIGHT }}>
            <div
              className="item-stage-tile"
              style={{ bottom: DOOR_STAGE_BASELINE, width: TILE_WIDTH_PX, height: TILE_HEIGHT_PX }}
            />
            {doorStagePreviewSrc ? (
              <img
                className="item-stage-item-img"
                src={doorStagePreviewSrc}
                alt="Preview da porta"
                style={{
                  width: doorDisplayWidth * PREVIEW_SCALE,
                  bottom: DOOR_STAGE_BASELINE,
                  transform: "translateX(-50%)",
                  cursor: "default",
                }}
              />
            ) : (
              <p className="edit-hint item-size-empty">Escolha a imagem "Fechada -- lado esquerdo" pra ver o preview aqui.</p>
            )}
            <StageRuler anchorBottomPx={DOOR_STAGE_BASELINE} />
          </div>
        </div>

        <div className="settings-slider-row settings-slider-row-editable">
          <span className="settings-slider-name">Tamanho no jogo (largura)</span>
          <input
            type="range"
            min={DISPLAY_WIDTH_MIN}
            max={DISPLAY_WIDTH_MAX}
            step={DISPLAY_WIDTH_STEP}
            value={doorDisplayWidth}
            onChange={(e) => setDoorDisplayWidth(Number(e.target.value))}
          />
          <span className="settings-slider-value-field">
            <input
              type="number"
              className="settings-slider-value-input"
              min={DISPLAY_WIDTH_MIN}
              max={DISPLAY_WIDTH_MAX}
              value={doorDisplayWidth}
              onChange={(e) => setDoorDisplayWidth(Number(e.target.value) || 0)}
              onBlur={() => setDoorDisplayWidth(clamp(Math.round(doorDisplayWidth), DISPLAY_WIDTH_MIN, DISPLAY_WIDTH_MAX))}
            />
            <span>px</span>
          </span>
        </div>
        <div className="item-stage-offset-row">
          <span>{DOOR_EDGE_WIDTH_PX}px encaixa exatamente no vão da aresta -- maior ou menor que isso, sobra/falta espaço nas laterais.</span>
          {doorDisplayWidth !== DOOR_EDGE_WIDTH_PX && (
            <button type="button" className="clear-btn" onClick={() => setDoorDisplayWidth(DOOR_EDGE_WIDTH_PX)}>
              Redefinir tamanho
            </button>
          )}
        </div>

        {doorError && <p className="items-panel-error">{doorError}</p>}

        <div className="items-panel-submit-row">
          <button type="submit" className="items-panel-submit" disabled={doorSubmitting}>
            {doorSubmitting ? "Enviando..." : doorEditingId ? "Salvar alterações" : "Cadastrar porta"}
          </button>
          {doorEditingId && (
            <button type="button" className="clear-btn" onClick={resetDoorForm} disabled={doorSubmitting}>
              Cancelar edição
            </button>
          )}
        </div>
      </form>

      <section className="items-panel-section">
        <h3>Portas cadastradas ({doorItems?.length ?? 0})</h3>
        {!doorItems ? (
          <p className="items-panel-loading">Carregando...</p>
        ) : doorItems.length === 0 ? (
          <p className="items-panel-loading">Nenhuma porta custom ainda.</p>
        ) : (
          <ul className="items-panel-list">
            {doorItems.map((item) => (
              <li key={item.id} className="items-panel-row-wrap">
                <div className="items-panel-row">
                  <div className="items-panel-thumb">
                    <img src={item.art_left_closed} alt={item.label} />
                  </div>
                  <span className="items-panel-name">{item.label}</span>
                  <button type="button" disabled={doorBusyId === item.id} onClick={() => startEditDoorItem(item)}>
                    Editar
                  </button>
                  <button type="button" disabled={doorBusyId === item.id} onClick={() => handleDoorDelete(item.id)}>
                    Excluir
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export default function ItemEditor({
  accessToken,
  onClose,
  onItemsChanged,
}: {
  accessToken: string;
  onClose: () => void;
  // parâmetro opcional (pedido do Douglas: "eu fui editar ela pra
  // posicionar o carinha melhor e ficou assim -- no editor ta certo no
  // mapa real nao ficou") -- ver comentário grande em handleSubmit mais
  // abaixo, perto de onItemsChanged(seatModelIdToClear).
  onItemsChanged: (seatModelIdToClear?: string) => void;
}) {
  // "Criar Mobi" (de sempre) / "Criar Avatar" (pedido do Douglas: "la
  // encima quero dois botoes criar mobi/criar avatar") -- dois modos
  // dentro do MESMO painel, não duas telas separadas. "Criar Avatar" usa
  // um componente à parte (AvatarCreatorPanel, ver acima) com seu próprio
  // formulário/estado, já que os campos são bem diferentes (sexo,
  // categoria, folha composta no navegador) do de móvel.
  // "Criar Parede" (pedido do Douglas: "criar parede cria uma aba nova:
  // criar mobi, criar parede, criar avatar") -- terceiro modo, mas NÃO é
  // um sistema novo: reaproveita o mesmo formulário/tabela de "Criar
  // Mobi" de sempre, só que com a categoria travada em "divisoria" (o
  // mesmo tipo que já virou "Parede" no rótulo da barra lateral da sala,
  // ver CATEGORY_ICONS em GameRoom.tsx) -- vira uma aba própria só pra
  // não precisar catar "Divisória" no meio do dropdown de categoria de
  // móvel. Ver handleCategoryChange no clique da aba abaixo (trava a
  // categoria) e visibleItems mais abaixo (separa a listagem: parede só
  // mostra parede, mobi só mostra o resto).
  //
  // "Criar Piso" (pedido do Douglas, logo em seguida: "eu quero uma aba
  // so pra piso tambem... vai ter funcoes totalmente diferentes dos
  // mobis") -- diferente de "Criar Parede" acima, esse é um sistema de
  // VERDADE à parte (não reaproveita o formulário de mobi): piso é uma
  // imagem PLANA só, sem direção/footprint/assento/interação -- todo o
  // estado/formulário fica em campos "floor*" próprios logo abaixo, e o
  // JSX dele é um bloco separado (ver {mode === "piso" && (...)} mais
  // abaixo), guardado numa tabela própria (room_floor_items, ver
  // supabase/migrations/0015_room_floor_items.sql) em vez de room_items.
  const [mode, setMode] = useState<"mobi" | "parede" | "parede-sistema" | "piso" | "porta" | "avatar">("mobi");
  const [items, setItems] = useState<CustomItemRow[] | null>(null);
  const [label, setLabel] = useState("");
  const [category, setCategory] = useState<CategoryId>("poltrona");
  const [files, setFiles] = useState<Partial<Record<MobiFacing, File>>>({});
  // zoom do preview -- mesma ideia do zoom em AvatarCreatorPanel acima
  // (pedido do Douglas: "tem como eu dar zoom nesse editor? ta mt
  // longe"), estado próprio aqui porque "Criar Mobi" é um componente
  // diferente (não reaproveita o de lá).
  const [zoom, setZoom] = useState(1.5);
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // qual item de mobi tem o FurnitureColorZoneTool.tsx aberto embaixo da
  // linha dele agora -- estado PRÓPRIO daqui (não o colorToolItemId de
  // AvatarCreatorPanel acima, que é de outro componente/escopo, só cobre
  // avatar/tom de pele) -- só 1 aberto por vez, mesmo esquema.
  const [furnitureColorToolItemId, setFurnitureColorToolItemId] = useState<string | null>(null);
  const fileInputRefs = useRef<Partial<Record<string, HTMLInputElement | null>>>({});
  const iconInputRef = useRef<HTMLInputElement | null>(null);
  // mesma indireção de AvatarCreatorPanel acima -- ver ImageCropModal e
  // pendingCrop lá pro comentário completo. "" como inputKey é o ícone
  // (usa iconInputRef, não fileInputRefs).
  const [pendingCrop, setPendingCrop] = useState<{ file: File; inputKey: string; apply: (f: File) => void } | null>(
    null
  );

  // "Editar" (pedido do Douglas: "quero editar os já cadastrados") --
  // null = formulário em modo "cadastrar item novo" (de sempre). Um id
  // aqui = editando ESSE item: o formulário é reusado (mesmos campos),
  // só troca o botão final e o destino do submit (PATCH em vez de
  // POST, ver handleSubmit). existingArt/existingIconUrl guardam as
  // URLs que JÁ estavam salvas -- mostradas como preview/miniatura
  // mesmo sem reenviar arquivo novo (só troca o que for re-upload).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [existingArt, setExistingArt] = useState<Partial<Record<MobiFacing, string>>>({});

  // tamanho de exibição ajustado à mão (ver DISPLAY_WIDTH_MIN/MAX/
  // PREVIEW_SCALE acima) -- começa no alvo padrão da categoria escolhida
  // e reseta pro alvo da categoria nova toda vez que ela muda (ver
  // handleCategoryChange), já que categorias diferentes têm escala bem
  // diferente (planta é bem menor que sofá) -- só quando NÃO tá editando
  // (editar um item existente não deve jogar fora o tamanho já ajustado
  // dele só por trocar a categoria).
  const [displayWidth, setDisplayWidth] = useState<number>(CUSTOM_ITEM_TARGET_WIDTH.poltrona);
  // footprint (em tiles do grid, não em px) -- pedido do Douglas: "tenho
  // mobis que ocupam mais tiles doq um ou dois, entao preciso selecionar
  // pra que nao se suba em um item". 1x1 (padrão) = comportamento de
  // sempre, só o próprio tile-âncora trava passagem (quando a categoria
  // trava, ver FURNITURE_BLOCKS_MOVEMENT em game/furniture.ts) -- acima
  // disso, o RESTO do retângulo footprintCols x footprintRows (a partir
  // da âncora) trava sempre, mesmo pra item que senta (só a âncora
  // mantém "anda até aqui e senta", ver furnitureFootprintTiles/
  // blockingFurnitureAt).
  const [footprintCols, setFootprintCols] = useState(1);
  const [footprintRows, setFootprintRows] = useState(1);
  // footprint DESENHADO À MÃO, por direção -- pedido do Douglas: "quero
  // selecionar os tiles que ele ocupa, CLICANDO, e preenchendo, do jeito
  // que ta eu nao consigo decidir rumo nem nada! E isso pra CADA
  // POSICAO, pois o movel gira e muda o bloqueio pela perspectiva!!!"
  // (footprintCols/Rows acima virou só o TAMANHO da grade clicável --
  // ver mobiFootprintTiles abaixo; o que trava passagem de verdade agora
  // é esse aqui). Cada chave é down/left/right/up (âncora de quina de
  // parede sempre cai em "down", ver footprintDirectionKey abaixo);
  // ausente = ainda não customizado NESSA direção, mostra/edita a partir
  // do retângulo cheio (footprintCols x footprintRows), MESMO
  // comportamento de sempre até o Douglas clicar em algo -- ver
  // FurnitureModelDef.footprintByDirection, game/furniture.ts.
  const [footprintByDirection, setFootprintByDirection] = useState<
    Partial<Record<"down" | "left" | "right" | "up", { dCol: number; dRow: number }[]>>
  >({});
  // "Sobrepor" -- pedido do Douglas: "cada item, ex: mesa mesinha de
  // centro, eu teria que configurar, a altura de um segundo item,
  // adicionado ao tile dele" + "esse item que eu não tickar a opção de
  // sobrepor, continua igual tá agora, ele não deixa por outro item no
  // mesmo quadrado". Dois campos NOVOS, independentes (o mesmo item pode
  // usar um, o outro, os dois, ou nenhum):
  //  - stackable: ESSE item (ex: notebook) pode ser colocado em cima de
  //    OUTRO já ancorado no mesmo tile (ver anyFurnitureAt, MainScene.ts)
  //    -- falso (padrão) = tile ocupado bloqueia igual sempre bloqueou.
  //  - stackSurfaceOffsetY: altura (px) da SUPERFÍCIE desse item (ex: a
  //    mesa) -- some no deslocamento de quem for colocado "Sobrepor" em
  //    cima dela (ver stackSurfaceOffsetYFor, MainScene.ts). 0 = sem
  //    superfície configurada (item em cima cai na posição normal, no
  //    chão).
  const [stackable, setStackable] = useState(false);
  const [stackSurfaceOffsetY, setStackSurfaceOffsetY] = useState(0);
  // assentos EXTRA (pedido do Douglas: "preciso... configurar dois
  // avatares no caso em que tenha mais de um assento", ex: sofá com 2
  // lugares) -- fora a âncora (que já senta do jeito de sempre, ver
  // sittable/seatOffsetX/Y acima/abaixo), cada entrada aqui é UM lugar
  // extra pra sentar: dCol/dRow (tile, offset a partir da âncora, dentro
  // do footprintCols x footprintRows acima) + x/y (px, deslocamento FIXO
  // de onde o boneco aparece sentado ali -- sem ajuste ao vivo no jogo,
  // ver comentário grande em FurnitureExtraSeat/seatSpotAt,
  // game/furniture.ts; ajustar aqui de novo é o jeito de afinar). []
  // (padrão) = só a âncora, comportamento de sempre.
  const [extraSeats, setExtraSeats] = useState<ExtraSeatRow[]>([]);
  // posição do item DENTRO do tile (pedido do Douglas: "delimitar ali no
  // editor a posição do mobi no tile") -- ajustado arrastando o item em
  // cima do quadrado/boneco de referência no preview (ver
  // handleItemDragStart), 0/0 = padrão (âncora na borda de baixo do
  // tile, sem deslocamento). Mesmo campo persistido em offsetX/offsetY
  // de FurnitureModelDef (ver game/furniture.ts).
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);
  // override de offsetX/offsetY por direção (pedido do Douglas: "editar
  // todos os lados do mobi") -- left/right/up só, "down" usa offsetX/
  // offsetY acima direto (ver comentário em FurnitureModelDef.directionOffsets,
  // game/furniture.ts). Qual direção tá sendo ajustada agora no preview
  // -- ver activeMobiDirection/DIRECTION_FIELDS.
  const [directionOffsets, setDirectionOffsets] = useState<
    Partial<Record<Exclude<MobiFacing, "down">, { x: number; y: number }>>
  >({});
  // override de displayWidth por direção (pedido do Douglas, testando o
  // campo digitável de "Tamanho no jogo" recém adicionado: "se eu mudar
  // de um ele muda de todas as vistas? nao tem como isolar?") -- MESMO
  // esquema de directionOffsets logo acima: left/right/up só, "down" usa
  // displayWidth direto (ver comentário em
  // FurnitureModelDef.directionDisplayWidth, game/furniture.ts). Sem
  // entrada numa direção = continua reaproveitando o displayWidth de
  // "down" (comportamento de sempre, sem regressão).
  const [directionDisplayWidth, setDirectionDisplayWidth] = useState<
    Partial<Record<Exclude<MobiFacing, "down">, number>>
  >({});
  const [activeMobiDirection, setActiveMobiDirection] = useState<MobiFacing>("down");

  // "Tem interação?" (pedido do Douglas: "se vai ter interação, e qual
  // interação -- por enquanto só temos sentar") -- desacopla "senta" da
  // CATEGORIA (antes só poltrona/sofá sentavam, sem escolha, ver
  // isSittableFurnitureType em game/furniture.ts). Começa pré-marcado
  // pelo palpite de categoria (poltrona/sofá = sentável), mas dá pra
  // mudar -- ver handleCategoryChange, que só reajusta esse palpite
  // quando NÃO tá editando (mesma regra do displayWidth acima).
  const [sittable, setSittable] = useState(() => DEFAULT_SITTABLE_BY_CATEGORY.poltrona);
  // ajuste PADRÃO (direção "down", também usado pra "up" sem override --
  // ver seatDirectionOffsets logo abaixo e resolveSeatOffset em
  // game/furniture.ts) de onde o boneco senta -- só importa quando
  // sittable=true, ver seat-marker arrastável no preview.
  const [seatOffsetX, setSeatOffsetX] = useState(0);
  const [seatOffsetY, setSeatOffsetY] = useState(0);
  // override do assento por direção (achado no "continua torto": um
  // valor só pras 4 direções sentava torto de lado sempre que ajustado
  // olhando frente/costas, ou vice-versa -- ver comentário grande em
  // FurnitureModelDef.seatDirectionOffsets, game/furniture.ts) --
  // left/right só (down/up caem em seatOffsetX/Y acima, mesmo esquema de
  // directionOffsets, MAS sem reaproveitar o valor de baixo quando falta
  // -- ver activeSeatOffset/resolveSeatOffset). Reaproveita
  // activeMobiDirection (mesma aba de direção da posição no tile) em vez
  // de um seletor à parte -- menos controle na tela, e o boneco já muda
  // de pose junto com a aba mesmo.
  const [seatDirectionOffsets, setSeatDirectionOffsets] = useState<
    Partial<Record<Exclude<MobiFacing, "down">, { x: number; y: number }>>
  >({});

  // URL (blob local, nunca sobe pra lugar nenhum) da imagem de FRENTE
  // escolhida, só pra mostrar no preview grande -- revogada
  // (URL.revokeObjectURL) toda vez que troca ou o componente desmonta,
  // pra não vazar memória.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  previewUrlRef.current = previewUrl;

  // ícone PRÓPRIO do catálogo (pedido do Douglas: "escolher o favicon
  // que aparece no catálogo") -- upload SEPARADO das 4 fotos de
  // direção, opcional: sem ele, o catálogo cai no fallback de sempre
  // (foto de frente, ver catalogEntryIconFile em GameRoom.tsx).
  // iconCleared = pediu pra tirar o ícone custom que já existia (ao
  // salvar, manda icon_url:null pro servidor) -- diferente de "não mexi
  // em nada" (nesse caso o PATCH nem manda o campo, mantém o que já tava
  // salvo).
  const [existingIconUrl, setExistingIconUrl] = useState<string | null>(null);
  const [iconFile, setIconFile] = useState<File | null>(null);
  const [iconCleared, setIconCleared] = useState(false);
  const [iconPreviewUrl, setIconPreviewUrl] = useState<string | null>(null);
  const iconPreviewUrlRef = useRef<string | null>(null);
  iconPreviewUrlRef.current = iconPreviewUrl;

  function handleCategoryChange(next: CategoryId) {
    setCategory(next);
    if (!editingId) {
      setDisplayWidth(CUSTOM_ITEM_TARGET_WIDTH[next]);
      setSittable(DEFAULT_SITTABLE_BY_CATEGORY[next]);
    }
  }

  function handleDownFileChange(file: File | undefined) {
    setFiles((prev) => ({ ...prev, down: file }));
    setPreviewUrl((prevUrl) => {
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      return file ? URL.createObjectURL(file) : null;
    });
  }

  function handleIconFileChange(file: File | undefined) {
    setIconFile(file ?? null);
    setIconCleared(false);
    setIconPreviewUrl((prevUrl) => {
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      return file ? URL.createObjectURL(file) : null;
    });
  }

  function removeIcon() {
    setIconFile(null);
    setIconCleared(true);
    setIconPreviewUrl((prevUrl) => {
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      return null;
    });
    if (iconInputRef.current) iconInputRef.current.value = "";
  }

  // --- "Criar Piso" (pedido do Douglas: "eu quero uma aba so pra piso
  // tambem... vai ter funcoes totalmente diferentes dos mobis", ver
  // comentário grande no mode acima) -- estado TODO separado do resto
  // do formulário de mobi/parede (nada aqui é reaproveitado de lá):
  // piso é só nome + categoria + (imagem OU padrão), sem direção/
  // footprint/assento/interação/cor. Tabela própria (room_floor_items,
  // ver supabase/migrations/0015_room_floor_items.sql e
  // 0016_room_floor_items_pattern.sql) e rotas próprias
  // (app/api/floor-items/**).
  //
  // "Padrão" (pedido do Douglas, mandou foto de um piso de tacos: "...
  // criamos ali dentro uma forma de preenchimento de linhas... nao
  // precise ser imagem mesmo, faz sentido? ficaria mais leve?") -- SEM
  // imagem nenhuma: largura da ripa + 2 cores, desenhado por código
  // direto no jogo (ver createFloorPatternGraphics em MainScene.ts). ---
  type CustomFloorRow = {
    id: string;
    label: string;
    category: FloorCategory;
    kind: "image" | "pattern";
    file_url: string | null;
    plank_width_px: number | null;
    color_a: string | null;
    color_b: string | null;
    plank_length_px: number | null;
    line_color: string | null;
    colors: string[] | null;
    wood_grain: boolean | null;
    marble: boolean | null;
    tile_aligned: boolean | null;
  };
  const [floorItems, setFloorItems] = useState<CustomFloorRow[] | null>(null);
  const [floorLabel, setFloorLabel] = useState("");
  const [floorCategory, setFloorCategory] = useState<FloorCategory>("porcelanato");
  // "Imagem" (de sempre) ou "Padrão" (sem imagem, ver comentário acima)
  // -- só escolhível ao CADASTRAR um piso novo (trocar o tipo no meio de
  // uma edição misturaria os dois formulários à toa; pra trocar o tipo
  // de um piso já existente, apaga e cadastra de novo).
  const [floorKind, setFloorKind] = useState<"image" | "pattern">("image");
  const [floorFile, setFloorFile] = useState<File | null>(null);
  const [floorPreviewUrl, setFloorPreviewUrl] = useState<string | null>(null);
  const floorPreviewUrlRef = useRef<string | null>(null);
  floorPreviewUrlRef.current = floorPreviewUrl;
  // ripa do tipo "padrão" -- largura em px (ver clamp 4..200 em
  // app/api/floor-items/route.ts) + lista de cores (2 a 6, direto como
  // <input type="color"> já devolve, "#rrggbb", mesmo formato salvo no
  // banco, ver comentário de FloorPatternConfig em game/floor.ts) --
  // ANTES eram 2 campos fixos (Cor 1/Cor 2), agora uma lista pra dar pra
  // criar tanto o efeito de 2 cores alternadas quanto o de "tábua
  // mesclada" (várias tonalidades) SEM precisar de 2 formulários
  // diferentes. Correção do Douglas: "eu nao defini as cores, so mandei
  // exemplo, quero criar eles el criar piso" -- ele quem escolhe.
  const [floorPlankWidth, setFloorPlankWidth] = useState(24);
  const [floorColors, setFloorColors] = useState<string[]>(["#a9835f", "#8f6a48"]);
  // comprimento da tábua -- STRING (não number) porque "" (vazio) tem um
  // significado próprio (ripa CONTÍNUA, sem emenda/junta nenhuma,
  // comportamento original) que não dá pra representar direito com 0
  // (0 seria uma tábua de comprimento zero, inválido). Só quando
  // preenchido a tábua vira "emendada" com linha de junta (floorLineColor
  // abaixo), ver FloorPatternConfig.plankLengthPx em game/floor.ts.
  const [floorPlankLength, setFloorPlankLength] = useState("");
  const [floorLineColor, setFloorLineColor] = useState("#2c2115");
  // efeito "laminado" (pedido do Douglas, com fotos de referência de
  // piso de madeira: "agora eu quero esse efeito laminado... de veios
  // de madeira", depois "no sentido das linhas também") -- riscos finos
  // dentro de cada tábua, ver FloorPatternConfig.woodGrain em
  // game/floor.ts. Só faz sentido com plankLength preenchido (tábua
  // EMENDADA -- sem isso, não tem tábua delimitada pra conter o veio),
  // por isso a checkbox só aparece nesse caso (ver JSX abaixo).
  const [floorWoodGrain, setFloorWoodGrain] = useState(false);
  // efeito "marmorado" (pedido do Douglas, foto de referência de
  // porcelanato marmorado: "agora eu quero um, porcelanato, que vai ser
  // do tamanho do tile, com linha divisoria, e com efeito de
  // porcelanato marmorado, assim") -- veios em diagonal dentro de cada
  // placa, ver FloorPatternConfig.marble em game/floor.ts. Mesma regra
  // do floorWoodGrain (só aparece com tábua/placa emendada).
  const [floorMarble, setFloorMarble] = useState(false);
  // emenda alinhada à grade (sem "amarração"/desalinhamento entre
  // colunas) -- junto do botão "Placa do tamanho do tile" abaixo, é o
  // que faz "vai ser do tamanho do tile" virar de verdade 1 placa = 1
  // quadrado da grade, com a junta batendo na borda (ver
  // FloorPatternConfig.tileAligned em game/floor.ts).
  const [floorTileAligned, setFloorTileAligned] = useState(false);
  const [floorEditingId, setFloorEditingId] = useState<string | null>(null);
  const [floorExistingFileUrl, setFloorExistingFileUrl] = useState<string | null>(null);
  const [floorSubmitting, setFloorSubmitting] = useState(false);
  const [floorBusyId, setFloorBusyId] = useState<string | null>(null);
  const [floorError, setFloorError] = useState<string | null>(null);
  const floorFileInputRef = useRef<HTMLInputElement | null>(null);

  // trava do Douglas (print de um porcelanato com a linha de junta
  // cruzando no MEIO do losango do tile em vez de bater na borda dele):
  // "o porcelanato nao ta com a linha na divisa do tile, quero travar
  // isso, entao no porcelanato nao me deixe colocar dimensao, ele e do
  // tamanho do tile e pronto, e tambem ja vem com linha". Causa: com
  // dimensão livre, dava pra esquecer de clicar "Placa do tamanho do
  // tile" (ou editar o valor depois) e a placa saía de um tamanho
  // diferente do tile, sem tileAligned -- daí a junta não bate na borda
  // do losango. Categoria "Porcelanato" agora SEMPRE usa
  // TILE_SIZED_PLANK_PX (1 placa = 1 tile exato, ver comentário grande
  // dela em game/floor.ts) + tileAligned=true, sem campo de dimensão
  // editável na tela (ver JSX abaixo, e o clamp de segurança extra em
  // handleFloorSubmit). Roda em toda troca de categoria -- inclusive ao
  // abrir pra editar um porcelanato antigo salvo com dimensão errada
  // (como o do print), corrigindo sozinho.
  useEffect(() => {
    if (floorCategory === "porcelanato") {
      const size = Math.round(TILE_SIZED_PLANK_PX * 100) / 100;
      setFloorPlankWidth(size);
      setFloorPlankLength(String(size));
      setFloorTileAligned(true);
    }
  }, [floorCategory]);

  /** "#rrggbb" -> número hex (o que FloorPatternConfig/
   * <FloorPatternSwatch> esperam, ver game/floor.ts) -- <input
   * type="color"> só devolve string. */
  function parseHexColor(css: string): number {
    return parseInt(css.replace("#", ""), 16) || 0;
  }

  /**
   * Ajusta um valor de largura/comprimento de tábua (px) pro DIVISOR
   * EXATO mais próximo de TILE_SIZED_PLANK_PX -- pedido do Douglas:
   * "nao tem como travar as divisões encima do limite do tile? fica
   * cortado assim, tentei fazer um deck" (com print de um piso de
   * madeira em várias tábuas por tile, cujas juntas cortavam no meio do
   * losango em vez de bater na borda dele).
   *
   * Causa raiz (ver createFloorPatternGraphics/acrossColOf/alongRowOf em
   * MainScene.ts): a faixa de cada tábua é calculada em coordenada
   * ABSOLUTA da tela (não por tile, é isso que faz o piso "correr" de um
   * tile pro vizinho sem emenda visível), e o CENTRO de cada tile cai
   * exatamente em múltiplos de TILE_SIZED_PLANK_PX nessa mesma base
   * (colAxis pra largura, rowAxis pro comprimento -- ver comentário
   * grande de TILE_SIZED_PLANK_PX em game/floor.ts). Isso já dava
   * "Placa do tamanho do tile" (1 tábua = 1 tile inteiro, sem corte),
   * mas pra um DECK de verdade (várias tábuas mais estreitas por tile)
   * faltava um jeito de garantir que save espaçamento também bata na
   * borda -- só acontece quando o tamanho da tábua é um divisor EXATO
   * de TILE_SIZED_PLANK_PX (N tábuas cabendo certinho de ponta a ponta
   * do tile, N inteiro). Qualquer outro valor (como os 24px padrão)
   * deixa uma tábua "cortada" bem no meio do losango, sem bater com a
   * borda -- exatamente o print que o Douglas mandou.
   *
   * Em vez de forçar um tamanho fixo (como o porcelanato), aqui só
   * ARREDONDA o valor que o Douglas já digitou pro divisor mais
   * PRÓXIMO (N = tábuas por tile mais perto do que ele tinha, mínimo 1)
   * -- o visual do deck continua quase idêntico ao que ele tentou fazer
   * (24px vira ~23,85px, por exemplo), só que agora sem corte no meio.
   */
  function snapPlankSizeToTileDivisor(px: number): number {
    if (!Number.isFinite(px) || px <= 0) return px;
    const divisions = Math.max(1, Math.round(TILE_SIZED_PLANK_PX / px));
    return Math.round((TILE_SIZED_PLANK_PX / divisions) * 100) / 100;
  }

  /** Adiciona uma cor no fim da lista (máximo 6, mesmo teto validado em
   * app/api/floor-items/route.ts) -- cor de partida genérica, o usuário
   * troca depois pelo <input type="color"> dela. */
  function addFloorColor() {
    setFloorColors((prev) => (prev.length >= 6 ? prev : [...prev, "#8a8079"]));
  }
  /** Remove uma cor da lista (mínimo 2 -- padrão "só 2 cores alternadas"
   * sempre precisa de pelo menos isso, senão não tem o que alternar). */
  function removeFloorColor(index: number) {
    setFloorColors((prev) => (prev.length <= 2 ? prev : prev.filter((_, i) => i !== index)));
  }
  function updateFloorColor(index: number, value: string) {
    setFloorColors((prev) => prev.map((c, i) => (i === index ? value : c)));
  }

  async function loadFloorItems() {
    setFloorError(null);
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data, error: fetchError } = await supabase
      .from("room_floor_items")
      .select(
        "id, label, category, kind, file_url, plank_width_px, color_a, color_b, plank_length_px, line_color, colors, wood_grain, marble, tile_aligned"
      );
    if (fetchError) {
      setFloorError(fetchError.message);
      return;
    }
    setFloorItems((data ?? []) as CustomFloorRow[]);
  }

  function resetFloorForm() {
    setFloorEditingId(null);
    setFloorLabel("");
    setFloorCategory("porcelanato");
    setFloorKind("image");
    setFloorFile(null);
    setFloorExistingFileUrl(null);
    setFloorPlankWidth(24);
    setFloorColors(["#a9835f", "#8f6a48"]);
    setFloorPlankLength("");
    setFloorLineColor("#2c2115");
    setFloorWoodGrain(false);
    setFloorMarble(false);
    setFloorTileAligned(false);
    setFloorPreviewUrl((prevUrl) => {
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      return null;
    });
    if (floorFileInputRef.current) floorFileInputRef.current.value = "";
  }

  function handleFloorFileChange(file: File | undefined) {
    setFloorFile(file ?? null);
    setFloorPreviewUrl((prevUrl) => {
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      return file ? URL.createObjectURL(file) : null;
    });
  }

  function startEditFloorItem(item: CustomFloorRow) {
    setFloorEditingId(item.id);
    setFloorLabel(item.label);
    setFloorCategory(item.category);
    setFloorKind(item.kind);
    setFloorFile(null);
    setFloorExistingFileUrl(item.file_url);
    setFloorPlankWidth(item.plank_width_px ?? 24);
    // paleta nova (colors) tem prioridade -- se o registro é antigo e só
    // tem color_a/color_b (de antes de existir a lista), monta uma
    // lista de 2 com elas, pra editar do mesmo jeito.
    setFloorColors(item.colors && item.colors.length >= 2 ? item.colors : [item.color_a ?? "#a9835f", item.color_b ?? "#8f6a48"]);
    setFloorPlankLength(item.plank_length_px ? String(item.plank_length_px) : "");
    setFloorLineColor(item.line_color ?? "#2c2115");
    setFloorWoodGrain(item.wood_grain ?? false);
    setFloorMarble(item.marble ?? false);
    setFloorTileAligned(item.tile_aligned ?? false);
    setFloorPreviewUrl((prevUrl) => {
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      return null;
    });
    if (floorFileInputRef.current) floorFileInputRef.current.value = "";
  }

  async function handleFloorSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFloorError(null);
    if (!floorLabel.trim()) {
      setFloorError("Dá um nome pro piso.");
      return;
    }
    if (floorKind === "image" && !floorEditingId && !floorFile) {
      setFloorError("A imagem é obrigatória.");
      return;
    }
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setFloorSubmitting(true);
    // mesma correção do handleSubmit de mobi/parede acima (ver comentário
    // grande lá): sobe a imagem pro Storage PRIMEIRO, só depois grava o
    // cadastro -- se o cadastro falhar depois do upload, desfaz o upload
    // órfão no catch, em vez de deixar lixo pra sempre no bucket. Piso
    // "padrão" não sobe imagem nenhuma -- uploadedPaths fica vazio, e o
    // desfazer no catch vira um no-op.
    const uploadedPaths: string[] = [];
    try {
      const slug = slugify(floorLabel);
      let fileUrl: string | undefined;
      if (floorKind === "image" && floorFile) {
        // teto de resolução: piso sempre desenha no tamanho FIXO do tile
        // (ISO_TILE_WIDTH x ISO_TILE_HEIGHT, ver addFloorSprite em
        // MainScene.ts -- diferente de móvel, não tem displayWidth
        // ajustável), então o teto usa direto ISO_TILE_WIDTH (com a
        // mesma folga de nitidez UPLOAD_SUPERSAMPLE do resto do editor).
        const resized = await resizeImageForUpload(floorFile, ISO_TILE_WIDTH * UPLOAD_SUPERSAMPLE);
        const ext = resized.name.split(".").pop() || "png";
        const path = `piso/${slug}-${Date.now()}.${ext}`;
        const { error: uploadError } = await supabase.storage.from("room-items").upload(path, resized, {
          upsert: false,
          contentType: resized.type || "image/png",
        });
        if (uploadError) throw uploadError;
        uploadedPaths.push(path);
        const { data: publicUrlData } = supabase.storage.from("room-items").getPublicUrl(path);
        fileUrl = publicUrlData.publicUrl;
      }

      const payload: Record<string, unknown> = { label: floorLabel.trim(), category: floorCategory };
      if (!floorEditingId) payload.kind = floorKind;
      if (floorKind === "image") {
        if (fileUrl) payload.file_url = fileUrl;
      } else {
        // porcelanato é travado no tamanho do tile (ver useEffect acima
        // e pedido do Douglas no comentário dele) -- clamp de segurança
        // aqui também, pra nunca mandar uma dimensão fora do tile pro
        // banco mesmo que o state do form esteja dessincronizado por
        // algum motivo.
        const isPorcelanato = floorCategory === "porcelanato";
        const tileSize = Math.round(TILE_SIZED_PLANK_PX * 100) / 100;
        payload.plank_width_px = isPorcelanato ? tileSize : floorPlankWidth;
        // color_a/color_b continuam sendo enviadas (a API ainda exige
        // as 2, ver app/api/floor-items/route.ts) -- derivadas das 2
        // primeiras da lista. `colors` vai sempre junto (mesmo com só 2
        // cores) -- é ela quem manda de verdade na hora de desenhar (ver
        // pickPlankColor em MainScene.ts), color_a/color_b viram só
        // fallback pra registro antigo.
        payload.color_a = floorColors[0];
        payload.color_b = floorColors[1] ?? floorColors[0];
        payload.colors = floorColors;
        // comprimento da tábua -- só manda quando preenchido (senão
        // ripa contínua sem junta, ver comentário grande no state
        // floorPlankLength acima). Junto vai a cor da linha de junta.
        // Porcelanato sempre cai aqui (nunca fica em branco, travado
        // pelo useEffect acima) -- "já vem com linha" por padrão.
        if (isPorcelanato || floorPlankLength.trim() !== "") {
          const plankLength = isPorcelanato ? tileSize : Number(floorPlankLength);
          if (!Number.isFinite(plankLength) || plankLength < 4 || plankLength > 400) {
            throw new Error("Comprimento da tábua precisa ser entre 4 e 400.");
          }
          payload.plank_length_px = plankLength;
          payload.line_color = floorLineColor;
          payload.wood_grain = floorWoodGrain;
          payload.marble = floorMarble;
          payload.tile_aligned = isPorcelanato ? true : floorTileAligned;
        } else if (floorEditingId) {
          // editando e deixou o campo em branco -- some com a emenda
          // (volta pra ripa contínua), não só ignora o campo -- e o
          // veio/marmorado/alinhamento (que só fazem sentido com
          // tábua/placa emendada) somem junto.
          payload.plank_length_px = null;
          payload.line_color = null;
          payload.wood_grain = false;
          payload.marble = false;
          payload.tile_aligned = false;
        }
      }

      const res = await fetch(floorEditingId ? `/api/floor-items/${floorEditingId}` : "/api/floor-items", {
        method: floorEditingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "erro ao salvar piso");

      resetFloorForm();
      await loadFloorItems();
      onItemsChanged();
    } catch (err) {
      if (uploadedPaths.length > 0) {
        await supabase.storage.from("room-items").remove(uploadedPaths).catch(() => null);
      }
      setFloorError(err instanceof Error ? err.message : "erro ao salvar piso");
    } finally {
      setFloorSubmitting(false);
    }
  }

  async function handleFloorDelete(id: string) {
    setFloorBusyId(id);
    setFloorError(null);
    try {
      const res = await fetch(`/api/floor-items/${id}`, { method: "DELETE", headers: authHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "erro ao apagar piso");
      if (floorEditingId === id) resetFloorForm();
      await loadFloorItems();
      onItemsChanged();
    } catch (err) {
      setFloorError(err instanceof Error ? err.message : "erro ao apagar piso");
    } finally {
      setFloorBusyId(null);
    }
  }

  useEffect(() => {
    loadFloorItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // limpa as últimas URLs de preview ao desmontar (ex: fechou o editor)
  // -- sem isso o blob fica preso na memória do navegador até a aba
  // fechar.
  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      if (iconPreviewUrlRef.current) URL.revokeObjectURL(iconPreviewUrlRef.current);
      if (floorPreviewUrlRef.current) URL.revokeObjectURL(floorPreviewUrlRef.current);
    };
  }, []);

  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  async function loadItems() {
    setError(null);
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data, error: fetchError } = await supabase
      .from("room_items")
      .select(
        // stackable/stack_surface_offset_y/footprint_by_direction
        // faltavam aqui (só existiam no tipo CustomItemRow acima e no
        // startEditItem abaixo) -- sem vir nessa query, SEMPRE caíam no
        // "?? false"/"?? undefined" do startEditItem, então reabrir um
        // item pra editar nunca mostrava "Sobrepor"/altura/footprint
        // customizado que já tinha sido salvo. Corrigido junto do
        // footprint por direção (mesmo bug, mesma causa).
        "id, label, category, art, icon_url, display_width, offset_x, offset_y, direction_offsets, direction_display_width, sittable, seat_offset_x, seat_offset_y, seat_direction_offsets, colors, footprint_cols, footprint_rows, footprint_by_direction, stackable, stack_surface_offset_y, extra_seats"
      );
    if (fetchError) {
      setError(fetchError.message);
      return;
    }
    setItems((data ?? []) as CustomItemRow[]);
  }

  useEffect(() => {
    loadItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Limpa o formulário inteiro de volta pro modo "cadastrar item novo".
   * Categoria padrão depende da aba atual (ver mode acima) -- "poltrona"
   * pra "Criar Mobi" (de sempre), "divisoria" pra "Criar Parede" (senão,
   * depois de cadastrar UMA parede, o formulário voltava pra categoria
   * "poltrona" por baixo dos panos mesmo a aba continuando em "Criar
   * Parede", e a PRÓXIMA parede cadastrada saía como móvel comum). */
  function resetForm() {
    const defaultCategory: CategoryId = mode === "parede" ? "divisoria" : "poltrona";
    setEditingId(null);
    setLabel("");
    setCategory(defaultCategory);
    setFiles({});
    setExistingArt({});
    setDisplayWidth(CUSTOM_ITEM_TARGET_WIDTH[defaultCategory]);
    setFootprintCols(1);
    setFootprintRows(1);
    setFootprintByDirection({});
    setStackable(false);
    setStackSurfaceOffsetY(0);
    setExtraSeats([]);
    setOffsetX(0);
    setOffsetY(0);
    setDirectionOffsets({});
    setDirectionDisplayWidth({});
    setActiveMobiDirection("down");
    setSittable(DEFAULT_SITTABLE_BY_CATEGORY[defaultCategory]);
    setSeatOffsetX(0);
    setSeatOffsetY(0);
    setSeatDirectionOffsets({});
    setPreviewUrl((prevUrl) => {
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      return null;
    });
    setExistingIconUrl(null);
    setIconFile(null);
    setIconCleared(false);
    setIconPreviewUrl((prevUrl) => {
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      return null;
    });
    for (const key of Object.keys(fileInputRefs.current)) {
      const input = fileInputRefs.current[key];
      if (input) input.value = "";
    }
    if (iconInputRef.current) iconInputRef.current.value = "";
  }

  /** Botão "Editar" na lista de cadastrados -- carrega o item inteiro de
   * volta no formulário (mesmo formulário do cadastro, ver comentário em
   * editingId acima), pronto pra ajustar e salvar. */
  function startEditItem(item: CustomItemRow) {
    setEditingId(item.id);
    setLabel(item.label);
    setCategory(item.category);
    setFiles({});
    setExistingArt(item.art ?? {});
    setDisplayWidth(item.display_width ?? CUSTOM_ITEM_TARGET_WIDTH[item.category]);
    setFootprintCols(clamp(item.footprint_cols ?? 1, 1, 6));
    setFootprintRows(clamp(item.footprint_rows ?? 1, 1, 6));
    setFootprintByDirection(item.footprint_by_direction ?? {});
    setStackable(item.stackable ?? false);
    setStackSurfaceOffsetY(item.stack_surface_offset_y ?? 0);
    setExtraSeats(
      (item.extra_seats ?? []).map((s) => ({
        dCol: clamp(s.dCol ?? 0, -6, 6),
        dRow: clamp(s.dRow ?? 0, -6, 6),
        x: clamp(s.x ?? 0, -OFFSET_LIMIT, OFFSET_LIMIT),
        y: clamp(s.y ?? 0, -OFFSET_LIMIT, OFFSET_LIMIT),
      }))
    );
    setOffsetX(clamp(item.offset_x ?? 0, -OFFSET_LIMIT, OFFSET_LIMIT));
    setOffsetY(clamp(item.offset_y ?? 0, -OFFSET_LIMIT, OFFSET_LIMIT));
    setDirectionOffsets(item.direction_offsets ?? {});
    setDirectionDisplayWidth(item.direction_display_width ?? {});
    setActiveMobiDirection("down");
    setSittable(item.sittable ?? DEFAULT_SITTABLE_BY_CATEGORY[item.category]);
    setSeatOffsetX(clamp(item.seat_offset_x ?? 0, -SEAT_OFFSET_LIMIT, SEAT_OFFSET_LIMIT));
    setSeatOffsetY(clamp(item.seat_offset_y ?? 0, -SEAT_OFFSET_LIMIT, SEAT_OFFSET_LIMIT));
    setSeatDirectionOffsets(item.seat_direction_offsets ?? {});
    setPreviewUrl((prevUrl) => {
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      return null;
    });
    setExistingIconUrl(item.icon_url ?? null);
    setIconFile(null);
    setIconCleared(false);
    setIconPreviewUrl((prevUrl) => {
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      return null;
    });
    setError(null);
    for (const key of Object.keys(fileInputRefs.current)) {
      const input = fileInputRefs.current[key];
      if (input) input.value = "";
    }
    if (iconInputRef.current) iconInputRef.current.value = "";
  }

  // imagem mostrada no preview grande -- pra "down" continua usando o
  // blob dedicado de sempre (previewUrl, ver handleDownFileChange);
  // pras outras 3 direções (pedido do Douglas: "editar todos os lados
  // do mobi"), um blob PRÓPRIO da direção ativa (ver activeMobiBlobUrl
  // logo abaixo, mesmo esquema que AvatarCreatorPanel já usa pra
  // isso). Sem arquivo novo escolhido, cai na URL já salva daquela
  // direção (existingArt).
  const activeMobiFile = activeMobiDirection === "down" ? undefined : files[activeMobiDirection];
  const [activeMobiBlobUrl, setActiveMobiBlobUrl] = useState<string | null>(null);
  const activeMobiBlobUrlRef = useRef<string | null>(null);
  activeMobiBlobUrlRef.current = activeMobiBlobUrl;

  useEffect(() => {
    setActiveMobiBlobUrl((prevUrl) => {
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      return activeMobiFile ? URL.createObjectURL(activeMobiFile) : null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMobiFile]);

  useEffect(() => {
    return () => {
      if (activeMobiBlobUrlRef.current) URL.revokeObjectURL(activeMobiBlobUrlRef.current);
    };
  }, []);

  const stageArtSrc =
    activeMobiDirection === "down"
      ? previewUrl ?? existingArt.down ?? null
      : activeMobiBlobUrl ?? existingArt[activeMobiDirection] ?? null;
  const stageIconSrc = iconPreviewUrl ?? (!iconCleared ? existingIconUrl : null);

  // boneco de referência (ver comentário grande no topo do módulo, perto
  // de onde essas 3 eram `const` fixas) -- recalculado a cada render pra
  // acompanhar HAIR_CATALOG/SKIN_CATALOG/OUTFIT_CATALOG assim que um
  // fetch de item custom termina. Traje: por padrão o ÚLTIMO não-"Nenhum"
  // (não o primeiro) -- upsertCatalogById (customization.ts) empurra item
  // NOVO pro fim do catálogo, então "o último" costuma ser o traje mais
  // recente que o Douglas cadastrou.
  //
  // Só que isso quebra quando ele EDITA um traje mais antigo em vez de
  // criar um novo (pedido: "atualiza o carinha sentado no editor de mobi"
  // / "eu alterei ele, tem que atualizar") -- upsertCatalogById mantém a
  // POSIÇÃO de quem já existia (só troca os dados no lugar), então "o
  // último da lista" continua sendo outro traje qualquer, não o que
  // acabou de ser editado. MOBI_REFERENCE_OUTFIT_STORAGE_KEY (gravado no
  // handleAvatarSubmit da AvatarCreatorPanel, tanto ao criar quanto ao
  // editar) guarda o id do traje TOCADO por último de verdade -- prioridade
  // sobre o "último do catálogo" sempre que esse id ainda existir no
  // catálogo atual (item apagado depois cai de volta no fallback).
  const referenceHair = HAIR_CATALOG.find((h) => h.id === DEFAULT_HAIR_ID) ?? HAIR_CATALOG[0];
  const referenceSkin = SKIN_CATALOG.find((s) => s.id === DEFAULT_SKIN_ID) ?? SKIN_CATALOG[0];
  const nonDefaultOutfits = OUTFIT_CATALOG.filter((o) => o.id !== DEFAULT_OUTFIT_ID);
  let lastTouchedOutfitId: string | null = null;
  try {
    lastTouchedOutfitId = window.localStorage.getItem(MOBI_REFERENCE_OUTFIT_STORAGE_KEY);
  } catch {
    // localStorage indisponível -- segue pro fallback de sempre
  }
  const referenceOutfit =
    (lastTouchedOutfitId && nonDefaultOutfits.find((o) => o.id === lastTouchedOutfitId)) ||
    nonDefaultOutfits[nonDefaultOutfits.length - 1] ||
    OUTFIT_CATALOG[0];
  const referenceOutfitFile = referenceOutfit ? outfitFileForSkin(referenceOutfit, DEFAULT_SKIN_ID) : undefined;

  // offset em uso pela direção ATIVA -- "down" lê offsetX/offsetY
  // direto, as outras 3 caem no PRÓPRIO override (directionOffsets) ou,
  // sem um ainda, no mesmo valor de "down" (mesma prévia do que vai
  // acontecer no jogo, ver addFurnitureSprite em MainScene.ts).
  const activeMobiOffset =
    activeMobiDirection === "down" ? { x: offsetX, y: offsetY } : directionOffsets[activeMobiDirection] ?? { x: offsetX, y: offsetY };

  // tamanho em uso pela direção ATIVA (mesma ideia de activeMobiOffset
  // acima, ver comentário grande em directionDisplayWidth/
  // FurnitureModelDef.directionDisplayWidth) -- "down" lê displayWidth
  // direto, as outras 3 caem no PRÓPRIO override (directionDisplayWidth)
  // ou, sem um ainda, no mesmo valor de "down" (mesma prévia do que vai
  // acontecer no jogo, ver addFurnitureSprite em MainScene.ts). Pedido
  // do Douglas: "se eu mudar de um ele muda de todas as vistas? nao tem
  // como isolar?".
  const activeDisplayWidth =
    activeMobiDirection === "down" ? displayWidth : directionDisplayWidth[activeMobiDirection] ?? displayWidth;
  const hasDisplayWidthOverride = activeMobiDirection !== "down" && activeMobiDirection in directionDisplayWidth;

  // grade de footprint CLICÁVEL, SEMPRE ABERTA -- pedido do Douglas:
  // "nao tem como a grande ja vir aberta, com a insersao no meio?? 2 pra
  // cada lado da insercao" (ver FOOTPRINT_GRID_RADIUS acima). FIXA (não
  // depende mais de footprintCols/footprintRows, que viraram só o
  // default de exibição pra item ANTIGO, ver isFootprintTileSelected
  // abaixo) -- dCol/dRow de -RADIUS a +RADIUS nos 2 eixos, âncora (0,0)
  // no meio da grade, MESMA conta isométrica de tileToWorld
  // (game/grid.ts) pra cada deslocamento.
  const mobiFootprintTiles: { dCol: number; dRow: number }[] = [];
  for (let dRow = -FOOTPRINT_GRID_RADIUS; dRow <= FOOTPRINT_GRID_RADIUS; dRow++) {
    for (let dCol = -FOOTPRINT_GRID_RADIUS; dCol <= FOOTPRINT_GRID_RADIUS; dCol++) {
      mobiFootprintTiles.push({ dCol, dRow });
    }
  }
  // espaço extra pra grade CABER inteira no stage -- diferente de antes
  // (só crescia pra baixo-direita, só precisava de espaço EMBAIXO), essa
  // grade cresce nos 4 quadrantes a partir da âncora, então precisa de
  // espaço ACIMA (quadrantes de dCol+dRow negativo, sobem na tela, ver
  // conta isométrica de tileToWorld) e ABAIXO (quadrantes positivos) em
  // volta do losango-âncora de sempre -- senão o resto da grade sai
  // cortado pelo overflow-y:hidden do ".item-stage" (achado já visto
  // antes nessa mesma tela: "cade os tiles"). Fixo (não muda mais com
  // footprintCols/Rows) -- todo item mobi agora ganha essa folga, é o
  // preço de a grade já vir aberta de cara.
  const mobiFootprintExtraPad = FOOTPRINT_GRID_RADIUS * 2 * (TILE_HEIGHT_PX / 2);
  const mobiStageBaseline = STAGE_BASELINE_PAD + mobiFootprintExtraPad;
  const mobiStageHeight = STAGE_HEIGHT + mobiFootprintExtraPad * 2;

  /** Quina de parede (cornerTop/cornerBottom) não tem footprint próprio
   * -- footprint só existe pras 4 direções-base (down/left/right/up,
   * MESMA Direction de directionOffsets), então as 2 quinas sempre
   * editam/mostram a entrada "down" (ver mesmo raciocínio em
   * furnitureFootprintTiles, game/furniture.ts). */
  function footprintDirectionKey(dir: MobiFacing): "down" | "left" | "right" | "up" {
    return dir === "cornerTop" || dir === "cornerBottom" ? "down" : dir;
  }
  const activeFootprintDir = footprintDirectionKey(activeMobiDirection);
  // customização da direção ATIVA -- undefined = ainda não mexeu nessa
  // direção, cai no retângulo cego de ANTES (footprintCols x
  // footprintRows, só pra decidir o que já vem marcado por padrão na
  // grade nova, ver isFootprintTileSelected abaixo) -- item cadastrado
  // antes dessa grade existir continua mostrando o footprint de sempre.
  const activeFootprintCustom = footprintByDirection[activeFootprintDir];
  /** Esse tile (dCol,dRow, DENTRO da grade fixa -RADIUS..+RADIUS, ver
   * FOOTPRINT_GRID_RADIUS/mobiFootprintTiles acima) trava passagem na
   * direção ATIVA -- a âncora (0,0) trava sempre (não é opcional,
   * ninguém clica pra desmarcar ela). Sem customização ainda nessa
   * direção, cai no retângulo cego de ANTES (0<=dCol<footprintCols,
   * 0<=dRow<footprintRows) -- item já cadastrado com footprintCols/Rows
   * >1x1 continua mostrando esse footprint marcado de cara (em vez de
   * "resetar" pra só a âncora só porque a grade agora é maior/fixa). */
  function isFootprintTileSelected(dCol: number, dRow: number): boolean {
    if (dCol === 0 && dRow === 0) return true;
    if (activeFootprintCustom) return activeFootprintCustom.some((t) => t.dCol === dCol && t.dRow === dRow);
    return dCol >= 0 && dCol < footprintCols && dRow >= 0 && dRow < footprintRows;
  }
  /** Clique num quadrado do preview (ver item-stage-footprint-tile mais
   * abaixo) -- pedido do Douglas depois de brigar com o retângulo cego:
   * "quero selecionar os tiles que ele ocupa, CLICANDO, e preenchendo,
   * do jeito que ta eu nao consigo decidir rumo nem nada! E isso pra
   * CADA POSICAO, pois o movel gira e muda o bloqueio pela
   * perspectiva!!!". Só afeta a direção ATIVA (activeMobiDirection,
   * mesma aba usada pra posição/tamanho por direção mais acima) -- na
   * PRIMEIRA vez que mexe numa direção, parte do retângulo cego de ANTES
   * já marcado (mesmo estado visual de antes do clique, ver
   * isFootprintTileSelected acima), só aí risca/soma o tile clicado.
   * Âncora (0,0) nunca entra aqui, sempre trava, sem opção de
   * desmarcar. */
  function toggleFootprintTile(dCol: number, dRow: number) {
    if (dCol === 0 && dRow === 0) return;
    setFootprintByDirection((prev) => {
      const base =
        prev[activeFootprintDir] ??
        mobiFootprintTiles.filter(
          (t) => !(t.dCol === 0 && t.dRow === 0) && t.dCol >= 0 && t.dCol < footprintCols && t.dRow >= 0 && t.dRow < footprintRows
        );
      const exists = base.some((t) => t.dCol === dCol && t.dRow === dRow);
      const next = exists ? base.filter((t) => !(t.dCol === dCol && t.dRow === dRow)) : [...base, { dCol, dRow }];
      return { ...prev, [activeFootprintDir]: next };
    });
  }
  /** Grava o tamanho na direção ATIVA -- "down" ajusta displayWidth
   * direto (base, reaproveitada por qualquer direção sem override
   * próprio), as outras 3 gravam SÓ o override daquela direção em
   * directionDisplayWidth, sem mexer em displayWidth nem nas demais. */
  function setActiveDisplayWidth(value: number) {
    if (activeMobiDirection === "down") {
      setDisplayWidth(value);
    } else {
      const dir = activeMobiDirection as Exclude<MobiFacing, "down">;
      setDirectionDisplayWidth((prev) => ({ ...prev, [dir]: value }));
    }
  }

  // assento em uso pela direção ATIVA (mesma ideia de activeMobiOffset
  // acima, ver comentário grande em seatDirectionOffsets/
  // FurnitureModelDef.seatDirectionOffsets) -- "down"/"up" leem
  // seatOffsetX/Y direto, "left"/"right" caem no PRÓPRIO override
  // (seatDirectionOffsets) ou, sem um ainda, no MESMO heurístico
  // genérico de "sentar de lado" que o jogo usa quando não tem nada
  // ajustado (SEAT_Y_LADO/SEAT_X_LADO, ver resolveSeatOffset em
  // game/furniture.ts) -- diferente de activeMobiOffset, NÃO cai no
  // valor de "down": é exatamente esse reaproveitamento que deixava o
  // boneco "torto" de lado.
  const isActiveSeatSide = activeMobiDirection === "left" || activeMobiDirection === "right";
  const activeSeatOffset = !isActiveSeatSide
    ? { x: seatOffsetX, y: seatOffsetY }
    : seatDirectionOffsets[activeMobiDirection] ??
      { x: activeMobiDirection === "left" ? -SEAT_X_LADO : SEAT_X_LADO, y: SEAT_Y_LADO };

  // boneco de referência NA POSE da direção ativa (mesmo esquema do
  // "Criar Avatar", ver DIRECTION_FIRST_FRAME_INDEX/frameOffsetXPx em
  // AvatarCreatorPanel acima). O boneco não tem pose de "quina" (só as 4
  // de sempre, ver DIRECTION_FIRST_FRAME_INDEX/SEAT_FRAME_INDEX logo
  // abaixo) -- nas 2 quinas extras de parede (cornerTop/cornerBottom,
  // pedido do Douglas: "quina de cima, quina de baixo") o boneco de
  // referência cai na pose de frente ("down"), só pra continuar servindo
  // de escala/referência de tamanho no preview (não representa a peça
  // em si, que não senta nem anda).
  const avatarPoseDirection: DirectionKey =
    activeMobiDirection === "cornerTop" || activeMobiDirection === "cornerBottom" ? "down" : activeMobiDirection;
  const activeMobiFrameIndex = DIRECTION_FIRST_FRAME_INDEX[avatarPoseDirection];
  const mobiFrameCol = activeMobiFrameIndex % SKIN_SHEET_COLS;
  const mobiFrameRow = Math.floor(activeMobiFrameIndex / SKIN_SHEET_COLS);
  const mobiFrameOffsetXPx = mobiFrameCol * (FRAME_W + SKIN_SHEET_SPACING) * AVATAR_SCALE * PREVIEW_SCALE;
  const mobiFrameOffsetYPx = mobiFrameRow * (FRAME_H + SKIN_SHEET_SPACING) * AVATAR_SCALE * PREVIEW_SCALE;

  // mesma ideia, mas pra pose SENTADO da direção ativa (usado no boneco
  // arrastável do marcador de assento logo abaixo, no lugar da bolinha
  // antiga -- pedido do Douglas).
  const activeSeatFrameIndex = SEAT_FRAME_INDEX[avatarPoseDirection];
  const seatFrameCol = activeSeatFrameIndex % SKIN_SHEET_COLS;
  const seatFrameRow = Math.floor(activeSeatFrameIndex / SKIN_SHEET_COLS);
  const seatFrameOffsetXPx = seatFrameCol * (FRAME_W + SKIN_SHEET_SPACING) * AVATAR_SCALE * PREVIEW_SCALE;
  const seatFrameOffsetYPx = seatFrameRow * (FRAME_H + SKIN_SHEET_SPACING) * AVATAR_SCALE * PREVIEW_SCALE;

  // Douglas pediu (depois de ver o resultado ao vivo, "remova esses
  // quadrados roxo do fundo") pra voltar atrás na ideia de mostrar um
  // "piso de referência" com vários losangos no palco -- ficou poluído
  // demais mesmo depois de deixar mais marcado. Removido: voltou a ser
  // só o tile ÂNCORA de sempre (ver item-stage-tile no JSX abaixo), sem
  // a grade extra nem o respiro/base ajustados por footprint.

  // --- arrastar o item em cima do quadrado/boneco de referência
  // (pedido do Douglas: "delimitar ali no editor a posição do mobi no
  // tile", depois "editar todos os lados do mobi") -- pointer capture
  // no próprio elemento arrastado, assim o arraste continua
  // funcionando mesmo se o cursor sair da área do preview no meio do
  // gesto. Converte pixel de TELA (delta do mouse) pra pixel de JOGO
  // dividindo por PREVIEW_SCALE -- offsetX/offsetY são sempre em px de
  // jogo (mesma unidade salva no banco/usada em MainScene.ts), não em
  // px de tela. Escreve em offsetX/offsetY quando a direção ativa é
  // "down", senão no override daquela direção (directionOffsets).
  function handleItemPointerDown(e: ReactPointerEvent<HTMLImageElement>) {
    e.preventDefault();
    const dir = activeMobiDirection;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const startOffsetX = activeMobiOffset.x;
    const startOffsetY = activeMobiOffset.y;

    function onMove(ev: PointerEvent) {
      const dx = (ev.clientX - startClientX) / PREVIEW_SCALE;
      const dy = (ev.clientY - startClientY) / PREVIEW_SCALE;
      const nextX = clamp(Math.round(startOffsetX + dx), -OFFSET_LIMIT, OFFSET_LIMIT);
      const nextY = clamp(Math.round(startOffsetY + dy), -OFFSET_LIMIT, OFFSET_LIMIT);
      if (dir === "down") {
        setOffsetX(nextX);
        setOffsetY(nextY);
      } else {
        setDirectionOffsets((prev) => ({ ...prev, [dir]: { x: nextX, y: nextY } }));
      }
    }
    function onUp(ev: PointerEvent) {
      target.releasePointerCapture(ev.pointerId);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
    }
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
  }

  // --- arrastar o MARCADOR de onde o boneco senta (pedido do Douglas:
  // "editar também a posição sentado lá dentro") -- só aparece quando
  // sittable=true (ver seletor "Tem interação?"). MESMO esquema de
  // handleItemPointerDown acima (posição no tile): "down"/"up" escrevem
  // em seatOffsetX/Y direto, "left"/"right" caem no PRÓPRIO override
  // (seatDirectionOffsets) -- ver activeSeatOffset/comentário grande em
  // FurnitureModelDef.seatDirectionOffsets (game/furniture.ts) pro
  // porquê de existir (achado: "eu salvo a posição e ele fica em outra
  // no mapa" -- um valor só pras 4 direções sentava torto de lado).
  function handleSeatMarkerPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const dir = activeMobiDirection;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const startX = activeSeatOffset.x;
    const startY = activeSeatOffset.y;

    function onMove(ev: PointerEvent) {
      const dx = (ev.clientX - startClientX) / PREVIEW_SCALE;
      const dy = (ev.clientY - startClientY) / PREVIEW_SCALE;
      const nextX = clamp(Math.round(startX + dx), -SEAT_OFFSET_LIMIT, SEAT_OFFSET_LIMIT);
      const nextY = clamp(Math.round(startY + dy), -SEAT_OFFSET_LIMIT, SEAT_OFFSET_LIMIT);
      if (dir === "left" || dir === "right") {
        setSeatDirectionOffsets((prev) => ({ ...prev, [dir]: { x: nextX, y: nextY } }));
      } else {
        setSeatOffsetX(nextX);
        setSeatOffsetY(nextY);
      }
    }
    function onUp(ev: PointerEvent) {
      target.releasePointerCapture(ev.pointerId);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
    }
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
  }

  // --- arrastar o TILE de "Sobrepor" (altura da superfície, ver
  // stackSurfaceOffsetY/stackable acima) -- pedido do Douglas: "voce
  // errou a ordem... entao o que eu quero? uma nova camada de tiles no
  // editor, que é ativada na opcao de sobrepor... eu vou subindo a
  // altura do tile ate chegar na superficie dela". Antes era um campo
  // numérico cru ("Altura da superfície (px)") -- sem preview nenhum,
  // só chute. Agora, igual offsetX/Y (handleItemPointerDown acima) e o
  // assento (handleSeatMarkerPointerDown acima): arrasta o PRÓPRIO tile
  // no preview até ele bater visualmente com o topo da mesa, MESMA
  // conta de dy/PREVIEW_SCALE das outras duas, sem separar por direção
  // (stackSurfaceOffsetY é UM valor só, não muda com a direção -- a
  // "altura da superfície" de uma mesa é a mesma não importa pra que
  // lado ela olha).
  function handleStackSurfacePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const startClientY = e.clientY;
    const startY = stackSurfaceOffsetY;

    function onMove(ev: PointerEvent) {
      const dy = (ev.clientY - startClientY) / PREVIEW_SCALE;
      setStackSurfaceOffsetY(clamp(Math.round(startY + dy), -OFFSET_LIMIT, OFFSET_LIMIT));
    }
    function onUp(ev: PointerEvent) {
      target.releasePointerCapture(ev.pointerId);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
    }
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!label.trim()) {
      setError("Dá um nome pro item.");
      return;
    }
    if (!editingId && !files.down) {
      setError("A imagem de frente é obrigatória.");
      return;
    }
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setSubmitting(true);
    // ACHADO (Douglas: "alguns itens que eu criei antes não aparecem
    // aqui" -> conferido direto no banco, só existiam 2 linhas de
    // verdade em room_items -> "apareceu várias" no storage.objects) --
    // esse handleSubmit sobe TODAS as imagens pro Storage primeiro (loop
    // abaixo) e só DEPOIS manda o POST/PATCH que grava a linha de
    // verdade. Se esse POST falhar por qualquer motivo (sessão expirou
    // no meio do upload, erro de rede, 500 do servidor) DEPOIS que as
    // imagens já subiram, sobra lixo órfão no bucket pra sempre -- é
    // exatamente isso que apareceu na consulta. uploadedPaths guarda
    // cada caminho conforme sobe, pra poder DESFAZER (apagar de volta)
    // no catch abaixo se o cadastro final não completar -- assim uma
    // falha no meio do caminho não deixa mais rastro nenhum no Storage,
    // só o erro visível na tela (ver items-panel-error mais abaixo).
    const uploadedPaths: string[] = [];
    try {
      const slug = slugify(label);
      // teto de resolução com folga (ver UPLOAD_SUPERSAMPLE acima) -- a
      // partir do tamanho de exibição ESCOLHIDO no preview
      // (displayWidth), não do alvo genérico da categoria: as direções
      // usam o mesmo teto (a peça tem proporções parecidas de qualquer
      // ângulo).
      const maxUploadWidth = displayWidth * UPLOAD_SUPERSAMPLE;
      const art: Record<string, string> = {};
      // achado corrigindo "quina de cima/quina de baixo": esse loop
      // sempre rodou em cima de DIRECTION_FIELDS fixo (só os 4 de
      // sempre), mesmo em modo parede -- então as 2 quinas NOVAS
      // (cornerTop/cornerBottom, só existem em WALL_DIRECTION_FIELDS)
      // nunca eram sequer OLHADAS aqui, o arquivo escolhido na aba delas
      // ia pro upload e sumia (nunca subia, nunca entrava no `art`
      // mandado pro servidor). Mesma condição usada em todo canto que já
      // decide entre as duas listas (DIRECTION_FIELDS.find/WALL_DIRECTION_FIELDS.find
      // logo abaixo, no JSX).
      for (const field of mode === "parede" ? WALL_DIRECTION_FIELDS : DIRECTION_FIELDS) {
        const rawFile = files[field.key];
        if (!rawFile) continue; // editando: direção não reenviada mantém a URL antiga (merge no servidor)
        const file = await resizeImageForUpload(rawFile, maxUploadWidth);
        const ext = file.name.split(".").pop() || "png";
        const path = `${category}/${slug}-${Date.now()}-${field.key}.${ext}`;
        const { error: uploadError } = await supabase.storage.from("room-items").upload(path, file, {
          upsert: false,
          contentType: file.type || "image/png",
        });
        if (uploadError) throw uploadError;
        uploadedPaths.push(path);
        const { data: publicUrlData } = supabase.storage.from("room-items").getPublicUrl(path);
        art[field.key] = publicUrlData.publicUrl;
      }

      // ícone próprio (opcional) -- mesmo esquema de upload das
      // direções, teto bem menor (ver ICON_BUTTON_SIZE acima, o botão do
      // catálogo é pequeno).
      let iconUrl: string | null | undefined;
      if (iconFile) {
        const resized = await resizeImageForUpload(iconFile, ICON_BUTTON_SIZE * UPLOAD_SUPERSAMPLE);
        const ext = resized.name.split(".").pop() || "png";
        const path = `${category}/${slug}-${Date.now()}-icon.${ext}`;
        const { error: uploadError } = await supabase.storage.from("room-items").upload(path, resized, {
          upsert: false,
          contentType: resized.type || "image/png",
        });
        if (uploadError) throw uploadError;
        uploadedPaths.push(path);
        const { data: publicUrlData } = supabase.storage.from("room-items").getPublicUrl(path);
        iconUrl = publicUrlData.publicUrl;
      } else if (iconCleared) {
        iconUrl = null;
      }
      // undefined = não mexeu no ícone -- só entra no corpo da
      // requisição quando tem valor de verdade (novo upload) ou null
      // explícito (removeu), pra não pisar num ícone que já existia sem
      // querer num PATCH que nem tocou nesse campo.

      const payload: Record<string, unknown> = {
        label: label.trim(),
        category,
        art,
        display_width: displayWidth,
        // footprint (pedido do Douglas: "tenho mobis que ocupam mais
        // tiles doq um ou dois, entao preciso selecionar pra que nao se
        // suba em um item") -- ver clampFootprintSize em
        // lib/supabase/itemFields.ts e a migration
        // 0013_room_items_footprint.sql.
        footprint_cols: footprintCols,
        footprint_rows: footprintRows,
        // footprint DESENHADO À MÃO, por direção (pedido do Douglas:
        // "quero selecionar os tiles que ele ocupa, CLICANDO... pra CADA
        // POSICAO") -- ver cleanFootprintByDirection em lib/supabase/
        // itemFields.ts e a migration
        // 0023_room_items_footprint_by_direction.sql. Vazio (nenhuma
        // direção customizada) manda null de propósito, mesma regra de
        // direction_offsets logo abaixo -- limpa qualquer customização
        // antiga em vez de deixar lixo pra trás.
        footprint_by_direction: Object.keys(footprintByDirection).length > 0 ? footprintByDirection : null,
        // "Sobrepor" (ver comentário grande no useState de
        // stackable/stackSurfaceOffsetY mais acima) -- pedido do
        // Douglas: notebook em cima da mesa.
        stackable,
        stack_surface_offset_y: stackSurfaceOffsetY,
        offset_x: offsetX,
        offset_y: offsetY,
        // ajuste por direção + interação/assento (pedido do Douglas:
        // "editar todos os lados do mobi" e "editar também a posição
        // sentado lá dentro, com uma seleção, se vai ter interação") --
        // ver cleanDirectionOffsets/clampSeatOffset em
        // lib/supabase/itemFields.ts. directionOffsets vazio (sem
        // nenhuma direção ajustada) manda null de propósito, limpando
        // qualquer override antigo ao invés de deixar lixo pra trás.
        direction_offsets: Object.keys(directionOffsets).length > 0 ? directionOffsets : null,
        // tamanho por direção (pedido do Douglas: "se eu mudar de um ele
        // muda de todas as vistas? nao tem como isolar?") -- mesma regra
        // de direction_offsets logo acima, ver cleanDirectionDisplayWidth
        // em lib/supabase/itemFields.ts.
        direction_display_width: Object.keys(directionDisplayWidth).length > 0 ? directionDisplayWidth : null,
        sittable,
        seat_offset_x: sittable ? seatOffsetX : null,
        seat_offset_y: sittable ? seatOffsetY : null,
        // ajuste do assento por direção (ver activeSeatOffset/
        // handleSeatMarkerPointerDown acima e a migration
        // 0011_room_items_seat_direction_offsets.sql) -- mesma regra de
        // direction_offsets: vazio manda null de propósito.
        seat_direction_offsets: sittable && Object.keys(seatDirectionOffsets).length > 0 ? seatDirectionOffsets : null,
        // assentos EXTRA (pedido do Douglas: "configurar dois avatares
        // no caso em que tenha mais de um assento") -- ver
        // cleanExtraSeats em lib/supabase/itemFields.ts e a migration
        // 0014_room_items_extra_seats.sql. NÃO depende de `sittable`
        // (a âncora pode não sentar e o item ainda ter assentos extras,
        // ex: um sofá em que só as almofadas sentam, não o braço).
        extra_seats: extraSeats,
      };
      if (iconUrl !== undefined) payload.icon_url = iconUrl;

      const res = await fetch(editingId ? `/api/items/${editingId}` : "/api/items", {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "erro ao salvar item");

      // ACHADO (Douglas: "eu fui editar ela pra posicionar o carinha
      // melhor e ficou assim -- no editor ta certo no mapa real nao
      // ficou"): resolveSeatOffset (game/furniture.ts) dá prioridade a
      // um ajuste "Assento" já salvo POR MODELO no editor de espaço
      // (roomStore.furnitureSeatOffsets, GET/POST /room/furniture) por
      // cima do seat_offset_x/y padrão do MODELO que a gente acabou de
      // salvar aqui -- editar o padrão aqui não muda nada na sala se já
      // existir esse ajuste mais específico, o boneco continua sentando
      // na posição VELHA, presa. Avisa o GameRoom (editingId = o mesmo
      // id usado como seatOffsetGroupKey pro modelo, ver seatOffsetGroupKey
      // em furniture.ts) pra limpar esse ajuste travado quando a peça é
      // sentável -- assim o valor que acabou de ser salvo aqui passa a
      // valer na hora, sem precisar abrir o editor de espaço e mexer no
      // "Assento" de novo só pra "destravar". Só faz sentido num item
      // JÁ existente (editingId) -- um item novo nunca teve ajuste de
      // Assento salvo, não tem nada pra limpar.
      const seatModelIdToClear = sittable && editingId ? editingId : undefined;

      resetForm();
      await loadItems();
      onItemsChanged(seatModelIdToClear);
    } catch (err) {
      // desfaz upload(s) órfão(s) (ver comentário grande no início desse
      // handleSubmit) -- melhor esforço, uma falha aqui não pode
      // esconder o erro ORIGINAL que já vai aparecer pro Douglas embaixo
      // do formulário (items-panel-error).
      if (uploadedPaths.length > 0) {
        await supabase.storage.from("room-items").remove(uploadedPaths).catch(() => null);
      }
      setError(err instanceof Error ? err.message : "erro ao salvar item");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/items/${id}`, { method: "DELETE", headers: authHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "erro ao apagar item");
      if (editingId === id) resetForm();
      await loadItems();
      onItemsChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "erro ao apagar item");
    } finally {
      setBusyId(null);
    }
  }

  // separa a listagem "Itens cadastrados" por aba (ver comentário do
  // mode acima) -- null enquanto ainda tá carregando (mesmo estado que
  // items), senão o array já filtrado: parede só mostra category
  // "divisoria", mobi mostra o resto (nunca mistura os dois na mesma
  // lista, já que agora são fluxos de cadastro separados).
  const visibleItems = items?.filter((it) => (mode === "parede" ? it.category === "divisoria" : it.category !== "divisoria")) ?? null;

  return (
    <div className="items-panel-backdrop" onClick={onClose}>
      <div className="items-panel items-panel-editor" onClick={(e) => e.stopPropagation()}>
        <div className="items-panel-header">
          <h2>
            {mode === "avatar"
              ? "Editor de itens"
              : mode === "piso"
                ? floorEditingId
                  ? "Editar piso"
                  : "Editor de itens"
                : editingId
                  ? "Editar item"
                  : "Editor de itens"}
          </h2>
          <button type="button" className="items-panel-close" onClick={onClose} title="Fechar">
            ✕
          </button>
        </div>

        <div className="edit-section-tabs">
          <button
            type="button"
            className={mode === "mobi" ? "edit-section-tab selected" : "edit-section-tab"}
            onClick={() => setMode("mobi")}
          >
            Criar Mobi
          </button>
          <button
            type="button"
            className={mode === "parede" ? "edit-section-tab selected" : "edit-section-tab"}
            onClick={() => {
              setMode("parede");
              handleCategoryChange("divisoria");
              // parede só tem "Frente esquerda"/"Frente direita" (ver
              // comentário grande nos uploads de direção mais abaixo) --
              // sem isso, se a pessoa tivesse acabado de olhar a aba
              // "Costas esquerda"/"Costas direita" de um mobi comum antes
              // de clicar aqui, nenhuma aba ficava marcada como
              // selecionada (nenhuma das 2 visíveis bate com o valor
              // antigo).
              setActiveMobiDirection("down");
            }}
          >
            {/* rebatizado de "Criar Parede" -- esse modo cadastra o vidro
                divisório antigo (item de móvel comum, 1 tile), agora que
                "Parede" virou o nome da aba NOVA logo abaixo (a parede de
                sistema de verdade, ver game/wall.ts) */}
            Criar Divisória
          </button>
          <button
            type="button"
            className={mode === "parede-sistema" ? "edit-section-tab selected" : "edit-section-tab"}
            onClick={() => setMode("parede-sistema")}
          >
            Criar Parede
          </button>
          <button
            type="button"
            className={mode === "piso" ? "edit-section-tab selected" : "edit-section-tab"}
            onClick={() => setMode("piso")}
          >
            Criar Piso
          </button>
          <button
            type="button"
            className={mode === "porta" ? "edit-section-tab selected" : "edit-section-tab"}
            onClick={() => setMode("porta")}
          >
            Criar Porta
          </button>
          <button
            type="button"
            className={mode === "avatar" ? "edit-section-tab selected" : "edit-section-tab"}
            onClick={() => setMode("avatar")}
          >
            Criar Avatar
          </button>
        </div>

        {mode === "avatar" && <AvatarCreatorPanel accessToken={accessToken} onChanged={onItemsChanged} />}

        {mode === "parede-sistema" && (
          <WallPatternCreatorPanel accessToken={accessToken} onChanged={onItemsChanged} />
        )}

        {mode === "porta" && <DoorCreatorPanel accessToken={accessToken} onChanged={onItemsChanged} />}

        {mode === "piso" && (
          <>
            <form className="items-panel-form" onSubmit={handleFloorSubmit}>
              <input
                className="items-panel-input"
                type="text"
                placeholder="Nome do piso"
                value={floorLabel}
                maxLength={40}
                onChange={(e) => setFloorLabel(e.target.value)}
              />
              <select
                className="items-panel-input"
                value={floorCategory}
                onChange={(e) => setFloorCategory(e.target.value as FloorCategory)}
              >
                {FLOOR_CATEGORIES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>

              {/* pedido do Douglas: "criamos ali dentro uma forma de
                  preenchimento de linhas... pra que nao precise ser
                  imagem mesmo, faz sentido? ficaria mais leve?" -- só dá
                  pra escolher "Imagem" ou "Padrão" ao CADASTRAR um piso
                  novo (não no meio de uma edição, pra não misturar os
                  dois formulários à toa -- pra trocar o tipo de um piso
                  já existente, apaga e cadastra de novo). */}
              {!floorEditingId && (
                <div className="items-panel-submit-row">
                  <button
                    type="button"
                    className={floorKind === "image" ? "edit-section-tab selected" : "edit-section-tab"}
                    onClick={() => setFloorKind("image")}
                  >
                    Imagem
                  </button>
                  <button
                    type="button"
                    className={floorKind === "pattern" ? "edit-section-tab selected" : "edit-section-tab"}
                    onClick={() => setFloorKind("pattern")}
                  >
                    Padrão (sem imagem)
                  </button>
                </div>
              )}

              {floorKind === "image" ? (
                <>
                  <p className="settings-hint">
                    Uma imagem PLANA só (sem direção) -- o jogo desenha ela deitada, do tamanho exato do quadrado da grade.
                    {floorEditingId ? " Só reenvie a imagem se quiser TROCAR -- senão continua com a de antes." : ""}
                  </p>

                  <label className="items-panel-upload-field">
                    <span>Imagem{!floorEditingId ? " *" : ""}</span>
                    {(floorPreviewUrl || floorExistingFileUrl) && (
                      <img
                        className="items-panel-upload-existing"
                        src={floorPreviewUrl ?? floorExistingFileUrl ?? undefined}
                        alt="Piso atual"
                      />
                    )}
                    <input
                      ref={floorFileInputRef}
                      type="file"
                      accept="image/png,image/webp,image/jpeg"
                      onChange={(e) => handleFloorFileChange(e.target.files?.[0])}
                    />
                  </label>
                </>
              ) : (
                <>
                  <p className="settings-hint">
                    Sem imagem nenhuma -- o jogo desenha ripas/tábuas alternando as cores abaixo, do tamanho de largura que
                    você escolher. Mais leve (não baixa arquivo nenhum) e encaixam perfeitinho de um tile pro vizinho,
                    parece um piso corrido de verdade.
                  </p>

                  {/* categoria "Porcelanato" é travada no tamanho exato
                      do tile, sem campo de dimensão editável -- pedido
                      do Douglas depois de um print com a linha de junta
                      saindo no meio do losango em vez de bater na borda:
                      "o porcelanato nao ta com a linha na divisa do
                      tile, quero travar isso, entao no porcelanato nao
                      me deixe colocar dimensao, ele e do tamanho do
                      tile e pronto, e tambem ja vem com linha" (ver
                      useEffect que trava floorPlankWidth/
                      floorPlankLength/floorTileAligned mais acima). Pra
                      laminado/natural a largura/comprimento continuam
                      livres (é o efeito de ripa/tábua, que não é do
                      tamanho do tile por natureza). */}
                  {floorCategory === "porcelanato" ? (
                    <p className="settings-hint">
                      Porcelanato é sempre do tamanho exato do tile, com linha de junta batendo certinho na borda do
                      losango -- sem precisar configurar dimensão.
                    </p>
                  ) : (
                    <>
                      {/* step=0.01 nos 2 campos abaixo -- sem isso, o
                          <input type="number"> assume passo inteiro (1) e
                          rejeita ("insira um valor válido") os números
                          quebrados que "Travar tábuas na grade do tile"
                          calcula (ex: 8,94), já que TILE_SIZED_PLANK_PX
                          raramente divide num inteiro exato. Bug relatado
                          pelo Douglas com print do aviso do navegador
                          bloqueando o campo. */}
                      <label className="items-panel-upload-field">
                        <span>Largura da ripa (px)</span>
                        <input
                          className="items-panel-input"
                          type="number"
                          min={4}
                          max={200}
                          step={0.01}
                          value={floorPlankWidth}
                          onChange={(e) => setFloorPlankWidth(Number(e.target.value))}
                        />
                      </label>

                      {/* comprimento OPCIONAL -- em branco = ripa contínua
                          (comportamento de sempre); preenchido = tábuas
                          EMENDADAS com linha de junta (ver comentário grande
                          do state floorPlankLength acima e
                          FloorPatternConfig.plankLengthPx em game/floor.ts). */}
                      <label className="items-panel-upload-field">
                        <span>Comprimento da tábua (px) -- opcional</span>
                        <input
                          className="items-panel-input"
                          type="number"
                          min={4}
                          max={400}
                          step={0.01}
                          placeholder="Em branco = ripa contínua, sem emenda"
                          value={floorPlankLength}
                          onChange={(e) => setFloorPlankLength(e.target.value)}
                        />
                      </label>
                      {/* atalho pra deixar a ripa/tábua do tamanho do
                          tile mesmo fora da categoria porcelanato (ver
                          TILE_SIZED_PLANK_PX em game/floor.ts), sem
                          precisar calcular 32*sqrt(5) à mão. Marca
                          também "emenda alinhada à grade" junto (senão
                          colunas ímpares saem desalinhadas da borda do
                          tile, ver FloorPatternConfig.tileAligned). */}
                      <button
                        type="button"
                        className="clear-btn"
                        onClick={() => {
                          const size = Math.round(TILE_SIZED_PLANK_PX * 100) / 100;
                          setFloorPlankWidth(size);
                          setFloorPlankLength(String(size));
                          setFloorTileAligned(true);
                        }}
                      >
                        Placa do tamanho do tile
                      </button>
                      {/* pedido do Douglas: "nao tem como travar as
                          divisões encima do limite do tile? fica
                          cortado assim, tentei fazer um deck" -- ao
                          contrário do botão acima (1 tábua = 1 tile
                          inteiro), este AJUSTA a largura/comprimento
                          que ele já digitou pro divisor exato mais
                          próximo de TILE_SIZED_PLANK_PX, pra várias
                          tábuas normais por tile ainda assim baterem
                          certinho na borda do losango (ver
                          snapPlankSizeToTileDivisor acima). Liga
                          "emenda alinhada à grade" junto -- senão o
                          desalinhamento entre colunas ("amarração")
                          quebraria o encaixe que acabou de travar. */}
                      <button
                        type="button"
                        className="clear-btn"
                        onClick={() => {
                          setFloorPlankWidth((w) => snapPlankSizeToTileDivisor(w));
                          if (floorPlankLength.trim() !== "") {
                            setFloorPlankLength((len) => String(snapPlankSizeToTileDivisor(Number(len))));
                          }
                          setFloorTileAligned(true);
                        }}
                      >
                        Travar tábuas na grade do tile
                      </button>
                      <p className="settings-hint">
                        Ajusta a largura/comprimento que você digitou pro valor mais próximo que encaixa um número
                        inteiro de tábuas dentro do tile -- assim a junta sempre bate na borda do losango, sem cortar
                        tábua no meio.
                      </p>
                    </>
                  )}
                  {floorPlankLength.trim() !== "" && (
                    <>
                      <div className="items-panel-upload-field">
                        <span>Cor da linha de junta</span>
                        <ColorPickerField value={floorLineColor} onChange={setFloorLineColor} />
                      </div>
                      {/* efeito "laminado" -- pedido do Douglas: "agora
                          eu quero esse efeito laminado... de veios de
                          madeira", depois "no sentido das linhas
                          também" (ver FloorPatternConfig.woodGrain em
                          game/floor.ts). Só aparece com tábua emendada
                          (precisa de comprimento definido pra ter onde
                          conter o veio). */}
                      <label className="settings-hint settings-hint-check">
                        <input type="checkbox" checked={floorWoodGrain} onChange={(e) => setFloorWoodGrain(e.target.checked)} />
                        Efeito laminado (veios de madeira)
                      </label>
                      {/* efeito "marmorado" -- pedido do Douglas, foto de
                          referência de porcelanato marmorado: "agora eu
                          quero um, porcelanato, que vai ser do tamanho
                          do tile, com linha divisoria, e com efeito de
                          porcelanato marmorado, assim" (ver
                          FloorPatternConfig.marble em game/floor.ts). */}
                      <label className="settings-hint settings-hint-check">
                        <input type="checkbox" checked={floorMarble} onChange={(e) => setFloorMarble(e.target.checked)} />
                        Efeito marmorado (veios de mármore)
                      </label>
                      {/* emenda alinhada à grade -- pra porcelanato fica
                          travada em true (ver useEffect mais acima), sem
                          checkbox pra não dar pra destravar sem querer;
                          o botão "Placa do tamanho do tile" acima já
                          marca isso sozinho, mas fica editável aqui pra
                          quem quiser um tamanho de placa diferente do
                          tile inteiro e ainda assim sem desalinhamento
                          entre colunas (ver FloorPatternConfig.tileAligned). */}
                      {floorCategory !== "porcelanato" && (
                        <label className="settings-hint settings-hint-check">
                          <input
                            type="checkbox"
                            checked={floorTileAligned}
                            onChange={(e) => setFloorTileAligned(e.target.checked)}
                          />
                          Emenda alinhada à grade (sem amarração/intercalado)
                        </label>
                      )}
                    </>
                  )}

                  {/* lista de cores -- 2 (o de sempre, alternadas) ou
                      mais (efeito "tábua mesclada", cada tábua sorteia
                      uma cor da lista, ver pickPlankColor em
                      MainScene.ts). Correção do Douglas: "eu nao defini
                      as cores, so mandei exemplo, quero criar eles el
                      criar piso" -- agora ele escolhe cada cor aqui. */}
                  <p className="settings-hint">Cores (mínimo 2, máximo 6) -- com mais de 2, cada tábua sorteia uma dessas cores.</p>
                  <div className="items-panel-submit-row">
                    {floorColors.map((color, i) => (
                      <div key={i} className="items-panel-upload-field">
                        <span>
                          Cor {i + 1}
                          {floorColors.length > 2 && (
                            <button type="button" className="clear-btn" onClick={() => removeFloorColor(i)} title="Remover cor">
                              ✕
                            </button>
                          )}
                        </span>
                        <ColorPickerField value={color} onChange={(hex) => updateFloorColor(i, hex)} />
                      </div>
                    ))}
                  </div>
                  {floorColors.length < 6 && (
                    <button type="button" className="clear-btn" onClick={addFloorColor}>
                      + Adicionar cor
                    </button>
                  )}

                  {/* pedido do Douglas: "da pra poe essa exibicao no
                      formato do tile?" -- preview no formato de LOSANGO
                      (2:1, igual ISO_TILE_WIDTH/ISO_TILE_HEIGHT), não
                      mais uma barra retangular -- mostra como o padrão
                      fica de verdade encaixado num quadrado da grade,
                      antes de cadastrar. Mesmo clip-path de .floor-swatch
                      em globals.css (o botão que ele clica pra ESCOLHER
                      o piso na paleta da sala), só que centralizado e
                      maior aqui, por ser o preview em destaque do
                      formulário, não um botão pequeno numa grade.
                      <FloorPatternSwatch> desenha os MESMOS polígonos
                      do jogo de verdade (ver floorPatternPolygons em
                      game/floor.ts) -- é o MESMO componente usado no
                      losango da paleta da sala (GameRoom.tsx) -- os dois
                      lugares sempre mostram a mesma coisa. */}
                  <div className="floor-pattern-preview-wrap">
                    <div className="floor-pattern-preview-tile">
                      <FloorPatternSwatch
                        pattern={{
                          plankWidthPx: floorPlankWidth,
                          colorA: parseHexColor(floorColors[0]),
                          colorB: parseHexColor(floorColors[1] ?? floorColors[0]),
                          plankLengthPx: floorPlankLength.trim() !== "" ? Number(floorPlankLength) : undefined,
                          lineColor: floorPlankLength.trim() !== "" ? parseHexColor(floorLineColor) : undefined,
                          colors: floorColors.length > 2 ? floorColors.map(parseHexColor) : undefined,
                          woodGrain: floorPlankLength.trim() !== "" ? floorWoodGrain : undefined,
                          marble: floorPlankLength.trim() !== "" ? floorMarble : undefined,
                          tileAligned: floorPlankLength.trim() !== "" ? floorTileAligned : undefined,
                        }}
                      />
                    </div>
                  </div>
                </>
              )}

              {floorError && <p className="items-panel-error">{floorError}</p>}

              <div className="items-panel-submit-row">
                <button type="submit" className="items-panel-submit" disabled={floorSubmitting}>
                  {floorSubmitting ? "Enviando..." : floorEditingId ? "Salvar alterações" : "Cadastrar piso"}
                </button>
                {floorEditingId && (
                  <button type="button" className="clear-btn" onClick={resetFloorForm} disabled={floorSubmitting}>
                    Cancelar edição
                  </button>
                )}
              </div>
            </form>

            <section className="items-panel-section">
              <h3>Pisos cadastrados ({floorItems?.length ?? 0})</h3>
              {!floorItems ? (
                <p className="items-panel-loading">Carregando...</p>
              ) : floorItems.length === 0 ? (
                <p className="items-panel-loading">Nenhum piso custom ainda.</p>
              ) : (
                <ul className="items-panel-list">
                  {floorItems.map((item) => (
                    <li key={item.id} className="items-panel-row-wrap">
                      <div className="items-panel-row">
                        {item.kind === "pattern" && item.color_a && item.color_b ? (
                          <div className="items-panel-thumb">
                            <FloorPatternSwatch
                              pattern={{
                                plankWidthPx: item.plank_width_px ?? 24,
                                colorA: parseHexColor(item.color_a),
                                colorB: parseHexColor(item.color_b),
                                plankLengthPx: item.plank_length_px ?? undefined,
                                lineColor: item.line_color ? parseHexColor(item.line_color) : undefined,
                                colors: item.colors && item.colors.length > 0 ? item.colors.map(parseHexColor) : undefined,
                                woodGrain: item.wood_grain ?? undefined,
                                marble: item.marble ?? undefined,
                                tileAligned: item.tile_aligned ?? undefined,
                              }}
                            />
                          </div>
                        ) : (
                          <img className="items-panel-thumb" src={item.file_url ?? undefined} alt={item.label} />
                        )}
                        <span className="items-panel-name">
                          {item.label}{" "}
                          <span className="items-panel-category">
                            ({FLOOR_CATEGORIES.find((c) => c.id === item.category)?.label ?? item.category})
                          </span>
                        </span>
                        <button type="button" disabled={floorBusyId === item.id} onClick={() => startEditFloorItem(item)}>
                          Editar
                        </button>
                        <button type="button" disabled={floorBusyId === item.id} onClick={() => handleFloorDelete(item.id)}>
                          Excluir
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}

        {(mode === "mobi" || mode === "parede") && (
        <>
        <form className="items-panel-form" onSubmit={handleSubmit}>
          <input
            className="items-panel-input"
            type="text"
            placeholder={mode === "parede" ? "Nome da parede" : "Nome do item"}
            value={label}
            maxLength={40}
            onChange={(e) => setLabel(e.target.value)}
          />
          {mode === "parede" ? (
            <p className="settings-hint">
              Categoria: Parede -- usa o mesmo tipo "Divisória" que já aparece assim na barra lateral da sala, só que numa aba própria pra não precisar catar no meio do dropdown de móvel.
            </p>
          ) : (
            <select className="items-panel-input" value={category} onChange={(e) => handleCategoryChange(e.target.value as CategoryId)}>
              {CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          )}

          <p className="settings-hint">
            Pode subir a imagem na qualidade original (do ChatGPT/Canva, sem redimensionar à mão) -- ajuste o tamanho de exibição no preview abaixo, o jogo encolhe sozinho pro tamanho certo.
            {editingId ? " Só reenvie a foto da direção que quiser TROCAR -- as outras continuam com a arte já salva." : ""}
          </p>

          <div className="items-panel-uploads">
            {/* parede usa WALL_DIRECTION_FIELDS -- os 4 slots de sempre
                (down/right retos, left/up relabelados "Quina esquerda/
                direita") + 2 EXTRAS (cornerTop/cornerBottom, "Quina de
                cima/baixo", pedido do Douglas) -- ver comentário grande
                onde WALL_DIRECTION_FIELDS é definida, perto de
                DIRECTION_FIELDS. */}
            {(mode === "parede" ? WALL_DIRECTION_FIELDS : DIRECTION_FIELDS).map((field) => {
              const existingSrc = existingArt[field.key];
              return (
                <label key={field.key} className="items-panel-upload-field">
                  <span>
                    {field.label}
                    {field.required && !editingId ? " *" : ""}
                  </span>
                  {existingSrc && (
                    <img className="items-panel-upload-existing" src={existingSrc} alt={`${field.label} atual`} />
                  )}
                  <input
                    ref={(el) => {
                      fileInputRefs.current[field.key] = el;
                    }}
                    type="file"
                    accept="image/png,image/webp,image/jpeg"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      // recorte OPCIONAL (ver ImageCropModal acima) --
                      // "Usar sem cortar" faz exatamente o que esse
                      // onChange fazia antes de existir.
                      setPendingCrop({
                        file,
                        inputKey: field.key,
                        apply: (result) => {
                          if (field.key === "down") handleDownFileChange(result);
                          else setFiles((prev) => ({ ...prev, [field.key]: result }));
                          // pula o preview pra direção que acabou de
                          // receber arquivo -- assim dá pra ajustar a
                          // posição dela na hora, sem precisar clicar na
                          // aba manualmente.
                          setActiveMobiDirection(field.key);
                        },
                      });
                    }}
                  />
                </label>
              );
            })}
          </div>

          {/* Ícone próprio do catálogo (pedido do Douglas: "escolher o
              favicon que aparece no catálogo") -- opcional, separado das
              4 fotos de direção acima. Sem ele, o botão da grade do
              catálogo usa a foto de frente (ver catalogEntryIconFile em
              GameRoom.tsx). */}
          <label className="items-panel-upload-field">
            <span>Ícone do catálogo (opcional)</span>
            {stageIconSrc && <img className="items-panel-upload-existing" src={stageIconSrc} alt="Ícone atual" />}
            <input
              ref={iconInputRef}
              type="file"
              accept="image/png,image/webp,image/jpeg"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setPendingCrop({ file, inputKey: "__icon__", apply: (result) => handleIconFileChange(result) });
              }}
            />
          </label>
          {stageIconSrc && (
            <button type="button" className="clear-btn" onClick={removeIcon}>
              Remover ícone (usar a foto de frente)
            </button>
          )}

          {/* "Tem interação?" (pedido do Douglas: "editar também a
              posição sentado lá dentro, com uma seleção, se vai ter
              interação, e qual interação 'por enquanto só temos
              sentar'") -- decidido AQUI, não mais preso à categoria
              (poltrona/sofá): DEFAULT_SITTABLE_BY_CATEGORY só decide o
              valor inicial ao trocar de categoria/criar um item novo,
              o dono pode sempre ligar/desligar (ver
              isFurnitureSittable em game/furniture.ts). */}
          <p className="settings-hint">Tem interação? (o que acontece quando alguém clica no item na sala)</p>
          <div className="gender-switch">
            <button
              type="button"
              className={!sittable ? "gender-btn selected" : "gender-btn"}
              onClick={() => setSittable(false)}
            >
              Nenhuma
            </button>
            <button
              type="button"
              className={sittable ? "gender-btn selected" : "gender-btn"}
              onClick={() => setSittable(true)}
            >
              Sentar
            </button>
          </div>

          {/* Preview grande (pedido do Douglas: "preciso disso num card
              maior, com a imagem maior", "quero boneco real ali dentro
              em perspectiva certa, e o quadrado também", "delimitar ali
              no editor a posição do mobi no tile", depois "editar todos
              os lados do mobi") -- mostra o item de verdade em cima de
              um QUADRADO do tamanho real do tile e um BONECO de
              referência (arte de verdade do jogo, não mais uma
              silhueta em CSS), na MESMA proporção/âncora do jogo (ver
              AVATAR_FOOT_FROM_TILE_BOTTOM acima -- boneco ancora no
              CENTRO do tile, móvel ancora na BORDA DE BAIXO, por isso
              não ficam na mesma "linha"). As abas de direção abaixo
              trocam qual foto tá sendo ajustada (o boneco muda de
              POSE junto) -- arrasta o item (clicar e arrastar em cima
              dele) pra ajustar a posição DAQUELA direção; "baixo" usa
              offsetX/offsetY direto, as outras 3 caem num override
              próprio (directionOffsets) só quando ajustadas -- sem
              ajuste, reaproveitam a mesma posição de "baixo" (mesmo
              fallback que addFurnitureSprite usa no jogo). */}
          <div className="edit-section-tabs">
            {/* mesmos rótulos de parede das abas de upload acima (ver
                WALL_DIRECTION_FIELDS). */}
            {(mode === "parede" ? WALL_DIRECTION_FIELDS : DIRECTION_FIELDS).map((field) => (
              <button
                key={field.key}
                type="button"
                className={activeMobiDirection === field.key ? "edit-section-tab selected" : "edit-section-tab"}
                onClick={() => setActiveMobiDirection(field.key)}
              >
                {field.label}
              </button>
            ))}
          </div>

          {/* zoom do preview -- ver comentário em AvatarCreatorPanel. */}
          <div className="settings-slider-row">
            <span className="settings-slider-name">Zoom do preview</span>
            <input
              type="range"
              min={0.75}
              max={3}
              step={0.25}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
            />
            <span className="settings-slider-value">{Math.round(zoom * 100)}%</span>
          </div>

          <div className="item-size-card">
            <div className="item-stage" style={{ height: mobiStageHeight, zoom }}>
              <div
                className="item-stage-avatar"
                style={{
                  bottom: mobiStageBaseline + AVATAR_FOOT_FROM_TILE_BOTTOM,
                  width: AVATAR_DISPLAY_W,
                  height: AVATAR_DISPLAY_H,
                }}
                title="Boneco de referência (penteado/traje padrão) -- o TAMANHO/ÂNCORA é que batem com o jogo de verdade"
              >
                <div
                  className="item-stage-avatar-crop"
                  style={{
                    width: FRAME_W,
                    height: FRAME_H,
                    marginLeft: -FRAME_W / 2,
                    transform: `translate(-${mobiFrameOffsetXPx}px, -${mobiFrameOffsetYPx}px) scale(${AVATAR_SCALE * PREVIEW_SCALE})`,
                  }}
                >
                  {/* avatarAssetUrl (não só `/assets/${file}` cru) --
                      item de cabelo/pele/traje CUSTOM (subido pelo
                      Douglas) tem `.file` com a URL COMPLETA do Supabase
                      Storage, não um nome de arquivo local -- prefixar
                      "/assets/" na frente dessa URL gera um caminho
                      quebrado (`/assets/https://...png`, 404, ver
                      DIRECTION_FIELDS acima e o comentário grande antes
                      de referenceHair/referenceSkin/referenceOutfit mais
                      acima nesse arquivo). Passou despercebido enquanto
                      REFERENCE_OUTFIT só apontava pro traje padrão
                      (arquivo local, sem "http"), e só apareceu quando o
                      fallback passou a preferir o traje custom mais
                      recente. */}
                  {referenceOutfitFile && (
                    <img className="item-stage-avatar-layer" src={avatarAssetUrl(referenceOutfitFile)} alt="" />
                  )}
                  {referenceSkin && <img className="item-stage-avatar-layer" src={avatarAssetUrl(referenceSkin.file)} alt="" />}
                  {referenceHair && <img className="item-stage-avatar-layer" src={avatarAssetUrl(referenceHair.file)} alt="" />}
                </div>
              </div>

              {/* boneco SENTADO arrastável (só quando "Sentar" tá
                  ligado acima) -- arrasta o próprio boneco (já na pose
                  sentado da direção ATIVA, aba de cima) pra ajustar o
                  assento daquela direção (down/up em seatOffsetX/Y,
                  left/right em seatDirectionOffsets -- ver
                  activeSeatOffset/handleSeatMarkerPointerDown e o
                  comentário grande em
                  FurnitureModelDef.seatDirectionOffsets,
                  game/furniture.ts).
                  ACHADO (Douglas: "nao e essa posicao qie eu salvei" --
                  ao vivo saía diferente do preview mesmo com o número
                  batendo): esse boneco ancorava no MESMO "bottom" do
                  boneco em PÉ (STAGE_BASELINE_PAD +
                  AVATAR_FOOT_FROM_TILE_BOTTOM, ponto que só existe pra
                  reproduzir onde o boneco anda ancorado -- ver
                  comentário dele acima). Só que ao vivo
                  (applySeatVisualPosition, MainScene.ts) o ajuste de
                  assento é somado direto em cima da posição do MÓVEL
                  (furnitureWorldPos, game/furniture.ts -- ancora no
                  VÉRTICE de baixo do tile, não no centro onde o boneco
                  de pé ancora, ver o comentário grande lá), sem passar
                  pela âncora "de pé" nenhuma vez. Faltava esse termo
                  aqui pra bater com o de lá -- por isso o preview
                  sempre mostrava a posição uns pixels mais alta/atrás
                  do que saía na sala de verdade, mesmo com o x/y salvo
                  idêntico. Mesmo referencial de item-stage-item-img
                  logo abaixo (o PRÓPRIO móvel, que já ancora certinho
                  no vértice) -- só deslocado pelo activeSeatOffset.x/y
                  atual (mesma conta que a bolinha antiga fazia).
                  Pedido do Douglas: trocar a bolinha abstrata por um
                  boneco de verdade, bem mais intuitivo de posicionar --
                  e, depois, deixar ajustar por direção (achado: um
                  valor só pras 4 direções sentava torto de lado). */}
              {sittable && (
                <div
                  className="item-stage-seat-avatar"
                  style={{
                    bottom: mobiStageBaseline - activeSeatOffset.y * PREVIEW_SCALE,
                    width: AVATAR_DISPLAY_W,
                    height: AVATAR_DISPLAY_H,
                    transform: `translate(calc(-50% + ${activeSeatOffset.x * PREVIEW_SCALE}px), 0)`,
                  }}
                  onPointerDown={handleSeatMarkerPointerDown}
                  title="Arraste o boneco sentado pra ajustar onde ele senta"
                >
                  <div
                    className="item-stage-avatar-crop"
                    style={{
                      width: FRAME_W,
                      height: FRAME_H,
                      marginLeft: -FRAME_W / 2,
                      transform: `translate(-${seatFrameOffsetXPx}px, -${seatFrameOffsetYPx}px) scale(${AVATAR_SCALE * PREVIEW_SCALE})`,
                    }}
                  >
                    {referenceOutfitFile && (
                      <img className="item-stage-avatar-layer" src={avatarAssetUrl(referenceOutfitFile)} alt="" />
                    )}
                    {referenceSkin && <img className="item-stage-avatar-layer" src={avatarAssetUrl(referenceSkin.file)} alt="" />}
                    {referenceHair && <img className="item-stage-avatar-layer" src={avatarAssetUrl(referenceHair.file)} alt="" />}
                  </div>
                </div>
              )}

              {/* footprint CLICÁVEL, quadrado a quadrado -- pedido do
                  Douglas: "quero os quadrados ali, com essas linhas
                  VISIVEIS... quero selecionar os tiles que ele ocupa,
                  CLICANDO, e preenchendo, do jeito que ta eu nao consigo
                  decidir rumo nem nada! E isso pra CADA POSICAO, pois o
                  movel gira e muda o bloqueio pela perspectiva!!!".
                  footprintCols x footprintRows (Ocupa (tiles), mais
                  abaixo) definem só o TAMANHO da grade que aparece aqui
                  pra clicar -- mobiFootprintTiles (ver acima) traz a
                  lista dCol/dRow de CADA quadrado dessa grade, cada um
                  desloca na MESMA conta isométrica de tileToWorld
                  (game/grid.ts). Clique (ver toggleFootprintTile acima)
                  risca/desmarca um quadrado na direção ATIVA
                  (activeMobiDirection, mesma aba de posição/tamanho por
                  direção) -- verde (.selected) = trava passagem, só
                  contorno = livre; a âncora (0,0, roxa/.anchor) nunca
                  desmarca, trava sempre. Sem clicar em nada ainda numa
                  direção, o retângulo inteiro aparece marcado (mesmo
                  comportamento de sempre, ver isFootprintTileSelected). */}
              {mobiFootprintTiles.map(({ dCol, dRow }) => {
                const isAnchor = dCol === 0 && dRow === 0;
                const selected = isFootprintTileSelected(dCol, dRow);
                return (
                  <div
                    key={`${dCol}-${dRow}`}
                    className={
                      "item-stage-footprint-tile" +
                      (selected ? " selected" : "") +
                      (isAnchor ? " anchor" : "")
                    }
                    style={{
                      bottom: mobiStageBaseline - (dCol + dRow) * (TILE_HEIGHT_PX / 2),
                      width: TILE_WIDTH_PX,
                      height: TILE_HEIGHT_PX,
                      transform: `translateX(calc(-50% + ${(dCol - dRow) * (TILE_WIDTH_PX / 2)}px))`,
                    }}
                    onClick={() => toggleFootprintTile(dCol, dRow)}
                    title={
                      isAnchor
                        ? "Âncora -- sempre trava passagem"
                        : selected
                          ? "Clique pra liberar esse quadrado"
                          : "Clique pra travar esse quadrado"
                    }
                  />
                );
              })}

              {stageArtSrc ? (
                <img
                  className="item-stage-item-img"
                  src={stageArtSrc}
                  alt="Preview do item"
                  onPointerDown={handleItemPointerDown}
                  style={{
                    width: activeDisplayWidth * PREVIEW_SCALE,
                    bottom: mobiStageBaseline - activeMobiOffset.y * PREVIEW_SCALE,
                    transform: `translate(calc(-50% + ${activeMobiOffset.x * PREVIEW_SCALE}px), 0)`,
                  }}
                  title="Arraste pra ajustar a posição no tile"
                />
              ) : (
                <p className="edit-hint item-size-empty">
                  Escolha a imagem de "{(mode === "parede" ? WALL_DIRECTION_FIELDS : DIRECTION_FIELDS).find((f) => f.key === activeMobiDirection)?.label}" pra ver o preview aqui.
                </p>
              )}

              {/* tile ARRASTÁVEL da altura da superfície (ver
                  stackSurfaceOffsetY/handleStackSurfacePointerDown acima)
                  -- SEMPRE aparece, independente do "Sobrepor: Sim/Não"
                  logo abaixo (pedido original do Douglas: "Dois campos
                  NOVOS, independentes... o mesmo item pode usar um, o
                  outro, os dois, ou nenhum" -- ver comentário grande no
                  useState de stackable/stackSurfaceOffsetY mais acima).
                  ANTES esse tile só aparecia com stackable=true, o que
                  obrigava marcar "Sobrepor: Sim" numa mesa só pra poder
                  arrastar a altura da superfície dela -- só que
                  stackable=true significa "ESSE item pode ir em cima de
                  outro", o CONTRÁRIO do que uma mesa precisa (pedido do
                  Douglas: "o tile que eu defini ali na mesa, nao e a
                  altura que outro item fica nela, é ela em outro item...
                  eu queria justamente o contrario"), e de quebra fazia
                  anyFurnitureAt (MainScene.ts) achar que a mesa JÁ TINHA
                  um item "Sobrepor" ancorado nela, bloqueando colocar o
                  notebook de verdade. Cor DIFERENTE do losango roxo do
                  footprint (item-stage-tile-surface, ver globals.css) --
                  pedido do Douglas "mantem esse roxo ali": os losangos do
                  footprint continuam roxos, só esse aqui (conceito
                  diferente -- é a ALTURA, não uma tile do chão) ganha cor
                  própria pra não confundir os dois. Mesma âncora
                  horizontal do tile 0,0 (sem deslocamento em dCol/dRow --
                  a altura da superfície não muda com footprint), só o
                  "bottom" muda com o arraste. Renderiza DEPOIS da <img>
                  de propósito (pedido do Douglas: "quando eu coloco o
                  item nao consigo clicar no tile de sobrepor") -- antes
                  vinha ANTES da imagem, então em item grande (ex: mesa) a
                  própria arte cobria esse losango e roubava o
                  clique/arraste; ficando depois, esse losango sempre
                  pinta por CIMA da imagem e continua clicável não importa
                  o tamanho do item. */}
              <div
                className="item-stage-tile item-stage-tile-surface"
                style={{
                  bottom: mobiStageBaseline - stackSurfaceOffsetY * PREVIEW_SCALE,
                  width: TILE_WIDTH_PX,
                  height: TILE_HEIGHT_PX,
                }}
                onPointerDown={handleStackSurfacePointerDown}
                title="Arraste pra ajustar a altura da superfície -- onde um item 'Sobrepor' vai sentar em cima (independente do 'Sobrepor: Sim/Não' logo abaixo, que é sobre ESSE item ir em cima de OUTRO)"
              />

              <StageRuler anchorBottomPx={mobiStageBaseline} />
            </div>

            {/* tamanho -- POR DIREÇÃO desde o pedido do Douglas: "se eu
                mudar de um ele muda de todas as vistas? nao tem como
                isolar?" (testando o campo digitável de baixo, recém
                adicionado). Mesmo esquema de "posição no tile" (mais
                abaixo): "down" ajusta displayWidth direto, as outras 3
                gravam o PRÓPRIO override em directionDisplayWidth (ver
                activeDisplayWidth/setActiveDisplayWidth) -- sem
                override, uma direção continua reaproveitando o tamanho
                de "down" (comportamento de sempre). */}
            <div className="settings-slider-row settings-slider-row-editable">
              <span className="settings-slider-name">
                Tamanho no jogo ({(mode === "parede" ? WALL_DIRECTION_FIELDS : DIRECTION_FIELDS).find((f) => f.key === activeMobiDirection)?.label})
              </span>
              <input
                type="range"
                min={DISPLAY_WIDTH_MIN}
                max={DISPLAY_WIDTH_MAX}
                step={DISPLAY_WIDTH_STEP}
                value={activeDisplayWidth}
                onChange={(e) => setActiveDisplayWidth(Number(e.target.value))}
              />
              {/* valor digitável (pedido do Douglas: "deixa essa linha
                  dimensao de pixel aqui digitalvel") -- NÃO trava
                  (clamp) a cada tecla, só no blur: como o mínimo (60) é
                  bem maior que zero, travar em cada onChange impediria
                  digitar qualquer número de 2-3 dígitos que comece
                  "baixo" (ex.: tentar digitar "750" começa em "7",
                  que já seria empurrado pra 60 antes do resto entrar).
                  Enquanto digita aceita qualquer número (até vazio =
                  0), só arruma (clamp) quando o campo perde o foco.
                  SEM `step` aqui de propósito (diferente do slider
                  acima, que pula de 8 em 8) -- é bug encontrado ao
                  vivo: com step=8 e min=60 o Safari rejeitava digitar
                  valores como 155 ("os dois valores válidos mais
                  próximos são 148 e 156"), já que 155 não bate num
                  múltiplo de 8 a partir de 60. O digitável é
                  justamente pra digitar QUALQUER pixel exato, driblando
                  os pulos do slider -- passo 8 só faz sentido
                  arrastando. */}
              <span className="settings-slider-value-field">
                <input
                  type="number"
                  className="settings-slider-value-input"
                  min={DISPLAY_WIDTH_MIN}
                  max={DISPLAY_WIDTH_MAX}
                  value={activeDisplayWidth}
                  onChange={(e) => setActiveDisplayWidth(Number(e.target.value) || 0)}
                  onBlur={() => setActiveDisplayWidth(clamp(Math.round(activeDisplayWidth), DISPLAY_WIDTH_MIN, DISPLAY_WIDTH_MAX))}
                />
                <span>px</span>
              </span>
            </div>
            {hasDisplayWidthOverride && (
              <div className="item-stage-offset-row">
                <span>
                  tamanho próprio pra essa direção -- diferente do de "
                  {(mode === "parede" ? WALL_DIRECTION_FIELDS : DIRECTION_FIELDS).find((f) => f.key === "down")?.label}"
                </span>
                <button
                  type="button"
                  className="clear-btn"
                  onClick={() => {
                    setDirectionDisplayWidth((prev) => {
                      const next = { ...prev };
                      delete next[activeMobiDirection as Exclude<MobiFacing, "down">];
                      return next;
                    });
                  }}
                >
                  Redefinir tamanho
                </button>
              </div>
            )}

            {/* footprint (pedido do Douglas: "tenho mobis que ocupam mais
                tiles doq um ou dois, entao preciso selecionar pra que nao
                se suba em um item", depois "quero selecionar os tiles
                que ele ocupa, CLICANDO", depois "nao tem como a grande ja
                vir aberta, com a insersao no meio?? 2 pra cada lado da
                insercao") -- a grade JÁ vem aberta no preview acima (ver
                FOOTPRINT_GRID_RADIUS), sem precisar digitar tamanho
                nenhum antes; footprintCols/footprintRows (os campos
                numéricos de "Ocupa (tiles)" que existiam aqui) saíram da
                tela -- só ficam guardados por baixo dos panos pra item
                JÁ cadastrado antes dessa grade existir continuar
                mostrando o footprint de sempre (ver isFootprintTileSelected
                acima), Douglas não precisa mais mexer nesse número, só
                clicar. */}
            {/* bloqueio É POR DIREÇÃO (pedido do Douglas: "isso pra CADA
                POSICAO, pois o movel gira e muda o bloqueio pela
                perspectiva!!!") -- troca de aba lá em cima (mesma de
                "Tamanho no jogo"/"posição no tile") edita uma forma
                DIFERENTE por direção. "Redefinir" só aparece depois que
                essa direção específica foi customizada (senão já tá
                mostrando o padrão, nada pra redefinir). */}
            <div className="item-stage-offset-row">
              <span>
                bloqueio de passagem ({(mode === "parede" ? WALL_DIRECTION_FIELDS : DIRECTION_FIELDS).find((f) => f.key === activeMobiDirection)?.label}) -- clique nos quadrados do preview pra marcar/desmarcar
              </span>
              {activeFootprintCustom && (
                <button
                  type="button"
                  className="clear-btn"
                  onClick={() =>
                    setFootprintByDirection((prev) => {
                      const next = { ...prev };
                      delete next[activeFootprintDir];
                      return next;
                    })
                  }
                >
                  Redefinir bloqueio
                </button>
              )}
            </div>

            {/* "Sobrepor" (ver comentário grande no useState de
                stackable/stackSurfaceOffsetY mais acima) -- pedido do
                Douglas: notebook em cima da mesa, sem travar a posição
                de nenhum dos dois. "Sim" deixa ESSE item (o de cima, ex:
                notebook) ser colocado em cima de outro já ancorado no
                mesmo tile -- sem marcar, comportamento de sempre (tile
                ocupado bloqueia). "Altura da superfície" é o OUTRO lado
                (ex: a mesa): quanto o item marcado "Sobrepor" que cair
                nesse tile sobe -- 0 = sem efeito (só faz sentido
                preencher num item de base tipo mesa/mesinha, mas o campo
                fica disponível em qualquer item pra não precisar
                bifurcar por categoria). */}
            <p className="settings-hint">
              Sobrepor? (deixa colocar ESSE item, ex: um notebook, em cima de outro já colocado no mesmo quadrado -- pra configurar a mesa que RECEBE outro item em cima, não precisa marcar "Sim" aqui, só ajustar a altura da superfície logo abaixo)
            </p>
            <div className="gender-switch">
              <button type="button" className={!stackable ? "gender-btn selected" : "gender-btn"} onClick={() => setStackable(false)}>
                Não
              </button>
              <button type="button" className={stackable ? "gender-btn selected" : "gender-btn"} onClick={() => setStackable(true)}>
                Sim
              </button>
            </div>
            {/* pedido do Douglas ("voce errou a ordem... eu vou subindo
                a altura do tile ate chegar na superficie dela"): trocado
                o campo numérico cru por um tile ARRASTÁVEL no preview
                (ver item-stage-tile-surface/handleStackSurfacePointerDown
                mais acima). SEMPRE aparece agora, independente do
                "Sobrepor: Sim/Não" acima (mesmo motivo do tile no stage
                acima ficar independente -- ver comentário grande lá:
                esse número é a altura da SUPERFÍCIE desse item pra quem
                cai "Sobrepor" nele, ex: a mesa; o Sim/Não acima é sobre
                ESSE item ir em cima de OUTRO, ex: o notebook -- são os
                "dois campos independentes" que o Douglas pediu desde o
                início, não um depender do outro). MESMO padrão de
                "posição no tile" logo abaixo (offsetX/Y): número só de
                leitura + "Redefinir" quando não tá mais em 0. */}
            <div className="item-stage-offset-row">
              <span>altura da superfície pra quem cai "Sobrepor" aqui (ex: a mesa) -- {stackSurfaceOffsetY}px (arraste o losango laranja no preview acima)</span>
              {stackSurfaceOffsetY !== 0 && (
                <button type="button" className="clear-btn" onClick={() => setStackSurfaceOffsetY(0)}>
                  Redefinir altura
                </button>
              )}
            </div>

            {/* assentos EXTRA (pedido do Douglas: "preciso... configurar
                dois avatares no caso em que tenha mais de um assento",
                ex: sofá de 2 lugares) -- cada linha é UM lugar extra pra
                sentar, fora a âncora (que já senta pelo "Tem interação?"/
                assento acima) -- dCol/dRow: tile, offset a partir da
                âncora (normalmente dentro do "Ocupa (tiles)" acima); x/y:
                posição (px) FIXA de onde o boneco aparece sentado ali --
                sem ajuste ao vivo no jogo (diferente do assento da
                âncora, que dá pra arrastar/nudge lá, ver "Assento" no
                editor de espaço) -- afinar é editar os números aqui de
                novo. Ver FurnitureExtraSeat/seatSpotAt em
                game/furniture.ts. */}
            <div className="settings-slider-row" style={{ flexWrap: "wrap", alignItems: "flex-start" }}>
              <span className="settings-slider-name">Assentos extras</span>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, width: "100%" }}>
                {extraSeats.map((seat, idx) => (
                  <div key={idx} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <span className="edit-hint">#{idx + 1}</span>
                    <span className="edit-hint">col</span>
                    <input
                      type="number"
                      value={seat.dCol}
                      onChange={(e) => {
                        const dCol = clamp(Math.round(Number(e.target.value) || 0), -6, 6);
                        setExtraSeats((prev) => prev.map((s, i) => (i === idx ? { ...s, dCol } : s)));
                      }}
                      style={{ width: 44 }}
                    />
                    <span className="edit-hint">lin</span>
                    <input
                      type="number"
                      value={seat.dRow}
                      onChange={(e) => {
                        const dRow = clamp(Math.round(Number(e.target.value) || 0), -6, 6);
                        setExtraSeats((prev) => prev.map((s, i) => (i === idx ? { ...s, dRow } : s)));
                      }}
                      style={{ width: 44 }}
                    />
                    <span className="edit-hint">x</span>
                    <input
                      type="number"
                      value={seat.x}
                      onChange={(e) => {
                        const x = clamp(Math.round(Number(e.target.value) || 0), -OFFSET_LIMIT, OFFSET_LIMIT);
                        setExtraSeats((prev) => prev.map((s, i) => (i === idx ? { ...s, x } : s)));
                      }}
                      style={{ width: 56 }}
                    />
                    <span className="edit-hint">y</span>
                    <input
                      type="number"
                      value={seat.y}
                      onChange={(e) => {
                        const y = clamp(Math.round(Number(e.target.value) || 0), -OFFSET_LIMIT, OFFSET_LIMIT);
                        setExtraSeats((prev) => prev.map((s, i) => (i === idx ? { ...s, y } : s)));
                      }}
                      style={{ width: 56 }}
                    />
                    <button
                      type="button"
                      className="clear-btn"
                      onClick={() => setExtraSeats((prev) => prev.filter((_, i) => i !== idx))}
                    >
                      remover
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="clear-btn"
                  onClick={() => setExtraSeats((prev) => [...prev, { dCol: 1, dRow: 0, x: 0, y: 0 }])}
                  style={{ alignSelf: "flex-start" }}
                >
                  + assento extra
                </button>
              </div>
            </div>

            <div className="item-stage-offset-row">
              <span>
                posição no tile ({(mode === "parede" ? WALL_DIRECTION_FIELDS : DIRECTION_FIELDS).find((f) => f.key === activeMobiDirection)?.label}) -- x: {activeMobiOffset.x}px · y: {activeMobiOffset.y}px
              </span>
              {(activeMobiOffset.x !== 0 || activeMobiOffset.y !== 0) && (
                <button
                  type="button"
                  className="clear-btn"
                  onClick={() => {
                    if (activeMobiDirection === "down") {
                      setOffsetX(0);
                      setOffsetY(0);
                    } else {
                      setDirectionOffsets((prev) => {
                        const next = { ...prev };
                        delete next[activeMobiDirection as Exclude<MobiFacing, "down">];
                        return next;
                      });
                    }
                  }}
                >
                  Redefinir posição
                </button>
              )}
            </div>

            {sittable && (
              <div className="item-stage-offset-row">
                <span>
                  posição sentado ({(mode === "parede" ? WALL_DIRECTION_FIELDS : DIRECTION_FIELDS).find((f) => f.key === activeMobiDirection)?.label}) -- x: {activeSeatOffset.x}px · y: {activeSeatOffset.y}px
                </span>
                {(isActiveSeatSide ? activeMobiDirection in seatDirectionOffsets : seatOffsetX !== 0 || seatOffsetY !== 0) && (
                  <button
                    type="button"
                    className="clear-btn"
                    onClick={() => {
                      if (isActiveSeatSide) {
                        setSeatDirectionOffsets((prev) => {
                          const next = { ...prev };
                          delete next[activeMobiDirection as Exclude<MobiFacing, "down">];
                          return next;
                        });
                      } else {
                        setSeatOffsetX(0);
                        setSeatOffsetY(0);
                      }
                    }}
                  >
                    Redefinir assento
                  </button>
                )}
              </div>
            )}
          </div>

          {error && <p className="items-panel-error">{error}</p>}

          <div className="items-panel-submit-row">
            <button type="submit" className="items-panel-submit" disabled={submitting}>
              {submitting ? "Enviando..." : editingId ? "Salvar alterações" : mode === "parede" ? "Cadastrar parede" : "Cadastrar item"}
            </button>
            {editingId && (
              <button type="button" className="clear-btn" onClick={resetForm} disabled={submitting}>
                Cancelar edição
              </button>
            )}
          </div>
        </form>

        <section className="items-panel-section">
          <h3>{mode === "parede" ? "Paredes cadastradas" : "Itens cadastrados"} ({visibleItems?.length ?? 0})</h3>
          {!visibleItems ? (
            <p className="items-panel-loading">Carregando...</p>
          ) : visibleItems.length === 0 ? (
            <p className="items-panel-loading">{mode === "parede" ? "Nenhuma parede custom ainda." : "Nenhum item custom ainda."}</p>
          ) : (
            <ul className="items-panel-list">
              {visibleItems.map((item) => (
                <li key={item.id} className="items-panel-row-wrap">
                  <div className="items-panel-row">
                    {(item.icon_url ?? item.art.down) && (
                      <img className="items-panel-thumb" src={item.icon_url ?? item.art.down} alt={item.label} />
                    )}
                    <span className="items-panel-name">
                      {item.label} <span className="items-panel-category">({CATEGORIES.find((c) => c.id === item.category)?.label ?? item.category})</span>
                      {item.colors && item.colors.length > 0 && (
                        <span className="items-panel-category"> -- {item.colors.length} cor(es)</span>
                      )}
                    </span>
                    <button type="button" disabled={busyId === item.id} onClick={() => startEditItem(item)}>
                      Editar
                    </button>
                    {/* "Gerar cor" (FurnitureColorZoneTool.tsx) -- pedido do
                        Douglas: "adiciona a edicao de cores nos mobis
                        tambe, quero testar". Mesma ferramenta/algoritmo do
                        avatar (ColorZoneTool.tsx), adaptada pro formato de
                        móvel (até 4 fotos por direção em vez de 1 folha só,
                        ver comentário grande no topo daquele arquivo).
                        Estado próprio (furnitureColorToolItemId, ver
                        acima) -- "Criar Mobi" é um componente diferente
                        de AvatarCreatorPanel, não reaproveita o
                        colorToolItemId de lá. */}
                    <button
                      type="button"
                      onClick={() => setFurnitureColorToolItemId((prev) => (prev === item.id ? null : item.id))}
                    >
                      {furnitureColorToolItemId === item.id ? "Fechar cor" : "Gerar cor"}
                    </button>
                    <button type="button" disabled={busyId === item.id} onClick={() => handleDelete(item.id)}>
                      Excluir
                    </button>
                  </div>
                  {furnitureColorToolItemId === item.id && (
                    <FurnitureColorZoneTool
                      item={item}
                      accessToken={accessToken}
                      onClose={() => setFurnitureColorToolItemId(null)}
                      onSaved={() => {
                        loadItems();
                        onItemsChanged();
                      }}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
        </>
        )}
      </div>
      {pendingCrop && (
        <ImageCropModal
          file={pendingCrop.file}
          onConfirm={(result) => {
            pendingCrop.apply(result);
            setPendingCrop(null);
          }}
          onSkip={(result) => {
            pendingCrop.apply(result);
            setPendingCrop(null);
          }}
          onCancel={() => {
            const input =
              pendingCrop.inputKey === "__icon__" ? iconInputRef.current : fileInputRefs.current[pendingCrop.inputKey];
            if (input) input.value = "";
            setPendingCrop(null);
          }}
        />
      )}
    </div>
  );
}
