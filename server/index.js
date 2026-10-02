// Servidor multiplayer simples (Node.js + WebSocket puro).
//
// Substitui o PartyKit: mesma lógica (guarda a posição de cada jogador,
// avisa todo mundo quando alguém entra/sai/se move, e repassa a
// sinalização WebRTC entre pares), mas roda em qualquer host Node comum
// (ex: Render), sem depender de Durable Objects/Cloudflare.
//
// Protocolo (idêntico ao que o cliente já espera):
//   init    -> { type: "init", selfId, players: [...] }
//   join    -> { type: "join", player }
//   move    -> { type: "move", id, x, y }
//   seat    -> cliente->servidor: { type: "seat", furnitureId, dCol?, dRow? }
//              (furnitureId = id do móvel sentado agora, ou null ao
//              levantar -- ver sitAt/standUp em MainScene.ts; dCol/dRow =
//              qual ASSENTO desse item, 0/0 = âncora -- ver
//              FurnitureModelDef.extraSeats em game/furniture.ts, pedido
//              do Douglas pra sofá/item com mais de uma pessoa sentada)
//              servidor->sala: { type: "seat", id, furnitureId, dCol, dRow }
//              (o server guarda o último valor em player.seatFurnitureId/
//              seatDCol/seatDRow, igual x/y -- por isso ele já sai certo
//              dentro de "init"/"join" pra quem entra depois de alguém já
//              sentado. Só corrige a POSE/profundidade do boneco remoto --
//              que antes nunca mostrava sentado pela rede, ver
//              setRemoteSeat em MainScene.ts -- NÃO tem nada a ver com
//              posse de mesa privada, que é "claim-area"/"release-area"
//              abaixo; também NÃO trava/reserva o assento pra ninguém --
//              cada cliente ainda decide sozinho onde senta, mesma falta
//              de arbitragem que já existia pra cadeira única antes disso)
//   leave   -> { type: "leave", id }
//   signal  -> { type: "signal", from, data }   (relay de WebRTC)
//   chat    -> cliente->servidor: { type: "chat", text?, attachment?, kind?, mentionedUserIds? }
//              servidor->sala:    { type: "chat", id, message }
//              (chat da SALA, todo mundo vê -- "message" tem o mesmo formato de
//              "chat:message" lá embaixo, pra dar pra desenhar com o mesmo componente
//              dos dois lados. 1/out: AGORA fica salvo -- ver roomChats em
//              chatStore.js/comentário grande mais abaixo, chat:room_history)
//   profile -> { type: "profile", id, name, status, instagram, bio, photoUrl }
//              (card de perfil -- ver ProfileCard em GameRoom.tsx; "role"
//              NÃO entra aqui, é só o servidor que atribui, ver PROFILE_FIELDS)
//   look    -> cliente->servidor: { type: "look", hairId?, skinId?, beardId?,
//              accessoryId?, outfitId? } (aparência do boneco -- cabelo/
//              tom de pele/barba/acessório/traje, já resolvidos pra cor
//              escolhida quando houver, ver SavedAvatar/AVATAR_STORAGE_KEY
//              em GameRoom.tsx; cada campo é OPCIONAL, só troca o que veio)
//              servidor->sala: { type: "look", id, hairId, skinId, beardId,
//              accessoryId, outfitId } (ver LOOK_FIELDS/pickLookFields --
//              pedido do Douglas, 30/set: "o estilo roupa que ele escolher
//              do avatar, deve seguir ele em qualquer ambiente que ele
//              for" -- ANTES disso o traje/cabelo/etc escolhido nunca
//              saía do navegador de quem escolheu, ver comentário que
//              existia em setLocalOutfitId/createAvatar, MainScene.ts:
//              cada jogador remoto sempre aparecia com o boneco padrão
//              pra todo mundo, em QUALQUER sala, não só de uma sala pra
//              outra. Mesmo esquema de "profile" acima, só que sem
//              limite de tamanho por campo maior que o catálogo (ids
//              curtos, nunca foto).
//   poke    -> cliente->servidor: { type: "poke", to, kind, text? }
//              servidor->alvo:    { type: "poke", from, fromName, kind, text? }
//              (botões de interação do card de OUTRO jogador -- "Disponível?"
//              / "Chamar até você" / "Enviar mensagem" -- relay privado, só
//              pro alvo, vira um toast do lado de quem recebe. "text" só
//              existe pro kind "note" -- pedido do Douglas: "deixar um
//              recado, igual o gather" -- um texto curto digitado na hora
//              no card, mandado como aviso avulso, igual "Disponível?"/
//              "Chamar até você" -- NÃO abre o chat, NÃO fica salvo em
//              lugar nenhum, só o toast de quem recebe, ver "poke" em
//              GameRoom.tsx e ProfileCard/recado-composer no JSX).
//
// Chat de VERDADE (conversa direta/grupo, histórico, foto/arquivo/áudio)
// -- ver server/chatStore.js pra persistência e o comentário logo antes
// de PROFILE_FIELDS pra por que usa "userId" (persistente) em vez do id
// de conexão (que troca a cada reconexão):
//   identify         -> cliente->servidor, primeira coisa mandada na conexão:
//                        { type: "identify", userId }
//   chat:list        -> cliente->servidor: { type: "chat:list" }
//                        servidor->cliente: { type: "chat:conversations", conversations }
//   chat:room_history -> servidor->cliente, mandado sozinho logo depois de "identify"
//                        resolver (1/out, ver comentário grande ali): { type: "chat:room_history",
//                        messages, pins } -- a "semente" do histórico da Sala dessa conexão
//                        (ver chatStore.getRoomMessages/getRoomPins); daí em diante os "chat"/
//                        "chat:pins"/"chat:reaction" ao vivo já mantêm sozinhos.
//   chat:open        -> cliente->servidor: { type: "chat:open", conversationId }
//                        servidor->cliente: { type: "chat:history", conversationId, messages, unreadSinceTs, pins }
//                        (marca a conversa como lida na hora -- unreadSinceTs é o lastRead
//                        de ANTES de marcar, pro cliente desenhar a linha "mensagens não
//                        vistas"; ver chatStore.markConversationRead. POST /chat/open faz o
//                        mesmo sem socket, usado pelo Lobby. 1/out: também avisa o RESTO da
//                        conversa em tempo real -- servidor->outros participantes:
//                        { type: "chat:read", conversationId, userId, ts } -- "visto por".)
//   chat:create_direct -> cliente->servidor: { type: "chat:create_direct", targetUserId }
//   chat:create_group  -> cliente->servidor: { type: "chat:create_group", name, participantIds }
//   chat:rename_group  -> cliente->servidor: { type: "chat:rename_group", conversationId, name }
//   (create_direct/create_group/rename_group respondem, pra CADA participante
//   online, com) -> { type: "chat:conversation", conversation }
//   chat:send        -> cliente->servidor: { type: "chat:send", conversationId, text?, attachment?, kind?, mentionedUserIds? }
//                        servidor->participantes online: { type: "chat:message", conversationId, message }
//   chat:delete      -> cliente->servidor: { type: "chat:delete", conversationId, messageId }
//                        (só quem MANDOU a mensagem pode apagar -- apaga PRA TODOS, ver
//                        deleteMessage em chatStore.js)
//                        servidor->participantes: { type: "chat:message_deleted", conversationId, messageId }
//   chat:delete_room -> cliente->servidor: { type: "chat:delete_room", messageId }
//                        (1/out: chat da SALA agora tem histórico salvo (ver chatStore.
//                        deleteRoomMessage) -- MESMA trava de chat:delete, só quem mandou apaga)
//                        servidor->sala: { type: "chat_room_deleted", messageId }
//   chat:react       -> cliente->servidor: { type: "chat:react", conversationId?, messageId, emoji }
//                        (1/out, reação com emoji -- conversationId ausente/null = reagindo
//                        na Sala. "Toggle": mandar o MESMO emoji de novo desliga a própria
//                        reação. Só participante da conversa pode reagir nela.)
//                        servidor->participantes/sala: { type: "chat:reaction", conversationId, messageId, reactions }
//                        (reactions = { "👍": [userId, ...], ... } JÁ ATUALIZADO, pronto pra
//                        substituir o que o cliente tinha)
//   chat:typing      -> cliente->servidor: { type: "chat:typing", conversationId? }
//                        (1/out, indicador "fulano está digitando..." -- efêmero, NUNCA
//                        persiste; conversationId ausente/null = digitando na Sala. Cliente
//                        manda isso throttled enquanto o campo de texto tem foco+conteúdo, e
//                        o lado que recebe expira sozinho depois de alguns segundos sem
//                        receber de novo -- sem "parei de digitar" explícito, mais simples.)
//                        servidor->outros participantes/sala: { type: "chat:typing", conversationId, userId, name }
//   chat:pin/chat:unpin -> cliente->servidor: { type: "chat:pin", conversationId?, messageId, durationMs? }
//                        / { type: "chat:unpin", conversationId?, messageId }
//                        (1/out, "mensagem fixada (definir tempo de fixação)" -- durationMs
//                        ausente/null = sem prazo, fixa até alguém tirar à mão; um número =
//                        expira sozinha (ver chatStore.livePins). conversationId ausente/null
//                        = fixando na Sala.)
//                        servidor->participantes/sala: { type: "chat:pins", conversationId, pins }
//                        (pins = lista INTEIRA já atualizada, mais recente primeiro)
//   chat:attachments -> cliente->servidor: { type: "chat:attachments", conversationId? }
//                        (1/out, painel lateral de arquivos/imagens da conversa -- varre o
//                        histórico INTEIRO, não só as últimas 200 mensagens de chat:open)
//                        servidor->cliente: { type: "chat:attachments", conversationId, items }
//   call:join         -> cliente->servidor: { type: "call:join", conversationId }
//                        (chamada de voz/vídeo de uma conversa direta/grupo -- "opt-in", só
//                        entra quem clicar; só quem PARTICIPA da conversa pode entrar)
//   call:leave        -> cliente->servidor: { type: "call:leave", conversationId }
//   call:state        -> servidor->cada participante da conversa (esteja OU NÃO na
//                        chamada, é o que acende o botão verde "entrar" de quem ainda
//                        não entrou -- ver comentário em broadcastCallState):
//                        { type: "call:state", conversationId, participants: [{ connectionId, userId, name, color, photoUrl }] }
//                        (participants: [] = ninguém na chamada agora; o mesh de WebRTC
//                        entre quem tá dentro usa o "signal" de cima, endereçado por
//                        connectionId, com um "channel":"call" dentro do "data" pra não
//                        misturar com a chamada de proximidade da Sala -- ver
//                        connectionsById/activeCalls)
//   users:list        -> servidor->sala, toda vez que alguém identifica ou muda o perfil:
//                        { type: "users:list", users: [{ userId, name, color, photoUrl }] }
//                        (todo mundo já cadastrado no ambiente, ONLINE OU NÃO -- ver
//                        listAllUsers em chatStore.js -- usado no picker de participantes
//                        e na busca de agenda de colega, que antes só viam quem tava na
//                        sala naquele momento)
//
// Upload de foto/arquivo/áudio do chat NÃO vai pelo WebSocket (ficaria
// pesado no JSON) -- vai por HTTP simples nesse mesmo servidor:
//   POST /upload?filename=<nome>   (corpo = bytes crus do arquivo, Content-Type = mime)
//     -> 200 { url, name, size, mime }  (url relativa, ver GET abaixo)
//   GET  /uploads/<arquivo>        -> serve o arquivo salvo
//
// Piso da sala ("Editar espaço" -> aba "Piso", ver EditPanel em
// GameRoom.tsx e server/roomStore.js pra persistência): antes o editor
// só gerava um código pra colar à mão em game/floor.ts, agora salva
// sozinho por aqui.
//   GET  /room/floor    -> 200 { items: FloorTileDef[] }  (piso salvo agora)
//   POST /room/floor    (corpo JSON: { items: FloorTileDef[] }, sempre o
//                        piso INTEIRO, não um diff -- ver onDraftFloorChange
//                        em MainScene.ts)
//     -> 200 { ok: true, items }
//     -> 403, DESATIVADO se NODE_ENV=production -- essa ferramenta é só
//        de uso interno do Douglas (ver IS_ROOM_EDITOR_ENABLED em
//        GameRoom.tsx, que já esconde o botão/painel pro cliente final;
//        isso aqui é a segunda trava, do lado do servidor, pro caso de
//        alguém chamar o endpoint direto sem passar pela tela). Rodando
//        `node server/index.js` localmente (npm run dev) fica disponível
//        normal; no deploy de verdade (ex: Render) o host precisa estar
//        com NODE_ENV=production setado.
//
// Parede de sistema ("Editar espaço" -> aba "Parede", ver game/wall.ts)
// -- MESMO esquema/travas do piso acima, só troca item por aresta
// (col/row/side) em vez de tile inteiro (col/row):
//   GET  /room/walls    -> 200 { items: WallSegmentDef[] }
//   POST /room/walls    (corpo JSON: { items: WallSegmentDef[] }, sempre
//                        a parede INTEIRA, não um diff)
//     -> 200 { ok: true, items }
//     -> 403, mesma trava de produção do /room/floor acima.
//
// Porta ("Editar espaço" -> aba "Porta", ver game/door.ts) -- MESMO
// esquema/travas da parede acima (também é aresta, col/row/side, com
// `facing` a mais -- ver DoorFacing em game/door.ts):
//   GET  /room/doors    -> 200 { items: DoorSegmentDef[] }
//   POST /room/doors    (corpo JSON: { items: DoorSegmentDef[] }, sempre
//                        a porta INTEIRA, não um diff)
//     -> 200 { ok: true, items }
//     -> 403, mesma trava de produção do /room/floor acima.
//
// Áreas da sala ("Editar espaço" -> aba "Área", ver game/areas.ts pro
// conceito de área NOMEADA/tipo "mesa-privada"/"sala") -- MESMO arquivo
// data/room.json do piso, mesma trava de produção:
//   GET  /room/areas    -> 200 { list: AreaDef[], tiles: AreaTileDef[] }
//                        (lista de áreas criadas + tiles pintados, ver
//                        game/areas.ts)
//   POST /room/areas    (corpo JSON: { list: AreaDef[], tiles: AreaTileDef[] },
//                        sempre os DOIS inteiros, não um diff -- ver
//                        autosave combinado em GameRoom.tsx)
//     -> 200 { ok: true, list, tiles }
//     -> 403, mesma trava de produção do /room/floor acima.
//
// Mobília da sala ("Editar espaço" -> abas de móvel, ver
// game/furniture.ts pro conceito de MODELO/cor -- FurnitureModelDef,
// gerado a partir da pasta de origem, ver scripts/syncFurnitureAssets.mjs)
// -- MESMO arquivo data/room.json do piso/área, mesma trava de produção:
//   GET  /room/furniture  -> 200 { items: FurnitureDef[], seatOffsets: FurnitureSeatOffsetsMap }
//                          (itens colocados pelo editor + ajuste de onde o
//                          boneco senta, por MODELO+direção -- ver
//                          "Assento" no editor, NÃO por instância. Isso é
//                          ADICIONAL a ROOM_FURNITURE, furniture.ts, que
//                          continua fixo/sempre desenhado)
//   POST /room/furniture  (corpo JSON: { items: FurnitureDef[], seatOffsets:
//                          FurnitureSeatOffsetsMap }, sempre os DOIS
//                          inteiros, não um diff -- ver autosave combinado
//                          em GameRoom.tsx)
//     -> 200 { ok: true, items, seatOffsets }
//     -> 403, mesma trava de produção do /room/floor acima.
//
// Posse de mesa privada (clicar "Tomar posse" numa área tipo
// "mesa-privada", ver onClaimArea/onReleaseArea em MainScene.ts) NÃO usa
// os endpoints acima -- passa pelo WebSocket, mas PERSISTE em disco (ver
// roomStore.js/livePlayerIdForUserId mais abaixo) -- pedido do Douglas:
// "quando voce assume a mesa, ela e sua, ate apagarem o espaco":
//   claim-area   -> cliente->servidor: { type: "claim-area", areaId }
//                   (ignorado em silêncio se a área já tiver dono --
//                   primeira mensagem a chegar no servidor ganha)
//   release-area -> cliente->servidor: { type: "release-area", areaId }
//                   (ignorado em silêncio se quem mandou não for o dono
//                   atual)
//                   as duas -> servidor->sala (incluindo quem mandou):
//                   { type: "area-owner", areaId, playerId, name }
//                   (playerId/name null = área voltou a ficar sem dono)
//   (a posse de cada área também sai dentro de "init", em `areaOwners:
//   [{areaId, playerId, name}]`, pra quem entra DEPOIS de alguém já ter
//   clicado "Tomar posse" ver o estado certo; e é solta sozinha -- com o
//   mesmo "area-owner" de broadcast -- se a conexão de quem é dono cair,
//   ver "close" mais abaixo, pra uma mesa nunca ficar "presa" pra
//   sempre)
//
// Agenda (marcar call: data/horário/participantes, necessidades de
// câmera/áudio/tela, aprovação dos convidados) -- ver server/agendaStore.js:
//   agenda:list         -> cliente->servidor: { type: "agenda:list" }
//                           servidor->cliente: { type: "agenda:calls", calls }
//   agenda:availability -> cliente->servidor: { type: "agenda:availability", candidateUserIds, startTs, durationMinutes }
//                           servidor->cliente: { type: "agenda:availability", busyUserIds }
//                           (checagem AO VIVO enquanto a pessoa preenche o
//                           formulário, pra já mostrar quem fica indisponível)
//   agenda:create       -> cliente->servidor: { type: "agenda:create", title, startTs, durationMinutes,
//                           needs, participantIds, visibility?, description?, attachments?, blocksAgenda? }
//                           (participantIds pode vir [] -- "compromisso" só da própria pessoa,
//                           sem convidar ninguém, ver comentário no case abaixo)
//                           (visibility: "public" (padrão) ou "private" -- privada só ocupa o
//                           horário pra quem pesquisar a agenda de um participante dela, ver
//                           agenda:view_colleague embaixo, sem mostrar o conteúdo)
//                           (blocksAgenda: true (padrão, "travar agenda") conta como ocupado pra quem
//                           tá na call; false ("mostrar compromisso sem travar agenda") só aparece
//                           na agenda, sem contar como conflito -- ver getConflictingUserIds)
//                           servidor->cada participante: { type: "agenda:call", call }
//                           servidor->cada convidado (exceto quem criou): { type: "agenda:invite", call }
//                           (recusa com { type: "agenda:error", reason: "conflict", busyUserIds }
//                           se alguém ficou ocupado ENTRE a checagem ao vivo e o clique em criar)
//   agenda:add_attachment -> cliente->servidor: { type: "agenda:add_attachment", callId, attachment }
//                           (só um PARTICIPANTE da call pode anexar -- diferente do "attachments" de
//                           agenda:create, que entra junto na hora de criar; esse aqui pendura um
//                           arquivo numa call que já existe, visível pra todo mundo que participa)
//                           servidor->cada participante: { type: "agenda:call", call }
//   agenda:respond      -> cliente->servidor: { type: "agenda:respond", callId, status }  (status: "approved"|"declined")
//                           servidor->cada participante: { type: "agenda:call", call }
//                           (histórico de aprovação fica visível pra todo mundo da call)
//   agenda:view_colleague -> cliente->servidor: { type: "agenda:view_colleague", userId }
//                           servidor->cliente: { type: "agenda:colleague_calls", userId, calls }
//                           (calls PRIVADAS do colega em que quem pediu não participa vêm
//                           "tarjadas" -- sem título/necessidades/participantes, só o horário,
//                           ver redact() em server/agendaStore.js)
//   agenda:reminder     -> servidor->participantes (não recusados), alguns minutos antes do horário:
//                           { type: "agenda:reminder", call }
//                           (timer em memória -- some se o servidor reiniciar antes da hora)
//
// 29/set: o Lobby (sem WebSocket, ver comentário logo abaixo) ganhou
// REST equivalente pra criar/editar/apagar compromisso, não só
// ler/responder (pedido do Douglas: "nao me da a agenda mesmo,
// editavel e criavel") -- MESMAS funções de agendaStore.js por baixo:
//   GET  /agenda/summary?userId=X           -> lista (agendaStore.listCallsForUser)
//   POST /agenda/respond {callId,userId,status}            -> agendaStore.respondToCall
//   POST /agenda/create  {userId,title,startTs,durationMinutes,participantIds,description} -> agendaStore.createCall
//   POST /agenda/update  {callId,userId,title,startTs,durationMinutes,description}         -> agendaStore.updateCall (só quem criou)
//   POST /agenda/delete  {callId,userId}                    -> agendaStore.deleteCall (só quem criou)

