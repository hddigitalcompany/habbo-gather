"use client";

import dynamic from "next/dynamic";
import { useRef, useState } from "react";
import AuthGate, { type AccountProfile } from "@/components/AuthGate";
import { AgendaDrawer } from "@/components/AgendaDrawer";
import Lobby from "@/components/Lobby";
import { usePlatformChat } from "@/components/usePlatformChat";

const GameRoom = dynamic(() => import("@/components/GameRoom"), {
  ssr: false,
  loading: () => <div className="loading">Carregando sala...</div>,
});

type AuthResult = {
  accountUserId: string | null;
  accountProfile: Partial<AccountProfile> | null;
  accountAccessToken: string | null;
  onSignOut: (() => void) | null;
};

// 1/out -- pedido direto do Douglas ("pega o chat de dentro e
// transforma ele em CHAT que acompanha toda a plataforma"): esse
// componente existe só pra montar usePlatformChat (ver comentário
// grande nele) UMA VEZ, acima da troca Lobby<->GameRoom, com os dados
// de conta que só existem DENTRO do render-prop do AuthGate
// (`(auth) => ...`) -- chamar o hook direto dentro dessa função
// anônima violaria as Regras dos Hooks (o AuthGate só invoca essa
// função depois que `stage.kind === "ready"`, ver AuthGate.tsx: antes
// disso ele nem é chamada, então o hook apareceria/sumiria entre
// renders do PRÓPRIO AuthGate). Um componente de verdade aqui resolve
// isso -- ele é QUEM monta/desmonta (uma vez só, quando o login resolve),
// não um número variável de hooks dentro do fiber do AuthGate.
function PlatformChatHost({
  auth,
  children,
}: {
  auth: AuthResult;
  children: (
    chat: ReturnType<typeof usePlatformChat>,
    ambientStreamRef: React.MutableRefObject<MediaStream | null>
  ) => React.ReactNode;
}) {
  // câmera/mic da Sala (ver localStreamRef de sempre em GameRoom.tsx) --
  // criado AQUI (não dentro do GameRoom) pra poder entrar tanto no
  // usePlatformChat (reaproveita no "entrar numa chamada"/"gravar
  // áudio" de uma conversa, ver getLocalStreamForCalls/
  // startVoiceRecording em usePlatformChat.ts) quanto no GameRoom (que
  // continua sendo quem de fato CAPTURA/solta essa stream, só que
  // guardando o resultado nesse ref em vez de num useRef próprio). No
  // Lobby não existe sala nenhuma pra ter stream ambiente -- por isso
  // só é passado pro GameRoom, nunca pro Lobby (ver Home() abaixo).
  const ambientStreamRef = useRef<MediaStream | null>(null);
  const chat = usePlatformChat({
    accountUserId: auth.accountUserId,
    accountProfile: auth.accountProfile,
    accountAccessToken: auth.accountAccessToken,
    ambientStreamRef,
  });
  return <>{children(chat, ambientStreamRef)}</>;
}