import { createServer } from "http";
import { randomUUID } from "crypto";
import { WebSocketServer } from "ws";
import { createWriteStream, createReadStream, existsSync, mkdirSync } from "fs";
import { unlink } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import * as chatStore from "./chatStore.js";
import * as agendaStore from "./agendaStore.js";
import * as roomStore from "./roomStore.js";
import { verifyAccessToken, getActiveMemberIds, isBanned, getRole, isRoomOwner, getRoomCompanyInfo } from "./roomAuth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, "..", "uploads");
if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

const PORT = process.env.PORT || 1999;

const COLORS = [
  "#ff5c7a",
  "#5c9bff",
  "#5cffb0",
  "#ffd75c",
  "#c45cff",
  "#5cf0ff",
  "#ff9a5c",
];

// roomId -> Map<connectionId, { ws, player }>
const rooms = new Map();

function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = new Map();
    rooms.set(roomId, room);
  }
  return room;
}

// posse de mesa privada ("mesa-privada", claim-area/release-area) agora
// PERSISTE em disco (ver roomStore.js) -- pedido do Douglas: "quando
// voce assume a mesa, ela e sua, ate apagarem o espaco, se nao nao
// troca". Guardada por userId PERSISTENTE (ver "identify" abaixo), não
// pelo id de conexão (esse muda a cada reconexão) -- o id de conexão
// "ao vivo" de quem tá com aquela mesa agora (null = dono offline no
// momento, a mesa continua dele mesmo assim) é sempre recalculado na
// hora de mandar pro cliente, nunca guardado.
function livePlayerIdForUserId(room, userId) {
  for (const [connId, c] of room.entries()) {
    if (c.player.userId === userId) return connId;
  }
  return null;
}

/** Monta o registro de posse de UMA área pronto pra mandar pro cliente
 * (broadcast "area-owner" ou dentro de "init", ver protocolo lá em
 * cima) -- null se essa área não tem dono nenhum persistido. */
function areaOwnerWireEntry(room, areaId, owners) {
  const entry = owners[areaId];
  if (!entry) return null;
  return { areaId, playerId: livePlayerIdForUserId(room, entry.userId), name: entry.name };
}

/** Manda pra SALA INTEIRA (todo mundo, ninguém excluído -- mesma
 * convenção de "area-owner" no protocolo) o estado atual de posse de
 * TODAS as áreas de que `userId` é dono agora -- chamado quando esse
 * userId conecta ou desconecta (ver "connection"/"close" abaixo), pra
 * quem já tava na sala atualizar a bolinha de status da mesa dele na
 * hora (online -> cinza de "offline" ou vice-versa), sem esperar o
 * próximo claim/release de QUALQUER mesa acontecer por acaso. */
async function broadcastAreaOwnershipFor(room, roomId, userId) {
  const owners = await roomStore.getAreaOwners(roomId);
  for (const areaId of Object.keys(owners)) {
    if (owners[areaId].userId !== userId) continue;
    const wire = areaOwnerWireEntry(room, areaId, owners);
    if (wire) broadcast(room, { type: "area-owner", ...wire });
  }
}

// roomId -> Set<"col_row_side"> -- portas travadas MANUALMENTE agora
// pelo dono da área que cada uma guarda (ver comentário grande de
// protocolo "lock-door"/"unlock-door" abaixo). SÓ em memória, DIFERENTE
// da posse de mesa acima (essa sim persiste, ver roomStore.js) -- uma
// porta travada volta destravada depois de um restart, sem problema, o
// dono trava de novo se quiser (travar porta não tem o mesmo peso de
// "perder a mesa" que motivou persistir a posse). Pedido do Douglas: "o
// dono da area em questao, pode bloquear ela, fechar, pra que ninguem
// entre".
const roomDoorLocks = new Map();

function getDoorLocks(roomId) {
  let locks = roomDoorLocks.get(roomId);
  if (!locks) {
    locks = new Set();
    roomDoorLocks.set(roomId, locks);
  }
  return locks;
}

function doorLockKey(col, row, side) {
  return `${col}_${row}_${side}`;
}

/** Dado um segmento de porta (col,row,side, ver DoorSegmentDef em
 * game/door.ts), acha a área tipo "mesa-privada" (se houver) num dos 2
 * tiles vizinhos da aresta que ela separa -- é essa área que a porta
 * "guarda" (só o dono DELA pode travar/destravar a porta, ver
 * "lock-door"/"unlock-door" abaixo). Mesma ideia de areaIdAtTile
 * (game/areas.ts), reescrita aqui em JS puro porque o servidor não
 * importa os módulos TS do jogo (mesmo motivo de WALL_SIDES/DOOR_SIDES
 * em roomStore.js serem Sets redigitados à mão em vez de importados).
 * Sem área "mesa-privada" nenhuma dos 2 lados, devolve null -- a porta
 * continua funcionando (abre por proximidade), só ninguém consegue
 * travá-la manualmente. */
async function doorGuardedAreaId(col, row, side, roomId) {
  const neighbor = side === "colPlus" ? { col: col + 1, row } : { col, row: row + 1 };
  const { list, tiles } = await roomStore.getAreaState(roomId);
  for (const t of [{ col, row }, neighbor]) {
    const tile = tiles.find((x) => x.col === t.col && x.row === t.row);
    if (!tile) continue;
    const def = list.find((d) => d.id === tile.areaId);
    if (def && def.type === "mesa-privada") return def.id;
  }
  return null;
}

// connectionId -> { ws, player } -- igual "rooms", mas achatado (sem
// precisar saber o roomId pra procurar), usado pela CHAMADA de chat (ver
// "call:join" embaixo): o mesh de WebRTC de uma call é endereçado por
// connectionId (mesmo esquema do "signal" de proximidade), então preciso
// resolver connectionId -> jogador/ws sem depender de qual sala a pessoa
// tá. Só um Map a mais espelhando o "rooms" de cima; populado/limpo nos
// mesmos pontos (connection/close).
const connectionsById = new Map();

// conversationId -> Set<connectionId> -- quem tá NA CHAMADA de uma
// conversa direta/grupo agora (ver "call:join"/"call:leave" embaixo).
// Só em memória, de propósito: uma chamada em andamento não precisa
// sobreviver a um restart do servidor (ninguém ficaria conectado mesmo,
// já que o WebSocket também cai). Diferente do chat/agenda, que persistem
// em disco -- ver chatStore.js/agendaStore.js.
const activeCalls = new Map();

/** Quem tá na chamada de uma conversa agora, já com nome/cor/foto pra
 * desenhar (ver call:state embaixo) -- ignora silenciosamente qualquer
 * connectionId que já caiu (não deveria acontecer, já que "close" limpa
 * a call, mas defende contra corrida). */
function callParticipantsPayload(conversationId) {
  const set = activeCalls.get(conversationId);
  if (!set) return [];
  const out = [];
  for (const connId of set) {
    const conn = connectionsById.get(connId);
    if (!conn) continue;
    out.push({
      connectionId: connId,
      userId: conn.player.userId,
      name: conn.player.name,
      color: conn.player.color,
      photoUrl: conn.player.photoUrl,
    });
  }
  return out;
}

/** Avisa TODO MUNDO que participa da conversa (online, esteja ou não NA
 * chamada agora) que a lista de quem tá na chamada mudou -- é o que
 * acende o botão verde "entrar na call" de quem ainda não entrou (ver
 * "tipo discord" no pedido) e atualiza a lista de participantes de quem
 * já tá dentro. */
function broadcastCallState(conversationId) {
  const conv = chatStore.getConversation(conversationId);
  if (!conv) return;
  const participants = callParticipantsPayload(conversationId);
  for (const userId of conv.participantIds) {
    sendToUser(userId, { type: "call:state", conversationId, participants });
  }
}

/** Tira uma conexão de QUALQUER chamada em que ela esteja (ver "close"
 * embaixo -- fechar a aba/cair a conexão não pode deixar um fantasma pra
 * sempre "na chamada" pros outros). Avisa só as conversas de onde ela
 * realmente saiu. */
function leaveAllCalls(connectionId) {
  for (const [conversationId, set] of activeCalls) {
    if (!set.has(connectionId)) continue;
    set.delete(connectionId);
    if (set.size === 0) activeCalls.delete(conversationId);
    broadcastCallState(conversationId);
  }
}

/** Entrar numa chamada de conversa -- MESMO corpo que já vivia inline no
 * case "call:join" do switch grande (ver comentário dele), extraído pra
 * dar pra chamar também do socket do Lobby (ver handleLobbySocketConnection/
 * LOBBY_SOCKET_ROOM_ID mais abaixo, pedido do Douglas 1/out: "eles tem
 * que ser o mesmo, e ponto final" -- chamada de voz/vídeo não podia
 * continuar só-dentro-da-sala). Room-independente de propósito: só usa
 * chatStore/activeCalls, nunca precisou de roomId nenhum. */
function handleCallJoin(player, connectionId, conversationId) {
  if (typeof conversationId !== "string") return;
  if (!chatStore.isParticipant(conversationId, player.userId)) return;
  let set = activeCalls.get(conversationId);
  if (!set) {
    set = new Set();
    activeCalls.set(conversationId, set);
  }
  set.add(connectionId);
  broadcastCallState(conversationId);
}

/** Sair de uma chamada de conversa -- ver handleCallJoin acima. */
function handleCallLeave(connectionId, conversationId) {
  if (typeof conversationId !== "string") return;
  const set = activeCalls.get(conversationId);
  if (set) {
    set.delete(connectionId);
    if (set.size === 0) activeCalls.delete(conversationId);
  }
  broadcastCallState(conversationId);
}

/** "Fulano está digitando..." numa conversa de verdade (nunca a Sala,
 * que não faz sentido pro socket do Lobby) -- MESMO corpo que já vivia
 * inline no ramo "if" do case "chat:typing" (ver comentário grande dele),
 * extraído pelo mesmo motivo de handleCallJoin acima. */
function handleChatTyping(player, conversationId) {
  if (typeof conversationId !== "string" || !conversationId) return;
  if (!chatStore.isParticipant(conversationId, player.userId)) return;
  const conv = chatStore.getConversation(conversationId);
  for (const uid of conv.participantIds) {
    if (uid === player.userId) continue;
    sendToUser(uid, { type: "chat:typing", conversationId, userId: player.userId, name: player.name });
  }
}

// ---------------------------------------------------------------
// 1/out -- Douglas, depois de ver a unificação do CHAT só de aparência
// (mesmo componente, mas duas conexões/dois donos de estado diferentes
// por baixo -- REST+socket reduzido no Lobby, WebSocket completo na
// sala): "nao tem que ter chat de fora chat de dentro, tem que ter
// CHAT... pega o chat de dentro e transforma ele em CHAT que acompanha
// toda a plataforma". Essas funções são o "motor" de conversas diretas/
// grupo (histórico, enviar, apagar, reagir, fixar, arquivos, digitando,
// chamada) extraídas do switch da sala (ver case "chat:*"/"call:*"
// embaixo) pra serem chamadas tanto de lá quanto da conexão ÚNICA da
// plataforma (ver handlePlatformConnection mais abaixo, antigo
// handleLobbySocketConnection) -- a MESMA função roda pros dois casos,
// nunca duas implementações paralelas de novo. Nenhuma delas depende de
// `room`/`roomId` de conexão (a Sala continua um conceito à parte, só
// ela é de fato amarrada a UMA sala específica, ver chat:react/chat:pin/
// chat:unpin/chat:attachments com conversationId null mais abaixo, que
// CONTINUAM só no switch da sala) -- as que precisavam de roomId
// (carimbar "Empresa" com a logo/nome de uma sala) recebem esse valor
// como PARÂMETRO explícito agora (roomSlugForCompany), MESMO padrão que
// as rotas REST /chat/direct e /chat/create-group já usavam (o Lobby,
// sem WebSocket até aqui, nunca teve "a sala dessa conexão" pra inferir
// sozinho -- sempre mandou explícito, ver handlePostChatDirect acima).
// ---------------------------------------------------------------

function handleChatList(player, ws) {
  const conversations = chatStore.listConversationsForUser(player.userId);
  ws.send(JSON.stringify({ type: "chat:conversations", conversations }));
  for (const conv of conversations) {
    const participants = callParticipantsPayload(conv.id);
    if (participants.length > 0) {
      ws.send(JSON.stringify({ type: "call:state", conversationId: conv.id, participants }));
    }
  }
}

function handleChatOpen(player, ws, data) {
  if (typeof data.conversationId !== "string") return;
  if (!chatStore.isParticipant(data.conversationId, player.userId)) return;
  const messages = chatStore.getMessages(data.conversationId);
  const unreadSinceTs = chatStore.markConversationRead(data.conversationId, player.userId) ?? 0;
  ws.send(
    JSON.stringify({
      type: "chat:history",
      conversationId: data.conversationId,
      messages,
      unreadSinceTs,
      pins: chatStore.getConversationPins(data.conversationId),
      lastRead: chatStore.getConversationLastRead(data.conversationId),
    })
  );
  const conv = chatStore.getConversation(data.conversationId);
  if (conv) {
    for (const uid of conv.participantIds) {
      if (uid === player.userId) continue;
      sendToUser(uid, { type: "chat:read", conversationId: data.conversationId, userId: player.userId, ts: Date.now() });
    }
  }
}

async function handleChatCreateDirect(player, data, roomSlugForCompany) {
  if (typeof data.targetUserId !== "string" || !data.targetUserId) return;
  if (data.targetUserId === player.userId) return;
  const targetUserId = data.targetUserId;
  const targetPlayer = findLivePlayerByUserId(targetUserId);
  const eitherIsGuest = !player.accountVerified || !(targetPlayer?.accountVerified);
  const requestedLane = data.lane === "private" ? "private" : "company";
  const lane = eitherIsGuest ? "private" : requestedLane;
  if (lane === "private" && !eitherIsGuest && !(await chatStore.areMutualFriends(player.userId, targetUserId))) {
    return { error: "Só dá pra abrir conversa privada com quem é amigo mútuo." };
  }
  const companyInfo = lane === "company" && roomSlugForCompany ? await getRoomCompanyInfo(roomSlugForCompany) : null;
  const conv = chatStore.getOrCreateDirectConversation(player.userId, targetUserId, lane, companyInfo);
  sendConversationTo(player.userId, conv.id);
  sendConversationTo(targetUserId, conv.id);
  return { conversationId: conv.id };
}

async function handleChatSetLane(player, data, roomSlugForCompany) {
  if (typeof data.conversationId !== "string" || !data.conversationId) return;
  if (data.lane !== "company" && data.lane !== "private") return;
  const targetLane = data.lane;
  const conv = chatStore.getConversation(data.conversationId);
  if (!conv || !conv.participantIds.includes(player.userId)) return;
  const companyInfo = targetLane === "company" && roomSlugForCompany ? await getRoomCompanyInfo(roomSlugForCompany) : null;
  const result = chatStore.setConversationLane(data.conversationId, player.userId, targetLane, companyInfo);
  if (!result) return;
  const { conversation, removedConversationId } = result;
  for (const uid of conversation.participantIds) {
    if (removedConversationId) sendConversationRemovedTo(uid, removedConversationId);
    sendConversationTo(uid, conversation.id);
  }
  return { conversation, removedConversationId };
}

// "Silenciar"/"Apagar conversa" (2/out, pedido do Douglas: "nao tem
// opcao de Silenciar, e de Apagar conversa") -- ver comentário grande
// de setConversationMuted/setConversationHidden em chatStore.js. Os
// dois são flags SÓ do próprio usuário (nunca manda nada pros outros
// participantes -- diferente de chat:set_lane acima, que avisa todo
// mundo porque mexe na conversa de verdade), então só reusa os
// mesmos sendConversationTo/sendConversationRemovedTo que já existem,
// só que pra UM userId só (o de quem pediu).
function handleChatMute(player, data) {
  if (typeof data.conversationId !== "string" || !data.conversationId) return;
  const conv = chatStore.setConversationMuted(data.conversationId, player.userId, !!data.muted);
  if (!conv) return;
  sendConversationTo(player.userId, conv.id);
}

function handleChatHide(player, data) {
  if (typeof data.conversationId !== "string" || !data.conversationId) return;
  const conv = chatStore.setConversationHidden(data.conversationId, player.userId, true);
  if (!conv) return;
  sendConversationRemovedTo(player.userId, conv.id);
}

async function handleChatCreateGroup(player, data, roomSlugForCompany) {
  if (!Array.isArray(data.participantIds)) return;
  const participantIds = data.participantIds.filter((x) => typeof x === "string" && x).slice(0, 50);
  if (participantIds.length === 0) return;
  const companyInfo = roomSlugForCompany ? await getRoomCompanyInfo(roomSlugForCompany) : null;
  const conv = chatStore.createGroupConversation({
    name: data.name,
    participantIds,
    createdBy: player.userId,
    companyInfo,
  });
  for (const uid of conv.participantIds) sendConversationTo(uid, conv.id);
  return { conversationId: conv.id };
}

function handleChatRenameGroup(player, data) {
  if (typeof data.conversationId !== "string" || typeof data.name !== "string") return;
  if (!chatStore.isParticipant(data.conversationId, player.userId)) return;
  const conv = chatStore.renameGroupConversation(data.conversationId, data.name);
  if (!conv) return;
  for (const uid of conv.participantIds) sendConversationTo(uid, conv.id);
}

function handleChatSend(player, data) {
  if (typeof data.conversationId !== "string") return;
  if (!chatStore.isParticipant(data.conversationId, player.userId)) return;
  const text = typeof data.text === "string" ? data.text.slice(0, 2000) : "";
  const attachment =
    data.attachment && typeof data.attachment === "object"
      ? {
          url: data.attachment.url,
          name: data.attachment.name,
          size: data.attachment.size,
          mime: data.attachment.mime,
        }
      : null;
  const roomCard =
    data.roomCard && typeof data.roomCard === "object"
      ? {
          action: data.roomCard.action === "invite" ? "invite" : "visit",
          roomSlug: String(data.roomCard.roomSlug || "").slice(0, 200),
          roomName: String(data.roomCard.roomName || "").slice(0, 200),
          roomLogoUrl: String(data.roomCard.roomLogoUrl || "").slice(0, 500),
        }
      : null;
  if (!text.trim() && !attachment && !roomCard) return;
  const kind = roomCard
    ? "room_card"
    : !attachment
      ? "text"
      : data.kind === "audio"
        ? "audio"
        : data.kind === "image"
          ? "image"
          : "file";
  const msg = chatStore.addMessage(data.conversationId, {
    senderId: player.userId,
    senderName: player.name,
    kind,
    text,
    attachment,
    roomCard,
    mentionedUserIds: data.mentionedUserIds,
    // "responder"/"mencionar" mensagem (2/out) -- ver comentário
    // grande de addMessage em chatStore.js.
    replyToMessageId: typeof data.replyToMessageId === "string" ? data.replyToMessageId : null,
  });
  if (!msg) return;
  const conv = chatStore.getConversation(data.conversationId);
  for (const uid of conv.participantIds) {
    sendToUser(uid, { type: "chat:message", conversationId: data.conversationId, message: msg });
  }
}

function handleChatDeleteMessage(player, data) {
  if (typeof data.conversationId !== "string" || typeof data.messageId !== "string") return;
  if (!chatStore.isParticipant(data.conversationId, player.userId)) return;
  const deleted = chatStore.deleteMessage(data.conversationId, data.messageId, player.userId);
  if (!deleted) return;
  const conv = chatStore.getConversation(data.conversationId);
  for (const uid of conv.participantIds) {
    sendToUser(uid, { type: "chat:message_deleted", conversationId: data.conversationId, messageId: deleted.id });
  }
}

/** "chat:react" numa conversa de VERDADE (conversationId presente) --
 * o ramo Sala (conversationId ausente/null) continua só no switch da
 * sala, ver case "chat:react" embaixo: aquele depende de `room`/roomId
 * de verdade, não faz sentido fora de uma sala. */
function handleChatReactConversation(player, conversationId, messageId, emoji) {
  if (!chatStore.isParticipant(conversationId, player.userId)) return;
  const result = chatStore.toggleConversationReaction(conversationId, messageId, player.userId, emoji);
  if (!result) return;
  const conv = chatStore.getConversation(conversationId);
  for (const uid of conv.participantIds) {
    sendToUser(uid, { type: "chat:reaction", conversationId, messageId, reactions: result.reactions });
  }
}

/** "chat:pin" numa conversa de VERDADE -- mesmo motivo de
 * handleChatReactConversation acima, ramo Sala fica só no switch da
 * sala. */
function handleChatPinConversation(player, conversationId, messageId, durationMs) {
  if (!chatStore.isParticipant(conversationId, player.userId)) return;
  const pin = chatStore.pinConversationMessage(conversationId, messageId, player.userId, player.name, durationMs);
  if (!pin) return;
  const conv = chatStore.getConversation(conversationId);
  const pins = chatStore.getConversationPins(conversationId);
  for (const uid of conv.participantIds) {
    sendToUser(uid, { type: "chat:pins", conversationId, pins });
  }
}

/** "chat:unpin" numa conversa de VERDADE -- mesmo motivo de
 * handleChatReactConversation acima. */
function handleChatUnpinConversation(player, conversationId, messageId) {
  if (!chatStore.isParticipant(conversationId, player.userId)) return;
  if (!chatStore.unpinConversationMessage(conversationId, messageId)) return;
  const conv = chatStore.getConversation(conversationId);
  const pins = chatStore.getConversationPins(conversationId);
  for (const uid of conv.participantIds) {
    sendToUser(uid, { type: "chat:pins", conversationId, pins });
  }
}

/** "chat:attachments" (painel "arquivos da conversa") numa conversa de
 * VERDADE -- mesmo motivo de handleChatReactConversation acima. */
function handleChatAttachmentsConversation(player, ws, conversationId) {
  if (!chatStore.isParticipant(conversationId, player.userId)) return;
  ws.send(JSON.stringify({ type: "chat:attachments", conversationId, items: chatStore.getConversationAttachments(conversationId) }));
}

function broadcast(room, data, excludeId) {
  const msg = JSON.stringify(data);
  for (const [id, conn] of room) {
    if (id === excludeId) continue;
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(msg);
  }
}

// --- identidade persistente pro CHAT (ver comentário grande lá em cima) ---
// userId -> Set<ws> -- uma pessoa pode ter mais de uma aba/dispositivo
// aberta ao mesmo tempo, todas recebem as mensagens.
const connectionsByUserId = new Map();

function registerUserConnection(userId, ws) {
  let set = connectionsByUserId.get(userId);
  if (!set) {
    set = new Set();
    connectionsByUserId.set(userId, set);
  }
  set.add(ws);
}

function unregisterUserConnection(userId, ws) {
  const set = connectionsByUserId.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) connectionsByUserId.delete(userId);
}

function sendToUser(userId, data) {
  const set = connectionsByUserId.get(userId);
  if (!set) return;
  const msg = JSON.stringify(data);
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

/** Acha o `player` de verdade (com .accountVerified, .name etc) de um
 * userId, se ele estiver conectado AGORA em qualquer sala -- mesma
 * varredura de handleGetPresence (GET /room/presence) logo abaixo,
 * reaproveitada aqui pro fix "visitante não cai no chat empresa" (ver
 * comentário grande em chat:create_direct). connectionsByUserId só
 * guarda o Set<ws>, não o player -- o player de verdade vive dentro do
 * Map por sala (rooms), então precisa varrer. Retorna undefined se a
 * pessoa não estiver conectada em NENHUMA sala nesse instante (ex:
 * desconectou entre o clique e essa mensagem chegar) -- quem chama
 * trata esse caso como "não dá pra confirmar, assume visitante" (mais
 * seguro: nunca carimba "Empresa" numa dúvida). */
function findLivePlayerByUserId(userId) {
  for (const room of rooms.values()) {
    for (const { player } of room.values()) {
      if (player.userId === userId) return player;
    }
  }
  return undefined;
}

/** Manda a versão "enriquecida" (com participantes/preview) de UMA
 * conversa específica pro dono de um userId -- usado depois de criar/
 * renomear, cada participante vê a lista atualizar sozinha. */
function sendConversationTo(userId, conversationId) {
  const enriched = chatStore.listConversationsForUser(userId).find((c) => c.id === conversationId);
  if (enriched) sendToUser(userId, { type: "chat:conversation", conversation: enriched });
}

/** Avisa um usuário que uma conversa SUMIU da lista dele -- só
 * acontece hoje quando setConversationLane (ver chatStore.js) mescla
 * duas conversas em uma (mover pra uma aba que já tinha conversa com
 * a mesma pessoa) e a "perdedora" é apagada de vez. */
function sendConversationRemovedTo(userId, conversationId) {
  sendToUser(userId, { type: "chat:conversation_removed", conversationId });
}

// --- lembrete de call agendada (ver server/agendaStore.js) ---
const REMINDER_LEAD_MS = 5 * 60 * 1000; // avisa 5min antes do horário marcado
const MAX_SETTIMEOUT_MS = 2_147_000_000; // margem abaixo do limite de 32 bits do setTimeout (~24.8 dias)
// mensagem fixada (ver case "chat:pin"/"chat:unpin" e handlePostChatPin
// abaixo) -- teto de segurança pro "tempo de fixação" que o cliente
// manda (nunca confia num número cru vindo de fora): 30 dias, bem acima
// da maior opção que o composer oferece (7 dias, ver PIN_DURATION_OPTIONS
// em GameRoom.tsx), só pra nunca deixar alguém fixar "pra sempre" por um
// valor gigante disfarçado de "com prazo".
const MAX_PIN_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

function scheduleReminder(call) {
  const fireAt = call.startTs - REMINDER_LEAD_MS;
  const delay = fireAt - Date.now();
  // só agenda se falta MENOS que o limite do setTimeout -- calls marcadas
  // com muita antecedência não recebem lembrete (o servidor não guarda
  // timers em disco: se reiniciar antes da hora, esse lembrete específico
  // se perde; aceitável pro tamanho desse projeto, sem fila de jobs).
  if (delay <= 0 || delay > MAX_SETTIMEOUT_MS) return;
  setTimeout(() => {
    const fresh = agendaStore.getCall(call.id);
    if (!fresh) return;
    for (const p of fresh.participants) {
      if (p.status !== "declined") sendToUser(p.id, { type: "agenda:reminder", call: fresh });
    }
  }, delay);
}

// 1/out -- pedido do Douglas, mesmo espírito da migração do chat pra
// "motor único" (ver comentário grande de handleChatTyping/scheduleReminder
// etc. acima, e o pedido direto: "quero ela [a agenda] toda isolada
// tambem, e sistema unico, assim como o chat, funcionando acima de
// tudo, acima de lobby acima de jogo"). Esses 6 handlers eram só os
// corpos inline do case "agenda:*" do switch da sala (ver comentário
// grande deles lá embaixo) -- extraídos pra poderem ser chamados
// TAMBÉM do socket do Lobby (handleLobbySocketConnection/
// LOBBY_SOCKET_ROOM_ID mais abaixo), a MESMA função rodando pros dois
// casos. Nenhuma lógica nova, só reuso -- e já eram 100%
// room-independentes mesmo antes de mover (só usam player.userId/
// agendaStore/sendToUser/ws, nunca room/roomId), exatamente como
// handleCallJoin/scheduleReminder acima.
function handleAgendaList(player, ws) {
  const calls = agendaStore.listCallsForUser(player.userId);
  ws.send(JSON.stringify({ type: "agenda:calls", calls }));
}

function handleAgendaAvailability(player, ws, data) {
  if (!Array.isArray(data.candidateUserIds)) return;
  const candidateUserIds = data.candidateUserIds.filter((x) => typeof x === "string").slice(0, 100);
  const startTs = Number(data.startTs);
  const durationMinutes = Number(data.durationMinutes) || 30;
  if (!Number.isFinite(startTs)) return;
  const busyUserIds = agendaStore.getConflictingUserIds(candidateUserIds, startTs, durationMinutes);
  ws.send(JSON.stringify({ type: "agenda:availability", busyUserIds }));
}

function handleAgendaCreate(player, ws, data) {
  if (!Array.isArray(data.participantIds)) return;
  // participantIds pode vir vazio -- "a pessoa pode subir compromisso
  // pra ela sozinha" (sem convidar ninguém, só ocupa a própria agenda).
  // createCall sempre inclui quem criou, então um array vazio ainda
  // vira uma call válida com 1 participante.
  const participantIds = data.participantIds.filter((x) => typeof x === "string" && x).slice(0, 50);
  const startTs = Number(data.startTs);
  const durationMinutes = Number(data.durationMinutes) || 30;
  if (!Number.isFinite(startTs)) return;

  // revalida no servidor (defesa contra corrida: alguém marcou ENQUANTO
  // essa pessoa preenchia o formulário) -- se algum convidado ficou
  // ocupado nesse meio-tempo, recusa a criação inteira em vez de criar
  // silenciosamente sem essa pessoa.
  const busyUserIds = agendaStore.getConflictingUserIds(participantIds, startTs, durationMinutes);
  if (busyUserIds.length > 0) {
    ws.send(JSON.stringify({ type: "agenda:error", reason: "conflict", busyUserIds }));
    return;
  }

  const call = agendaStore.createCall({
    title: data.title,
    startTs,
    durationMinutes,
    needs: data.needs,
    participantIds,
    createdBy: player.userId,
    visibility: data.visibility === "private" ? "private" : "public",
    description: data.description,
    attachments: data.attachments,
    blocksAgenda: data.blocksAgenda,
  });
  for (const p of call.participants) {
    sendToUser(p.id, { type: "agenda:call", call });
    if (p.id !== player.userId) sendToUser(p.id, { type: "agenda:invite", call });
  }
  scheduleReminder(call);
}

function handleAgendaAddAttachment(player, data) {
  // anexar arquivo numa call já existente (ver comentário em
  // addAttachmentToCall em server/agendaStore.js) -- o upload em si já
  // rolou por HTTP (POST /upload, ver comentário grande no topo), aqui
  // só chega a URL resultante.
  if (typeof data.callId !== "string" || !data.callId) return;
  const call = agendaStore.addAttachmentToCall(data.callId, data.attachment, player.userId);
  if (!call) return;
  for (const p of call.participants) {
    sendToUser(p.id, { type: "agenda:call", call });
  }
}

function handleAgendaRespond(player, data) {
  if (typeof data.callId !== "string" || typeof data.status !== "string") return;
  const call = agendaStore.respondToCall(data.callId, player.userId, data.status);
  if (!call) return;
  for (const p of call.participants) {
    sendToUser(p.id, { type: "agenda:call", call });
  }
}

function handleAgendaViewColleague(player, ws, data) {
  // "pesquise a agenda de um colega" -- devolve as calls dele (privadas
  // vêm tarjadas se quem pediu não for participante, ver
  // listCallsForColleague em server/agendaStore.js). Não precisa ser
  // participante de nada em comum, qualquer um pode pesquisar qualquer um.
  if (typeof data.userId !== "string" || !data.userId) return;
  const targetUserId = data.userId.trim().slice(0, 80);
  const calls = agendaStore.listCallsForColleague(player.userId, targetUserId);
  ws.send(JSON.stringify({ type: "agenda:colleague_calls", userId: targetUserId, calls }));
}

// editar/apagar compromisso (2/out) -- antes só existia via REST
// (POST /agenda/update,delete, pedido do Douglas 29/set: "nao me da a
// agenda mesmo, editavel e criavel"), um bolt-on que só o Lobby tinha
// (LobbyAgendaPanel, removido -- ver comentário grande dele). Migrado
// pro protocolo único da agenda (mesmo motivo/mesmo formato do resto
// desse bloco) -- os dois lados (dentro da sala E no Lobby/AgendaDrawer
// global, ver app/page.tsx) ganham editar/apagar de graça agora, nunca
// só um dos dois. Só quem CRIOU o compromisso pode editar/apagar (ver
// agendaStore.updateCall/deleteCall) -- participantes continuam só
// podendo aceitar/recusar. Editar não mexe em quem foi convidado
// (mesma trava de sempre, participantes só se define na criação).
function handleAgendaUpdate(player, ws, data) {
  if (typeof data.callId !== "string" || !data.callId) return;
  const call = agendaStore.updateCall(data.callId, player.userId, {
    title: data.title,
    startTs: Number(data.startTs),
    durationMinutes: Number(data.durationMinutes) || 30,
    description: data.description,
  });
  if (!call) {
    ws.send(JSON.stringify({ type: "agenda:error", reason: "update_failed" }));
    return;
  }
  for (const p of call.participants) {
    sendToUser(p.id, { type: "agenda:call", call });
  }
}

function handleAgendaDelete(player, ws, data) {
  if (typeof data.callId !== "string" || !data.callId) return;
  const removed = agendaStore.deleteCall(data.callId, player.userId);
  if (!removed) {
    ws.send(JSON.stringify({ type: "agenda:error", reason: "delete_failed" }));
    return;
  }
  for (const p of removed.participants) {
    sendToUser(p.id, { type: "agenda:call_deleted", callId: removed.id });
  }
}

// campos do card de perfil que o PRÓPRIO jogador manda (ver mensagem
// "profile" acima) -- "role" fica de fora de propósito: é o único campo
// "setado pelo administrador" que o pedido descreve, e como ainda não
// existe login/admin nenhum aqui, cada jogador só recebe um valor fixo
// (PROFILE_ROLE_PLACEHOLDER) que o cliente mostra como somente-leitura.
const PROFILE_FIELDS = ["name", "status", "instagram", "bio", "photoUrl"];
const PROFILE_ROLE_PLACEHOLDER = "";
// aparência do boneco (ver protocolo "look" acima) -- mesmo esquema de
// PROFILE_FIELDS, só que quem decide o valor certo de cada campo é
// SEMPRE o cliente (catálogo/cor já resolvidos, ver SavedAvatar em
// GameRoom.tsx) -- o servidor só guarda e repassa pra sala, nunca
// valida contra um catálogo (não existe um aqui, de propósito -- mesma
// razão de "role" nunca vir do cliente em PROFILE_FIELDS, só que aqui é
// o oposto: não tem NADA que só o servidor saiba, então não tem campo
// de fora igual "role").
const LOOK_FIELDS = ["hairId", "skinId", "beardId", "accessoryId", "outfitId"];
// tamanho máx de uma mensagem (principalmente a foto de PERFIL, que vai
// como data-URL) -- generoso o bastante pra uma foto pequena comprimida
// no cliente (ver compressPhotoToDataUrl em GameRoom.tsx), mas evita que
// alguém trave a sala mandando um payload gigante. Anexos de CHAT não
// passam por aqui -- ver upload HTTP lá em cima, só a URL entra na
// mensagem WS, que é pequena.
const MAX_MESSAGE_BYTES = 900_000;

function pickProfileFields(player) {
  const out = {};
  for (const field of PROFILE_FIELDS) out[field] = player[field] ?? "";
  return out;
}

// ver LOOK_FIELDS acima -- diferente de pickProfileFields, usa null (não
// "") como vazio: "" seria um id de catálogo inválido que quebraria o
// find() do cliente (ver setRemoteLook, MainScene.ts, que já ignora
// campo nenhum/null de propósito -- ver comentário lá).
function pickLookFields(player) {
  const out = {};
  for (const field of LOOK_FIELDS) out[field] = player[field] ?? null;
  return out;
}

function syncChatUser(player) {
  if (!player.userId) return;
  chatStore.upsertUser(player.userId, {
    name: player.name,
    color: player.color,
    photoUrl: player.photoUrl,
  });
}

// --- upload de arquivo do chat: HTTP simples (sem multipart, o corpo
// inteiro do POST já É o arquivo) -- ver comentário grande no topo. ---
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20MB, dá pra foto/áudio curto/PDF pequeno

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".webm": "audio/webm",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip",
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    // "Content-Type" só não bastava -- o front manda "Authorization"
    // (login/dono, ver callerIsOwner acima) em GET/POST /room/floor,
    // /room/areas e /room/furniture, e o preflight OPTIONS (handler lá
    // embaixo, mesma corsHeaders()) rejeitava esse header (Douglas:
    // "adicionei uma cadeira e ela sumiu" -- o POST /room/furniture
    // nunca chegava a rodar, ficava bloqueado no preflight do próprio
    // navegador -- console mostrava "Request header field authorization
    // is not allowed by Access-Control-Allow-Headers").
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function handleUpload(req, res, url) {
  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentLength > MAX_UPLOAD_BYTES) {
    res.writeHead(413, corsHeaders());
    res.end("Arquivo muito grande (máx 20MB)");
    return;
  }

  const filenameParam = (url.searchParams.get("filename") || "arquivo").slice(0, 200);
  const ext = path.extname(filenameParam).slice(0, 12);
  const diskName = `${randomUUID()}${ext}`;
  const diskPath = path.join(UPLOAD_DIR, diskName);
  const writeStream = createWriteStream(diskPath);

  let received = 0;
  let aborted = false;

  req.on("data", (chunk) => {
    received += chunk.length;
    if (received > MAX_UPLOAD_BYTES && !aborted) {
      aborted = true;
      writeStream.destroy();
      unlink(diskPath).catch(() => {});
      if (!res.headersSent) {
        res.writeHead(413, corsHeaders());
        res.end("Arquivo muito grande (máx 20MB)");
      }
      req.destroy();
    }
  });

  req.on("error", () => {
    writeStream.destroy();
  });

  req.pipe(writeStream);

  writeStream.on("finish", () => {
    if (aborted) return;
    res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        url: `/uploads/${diskName}`,
        name: filenameParam,
        size: received,
        mime: req.headers["content-type"] || "",
      })
    );
  });

  writeStream.on("error", (e) => {
    console.error("Falha ao salvar upload", e);
    if (!res.headersSent) {
      res.writeHead(500, corsHeaders());
      res.end("Erro ao salvar arquivo");
    }
  });
}