export default function Home() {
  // pedido do Douglas (28/set): "nao deve abrir direto na sala, crie
  // um lobby igual do habbo" -- entered começa false pra TODO mundo
  // (conta ou visitante), então o GameRoom (que abre o WebSocket assim
  // que monta) só monta depois do clique em "Entrar na sala" no Lobby.
  // Reseta pra false de novo se a pessoa sair da conta (onSignOut),
  // senão voltaria direto pro Lobby só pra clicar Entrar de novo com
  // outra conta -- mais natural já cair no portão de login.
  const [entered, setEntered] = useState(false);
  // qual sala foi escolhida em "Meus espaços" antes de clicar "Entrar
  // na sala" (ver ROOM_SLUGS/selectedRoomSlug em Lobby.tsx) -- pedido
  // do Douglas (29/set): "Mapa publicada (essa) / Mapa modelo (ja pode
  // criar um...)". Default "mapa-publicado" (Mapa Publicada, mesmo
  // valor de sempre) -- só muda de verdade quando o Lobby manda um
  // slug diferente pra onEnter.
  const [roomSlug, setRoomSlug] = useState("mapa-publicado");

  // refs dos <input type="file"> da Agenda (2/out) -- moraram dentro de
  // GameRoom.tsx antes, mas agora que o AgendaDrawer renderiza UMA SÓ
  // VEZ aqui (ver PlatformAgendaHost abaixo, mesmo espírito do
  // PlatformChatHost acima: "funcionando acima de tudo, acima de lobby
  // acima de jogo", pedido direto do Douglas), quem dispara o picker de
  // arquivo (onPickAgendaFile/onPickDetailAttachment) também precisa
  // morar aqui -- senão seriam dois <input> escondidos duplicados, um
  // por tela, voltando a ser "unificação só de aparência".
  const agendaFileInputRef = useRef<HTMLInputElement>(null);
  const agendaDetailFileInputRef = useRef<HTMLInputElement>(null);

  return (
    <main className="page">
      <AuthGate>
        {(auth) => (
          <PlatformChatHost auth={auth}>
            {(chat, ambientStreamRef) => (
              <>
                {entered ? (
                  <GameRoom
                    accountUserId={auth.accountUserId}
                    accountProfile={auth.accountProfile}
                    accountAccessToken={auth.accountAccessToken}
                    onSignOut={auth.onSignOut}
                    roomSlug={roomSlug}
                    // pedido do Douglas (29/set (8)): o X do topo vira link
                    // de volta pro Lobby -- mesma troca de tela que
                    // onEnter faz no sentido contrário (ver comentário
                    // grande de `entered` lá em cima).
                    onBackToLobby={() => setEntered(false)}
                    // GameRoom.tsx migrado pra consumir o motor único (ver
                    // comentário grande no topo de usePlatformChat.ts) --
                    // mesma conexão/estado que o Lobby já usa.
                    platformChat={chat}
                    ambientStreamRef={ambientStreamRef}
                  />
                ) : (
                  <Lobby
                    accountUserId={auth.accountUserId}
                    accountProfile={auth.accountProfile}
                    accountAccessToken={auth.accountAccessToken}
                    onEnter={(slug) => {
                      setRoomSlug(slug);
                      setEntered(true);
                    }}
                    onSignOut={
                      auth.onSignOut
                        ? () => {
                            setEntered(false);
                            auth.onSignOut?.();
                          }
                        : null
                    }
                    platformChat={chat}
                  />
                )}
                {/* 2/out -- pedido do Douglas: "quero ela [a agenda] toda
                    isolada tambem, e sistema unico, assim como o chat,
                    funcionando acima de tudo, acima de lobby acima de
                    jogo". Ao contrário do ChatDrawer (que ainda renderiza
                    uma vez DENTRO de cada tela, GameRoom e Lobby, só
                    compartilhando o estado), a Agenda pediu
                    explicitamente pra ficar ACIMA das duas telas -- então
                    mora só aqui, irmã do `entered ? <GameRoom/> : <Lobby/>`
                    acima, nunca duplicada. onlinePlayers sempre [] aqui
                    (não existe "quem tá na sala" nesse nível, mesmo
                    padrão que Lobby.tsx já usa pro ChatDrawer dele). */}
                {chat.agendaOpen && (
                  <AgendaDrawer
                    myUserId={chat.myUserId}
                    onlinePlayers={[]}
                    allUsers={chat.allUsers}
                    calls={chat.calls}
                    busyUserIds={chat.busyUserIds}
                    agendaView={chat.agendaView}
                    onChangeAgendaView={chat.setAgendaView}
                    agendaDetailId={chat.agendaDetailId}
                    onOpenCallDetail={chat.openCallDetail}
                    agendaForm={chat.agendaForm}
                    onChangeAgendaForm={chat.updateAgendaForm}
                    onToggleAgendaParticipant={chat.toggleAgendaParticipant}
                    agendaError={chat.agendaError}
                    onStartNewCall={chat.startNewCall}
                    editingCallId={chat.editingCallId}
                    onEditCall={chat.startEditCall}
                    onDeleteCall={chat.deleteCall}
                    onSubmitCreateCall={chat.submitCreateCall}
                    onRespondToCall={chat.respondToCall}
                    agendaSearchQuery={chat.agendaSearchQuery}
                    onChangeAgendaSearchQuery={chat.setAgendaSearchQuery}
                    agendaColleagueId={chat.agendaColleagueId}
                    agendaColleagueName={chat.agendaColleagueName}
                    colleagueCalls={chat.colleagueCalls}
                    onViewColleagueAgenda={chat.viewColleagueAgenda}
                    onBackToMyAgenda={chat.backToMyAgenda}
                    onPickAgendaFile={() => agendaFileInputRef.current?.click()}
                    onRemoveAgendaAttachment={chat.removeAgendaFormAttachment}
                    sendingAgendaAttachment={chat.sendingAgendaAttachment}
                    onPickDetailAttachment={() => agendaDetailFileInputRef.current?.click()}
                    sendingDetailAttachment={chat.sendingDetailAttachment}
                    expandedAgendaDays={chat.expandedAgendaDays}
                    onToggleAgendaDay={chat.toggleAgendaDay}
                    onClose={() => chat.setAgendaOpen(false)}
                  />
                )}
                <input
                  ref={agendaFileInputRef}
                  type="file"
                  style={{ display: "none" }}
                  onChange={chat.handleAgendaFileChange}
                />
                <input
                  ref={agendaDetailFileInputRef}
                  type="file"
                  style={{ display: "none" }}
                  onChange={chat.handleAgendaDetailFileChange}
                />
              </>
            )}
          </PlatformChatHost>
        )}
      </AuthGate>
    </main>
  );
}