function handleServeUpload(req, res, pathname) {
  // path.basename corta qualquer "../" -- só deixa pegar arquivo direto
  // de dentro de UPLOAD_DIR, nunca escapar pra outra pasta.
  const safeName = path.basename(pathname);
  const filePath = path.join(UPLOAD_DIR, safeName);
  if (!filePath.startsWith(UPLOAD_DIR) || !existsSync(filePath)) {
    res.writeHead(404, corsHeaders());
    res.end("Não encontrado");
    return;
  }
  const ext = path.extname(safeName).toLowerCase();
  const mime = MIME_BY_EXT[ext] || "application/octet-stream";
  res.writeHead(200, {
    ...corsHeaders(),
    "Content-Type": mime,
    "Cache-Control": "public, max-age=31536000, immutable",
  });
  createReadStream(filePath).pipe(res);
}

/** Extrai o slug da sala (ver comentário grande "MULTI-SALA" em
 * server/roomStore.js) do query string de uma rota REST /room/* -- ex:
 * GET /room/shape?room=mapa-modelo. Sem "?room=" (todo request de hoje,
 * antes do Lobby ganhar um 2º espaço clicável -- ver Lobby.tsx), cai
 * pro slug padrão (roomStore trata undefined como DEFAULT_ROOM_SLUG
 * sozinho) -- é assim que "mapa-publicado" continua funcionando
 * IDÊNTICO a antes, sem precisar mandar "?room=mapa-publicado" toda
 * vez. */
function roomSlugFromUrl(url) {
  const raw = url.searchParams.get("room");
  return raw && raw.trim() ? raw.trim().slice(0, 80) : undefined;
}

/** GET /room/shape -- formato salvo da sala (ver comentário grande de
 * roomTiles em roomStore.js), pedido do Douglas: "eu quero adicionar
 * mais piso alem do limite que ja tem da sala, quero aumentar a sala"
 * (aba "Tamanho" no editor de espaço). Devolve pra popular a cena assim
 * que ela fica pronta (ver MainScene.loadSavedRoomShape, chamado pelo
 * React em GameRoom.tsx), mesma ideia/mesmo formato de resposta
 * ({items: [...]}) de handleGetFloor logo abaixo. */
async function handleGetShape(req, res, url) {
  const roomSlug = roomSlugFromUrl(url);
  res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
  res.end(JSON.stringify({ items: await roomStore.getRoomShape(roomSlug) }));
}

/** POST /room/shape -- mesma trava/mesmo limite de tamanho de corpo de
 * handlePostFloor abaixo (só o DONO da sala salva em produção). */
async function handlePostShape(req, res, url) {
  const roomSlug = roomSlugFromUrl(url);
  if (process.env.NODE_ENV === "production" && !(await callerIsOwner(req, roomSlug))) {
    res.writeHead(403, corsHeaders());
    res.end("Editor de espaço desativado em produção.");
    return;
  }

  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentLength > MAX_ROOM_BODY_BYTES) {
    res.writeHead(413, corsHeaders());
    res.end("Corpo grande demais");
    return;
  }

  const chunks = [];
  let received = 0;
  let aborted = false;

  req.on("data", (chunk) => {
    received += chunk.length;
    if (received > MAX_ROOM_BODY_BYTES && !aborted) {
      aborted = true;
      if (!res.headersSent) {
        res.writeHead(413, corsHeaders());
        res.end("Corpo grande demais");
      }
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on("end", async () => {
    if (aborted) return;
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400, corsHeaders());
      res.end("JSON inválido");
      return;
    }
    const saved = await roomStore.setRoomShape(roomSlug, data?.items);
    if (saved === null) {
      res.writeHead(400, corsHeaders());
      res.end('Corpo precisa ter "items" (array, nunca vazio -- a sala não pode ficar sem tile nenhum)');
      return;
    }
    res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, items: saved }));
  });
}

/** GET /room/floor -- ver comentário grande no topo do arquivo. Devolve o
 * piso salvo pra popular a cena assim que ela fica pronta (ver
 * loadSavedFloor em MainScene.ts, chamado pelo React em GameRoom.tsx). */
async function handleGetFloor(req, res, url) {
  const roomSlug = roomSlugFromUrl(url);
  res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
  res.end(JSON.stringify({ items: await roomStore.getFloor(roomSlug) }));
}

/** GET /room/walls -- mesma ideia de handleGetFloor acima, ver
 * game/wall.ts (WallSegmentDef) e loadSavedWall em MainScene.ts. */
async function handleGetWalls(req, res, url) {
  const roomSlug = roomSlugFromUrl(url);
  res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
  res.end(JSON.stringify({ items: await roomStore.getWalls(roomSlug) }));
}

/** POST /room/walls -- mesma ideia/travas de handlePostFloor acima, só
 * troca roomStore.setFloor por roomStore.setWalls. */
async function handlePostWalls(req, res, url) {
  const roomSlug = roomSlugFromUrl(url);
  if (process.env.NODE_ENV === "production" && !(await callerIsOwner(req, roomSlug))) {
    res.writeHead(403, corsHeaders());
    res.end("Editor de espaço desativado em produção.");
    return;
  }

  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentLength > MAX_ROOM_BODY_BYTES) {
    res.writeHead(413, corsHeaders());
    res.end("Corpo grande demais");
    return;
  }

  const chunks = [];
  let received = 0;
  let aborted = false;

  req.on("data", (chunk) => {
    received += chunk.length;
    if (received > MAX_ROOM_BODY_BYTES && !aborted) {
      aborted = true;
      if (!res.headersSent) {
        res.writeHead(413, corsHeaders());
        res.end("Corpo grande demais");
      }
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on("end", async () => {
    if (aborted) return;
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400, corsHeaders());
      res.end("JSON inválido");
      return;
    }
    const saved = await roomStore.setWalls(roomSlug, data?.items);
    if (saved === null) {
      res.writeHead(400, corsHeaders());
      res.end('Corpo precisa ter "items" (array)');
      return;
    }
    res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, items: saved }));
  });

  req.on("error", () => {
    aborted = true;
  });
}

/** GET /room/doors -- mesma ideia de handleGetWalls acima, ver
 * game/door.ts (DoorSegmentDef) e loadSavedDoors em MainScene.ts. */
async function handleGetDoors(req, res, url) {
  const roomSlug = roomSlugFromUrl(url);
  res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
  res.end(JSON.stringify({ items: await roomStore.getDoors(roomSlug) }));
}

/** POST /room/doors -- mesma ideia/travas de handlePostWalls acima, só
 * troca roomStore.setWalls por roomStore.setDoors. */
async function handlePostDoors(req, res, url) {
  const roomSlug = roomSlugFromUrl(url);
  if (process.env.NODE_ENV === "production" && !(await callerIsOwner(req, roomSlug))) {
    res.writeHead(403, corsHeaders());
    res.end("Editor de espaço desativado em produção.");
    return;
  }

  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentLength > MAX_ROOM_BODY_BYTES) {
    res.writeHead(413, corsHeaders());
    res.end("Corpo grande demais");
    return;
  }

  const chunks = [];
  let received = 0;
  let aborted = false;

  req.on("data", (chunk) => {
    received += chunk.length;
    if (received > MAX_ROOM_BODY_BYTES && !aborted) {
      aborted = true;
      if (!res.headersSent) {
        res.writeHead(413, corsHeaders());
        res.end("Corpo grande demais");
      }
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on("end", async () => {
    if (aborted) return;
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400, corsHeaders());
      res.end("JSON inválido");
      return;
    }
    const saved = await roomStore.setDoors(roomSlug, data?.items);
    if (saved === null) {
      res.writeHead(400, corsHeaders());
      res.end('Corpo precisa ter "items" (array)');
      return;
    }
    res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, items: saved }));
  });

  req.on("error", () => {
    aborted = true;
  });
}

/** GET /room/presence -- contagem de membro x visitante ONLINE agora
 * (ver painel de configuração de membros em RoomMembersPanel.tsx) --
 * "membro" = conta confirmada (player.accountVerified, ver
 * roomAuth.js) E presente em room_members com status ativo; todo o
 * resto (sem conta, ou com conta mas nunca promovido) conta como
 * "visitante". Dedupe por userId -- a mesma pessoa com 2 abas abertas
 * conta uma vez só.
 *
 * Com ?detail=1 E um Authorization: Bearer <token> de quem é OWNER,
 * também devolve "onlineVisitors" (visitante com conta confirmada,
 * ainda não promovido, que tá na sala AGORA) -- é a lista que alimenta
 * o botão "Promover" do painel, pra não precisar de um "buscar por
 * email" separado. Sem token de owner, esse campo simplesmente não
 * vem (o resto da resposta -- os números -- não é sensível, fica
 * público). */
async function handleGetPresence(req, res, url) {
  const memberIds = await getActiveMemberIds();
  const byUserId = new Map();
  for (const room of rooms.values()) {
    for (const { player } of room.values()) {
      byUserId.set(player.userId, player);
    }
  }
  let memberCount = 0;
  let visitorCount = 0;
  const onlineVisitors = [];
  for (const [userId, player] of byUserId) {
    const isMember = player.accountVerified && memberIds.has(userId);
    if (isMember) {
      memberCount++;
    } else {
      visitorCount++;
      if (player.accountVerified) onlineVisitors.push({ userId, name: player.name || "" });
    }
  }

  const payload = { memberCount, visitorCount, totalOnline: byUserId.size };
  if (url.searchParams.get("detail") === "1") {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const callerUserId = token ? await verifyAccessToken(token) : null;
    const role = callerUserId ? await getRole(callerUserId) : null;
    if (role === "owner") payload.onlineVisitors = onlineVisitors;
  }

  res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

/** Lê e faz JSON.parse do corpo de um POST pequeno (chat/agenda daqui
 * pra baixo -- texto curto, nunca upload de arquivo, ver MAX_LOBBY_BODY_BYTES),
 * mesmo padrão chunk-a-chunk de handlePostFloor/handlePostWalls/etc (só
 * que fatorado -- esses dois endpoints novos não precisam репetir as
 * ~25 linhas de novo). Resolve null e JÁ escreve a resposta de erro
 * (400/413) quando o corpo vem grande/inválido demais -- quem chamou só
 * precisa checar `if (!body) return`. */
const MAX_LOBBY_BODY_BYTES = 8_000;
function readJsonBody(req, res) {
  return new Promise((resolve) => {
    const contentLength = Number(req.headers["content-length"] || 0);
    if (contentLength > MAX_LOBBY_BODY_BYTES) {
      res.writeHead(413, corsHeaders());
      res.end("Corpo grande demais");
      resolve(null);
      return;
    }
    const chunks = [];
    let received = 0;
    let aborted = false;
    req.on("data", (chunk) => {
      received += chunk.length;
      if (received > MAX_LOBBY_BODY_BYTES && !aborted) {
        aborted = true;
        if (!res.headersSent) {
          res.writeHead(413, corsHeaders());
          res.end("Corpo grande demais");
        }
        req.destroy();
        resolve(null);
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => {
      if (aborted) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        res.writeHead(400, corsHeaders());
        res.end("JSON inválido");
        resolve(null);
      }
    });
    req.on("error", () => {
      aborted = true;
      resolve(null);
    });
  });
}

/** GET /chat/messages?conversationId=X&userId=Y -- histórico de UMA
 * conversa, pro Lobby mostrar ao clicar numa conversa da prévia (ver
 * handleGetChatSummary acima). Só devolve se userId for participante de
 * verdade (mesma trava de chatStore.isParticipant usada pelo
 * WebSocket) -- sem isso, qualquer um adivinhando um conversationId
 * leria mensagem de conversa alheia. */
function handleGetChatMessages(req, res, url) {
  const userId = url.searchParams.get("userId");
  const conversationId = url.searchParams.get("conversationId");
  if (!userId || !conversationId) {
    res.writeHead(400, corsHeaders());
    res.end('Falta "userId"/"conversationId"');
    return;
  }
  if (!chatStore.isParticipant(conversationId, userId)) {
    res.writeHead(403, corsHeaders());
    res.end("Não é participante dessa conversa.");
    return;
  }
  res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
  // 1/out, pedido do Douglas (espelhar no Lobby o que o chat de dentro
  // da sala ganhou: reação/@menção/"visto por"/fixar/painel de
  // arquivos) -- esse GET já é chamado em POLLING (ver fetchMessages
  // a cada 4s em LobbyChatPanel/components/Lobby.tsx), então junto com
  // `pins`/`lastRead` aqui o Lobby ganha "visto por" e a faixa de
  // fixadas ATUALIZANDO SOZINHOS a cada poll, sem precisar de um
  // endpoint novo nem de mais um round-trip (ao contrário do POST
  // /chat/open, que só roda UMA VEZ ao abrir a conversa -- ver
  // comentário grande dele logo abaixo -- esse aqui não marca como
  // lida, só LÊ, então pode repetir à vontade sem efeito colateral).
  res.end(
    JSON.stringify({
      messages: chatStore.getMessages(conversationId),
      pins: chatStore.getConversationPins(conversationId),
      lastRead: chatStore.getConversationLastRead(conversationId),
    })
  );
}

/** POST /chat/open -- marca uma conversa como lida pro Lobby, MESMA
 * ideia/mesmo retorno do case "chat:open" do WebSocket acima
 * (chatStore.markConversationRead + unreadSinceTs pra linha "mensagens
 * não vistas"), só que sem socket -- o Lobby chama isso toda vez que
 * abre uma conversa no LobbyChatPanel (ver comentário grande no topo
 * de components/Lobby.tsx sobre esse painel ser REST-only). */
async function handlePostChatOpen(req, res) {
  const body = await readJsonBody(req, res);
  if (!body) return;
  const { conversationId, userId } = body;
  if (typeof conversationId !== "string" || typeof userId !== "string" || !userId) {
    res.writeHead(400, corsHeaders());
    res.end('Corpo precisa ter "conversationId"/"userId"');
    return;
  }
  if (!chatStore.isParticipant(conversationId, userId)) {
    res.writeHead(403, corsHeaders());
    res.end("Não é participante dessa conversa.");
    return;
  }
  const unreadSinceTs = chatStore.markConversationRead(conversationId, userId) ?? 0;
  // 1/out: mesmo par pins/"visto por" que o case "chat:open" do
  // WebSocket ganhou (ver comentário grande lá) -- manda a faixa de
  // fixadas junto (sem round-trip extra) e avisa o resto da conversa em
  // tempo real (só alcança quem JÁ tiver socket aberto, ver comentário
  // grande no topo dessa função -- quem só tem o Lobby também vê ao
  // reabrir, por causa do lastRead que já fica salvo de qualquer jeito).
  const conv = chatStore.getConversation(conversationId);
  if (conv) {
    for (const uid of conv.participantIds) {
      if (uid === userId) continue;
      sendToUser(uid, { type: "chat:read", conversationId, userId, ts: Date.now() });
    }
  }
  res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      ok: true,
      unreadSinceTs,
      pins: chatStore.getConversationPins(conversationId),
      lastRead: chatStore.getConversationLastRead(conversationId),
    })
  );
}

/** POST /chat/react -- MESMA ação do case "chat:react" do WebSocket
 * (reação com emoji, "toggle"), sem socket -- ver comentário grande no
 * topo do arquivo. Só serve conversa de verdade (o Lobby nunca tá
 * "dentro" de uma Sala, sem roomId nenhum aqui -- reagir no chat da
 * Sala continua exclusivo de dentro dela, ver ChatDrawer). */
async function handlePostChatReact(req, res) {
  const body = await readJsonBody(req, res);
  if (!body) return;
  const { conversationId, userId, messageId, emoji } = body;
  if (
    typeof conversationId !== "string" || !conversationId ||
    typeof userId !== "string" || !userId ||
    typeof messageId !== "string" || !messageId ||
    typeof emoji !== "string" || !emoji
  ) {
    res.writeHead(400, corsHeaders());
    res.end('Corpo precisa ter "conversationId"/"userId"/"messageId"/"emoji"');
    return;
  }
  if (!chatStore.isParticipant(conversationId, userId)) {
    res.writeHead(403, corsHeaders());
    res.end("Não é participante dessa conversa.");
    return;
  }
  const result = chatStore.toggleConversationReaction(conversationId, messageId, userId, emoji);
  if (!result) {
    res.writeHead(400, corsHeaders());
    res.end("Mensagem não encontrada (ou já apagada).");
    return;
  }
  const conv = chatStore.getConversation(conversationId);
  for (const uid of conv.participantIds) {
    sendToUser(uid, { type: "chat:reaction", conversationId, messageId, reactions: result.reactions });
  }
  res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, reactions: result.reactions }));
}

/** POST /chat/pin e POST /chat/unpin -- MESMA ação dos cases
 * "chat:pin"/"chat:unpin" do WebSocket, sem socket (ver comentário
 * grande no topo do arquivo). `unpin` reaproveita essa função com
 * `body.unpin === true` em vez de duplicar o corpo inteiro. */
async function handlePostChatPin(req, res, { unpin } = {}) {
  const body = await readJsonBody(req, res);
  if (!body) return;
  const { conversationId, userId, messageId } = body;
  if (
    typeof conversationId !== "string" || !conversationId ||
    typeof userId !== "string" || !userId ||
    typeof messageId !== "string" || !messageId
  ) {
    res.writeHead(400, corsHeaders());
    res.end('Corpo precisa ter "conversationId"/"userId"/"messageId"');
    return;
  }
  if (!chatStore.isParticipant(conversationId, userId)) {
    res.writeHead(403, corsHeaders());
    res.end("Não é participante dessa conversa.");
    return;
  }
  let ok;
  if (unpin) {
    ok = chatStore.unpinConversationMessage(conversationId, messageId);
  } else {
    const durationMs =
      Number.isFinite(body.durationMs) && body.durationMs > 0
        ? Math.min(Number(body.durationMs), MAX_PIN_DURATION_MS)
        : null;
    const senderName = typeof body.userName === "string" ? body.userName.slice(0, 80) : "";
    ok = !!chatStore.pinConversationMessage(conversationId, messageId, userId, senderName, durationMs);
  }
  if (!ok) {
    res.writeHead(400, corsHeaders());
    res.end("Não deu pra fixar/desafixar (mensagem não encontrada ou já apagada).");
    return;
  }
  const conv = chatStore.getConversation(conversationId);
  const pins = chatStore.getConversationPins(conversationId);
  for (const uid of conv.participantIds) {
    sendToUser(uid, { type: "chat:pins", conversationId, pins });
  }
  res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, pins }));
}

/** GET /chat/attachments?conversationId=X&userId=Y -- MESMA ação do
 * case "chat:attachments" do WebSocket, sem socket (painel lateral de
 * arquivos/imagens, ver comentário grande no topo do arquivo). */
function handleGetChatAttachments(req, res, url) {
  const userId = url.searchParams.get("userId");
  const conversationId = url.searchParams.get("conversationId");
  if (!userId || !conversationId) {
    res.writeHead(400, corsHeaders());
    res.end('Falta "userId"/"conversationId"');
    return;
  }
  if (!chatStore.isParticipant(conversationId, userId)) {
    res.writeHead(403, corsHeaders());
    res.end("Não é participante dessa conversa.");
    return;
  }
  res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
  res.end(JSON.stringify({ items: chatStore.getConversationAttachments(conversationId) }));
}

/** POST /chat/set-lane -- MESMA ação do case "chat:set_lane" do
 * WebSocket acima ("3 pontinhos" -- mover conversa 1x1 pra outra aba),
 * só que sem socket -- o Lobby chama isso (ver comentário grande no
 * topo de components/Lobby.tsx sobre esse painel ser REST-only). SEM
 * companyInfo: o Lobby não tá "dentro" de nenhuma sala específica (não
 * tem roomId nenhum aqui, diferente do WS que sabe a sala da conexão),
 * então mover pra "company" pelo Lobby nunca carimba logo/nome de
 * empresa (fica com o ícone genérico, ver CompanyIcon em
 * components/Lobby.tsx) -- só um "jogar pra lá dentro da sala" (ver
 * chat:set_lane) carimba de verdade. Empurra em tempo real
 * (sendToUser) pra quem já tiver socket aberto (ex: a outra pessoa tá
 * dentro de uma sala agora), mesmo espírito de handlePostChatSend
 * abaixo. */
async function handlePostChatSetLane(req, res) {
  const body = await readJsonBody(req, res);
  if (!body) return;
  const { conversationId, userId, lane } = body;
  if (typeof conversationId !== "string" || typeof userId !== "string" || !userId) {
    res.writeHead(400, corsHeaders());
    res.end('Corpo precisa ter "conversationId"/"userId"');
    return;
  }
  if (lane !== "company" && lane !== "private") {
    res.writeHead(400, corsHeaders());
    res.end('"lane" precisa ser "company" ou "private"');
    return;
  }
  // 30/set, bug reportado pelo Douglas: "adicionei logo a empresa e no
  // chat nao carregou" -- mover uma conversa pra "Empresa" por aqui
  // (Lobby, sem WebSocket/sem roomId de conexão) NUNCA carimbava
  // logo/nome, sempre `null` (comentário antigo, agora corrigido) --
  // "onde" vem do client explícito (a sala PRÓPRIA de quem está
  // movendo, ver myRoomSlug/moveConversationLane em
  // components/Lobby.tsx), mesma origem que POST /chat/direct abaixo.
  const roomSlug = typeof body.roomSlug === "string" ? body.roomSlug.trim() : "";
  const companyInfo = lane === "company" && roomSlug ? await getRoomCompanyInfo(roomSlug) : null;
  const result = chatStore.setConversationLane(conversationId, userId, lane, companyInfo);
  if (!result) {
    res.writeHead(403, corsHeaders());
    res.end("Não dá pra mover essa conversa (não existe, é grupo, ou você não participa dela).");
    return;
  }
  const { conversation, removedConversationId } = result;
  for (const uid of conversation.participantIds) {
    if (uid === userId) continue;
    if (removedConversationId) sendConversationRemovedTo(uid, removedConversationId);
    sendConversationTo(uid, conversation.id);
  }
  const enriched = chatStore.listConversationsForUser(userId).find((c) => c.id === conversation.id);
  res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, conversation: enriched, removedConversationId }));
}

/** POST /chat/send -- manda mensagem de TEXTO numa conversa já
 * existente, sem precisar abrir WebSocket -- pedido do Douglas: os
 * botões de chat/agenda do Lobby "mantenha igual de dentro da sala"
 * (28/set). MESMA trava/lógica do case "chat:send" no WebSocket (ver
 * comentário grande no topo do arquivo) -- só sem anexo (áudio/imagem/
 * arquivo continuam precisando abrir a sala de verdade, ver
 * ChatDrawer). Empurra a mensagem em tempo real (sendToUser) pra quem
 * JÁ tiver uma conexão WebSocket aberta (ex: a outra pessoa já tá
 * dentro da sala) -- quem também tiver só o Lobby aberto vê ao reabrir
 * a conversa (sem socket lá, sem como empurrar). */
async function handlePostChatSend(req, res) {
  const body = await readJsonBody(req, res);
  if (!body) return;
  const { conversationId, userId, userName } = body;
  if (typeof conversationId !== "string" || typeof userId !== "string" || !userId) {
    res.writeHead(400, corsHeaders());
    res.end('Corpo precisa ter "conversationId"/"userId"');
    return;
  }
  if (!chatStore.isParticipant(conversationId, userId)) {
    res.writeHead(403, corsHeaders());
    res.end("Não é participante dessa conversa.");
    return;
  }
  const text = typeof body.text === "string" ? body.text.slice(0, 2000) : "";
  // 30/set, pedido do Douglas: "fora da sala nao deixa anexar e mandar
  // audio, adicione" -- Lobby (REST, sem WebSocket) agora aceita o
  // MESMO formato de anexo/cardzinho que o "chat:send" do WebSocket
  // (ver case em cima); o upload em si continua indo direto pro POST
  // /upload (rota já pública/sem trava de sala nenhuma, ver
  // uploadChatFile em components/Lobby.tsx) -- aqui só valida e
  // guarda a mensagem, igual sempre.
  const attachment =
    body.attachment && typeof body.attachment === "object"
      ? {
          url: String(body.attachment.url || "").slice(0, 500),
          name: String(body.attachment.name || "arquivo").slice(0, 200),
          size: Number(body.attachment.size) || 0,
          mime: String(body.attachment.mime || "").slice(0, 100),
        }
      : null;
  // cardzinho de convite/visita (ver comentário grande em
  // chatStore.addMessage) -- pedido do Douglas, 30/set: "os contatos,
  // se convidarem direto com envio de convite que na conversa fica
  // como um cardzinho".
  const roomCard =
    body.roomCard && typeof body.roomCard === "object"
      ? {
          action: body.roomCard.action === "invite" ? "invite" : "visit",
          roomSlug: String(body.roomCard.roomSlug || "").slice(0, 200),
          roomName: String(body.roomCard.roomName || "").slice(0, 200),
          roomLogoUrl: String(body.roomCard.roomLogoUrl || "").slice(0, 500),
        }
      : null;
  if (!text.trim() && !attachment && !roomCard) {
    res.writeHead(400, corsHeaders());
    res.end('Falta "text"/anexo/cardzinho');
    return;
  }
  const kind = roomCard
    ? "room_card"
    : !attachment
      ? "text"
      : body.kind === "audio"
        ? "audio"
        : body.kind === "image"
          ? "image"
          : "file";
  const senderName = typeof userName === "string" ? userName.slice(0, 80) : "";
  // registra/atualiza o nome no diretório (ver chatStore.upsertUser,
  // MESMA função que o WebSocket chama no "identify" -- syncChatUser
  // aqui em cima) -- sem isso, alguém que só usa o Lobby (nunca abriu
  // a sala/nunca mandou "identify") apareceria sem nome pros outros.
  if (senderName) chatStore.upsertUser(userId, { name: senderName });
  const msg = chatStore.addMessage(conversationId, {
    senderId: userId,
    senderName,
    kind,
    text,
    attachment,
    roomCard,
    mentionedUserIds: body.mentionedUserIds,
  });
  const conv = chatStore.getConversation(conversationId);
  for (const uid of conv.participantIds) {
    sendToUser(uid, { type: "chat:message", conversationId, message: msg });
  }
  res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, message: msg }));
}

/** GET /users/directory -- "todo mundo já cadastrado no ambiente"
 * (MESMA lista que o WebSocket manda em "users:list", ver
 * chatStore.listAllUsers) sem precisar abrir socket -- pedido do
 * Douglas: "quero agora, mais um icone de contatos" no Lobby (28/set).
 * Pública/sem filtro por sala de propósito, mesma regra de sempre
 * (catálogo/diretório de chat não é por sala, ver comentário grande em
 * chatStore.js). */
function handleGetUsersDirectory(req, res) {
  res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
  res.end(JSON.stringify({ users: chatStore.listAllUsers() }));
}

/** POST /chat/direct -- cria (ou acha) a conversa direta com um
 * contato e devolve ela já no formato "enriquecido" de
 * listConversationsForUser (participantes com nome, lastMessage) --
 * pra Lobby.tsx poder abrir ela direto no painel de chat, mesmo fluxo
 * de startDirectWith em GameRoom.tsx, só que sem WebSocket (ver
 * comentário grande no topo de components/Lobby.tsx). */
function handlePostChatDirect(req, res) {
  readJsonBody(req, res).then(async (body) => {
    if (!body) return;
    const { userId, userName, targetUserId } = body;
    if (typeof userId !== "string" || !userId || typeof targetUserId !== "string" || !targetUserId) {
      res.writeHead(400, corsHeaders());
      res.end('Corpo precisa ter "userId"/"targetUserId"');
      return;
    }
    if (userId === targetUserId) {
      res.writeHead(400, corsHeaders());
      res.end("Não dá pra conversar com você mesmo.");
      return;
    }
    // lane "private" (aba "Conversas Privadas", ver comentário grande
    // em chatStore.getOrCreateDirectConversation) só é criável entre
    // amigos mútuos -- pedido do Douglas: "conversas privadas e so
    // desses amigos". Qualquer outro valor (ou ausente) cai pra
    // "company", que é o comportamento de sempre (sem trava).
    const lane = body.lane === "private" ? "private" : "company";
    if (lane === "private" && !(await chatStore.areMutualFriends(userId, targetUserId))) {
      res.writeHead(403, corsHeaders());
      res.end("Só dá pra abrir conversa privada com quem é amigo mútuo.");
      return;
    }
    const senderName = typeof userName === "string" ? userName.slice(0, 80) : "";
    if (senderName) chatStore.upsertUser(userId, { name: senderName });
    // 30/set, mesmo bug/mesma correção do POST /chat/set-lane acima --
    // "onde" vem do client explícito (a sala PRÓPRIA de quem está
    // criando a conversa, ver myRealRoom/handleStartConversation em
    // components/Lobby.tsx), já que o Lobby não tem roomId de conexão
    // (sem WebSocket) igual o case "chat:create_direct" tem.
    const roomSlug = typeof body.roomSlug === "string" ? body.roomSlug.trim() : "";
    const companyInfo = lane === "company" && roomSlug ? await getRoomCompanyInfo(roomSlug) : null;
    const conv = chatStore.getOrCreateDirectConversation(userId, targetUserId, lane, companyInfo);
    const enriched = chatStore.listConversationsForUser(userId).find((c) => c.id === conv.id);
    // avisa o OUTRO participante em tempo real, se ele já tiver a sala
    // aberta em outra aba (mesmo "chat:conversation" que o WebSocket
    // manda ao criar, ver case "chat:create_direct").
    const otherEnriched = chatStore.listConversationsForUser(targetUserId).find((c) => c.id === conv.id);
    if (otherEnriched) sendToUser(targetUserId, { type: "chat:conversation", conversation: otherEnriched });
    res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, conversation: enriched }));
  });
}

/** POST /chat/delete -- apaga uma mensagem numa conversa direta/grupo
 * sem precisar abrir WebSocket (pedido do Douglas, 1/out: "quero a
 * mesma estrutura nao que seja separado" -- o Lobby ganhou essa ação
 * só agora porque até aqui ele desenhava o próprio JSX sem esse
 * botão; MESMA trava do case "chat:delete" acima -- só quem mandou
 * apaga, apaga PRA TODOS, ver chatStore.deleteMessage). */
async function handlePostChatDelete(req, res) {
  const body = await readJsonBody(req, res);
  if (!body) return;
  const { conversationId, userId, messageId } = body;
  if (
    typeof conversationId !== "string" || !conversationId ||
    typeof userId !== "string" || !userId ||
    typeof messageId !== "string" || !messageId
  ) {
    res.writeHead(400, corsHeaders());
    res.end('Corpo precisa ter "conversationId"/"userId"/"messageId"');
    return;
  }
  if (!chatStore.isParticipant(conversationId, userId)) {
    res.writeHead(403, corsHeaders());
    res.end("Não é participante dessa conversa.");
    return;
  }
  const deleted = chatStore.deleteMessage(conversationId, messageId, userId);
  if (!deleted) {
    res.writeHead(400, corsHeaders());
    res.end("Não deu pra apagar (mensagem não encontrada, já apagada, ou não é sua).");
    return;
  }
  const conv = chatStore.getConversation(conversationId);
  for (const uid of conv.participantIds) {
    sendToUser(uid, { type: "chat:message_deleted", conversationId, messageId: deleted.id });
  }
  res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, messageId: deleted.id }));
}

/** POST /chat/create-group -- cria uma conversa em grupo sem precisar
 * abrir WebSocket, MESMA ação do case "chat:create_group" acima
 * (pedido do Douglas, 1/out: "criar grupo" tem que existir fora da
 * sala também, igual estrutura de dentro -- ver newConvMode em
 * components/ChatDrawer.tsx). companyInfo vem do roomSlug explícito
 * (a sala PRÓPRIA de quem tá criando), mesmo padrão de
 * handlePostChatDirect logo abaixo -- o Lobby não tem roomId de
 * conexão pra inferir sozinho. */
async function handlePostChatCreateGroup(req, res) {
  const body = await readJsonBody(req, res);
  if (!body) return;
  const { userId, userName, participantIds, name, roomSlug } = body;
  if (typeof userId !== "string" || !userId || !Array.isArray(participantIds)) {
    res.writeHead(400, corsHeaders());
    res.end('Corpo precisa ter "userId" e "participantIds" (array)');
    return;
  }
  const cleanParticipantIds = participantIds.filter((x) => typeof x === "string" && x).slice(0, 50);
  if (cleanParticipantIds.length === 0) {
    res.writeHead(400, corsHeaders());
    res.end('"participantIds" precisa ter pelo menos uma pessoa');
    return;
  }
  const senderName = typeof userName === "string" ? userName.slice(0, 80) : "";
  if (senderName) chatStore.upsertUser(userId, { name: senderName });
  const cleanRoomSlug = typeof roomSlug === "string" ? roomSlug.trim() : "";
  const companyInfo = cleanRoomSlug ? await getRoomCompanyInfo(cleanRoomSlug) : null;
  const conv = chatStore.createGroupConversation({
    name: typeof name === "string" ? name : undefined,
    participantIds: cleanParticipantIds,
    createdBy: userId,
    companyInfo,
  });
  for (const uid of conv.participantIds) {
    if (uid === userId) continue;
    sendConversationTo(uid, conv.id);
  }
  const enriched = chatStore.listConversationsForUser(userId).find((c) => c.id === conv.id);
  res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, conversation: enriched }));
}

/** POST /chat/rename-group -- MESMA ação do case "chat:rename_group"
 * acima, sem socket (ver comentário grande de handlePostChatCreateGroup
 * logo acima sobre o porquê). */
async function handlePostChatRenameGroup(req, res) {
  const body = await readJsonBody(req, res);
  if (!body) return;
  const { conversationId, userId, name } = body;
  if (typeof conversationId !== "string" || !conversationId || typeof userId !== "string" || !userId || typeof name !== "string") {
    res.writeHead(400, corsHeaders());
    res.end('Corpo precisa ter "conversationId"/"userId"/"name"');
    return;
  }
  if (!chatStore.isParticipant(conversationId, userId)) {
    res.writeHead(403, corsHeaders());
    res.end("Não é participante dessa conversa.");
    return;
  }
  const conv = chatStore.renameGroupConversation(conversationId, name);
  if (!conv) {
    res.writeHead(400, corsHeaders());
    res.end("Conversa não encontrada (ou não é grupo).");
    return;
  }
  for (const uid of conv.participantIds) {
    sendConversationTo(uid, conv.id);
  }
  const enriched = chatStore.listConversationsForUser(userId).find((c) => c.id === conv.id);
  res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, conversation: enriched }));
}

/** POST /agenda/respond -- aceita/recusa um compromisso sem precisar
 * abrir WebSocket, mesma ideia de handlePostChatSend acima (pedido do
 * Douglas: botões do Lobby "igual de dentro da sala"). MESMA
 * função/trava de dentro do case "agenda:respond" no WebSocket
 * (agendaStore.respondToCall já confere que userId é participante). */
async function handlePostAgendaRespond(req, res) {
  const body = await readJsonBody(req, res);
  if (!body) return;
  const { callId, userId, status } = body;
  if (typeof callId !== "string" || typeof userId !== "string" || typeof status !== "string") {
    res.writeHead(400, corsHeaders());
    res.end('Corpo precisa ter "callId"/"userId"/"status"');
    return;
  }
  const call = agendaStore.respondToCall(callId, userId, status);
  if (!call) {
    res.writeHead(400, corsHeaders());
    res.end("Compromisso não encontrado, ou status inválido, ou userId não é participante.");
    return;
  }
  for (const p of call.participants) {
    sendToUser(p.id, { type: "agenda:call", call });
  }
  res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, call }));
}

/** POST /agenda/create -- cria um compromisso sem precisar abrir
 * WebSocket (mesma ideia de handlePostAgendaRespond acima). 29/set,
 * pedido do Douglas: agenda do Lobby "editavel e criavel", não só
 * aceitar/recusar o que já existe. MESMA função usada pelo caso
 * "agenda:create" do WebSocket (agendaStore.createCall) -- os campos
 * mais avançados de lá (câmera/áudio/tela necessários, anexos) ficam
 * de fora aqui de propósito: o formulário do Lobby é o básico
 * (título/data/hora/duração/participantes/descrição); quem quiser
 * afinar isso monta a call de dentro da sala mesmo ("Marcar
 * compromisso" na av-bar), que já tem esse formulário completo. */
async function handlePostAgendaCreate(req, res) {
  const body = await readJsonBody(req, res);
  if (!body) return;
  const { userId, title, startTs, durationMinutes, participantIds, description } = body;
  if (typeof userId !== "string" || !Number.isFinite(Number(startTs))) {
    res.writeHead(400, corsHeaders());
    res.end('Corpo precisa ter "userId" e "startTs" (timestamp em ms)');
    return;
  }
  const call = agendaStore.createCall({
    title,
    startTs: Number(startTs),
    durationMinutes,
    needs: { camera: false, audio: false, screen: false },
    participantIds: Array.isArray(participantIds) ? participantIds.filter((x) => typeof x === "string") : [],
    createdBy: userId,
    visibility: "private",
    description,
    attachments: [],
    blocksAgenda: true,
  });
  for (const p of call.participants) {
    sendToUser(p.id, { type: "agenda:call", call });
  }
  res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, call }));
}

/** POST /agenda/update -- edita um compromisso JÁ criado (só quem
 * criou, ver agendaStore.updateCall). */
async function handlePostAgendaUpdate(req, res) {
  const body = await readJsonBody(req, res);
  if (!body) return;
  const { callId, userId, title, startTs, durationMinutes, description } = body;
  if (typeof callId !== "string" || typeof userId !== "string") {
    res.writeHead(400, corsHeaders());
    res.end('Corpo precisa ter "callId"/"userId"');
    return;
  }
  const call = agendaStore.updateCall(callId, userId, { title, startTs, durationMinutes, description });
  if (!call) {
    res.writeHead(400, corsHeaders());
    res.end("Compromisso não encontrado, ou quem pediu não é quem criou.");
    return;
  }
  for (const p of call.participants) {
    sendToUser(p.id, { type: "agenda:call", call });
  }
  res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, call }));
}

/** POST /agenda/delete -- cancela/apaga um compromisso (só quem
 * criou). */
async function handlePostAgendaDelete(req, res) {
  const body = await readJsonBody(req, res);
  if (!body) return;
  const { callId, userId } = body;
  if (typeof callId !== "string" || typeof userId !== "string") {
    res.writeHead(400, corsHeaders());
    res.end('Corpo precisa ter "callId"/"userId"');
    return;
  }
  const removed = agendaStore.deleteCall(callId, userId);
  if (!removed) {
    res.writeHead(400, corsHeaders());
    res.end("Compromisso não encontrado, ou quem pediu não é quem criou.");
    return;
  }
  for (const p of removed.participants) {
    sendToUser(p.id, { type: "agenda:call_deleted", callId: removed.id });
  }
  res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

/** GET /chat/summary?userId=X -- resumo LEVE das conversas de um
 * usuário, sem precisar abrir WebSocket/"identify" -- pedido do
 * Douglas: chat "acompanha a pessoa por toda a plataforma", não só
 * depois de entrar na sala (ver Lobby.tsx, mostrado ANTES do usuário
 * clicar "Entrar na sala"). Reaproveita a mesma
 * chatStore.listConversationsForUser usada pelo WebSocket
 * ("chat:list") -- mesmos dados, só um jeito de pedir mais barato
 * (sem socket) pra tela do lobby. Só leitura, mesmo nível de
 * confiança que o resto do fallback anônimo (userId vem do
 * localStorage do navegador, ver getOrCreateUserId em lib/identity.ts
 * -- não autentica nada, só filtra); enviar/editar mensagem continua
 * exigindo o WebSocket de verdade. */
function handleGetChatSummary(req, res, url) {
  const userId = url.searchParams.get("userId");
  if (!userId) {
    res.writeHead(400, corsHeaders());
    res.end('Falta "userId"');
    return;
  }
  const conversations = chatStore.listConversationsForUser(userId);
  res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
  res.end(JSON.stringify({ conversations }));
}

/** GET /agenda/summary?userId=X -- mesma ideia de handleGetChatSummary
 * acima, só que pra agenda (ver agendaStore.listCallsForUser, mesma
 * função usada pelo WebSocket em "agenda:list"). Devolve TODAS as
 * calls do usuário (passadas e futuras); quem chama decide o que
 * mostrar (ver Lobby.tsx, que pega só a próxima futura). */
function handleGetAgendaSummary(req, res, url) {
  const userId = url.searchParams.get("userId");
  if (!userId) {
    res.writeHead(400, corsHeaders());
    res.end('Falta "userId"');
    return;
  }
  const calls = agendaStore.listCallsForUser(userId);
  res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
  res.end(JSON.stringify({ calls }));
}

/** GET /room/areas -- mesma ideia do handleGetFloor acima, ver
 * loadSavedAreas/setAreaDefs em MainScene.ts. Devolve lista + tiles
 * juntos (ver getAreaState em roomStore.js) -- posse (quem clicou
 * "Assumir mesa") NÃO vem por aqui, chega pelo WebSocket (ver "init"
 * acima/roomStore.getAreaOwners). */
async function handleGetAreas(req, res, url) {
  const roomSlug = roomSlugFromUrl(url);
  const { list, tiles } = await roomStore.getAreaState(roomSlug);
  res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
  res.end(JSON.stringify({ list, tiles }));
}

/** GET /room/furniture -- ver comentário grande no topo do arquivo. Devolve
 * a mobília colocada + o ajuste de assento por modelo (ver
 * loadSavedFurniture/setSeatOffsets em MainScene.ts, chamado pelo React em
 * GameRoom.tsx). */
async function handleGetFurniture(req, res, url) {
  const roomSlug = roomSlugFromUrl(url);
  const { items, seatOffsets } = await roomStore.getFurnitureState(roomSlug);
  res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
  res.end(JSON.stringify({ items, seatOffsets }));
}

const MAX_ROOM_BODY_BYTES = 500_000; // generoso pro tamanho da sala hoje (12x7), evita payload absurdo

/** Confere se quem chamou é o DONO da sala CERTA (roomSlug -- ver
 * public.rooms.owner_user_id via isRoomOwner em roomAuth.js), via header
 * "Authorization: Bearer <token>" (mesmo esquema já usado em
 * handleGetPresence acima) -- usado pelos handlePost* abaixo pra decidir
 * se libera salvar em PRODUÇÃO (ver comentário neles). Sem token, ou
 * token de quem não é dono DESSA sala, devolve false -- nunca lança.
 *
 * CORRIGIDO (29/set, bug real de autorização, não só visual): antes
 * checava getRole(callerUserId) -- o papel GLOBAL na Sala Principal,
 * sem nenhuma relação com roomSlug -- então o dono da Sala Principal (ou
 * qualquer conta que getRole achasse "owner") conseguia salvar o
 * floor/walls/furniture da sala de QUALQUER cliente, só mandando o
 * roomSlug certo no POST. Agora confere o dono de VERDADE daquela sala
 * específica. */
async function callerIsOwner(req, roomSlug) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return false;
  const callerUserId = await verifyAccessToken(token);
  if (!callerUserId) return false;
  return isRoomOwner(callerUserId, roomSlug);
}

/** POST /room/floor -- ver comentário grande no topo do arquivo. Em
 * PRODUÇÃO, só salva se quem chamou for o DONO da sala (ver
 * callerIsOwner acima) -- em dev, sempre libera (facilita testar sem
 * precisar de token). Isso é a trava do lado do SERVIDOR; o cliente já
 * só mostra o botão/painel pro dono (ver canEditRoom em GameRoom.tsx) --
 * antes disso aqui, em produção o servidor recusava TODO mundo, mesmo o
 * dono (bug -- o editor abria, parecia salvar, mas sempre dava "Erro ao
 * salvar" assim que saía do ambiente de dev). */
async function handlePostFloor(req, res, url) {
  const roomSlug = roomSlugFromUrl(url);
  if (process.env.NODE_ENV === "production" && !(await callerIsOwner(req, roomSlug))) {
    res.writeHead(403, corsHeaders());
    res.end("Editor de espaço desativado em produção.");
    return;
  }

  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentLength > MAX_ROOM_BODY_BYTES) {
    res.writeHead(413, corsHeaders());
    res.end("Corpo grande demais");
    return;
  }

  const chunks = [];
  let received = 0;
  let aborted = false;

  req.on("data", (chunk) => {
    received += chunk.length;
    if (received > MAX_ROOM_BODY_BYTES && !aborted) {
      aborted = true;
      if (!res.headersSent) {
        res.writeHead(413, corsHeaders());
        res.end("Corpo grande demais");
      }
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on("end", async () => {
    if (aborted) return;
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400, corsHeaders());
      res.end("JSON inválido");
      return;
    }
    const saved = await roomStore.setFloor(roomSlug, data?.items);
    if (saved === null) {
      res.writeHead(400, corsHeaders());
      res.end('Corpo precisa ter "items" (array)');
      return;
    }
    res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, items: saved }));
  });

  req.on("error", () => {
    aborted = true;
  });
}

/** POST /room/areas -- mesma ideia/travas do handlePostFloor acima (ver
 * callerIsOwner), só troca roomStore.setFloor por
 * roomStore.setAreaState (ver validação em server/roomStore.js --
 * espera { list, tiles } em vez de { items }). */
async function handlePostAreas(req, res, url) {
  const roomSlug = roomSlugFromUrl(url);
  if (process.env.NODE_ENV === "production" && !(await callerIsOwner(req, roomSlug))) {
    res.writeHead(403, corsHeaders());
    res.end("Editor de espaço desativado em produção.");
    return;
  }

  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentLength > MAX_ROOM_BODY_BYTES) {
    res.writeHead(413, corsHeaders());
    res.end("Corpo grande demais");
    return;
  }

  const chunks = [];
  let received = 0;
  let aborted = false;

  req.on("data", (chunk) => {
    received += chunk.length;
    if (received > MAX_ROOM_BODY_BYTES && !aborted) {
      aborted = true;
      if (!res.headersSent) {
        res.writeHead(413, corsHeaders());
        res.end("Corpo grande demais");
      }
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on("end", async () => {
    if (aborted) return;
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400, corsHeaders());
      res.end("JSON inválido");
      return;
    }
    const saved = await roomStore.setAreaState(roomSlug, data);
    if (saved === null) {
      res.writeHead(400, corsHeaders());
      res.end('Corpo precisa ter "list" e "tiles" (arrays)');
      return;
    }
    res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, list: saved.list, tiles: saved.tiles }));
  });

  req.on("error", () => {
    aborted = true;
  });
}

/** POST /room/furniture -- mesma ideia/travas do handlePostAreas acima
 * (ver callerIsOwner), só troca roomStore.setAreaState por
 * roomStore.setFurnitureState (ver validação em server/roomStore.js --
 * espera { items, seatOffsets } em vez de { list, tiles }). */
async function handlePostFurniture(req, res, url) {
  const roomSlug = roomSlugFromUrl(url);
  if (process.env.NODE_ENV === "production" && !(await callerIsOwner(req, roomSlug))) {
    res.writeHead(403, corsHeaders());
    res.end("Editor de espaço desativado em produção.");
    return;
  }

  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentLength > MAX_ROOM_BODY_BYTES) {
    res.writeHead(413, corsHeaders());
    res.end("Corpo grande demais");
    return;
  }

  const chunks = [];
  let received = 0;
  let aborted = false;

  req.on("data", (chunk) => {
    received += chunk.length;
    if (received > MAX_ROOM_BODY_BYTES && !aborted) {
      aborted = true;
      if (!res.headersSent) {
        res.writeHead(413, corsHeaders());
        res.end("Corpo grande demais");
      }
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on("end", async () => {
    if (aborted) return;
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400, corsHeaders());
      res.end("JSON inválido");
      return;
    }
    const saved = await roomStore.setFurnitureState(roomSlug, data);
    if (saved === null) {
      res.writeHead(400, corsHeaders());
      res.end('Corpo precisa ter "items" (array)');
      return;
    }
    res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, items: saved.items, seatOffsets: saved.seatOffsets }));
  });

  req.on("error", () => {
    aborted = true;
  });
}

const httpServer = createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "POST" && url.pathname === "/upload") {
    handleUpload(req, res, url);
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/uploads/")) {
    handleServeUpload(req, res, url.pathname);
    return;
  }

  if (req.method === "GET" && url.pathname === "/room/shape") {
    handleGetShape(req, res, url);
    return;
  }

  if (req.method === "POST" && url.pathname === "/room/shape") {
    handlePostShape(req, res, url);
    return;
  }

  if (req.method === "GET" && url.pathname === "/room/floor") {
    handleGetFloor(req, res, url);
    return;
  }

  if (req.method === "POST" && url.pathname === "/room/floor") {
    handlePostFloor(req, res, url);
    return;
  }

  if (req.method === "GET" && url.pathname === "/room/walls") {
    handleGetWalls(req, res, url);
    return;
  }

  if (req.method === "POST" && url.pathname === "/room/walls") {
    handlePostWalls(req, res, url);
    return;
  }

  if (req.method === "GET" && url.pathname === "/room/doors") {
    handleGetDoors(req, res, url);
    return;
  }

  if (req.method === "POST" && url.pathname === "/room/doors") {
    handlePostDoors(req, res, url);
    return;
  }

  if (req.method === "GET" && url.pathname === "/room/areas") {
    handleGetAreas(req, res, url);
    return;
  }

  if (req.method === "POST" && url.pathname === "/room/areas") {
    handlePostAreas(req, res, url);
    return;
  }

  if (req.method === "GET" && url.pathname === "/room/furniture") {
    handleGetFurniture(req, res, url);
    return;
  }

  if (req.method === "POST" && url.pathname === "/room/furniture") {
    handlePostFurniture(req, res, url);
    return;
  }

  if (req.method === "GET" && url.pathname === "/room/presence") {
    handleGetPresence(req, res, url);
    return;
  }

  if (req.method === "GET" && url.pathname === "/chat/summary") {
    handleGetChatSummary(req, res, url);
    return;
  }

  if (req.method === "GET" && url.pathname === "/agenda/summary") {
    handleGetAgendaSummary(req, res, url);
    return;
  }

  if (req.method === "GET" && url.pathname === "/chat/messages") {
    handleGetChatMessages(req, res, url);
    return;
  }

  if (req.method === "POST" && url.pathname === "/chat/open") {
    handlePostChatOpen(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/chat/set-lane") {
    handlePostChatSetLane(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/chat/send") {
    handlePostChatSend(req, res);
    return;
  }

  // 1/out, pedido do Douglas (comparando com o Slack) -- reação/fixar/
  // arquivos da conversa também pelo Lobby (REST, sem WebSocket), MESMA
  // ação dos cases equivalentes do WebSocket (ver handlePostChatReact/
  // handlePostChatPin/handleGetChatAttachments lá em cima).
  if (req.method === "POST" && url.pathname === "/chat/react") {
    handlePostChatReact(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/chat/pin") {
    handlePostChatPin(req, res, { unpin: false });
    return;
  }

  if (req.method === "POST" && url.pathname === "/chat/unpin") {
    handlePostChatPin(req, res, { unpin: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/chat/attachments") {
    handleGetChatAttachments(req, res, url);
    return;
  }

  if (req.method === "POST" && url.pathname === "/agenda/respond") {
    handlePostAgendaRespond(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/agenda/create") {
    handlePostAgendaCreate(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/agenda/update") {
    handlePostAgendaUpdate(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/agenda/delete") {
    handlePostAgendaDelete(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/users/directory") {
    handleGetUsersDirectory(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/chat/direct") {
    handlePostChatDirect(req, res);
    return;
  }

  // 1/out, pedido do Douglas: "quero a mesma estrutura nao que seja
  // separado" -- apagar mensagem/criar grupo/renomear grupo também
  // pelo Lobby (REST, sem WebSocket), MESMA ação dos cases
  // equivalentes do WebSocket (ver handlePostChatDelete/
  // handlePostChatCreateGroup/handlePostChatRenameGroup lá em cima).
  if (req.method === "POST" && url.pathname === "/chat/delete") {
    handlePostChatDelete(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/chat/create-group") {
    handlePostChatCreateGroup(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/chat/rename-group") {
    handlePostChatRenameGroup(req, res);
    return;
  }

  res.writeHead(200, { ...corsHeaders(), "Content-Type": "text/plain; charset=utf-8" });
  res.end("Servidor multiplayer do habbo-gather está no ar.\n");
});

const wss = new WebSocketServer({ server: httpServer });

// "boneco fantasma" (Douglas: "voltou a aparecer isso na primeira
// atualizada" / "continua" -- avatares parados, fora de qualquer
// posição atual, que nunca somem da sala) -- ACHADO/CORRIGIDO: esse
// servidor nunca detectava uma conexão que caiu SEM mandar o frame de
// close de verdade (notebook dormiu, trocou de wifi/rede, aba travou
// ou o processo do navegador morreu) -- "close" (ver mais abaixo) só
// dispara nesses casos de queda "limpa"; numa queda "suja" o player
// correspondente nunca saía de `room`/`connectionsById`, continuava
// sendo mandado pra sempre no "init" de quem entra depois (e nunca
// recebia o "leave" que tira o boneco da tela de quem já tava
// dentro). Fix padrão da lib `ws` (ping periódico + isAlive): quem não
// respondeu (pong) o ping ANTERIOR é considerado morto e
// terminate()ado -- isso já dispara "close" sozinho, reaproveitando
// toda a limpeza que já existe ali (solta mesa/chamada, broadcast
// "leave", etc.), sem precisar duplicar nada.
const HEARTBEAT_INTERVAL_MS = 30_000;
const heartbeatInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);
wss.on("close", () => clearInterval(heartbeatInterval));

// 1/out, pedido do Douglas ("eles tem que ser o mesmo, e ponto final",
// depois de perguntar "porque chamada de voz/video so dentro da sala?")
// -- nome de sala RESERVADO que o Lobby usa pra abrir um WebSocket só
// pra chamada de voz/vídeo e "digitando..." (ver handleLobbySocketConnection
// logo abaixo), sem o Lobby virar um jogador FANTASMA numa sala de
// verdade que a pessoa nunca visitou (ver comentário grande de sempre
// sobre o resto do Lobby ficar em REST). Nunca passa por getRoom/
// roomStore/áreas/portas -- nada disso faz sentido sem sala nenhuma.
const LOBBY_SOCKET_ROOM_ID = "__lobby__";

/** Conexão do socket do Lobby (ver LOBBY_SOCKET_ROOM_ID acima) -- fala só
 * o SUBCONJUNTO do protocolo que não depende de posição/mobília/porta/
 * área: identify (versão enxuta, sem broadcast de sala nenhum -- o
 * Lobby já tem o próprio nome/foto via conta, só precisa registrar
 * essa conexão com o userId certo), call:join/call:leave/signal
 * (handleCallJoin/handleCallLeave/connectionsById já eram 100%
 * independentes de sala, ver comentário grande deles), o protocolo de
 * chat INTEIRO (chat:*, ver comentário grande em "chat:open" logo
 * abaixo) e o de agenda INTEIRO (agenda:*, ver comentário grande dos
 * handleAgenda*, logo depois de scheduleReminder) -- nenhum dos dois
 * nunca dependeu de sala pra nada. */
async function handleLobbySocketConnection(ws) {
  const id = randomUUID();
  const player = { id, userId: id, name: "", color: "", photoUrl: "", accountVerified: false };
  connectionsById.set(id, { ws, player });
  registerUserConnection(player.userId, ws);
  ws.send(JSON.stringify({ type: "init", selfId: id }));

  ws.on("message", async (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (data.type) {
      case "identify": {
        // mesma verificação de token/ban do identify de sala (ver
        // comentário grande dele mais abaixo), só que sem broadcast de
        // sala nenhum -- o Lobby já manda name/color/photoUrl direto
        // (tira da própria conta, ver identify no client) em vez de
        // depender de "look"/chatStore.upsertUser (que podia sobrescrever
        // o que já existe com valor vazio, já que esse player nasce
        // sem nenhum dos dois).
        const verifiedUserId = await verifyAccessToken(data.accessToken);
        if (verifiedUserId && (await isBanned(verifiedUserId))) {
          ws.close(4403, "banido da sala");
          return;
        }
        const newUserId =
          verifiedUserId ??
          (typeof data.userId === "string" && data.userId.trim() ? data.userId.trim().slice(0, 80) : id);
        player.accountVerified = Boolean(verifiedUserId);
        if (newUserId !== player.userId) {
          unregisterUserConnection(player.userId, ws);
          player.userId = newUserId;
          registerUserConnection(player.userId, ws);
        }
        if (typeof data.name === "string") player.name = data.name.slice(0, 80);
        if (typeof data.color === "string") player.color = data.color.slice(0, 20);
        if (typeof data.photoUrl === "string") player.photoUrl = data.photoUrl.slice(0, 500);
        syncChatUser(player);
        handleChatList(player, ws);
        break;
      }
      // 1/out, pedido do Douglas ("nao tem que ter chat de fora chat de
      // dentro, tem que ter CHAT ... pega o chat de dentro e transforma
      // ele em CHAT que acompanha toda a plataforma") -- essa conexão
      // (antes só chamada/digitando do Lobby) agora fala o protocolo de
      // chat INTEIRO (conversas/mensagens/reação/fixar/arquivos), MESMAS
      // funções do switch da sala (ver comentário grande delas lá em
      // cima) -- nenhuma lógica nova, só reuso. roomSlug pra carimbar
      // "Empresa" vem EXPLÍCITO de data.roomSlug (mesmo padrão das rotas
      // REST /chat/direct e /chat/create-group) já que essa conexão não
      // tem roomId nenhum pra inferir sozinha.
      case "chat:open": {
        handleChatOpen(player, ws, data);
        break;
      }
      case "chat:create_direct": {
        (async () => {
          const result = await handleChatCreateDirect(player, data, typeof data.roomSlug === "string" ? data.roomSlug : "");
          if (result?.error) ws.send(JSON.stringify({ type: "error", message: result.error }));
        })();
        break;
      }
      case "chat:set_lane": {
        handleChatSetLane(player, data, typeof data.roomSlug === "string" ? data.roomSlug : "");
        break;
      }
      case "chat:mute": {
        handleChatMute(player, data);
        break;
      }
      case "chat:hide": {
        handleChatHide(player, data);
        break;
      }
      case "chat:create_group": {
        handleChatCreateGroup(player, data, typeof data.roomSlug === "string" ? data.roomSlug : "");
        break;
      }
      case "chat:rename_group": {
        handleChatRenameGroup(player, data);
        break;
      }
      case "chat:send": {
        handleChatSend(player, data);
        break;
      }
      case "chat:delete": {
        handleChatDeleteMessage(player, data);
        break;
      }
      case "chat:react": {
        if (typeof data.conversationId !== "string" || !data.conversationId) break;
        const messageId = typeof data.messageId === "string" ? data.messageId : "";
        const emoji = typeof data.emoji === "string" ? data.emoji : "";
        if (!messageId || !emoji) break;
        handleChatReactConversation(player, data.conversationId, messageId, emoji);
        break;
      }
      case "chat:pin": {
        if (typeof data.conversationId !== "string" || !data.conversationId) break;
        const messageId = typeof data.messageId === "string" ? data.messageId : "";
        if (!messageId) break;
        const durationMs =
          Number.isFinite(data.durationMs) && data.durationMs > 0
            ? Math.min(Number(data.durationMs), MAX_PIN_DURATION_MS)
            : null;
        handleChatPinConversation(player, data.conversationId, messageId, durationMs);
        break;
      }
      case "chat:unpin": {
        if (typeof data.conversationId !== "string" || !data.conversationId) break;
        const messageId = typeof data.messageId === "string" ? data.messageId : "";
        if (!messageId) break;
        handleChatUnpinConversation(player, data.conversationId, messageId);
        break;
      }
      case "chat:attachments": {
        if (typeof data.conversationId !== "string" || !data.conversationId) break;
        handleChatAttachmentsConversation(player, ws, data.conversationId);
        break;
      }
      case "chat:typing": {
        handleChatTyping(player, data.conversationId);
        break;
      }
      case "call:join": {
        handleCallJoin(player, id, data.conversationId);
        break;
      }
      case "call:leave": {
        handleCallLeave(id, data.conversationId);
        break;
      }
      case "signal": {
        const target = connectionsById.get(data.to);
        if (target && target.ws.readyState === target.ws.OPEN) {
          target.ws.send(JSON.stringify({ type: "signal", from: id, data: data.data }));
        }
        break;
      }
      // 1/out, pedido do Douglas: "quero ela [a agenda] toda isolada
      // tambem, e sistema unico, assim como o chat, funcionando acima
      // de tudo, acima de lobby acima de jogo" -- mesmo motivo/mesmo
      // formato do bloco "chat:*" acima (handleAgenda* extraídos logo
      // depois de scheduleReminder, ver comentário grande deles): a
      // agenda nunca dependeu de roomId pra nada (só userId/agendaStore),
      // então os MESMOS 6 handlers do switch da sala rodam aqui sem
      // nenhuma lógica nova.
      case "agenda:list": {
        handleAgendaList(player, ws);
        break;
      }
      case "agenda:availability": {
        handleAgendaAvailability(player, ws, data);
        break;
      }
      case "agenda:create": {
        handleAgendaCreate(player, ws, data);
        break;
      }
      case "agenda:add_attachment": {
        handleAgendaAddAttachment(player, data);
        break;
      }
      case "agenda:respond": {
        handleAgendaRespond(player, data);
        break;
      }
      case "agenda:update": {
        handleAgendaUpdate(player, ws, data);
        break;
      }
      case "agenda:delete": {
        handleAgendaDelete(player, ws, data);
        break;
      }
      case "agenda:view_colleague": {
        handleAgendaViewColleague(player, ws, data);
        break;
      }
      default:
        // movimento/assento/porta/área/"look"/chat da Sala etc. não
        // fazem sentido sem sala nenhuma -- ignora silenciosamente em
        // vez de derrubar a conexão por uma mensagem inesperada.
        break;
    }
  });

  ws.on("close", () => {
    connectionsById.delete(id);
    unregisterUserConnection(player.userId, ws);
    leaveAllCalls(id);
  });

  ws.on("error", (err) => {
    console.error("Erro de conexão (lobby)", id, err);
  });
}

wss.on("connection", async (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  const url = new URL(req.url ?? "/", "http://localhost");
  const segments = url.pathname.split("/").filter(Boolean);
  // aceita qualquer caminho; usa o último pedaço da URL como nome da sala
  const roomId = segments[segments.length - 1] || "default";
  if (roomId === LOBBY_SOCKET_ROOM_ID) {
    await handleLobbySocketConnection(ws);
    return;
  }
  const room = getRoom(roomId);

  const id = randomUUID();
  const color = COLORS[Math.floor(Math.random() * COLORS.length)];
  const player = {
    id,
    // userId "de verdade" (persistente, ver identify) só chega DEPOIS
    // da conexão abrir -- até lá cai de volta pro id da conexão, então
    // o chat ainda funciona (só não mantém histórico entre reconexões)
    // mesmo se o cliente nunca mandar identify.
    userId: id,
    x: 360 + Math.floor(Math.random() * 5) * 20,
    y: 480 + Math.floor(Math.random() * 3) * 20,
    name: `Visitante-${id.slice(0, 4)}`,
    color,
    // móvel (id) em que a pessoa tá sentada agora, ou null -- ver "seat"
    // no comentário de protocolo lá em cima. Guardado no player (igual
    // x/y) pra sair certo dentro de "init"/"join" pra quem entra DEPOIS
    // de alguém já sentado numa mesa privada.
    seatFurnitureId: null,
    // qual ASSENTO de seatFurnitureId (0/0 = âncora, comportamento de
    // sempre) -- ver FurnitureModelDef.extraSeats em game/furniture.ts,
    // pedido do Douglas pra sofá/item com mais de um lugar (mais de uma
    // pessoa sentada no mesmo móvel, cada uma no seu assento).
    seatDCol: 0,
    seatDRow: 0,
    status: "online",
    instagram: "",
    bio: "",
    photoUrl: "",
    role: PROFILE_ROLE_PLACEHOLDER,
    // aparência do boneco (ver LOOK_FIELDS/protocolo "look" acima) --
    // começa tudo null (cliente ainda não mandou o "look" de verdade
    // dele, chega logo depois do "init" -- ver comentário grande no
    // protocolo); o cliente já sabe renderizar um remoto sem isso ainda
    // (usa o boneco padrão até o "look" chegar, ver createAvatar em
    // MainScene.ts).
    hairId: null,
    skinId: null,
    beardId: null,
    accessoryId: null,
    outfitId: null,
  };

  room.set(id, { ws, player });
  connectionsById.set(id, { ws, player });
  registerUserConnection(player.userId, ws);

  const initAreaOwners = await roomStore.getAreaOwners(roomId);

  ws.send(
    JSON.stringify({
      type: "init",
      selfId: id,
      players: Array.from(room.values()).map((c) => c.player),
      // posse de mesa privada já em andamento agora (ver comentário de
      // protocolo lá em cima) -- sem isso, quem entra DEPOIS de alguém
      // já ter clicado "Tomar posse" só veria o dono na tela depois do
      // PRÓXIMO claim/release de qualquer área, não do estado atual.
      areaOwners: Object.keys(initAreaOwners)
        .map((areaId) => areaOwnerWireEntry(room, areaId, initAreaOwners))
        .filter(Boolean),
      // portas já travadas agora (mesmo motivo do areaOwners acima --
      // sem isso, quem entra DEPOIS de alguém travar uma porta só veria
      // ela travada na tela depois do PRÓXIMO lock/unlock, não do
      // estado atual).
      doorLocks: Array.from(getDoorLocks(roomId)).map((key) => {
        const [col, row, side] = key.split("_");
        return { col: Number(col), row: Number(row), side };
      }),
    })
  );

  broadcast(room, { type: "join", player }, id);

  ws.on("message", (raw) => {
    if (raw.length > MAX_MESSAGE_BYTES) return;

    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (data?.type) {
      case "identify": {
        // resolve o userId em duas etapas: se veio um accessToken (ver
        // AuthGate.tsx/GameRoom.tsx -- só quem tem conta manda),
        // confere ele de verdade com o Supabase ANTES de aceitar (ver
        // roomAuth.js) -- o userId da conta manda, ignora o que o
        // cliente mandou em "data.userId" nesse caso (não dá pra
        // confiar num userId auto-declarado quando existe um jeito de
        // confirmar). Sem token (visitante anônimo, ou Supabase ainda
        // não configurado nesse processo -- ver isAccountsConfigured),
        // segue EXATAMENTE como sempre foi: troca o userId
        // "provisório" (= id da conexão) pelo PERSISTENTE que o
        // cliente guarda no localStorage (ver getOrCreateUserId em
        // GameRoom.tsx). Sem isso o histórico de chat reiniciaria do
        // zero a cada F5.
        //
        // async (verificar o token é uma chamada de rede) -- roda em
        // segundo plano, sem travar o resto das mensagens dessa
        // conexão (igual o resto do handler, que é síncrono).
        (async () => {
          const verifiedUserId = await verifyAccessToken(data.accessToken);
          // conta confirmada E banida (ver ação "ban" em
          // app/api/room/members/route.ts) -- derruba a conexão na
          // hora, antes de deixar ela "entrar" na sala de verdade.
          // Visitante sem conta não passa por aqui (não tem como
          // banir quem não tem conta ainda).
          if (verifiedUserId && (await isBanned(verifiedUserId))) {
            ws.close(4403, "banido da sala");
            return;
          }
          const newUserId =
            verifiedUserId ??
            (typeof data.userId === "string" && data.userId.trim() ? data.userId.trim().slice(0, 80) : id);
          player.accountVerified = Boolean(verifiedUserId);
          if (newUserId !== player.userId) {
            unregisterUserConnection(player.userId, ws);
            player.userId = newUserId;
            registerUserConnection(player.userId, ws);
            // "join" (mandado pro resto da sala no exato instante em que a
            // conexão abriu, ver embaixo) sempre sai ANTES desse "identify"
            // chegar (é round-trip de rede, o outro é local/síncrono) --
            // nesse momento o player.userId de todo mundo ainda tá com o
            // valor provisório (= id da conexão). Sem avisar a sala da
            // troca, quem já tava na sala ficaria pra sempre com o userId
            // ERRADO desse jogador (ver remotePlayersRef em GameRoom.tsx),
            // e uma conversa direta iniciada CONTRA ele usaria um id que
            // muda a cada reconexão -- exatamente o problema que o
            // "userId" persistente existe pra evitar.
            broadcast(room, { type: "identity", id, userId: player.userId }, id);
            // se esse userId (agora resolvido de verdade) já é dono de
            // alguma mesa, avisa a sala de novo com o id de conexão ATUAL
            // -- sem isso, quem já tava na sala só saberia que essa mesa
            // "acordou" (voltou a ficar online) no próximo claim/release
            // de QUALQUER área da sala, por acaso (ver
            // broadcastAreaOwnershipFor acima).
            await broadcastAreaOwnershipFor(room, roomId, player.userId);
          }
          syncChatUser(player);
          // roster de "todo mundo cadastrado no ambiente" (ver
          // listAllUsers em chatStore.js) -- manda de novo pra sala inteira
          // toda vez que alguém entra/identifica, assim quem já tava
          // conectado também enxerga gente nova sem precisar recarregar.
          broadcast(room, { type: "users:list", users: chatStore.listAllUsers() });
          // Corrige corrida achada 28/set ("crio agenda, salvo, atualizo
          // e some"): o cliente manda "chat:list"/"agenda:list" logo
          // depois de "identify" (ver GameRoom.tsx), mas esse handler é
          // ASSÍNCRONO (verifyAccessToken acima é um round-trip de rede
          // pro Supabase quando tem accessToken) -- então aquele
          // chat:list/agenda:list quase sempre processava ANTES de
          // player.userId virar o id de verdade, e respondia com a
          // lista vazia do id provisório (= id da conexão), que o
          // cliente aplica com setCalls/setConversations (SUBSTITUI, não
          // mescla) -- a call/conversa que acabou de aparecer "sumia" da
          // tela (o dado sempre ficou salvo certinho no servidor, só a
          // lista que a tela mostrava é que ficava errada). Agora que o
          // userId de verdade já foi resolvido (linha acima), manda a
          // lista CERTA de novo pra essa conexão -- sobrescreve a
          // resposta vazia/errada que já tinha ido antes.
          ws.send(JSON.stringify({ type: "agenda:calls", calls: agendaStore.listCallsForUser(player.userId) }));
          ws.send(
            JSON.stringify({
              type: "chat:conversations",
              conversations: chatStore.listConversationsForUser(player.userId),
            })
          );
          // 1/out, pedido do Douglas: "histórico tem que salvar" (chat
          // da Sala) -- a "semente" do histórico dessa sala pra essa
          // conexão, mandada uma vez só aqui (daí em diante os "chat"/
          // "chat:pins"/"chat:reaction" ao vivo já mantêm o estado local
          // sozinhos, ver handler de mensagens em GameRoom.tsx). Mesmo
          // roomId da conexão (não é por usuário, é por SALA -- ver
          // comentário grande em chatStore.getRoomChat).
          ws.send(
            JSON.stringify({
              type: "chat:room_history",
              messages: chatStore.getRoomMessages(roomId),
              pins: chatStore.getRoomPins(roomId),
            })
          );
        })();
        break;
      }
      case "move": {
        player.x = data.x;
        player.y = data.y;
        broadcast(room, { type: "move", id, x: player.x, y: player.y }, id);
        break;
      }
      case "seat": {
        const furnitureId =
          typeof data.furnitureId === "string" && data.furnitureId ? data.furnitureId.slice(0, 200) : null;
        // dCol/dRow: qual ASSENTO desse item (ver FurnitureModelDef.
        // extraSeats em game/furniture.ts, pedido do Douglas pra
        // sofá/item com mais de um lugar) -- só faz sentido junto de um
        // furnitureId de verdade, levantar (furnitureId null) sempre
        // zera os dois. Clamp defensivo (mesma faixa 1-6 de
        // clampFootprintSize em lib/supabase/itemFields.ts, dando folga
        // pra negativo também já que é um DELTA, não um tamanho) --
        // nunca confia sem checar, vem direto do cliente.
        const dCol = furnitureId && Number.isFinite(data.dCol) ? Math.max(-6, Math.min(6, Math.round(data.dCol))) : 0;
        const dRow = furnitureId && Number.isFinite(data.dRow) ? Math.max(-6, Math.min(6, Math.round(data.dRow))) : 0;
        player.seatFurnitureId = furnitureId;
        player.seatDCol = dCol;
        player.seatDRow = dRow;
        broadcast(room, { type: "seat", id, furnitureId, dCol, dRow }, id);
        break;
      }
      case "claim-area": {
        const areaId = typeof data.areaId === "string" ? data.areaId.slice(0, 100) : "";
        if (!areaId) break;
        (async () => {
        const owners = await roomStore.getAreaOwners(roomId);
        if (owners[areaId]) return; // já tem dono (mesmo offline) -- primeira mensagem a chegar ganha, ignora o resto
        // pedido do Douglas: "uma pessoa só pode assumir uma mesa por
        // espaço" -- confere se esse MESMO jogador (pelo userId
        // PERSISTENTE agora, ver comentário grande de
        // livePlayerIdForUserId acima) já é dono de outra área nessa
        // sala antes de aceitar mais uma (servidor decide de verdade,
        // mesmo motivo de sempre: nunca confia só no cliente pra travar
        // isso -- ele nem deveria deixar clicar, ver
        // onLocalAreaTileChanged/showAreaClaimPrompt e
        // updateAreaHoverLabels em MainScene.ts, mas a trava de verdade é
        // aqui). BLOQUEIA de propósito (perguntado se preferia trocar
        // sozinho automaticamente, respondeu que não -- "tem que soltar"
        // a mesa antiga à mão antes de assumir outra, ver release-area
        // acima). Avisa só quem tentou (claim-area-denied), sem broadcast
        // -- ninguém mais precisa saber que essa tentativa aconteceu.
        const alreadyOwnsAnother = Object.values(owners).some((o) => o.userId === player.userId);
        if (alreadyOwnsAnother) {
          ws.send(JSON.stringify({ type: "claim-area-denied", areaId, reason: "already-owns" }));
          return;
        }
        await roomStore.setAreaOwner(roomId, areaId, player.userId, player.name);
        // pra TODO MUNDO, incluindo quem clicou (diferente do "move"/
        // "seat" acima, que excluem o remetente porque ele já aplicou
        // local -- aqui o cliente só reage a esse broadcast, não aplica
        // otimista, pra não desincronizar numa corrida de dois cliques
        // quase juntos).
        broadcast(room, { type: "area-owner", areaId, playerId: id, name: player.name });
        })();
        break;
      }
      case "release-area": {
        const areaId = typeof data.areaId === "string" ? data.areaId.slice(0, 100) : "";
        if (!areaId) break;
        (async () => {
        const current = (await roomStore.getAreaOwners(roomId))[areaId];
        if (!current || current.userId !== player.userId) return; // só quem é dono pode soltar
        await roomStore.removeAreaOwner(roomId, areaId);
        broadcast(room, { type: "area-owner", areaId, playerId: null, name: null });
        })();
        break;
      }
      // "force-release-area" -- pedido do Douglas: "esse tomar posse,
      // vamos renomear 'assumir mesa'... somente o CEO pode 'destituir
      // mesa de fulano'". DIFERENTE de "release-area" acima (que só quem
      // É o dono pode mandar): aqui é o contrário, só quem NÃO é o dono
      // (o "CEO", ver isRoomOwner/setRoomOwner em MainScene.ts) pode
      // tirar a posse de OUTRA pessoa à força. "CEO" aqui é o MESMO
      // "owner" de room_members (dono da sala) que já libera o editor de
      // espaço (ver callerIsOwner acima) -- não existe um papel separado
      // só pra isso, essa sala só tem UM dono mesmo. Confere o papel de
      // NOVO aqui, sem cache nenhum (mesma cautela de getRole/
      // callerIsOwner -- isso é permissão de verdade, não contador),
      // porque uma conexão WebSocket pode ficar aberta por muito tempo
      // (bem mais que qualquer cache faria sentido) e "identify" só
      // roda uma vez por conexão. Em desenvolvimento (sem
      // NODE_ENV=production), libera geral, igual toda outra trava de
      // dono já feita nesse arquivo -- não trava ninguém enquanto o
      // Douglas ainda não tiver o Supabase/conta configurados.
      case "force-release-area": {
        const areaId = typeof data.areaId === "string" ? data.areaId.slice(0, 100) : "";
        if (!areaId) break;
        (async () => {
          const role = player.userId ? await getRole(player.userId) : null;
          const isCeo = process.env.NODE_ENV !== "production" || role === "owner";
          if (!isCeo) return;
          if (!(await roomStore.getAreaOwners(roomId))[areaId]) return; // já sem dono -- nada pra destituir
          await roomStore.removeAreaOwner(roomId, areaId);
          broadcast(room, { type: "area-owner", areaId, playerId: null, name: null });
        })();
        break;
      }
      // "lock-door"/"unlock-door" -- pedido do Douglas: "o dono da area
      // em questao, pode bloquear ela, fechar, pra que ninguem entre"
      // (ver comentário grande de roomDoorLocks/doorGuardedAreaId acima).
      // Só quem é dono DA ÁREA QUE A PORTA GUARDA pode travar/destravar
      // -- não é "quem clicou primeiro" como claim-area, é sempre o
      // MESMO dono (a posse da área já resolveu essa disputa antes).
      case "lock-door":
      case "unlock-door": {
        const col = Number.isFinite(Number(data.col)) ? Math.trunc(Number(data.col)) : NaN;
        const row = Number.isFinite(Number(data.row)) ? Math.trunc(Number(data.row)) : NaN;
        const side = data.side === "colPlus" || data.side === "rowPlus" ? data.side : null;
        if (!Number.isFinite(col) || !Number.isFinite(row) || !side) break;
        (async () => {
        const areaId = await doorGuardedAreaId(col, row, side, roomId);
        if (!areaId) return; // porta sem área "mesa-privada" nos 2 lados -- ninguém trava
        const owner = (await roomStore.getAreaOwners(roomId))[areaId];
        if (!owner || owner.userId !== player.userId) return;
        const key = doorLockKey(col, row, side);
        const locks = getDoorLocks(roomId);
        const locked = data.type === "lock-door";
        if (locked) locks.add(key);
        else locks.delete(key);
        broadcast(room, { type: "door-lock", col, row, side, locked });
        })();
        break;
      }
      case "signal": {
        // 1/out -- ERA room.get(data.to) (só achava o alvo se estivesse
        // na MESMA sala de quem mandou); pra uma chamada de conversa
        // direta/grupo (diferente da chamada de proximidade da Sala,
        // ver comentário grande de channel:"call" em call:join acima)
        // os dois lados podem estar em QUALQUER lugar -- salas
        // diferentes, ou um deles no socket do Lobby (sem sala nenhuma,
        // ver handleLobbySocketConnection/LOBBY_SOCKET_ROOM_ID mais
        // abaixo) -- então o endereçamento certo é o Map GLOBAL por
        // connectionId (connectionsById), não o da sala de quem mandou.
        const target = connectionsById.get(data.to);
        if (target && target.ws.readyState === target.ws.OPEN) {
          target.ws.send(
            JSON.stringify({ type: "signal", from: id, data: data.data })
          );
        }
        break;
      }
      case "chat": {
        // chat da SALA -- 1/out: AGORA fica salvo de verdade (pedido do
        // Douglas, comparando com o Slack: "histórico tem que salvar";
        // ANTES só era repassado ao vivo, sem persistência nenhuma, ver
        // chatStore.addRoomMessage/getRoomMessages/chat:room_history).
        // Aceita anexo (foto/arquivo/áudio) igual ao chat direto/grupo,
        // no mesmo formato de mensagem (ver chat:send embaixo) pra dar
        // pra desenhar com o mesmo componente.
        const text = typeof data.text === "string" ? data.text.slice(0, 2000) : "";
        const attachment =
          data.attachment && typeof data.attachment === "object"
            ? {
                url: String(data.attachment.url || "").slice(0, 500),
                name: String(data.attachment.name || "arquivo").slice(0, 200),
                size: Number(data.attachment.size) || 0,
                mime: String(data.attachment.mime || "").slice(0, 100),
              }
            : null;
        // cardzinho de convite/visita (ver comentário grande em
        // chatStore.addMessage) -- só faz sentido em conversa direta,
        // mas o chat da SALA aceita o mesmo formato de mensagem por
        // consistência (nunca é mandado daqui pelo client hoje).
        const roomCard =
          data.roomCard && typeof data.roomCard === "object"
            ? {
                action: data.roomCard.action === "invite" ? "invite" : "visit",
                roomSlug: String(data.roomCard.roomSlug || "").slice(0, 200),
                roomName: String(data.roomCard.roomName || "").slice(0, 200),
                roomLogoUrl: String(data.roomCard.roomLogoUrl || "").slice(0, 500),
              }
            : null;
        if (!text.trim() && !attachment && !roomCard) break;
        const kind = roomCard
          ? "room_card"
          : !attachment
            ? "text"
            : data.kind === "audio"
              ? "audio"
              : data.kind === "image"
                ? "image"
                : "file";
        const message = chatStore.addRoomMessage(roomId, {
          senderId: player.userId,
          senderName: player.name,
          kind,
          text,
          attachment,
          roomCard,
          mentionedUserIds: data.mentionedUserIds,
        });
        broadcast(room, { type: "chat", id, message });
        break;
      }
      case "profile": {
        // card de perfil (ver ProfileCard) -- só os campos que o próprio
        // jogador é dono; "role" nunca vem do cliente (ver PROFILE_FIELDS).
        for (const field of PROFILE_FIELDS) {
          if (typeof data[field] !== "string") continue;
          const max = field === "photoUrl" ? 400_000 : field === "bio" ? 280 : 80;
          player[field] = data[field].slice(0, max);
        }
        syncChatUser(player);
        broadcast(room, { type: "profile", id, ...pickProfileFields(player) });
        // nome/cor/foto podem ter mudado -- atualiza o roster de todo
        // mundo pra refletir no picker de participantes/busca da Agenda
        // (ver comentário em "identify" acima).
        broadcast(room, { type: "users:list", users: chatStore.listAllUsers() });
        break;
      }
      case "look": {
        // aparência do boneco (ver LOOK_FIELDS/protocolo "look" acima) --
        // pedido do Douglas, 30/set: "o estilo roupa que ele escolher do
        // avatar, deve seguir ele em qualquer ambiente que ele for".
        // Mesmo esquema de "profile" acima (string ou ignora o campo,
        // mantém o que já tinha), só que aceita null explícito também
        // (GameRoom.tsx nunca manda null hoje -- cada campo só existe
        // depois de escolhido -- mas aceitar deixa o protocolo pronto
        // pra "voltar ao padrão" no futuro sem precisar mexer aqui de
        // novo). ids de catálogo são curtos -- limite generoso (80,
        // igual "instagram"/"status" em PROFILE_FIELDS), só pra nunca
        // deixar alguém mandar um payload gigante nesse campo.
        for (const field of LOOK_FIELDS) {
          if (data[field] === null) {
            player[field] = null;
            continue;
          }
          if (typeof data[field] !== "string") continue;
          player[field] = data[field].slice(0, 80);
        }
        broadcast(room, { type: "look", id, ...pickLookFields(player) });
        break;
      }
      case "poke": {
        // botões do card de OUTRO jogador ("Disponível?" / "Chamar até
        // você" / "Enviar mensagem" / "Deixar um recado") -- relay
        // PRIVADO, só quem recebeu o clique vê o toast, não a sala toda.
        const target = room.get(data.to);
        const kind = String(data.kind ?? "").slice(0, 40);
        // "text" só existe (e só é repassado) pro kind "note" -- pedido
        // do Douglas: "deixar um recado, igual o gather", um aviso avulso
        // com texto livre, mesmo espírito dos outros pokes (NÃO vira
        // mensagem de chat de verdade, não fica salvo em lugar nenhum
        // além do toast momentâneo de quem recebe).
        const text = kind === "note" && typeof data.text === "string" ? data.text.slice(0, 200) : undefined;
        if (target && target.ws.readyState === target.ws.OPEN && kind) {
          target.ws.send(
            JSON.stringify({ type: "poke", from: id, fromName: player.name, kind, ...(text ? { text } : {}) })
          );
        }
        break;
      }

      // --- chat de verdade: direta/grupo, histórico, foto/arquivo/áudio
      // (ver comentário grande no topo do arquivo e server/chatStore.js) ---
      case "chat:list": {
        handleChatList(player, ws);
        break;
      }
      case "chat:open": {
        handleChatOpen(player, ws, data);
        break;
      }
      case "chat:create_direct": {
        (async () => {
          const result = await handleChatCreateDirect(player, data, roomId);
          if (result?.error) ws.send(JSON.stringify({ type: "error", message: result.error }));
        })();
        break;
      }
      // "3 pontinhos" -- mover uma conversa 1x1 já existente pra outra
      // aba (Empresa <-> Privada). roomId aqui é a sala dessa CONEXÃO,
      // mesmo valor que a função já recebia antes da extração.
      case "chat:set_lane": {
        handleChatSetLane(player, data, roomId);
        break;
      }
      case "chat:mute": {
        handleChatMute(player, data);
        break;
      }
      case "chat:hide": {
        handleChatHide(player, data);
        break;
      }
      case "chat:create_group": {
        handleChatCreateGroup(player, data, roomId);
        break;
      }
      case "chat:rename_group": {
        handleChatRenameGroup(player, data);
        break;
      }
      case "chat:send": {
        handleChatSend(player, data);
        break;
      }
      case "chat:delete": {
        handleChatDeleteMessage(player, data);
        break;
      }
      case "chat:delete_room": {
        // "apagar mensagem" na SALA -- 1/out: agora que o chat da Sala
        // tem histórico salvo (ver chatStore.deleteRoomMessage), dá pra
        // conferir de verdade quem mandou a mensagem original, MESMA
        // trava de "chat:delete" acima (só quem mandou apaga, apaga PRA
        // TODOS). ANTES disso (sem persistência nenhuma) não tinha como
        // confirmar nada aqui, só repassava pra quem tava conectado
        // AGORA tarjar no próprio log local.
        if (typeof data.messageId !== "string") break;
        const deletedRoomMsg = chatStore.deleteRoomMessage(roomId, data.messageId, player.userId);
        if (!deletedRoomMsg) break;
        broadcast(room, { type: "chat_room_deleted", messageId: data.messageId });
        break;
      }
      // --- reação com emoji (pedido do Douglas, 1/out, comparando com o
      // Slack) -- MESMA ação pra conversa de verdade e pra Sala, só muda
      // de onde a mensagem vem (ver chatStore.toggleConversationReaction/
      // toggleRoomReaction). conversationId ausente/vazio = Sala. ---
      case "chat:react": {
        const messageId = typeof data.messageId === "string" ? data.messageId : "";
        const emoji = typeof data.emoji === "string" ? data.emoji : "";
        if (!messageId || !emoji) break;
        if (typeof data.conversationId === "string" && data.conversationId) {
          handleChatReactConversation(player, data.conversationId, messageId, emoji);
        } else {
          const result = chatStore.toggleRoomReaction(roomId, messageId, player.userId, emoji);
          if (!result) break;
          broadcast(room, { type: "chat:reaction", conversationId: null, messageId, reactions: result.reactions });
        }
        break;
      }
      // --- "fulano está digitando..." (pedido do Douglas, 1/out) --
      // EFÊMERO, nunca persiste (nem em chatStore nem em lugar nenhum) --
      // só um relay pro resto ver em tempo real. Cliente decide o
      // throttle/quando parar de mandar (ver comentário grande no topo
      // do arquivo); aqui só repassa, sem guardar estado nenhum do lado
      // do servidor. ---
      case "chat:typing": {
        if (typeof data.conversationId === "string" && data.conversationId) {
          handleChatTyping(player, data.conversationId);
        } else {
          broadcast(room, { type: "chat:typing", conversationId: null, userId: player.userId, name: player.name }, id);
        }
        break;
      }
      // --- mensagem fixada, com tempo de expiração opcional (pedido do
      // Douglas, 1/out: "mensagem fixada (definir tempo de fixacao)") --
      // durationMs ausente/<=0 = sem prazo (fica até alguém tirar à
      // mão); clampado num teto generoso só por segurança (nunca confia
      // num número cru vindo do cliente). ---
      case "chat:pin": {
        const messageId = typeof data.messageId === "string" ? data.messageId : "";
        if (!messageId) break;
        const durationMs =
          Number.isFinite(data.durationMs) && data.durationMs > 0
            ? Math.min(Number(data.durationMs), MAX_PIN_DURATION_MS)
            : null;
        if (typeof data.conversationId === "string" && data.conversationId) {
          handleChatPinConversation(player, data.conversationId, messageId, durationMs);
        } else {
          const pin = chatStore.pinRoomMessage(roomId, messageId, player.userId, player.name, durationMs);
          if (!pin) break;
          broadcast(room, { type: "chat:pins", conversationId: null, pins: chatStore.getRoomPins(roomId) });
        }
        break;
      }
      case "chat:unpin": {
        const messageId = typeof data.messageId === "string" ? data.messageId : "";
        if (!messageId) break;
        if (typeof data.conversationId === "string" && data.conversationId) {
          handleChatUnpinConversation(player, data.conversationId, messageId);
        } else {
          if (!chatStore.unpinRoomMessage(roomId, messageId)) break;
          broadcast(room, { type: "chat:pins", conversationId: null, pins: chatStore.getRoomPins(roomId) });
        }
        break;
      }
      // --- painel lateral "arquivos da conversa" (pedido do Douglas,
      // 1/out) -- varre o histórico INTEIRO (não só as últimas 200
      // mensagens de chat:open/chat:room_history), só os itens com
      // anexo. Sob demanda (o cliente pede ao abrir o painel), não
      // mandado sozinho em nenhum outro momento. ---
      case "chat:attachments": {
        if (typeof data.conversationId === "string" && data.conversationId) {
          handleChatAttachmentsConversation(player, ws, data.conversationId);
        } else {
          ws.send(JSON.stringify({ type: "chat:attachments", conversationId: null, items: chatStore.getRoomAttachments(roomId) }));
        }
        break;
      }

      // --- chamada de voz/vídeo de uma conversa direta/grupo ("tipo
      // discord"): opt-in (ninguém entra sozinho), qualquer participante
      // pode entrar/sair a qualquer momento, o mesh de WebRTC entre quem
      // tá NA chamada usa o mesmo relay "signal" de cima (endereçado por
      // connectionId, ver comentário em activeCalls) -- só a lista de
      // quem tá dentro passa por aqui. ---
      case "call:join": {
        handleCallJoin(player, id, data.conversationId);
        break;
      }
      case "call:leave": {
        handleCallLeave(id, data.conversationId);
        break;
      }

      // --- agenda: marcar call (data/horário/participantes, necessidades
      // de câmera/áudio/tela), aprovação dos convidados, checagem de
      // conflito de horário (ver server/agendaStore.js) ---
      // 1/out: corpos extraídos pra handleAgenda* (ver comentário grande
      // deles, logo depois de scheduleReminder acima) -- reusados
      // também pelo socket do Lobby, ver handleLobbySocketConnection.
      case "agenda:list": {
        handleAgendaList(player, ws);
        break;
      }
      case "agenda:availability": {
        handleAgendaAvailability(player, ws, data);
        break;
      }
      case "agenda:create": {
        handleAgendaCreate(player, ws, data);
        break;
      }
      case "agenda:add_attachment": {
        handleAgendaAddAttachment(player, data);
        break;
      }
      case "agenda:respond": {
        handleAgendaRespond(player, data);
        break;
      }
      case "agenda:update": {
        handleAgendaUpdate(player, ws, data);
        break;
      }
      case "agenda:delete": {
        handleAgendaDelete(player, ws, data);
        break;
      }
      case "agenda:view_colleague": {
        handleAgendaViewColleague(player, ws, data);
        break;
      }
    }
  });

  ws.on("close", async () => {
    room.delete(id);
    connectionsById.delete(id);
    unregisterUserConnection(player.userId, ws);
    leaveAllCalls(id);
    // NÃO solta mais a mesa privada que essa pessoa tinha posse -- pedido
    // do Douglas: "quando voce assume a mesa, ela e sua, ate apagarem o
    // espaco, se nao nao troca". Antes soltava aqui (fechar a aba, F5,
    // queda de wifi, restart do servidor -- QUALQUER close), o que
    // parecia "mesa voltando a aparecer Assumir mesa" pra ele depois de
    // um refresh comum. A posse persiste (ver roomStore.js); só avisa a
    // sala que o dono ficou OFFLINE agora (bolinha cinza no rótulo "mesa
    // de <nome>", ver statusColorForPlayer/updateAreaHoverLabels em
    // MainScene.ts) -- `room.delete(id)` já rodou 2 linhas acima, então
    // livePlayerIdForUserId (dentro de broadcastAreaOwnershipFor) só acha
    // OUTRA aba/dispositivo dessa mesma pessoa ainda conectada, se
    // houver; sem nenhuma, devolve null de verdade.
    await broadcastAreaOwnershipFor(room, roomId, player.userId);
    broadcast(room, { type: "leave", id });
    if (room.size === 0) rooms.delete(roomId);
  });

  ws.on("error", (err) => {
    console.error("Erro de conexão", id, err);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Servidor multiplayer rodando na porta ${PORT}`);
});
