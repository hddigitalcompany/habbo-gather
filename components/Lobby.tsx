"use client";

// Lobby -- tela de entrada mostrada ANTES da sala (pedido do Douglas,
// 28/set: "nao deve abrir direto na sala, crie um lobby igual do
// habbo" + depois "quero ali no centro a previa da sala da pessoa,
// como no gather"). Fica entre o AuthGate (resolve quem é a pessoa) e
// o GameRoom (que só monta -- e só aí abre o WebSocket -- depois do
// clique em "Entrar na sala", ver app/page.tsx). Sem estado de jogo
// nenhum aqui, só decide SE mostra o botão de entrar; quem entra e sai
// da sala de verdade continua sendo o GameRoom.
//
// A prévia central (RoomPreview) busca piso/parede/mobília pelos MESMOS
// GETs públicos que o GameRoom usa (GET /room/floor, /room/walls,
// /room/furniture em server/index.js -- não exigem dono, só leitura) e
// desenha um grid top-down simplificado em SVG: não é a arte de verdade
// (texturas/sprites, isso só o Phaser dentro do GameRoom sabe montar),
// é um "mapinha" abstrato só pra dar uma ideia do formato/tamanho da
// sala antes de entrar -- mesma ideia da prévia do Gather, sem precisar
// carregar o motor do jogo inteiro só pra isso.
//
// A contagem de "quem tá na sala agora" vem de GET /room/presence (ver
// server/index.js) -- endpoint HTTP público que já existia pro painel
// de membros, escolhido de propósito por não precisar abrir o
// WebSocket só pra mostrar um número no lobby.
//
// Chat/agenda (28/set, pedido do Douglas: "chat, agenda, configuracoes
// nao ficam presas apenas a sala, acompanha cada pessoa por toda
// plataforma" -- depois, vendo só o resumo em texto: "cade o botao das
// conversas e da agenda? mantenha igual de dentro da sala") -- os
// ícones aqui são os MESMOS ChatIcon/AgendaIcon da av-bar do GameRoom
// (copiados, ver comentário deles abaixo) e abrem um painel de verdade
// (ler mensagens, RESPONDER, aceitar/recusar compromisso), não só
// texto. A diferença de "dentro da sala": aqui NÃO existe WebSocket
// (entrar no Lobby não pode virar presença fantasma na sala pra quem
// já tá lá dentro, ver comentário grande em server/index.js sobre
// broadcast de "join" assim que uma conexão abre) -- então tudo aqui
// usa REST simples (GET /chat/summary, /chat/messages, POST
// /chat/send, GET /agenda/summary, POST /agenda/respond, todos novos
// em server/index.js, reaproveitando as MESMAS funções de
// chatStore/agendaStore que o WebSocket usa). Quem estiver com a sala
// aberta em outra aba recebe a mensagem/resposta em tempo real do
// mesmo jeito (o servidor empurra por sendToUser); só quem só tem o
// Lobby aberto não recebe push -- teria que reabrir a conversa. Criar
// conversa nova, anexo e chamada de voz/vídeo continuam só dentro da
// sala (dependem de WebRTC/WebSocket de verdade, ver ChatDrawer em
// GameRoom.tsx).

import { useEffect, useMemo, useRef, useState } from "react";
import type { AccountProfile } from "@/components/AuthGate";
import { resolveUserId } from "@/lib/identity";
import SettingsPanel from "@/components/SettingsPanel";
import FriendsPanel, { type ContactUser } from "@/components/FriendsPanel";
import ProfileViewCard from "@/components/ProfileViewCard";
import {
  getStoredMicOn,
  getStoredCamOn,
  getStoredMicDeviceId,
  getStoredCamDeviceId,
  getStoredSpeakerDeviceId,
  setStoredMicOn,
  setStoredCamOn,
  setStoredMicDeviceId,
  setStoredCamDeviceId,
  setStoredSpeakerDeviceId,
} from "@/lib/mediaPrefs";

const REALTIME_HOST = process.env.NEXT_PUBLIC_REALTIME_HOST || "127.0.0.1:1999";
const REALTIME_HTTP_BASE =
  (typeof window !== "undefined" && window.location.protocol === "https:" ? "https" : "http") +
  `://${REALTIME_HOST}`;

type PresenceInfo = { totalOnline: number } | null;

type ConversationSummary = {
  id: string;
  name: string;
  kind: "direct" | "group";
  // "company" (padrão de sempre, sem trava) ou "private" (só entre
  // amigos mútuos) -- ver comentário grande em server/chatStore.js/
  // getOrCreateDirectConversation e a aba "Conversas privadas" em
  // LobbyChatPanel mais abaixo.
  lane: "company" | "private";
  // 29/set (12), pedido do Douglas: "QUERO O CHAT DE FORA IGUAL AO
  // CHAT DE DENTRO, ATE NA POSICAO, IGUAL" -- color/photoUrl JÁ
  // vinham nessa resposta (GET /chat/summary reaproveita
  // chatStore.listConversationsForUser, que já soma ...getUser(id) em
  // cada participante, ver server/chatStore.js), só o tipo aqui não
  // declarava os campos e o painel não desenhava nada com eles -- por
  // isso a lista/cabeçalho de conversa direta ficavam sem avatar
  // nenhum enquanto o de dentro da sala (ChatDrawer) já mostrava.
  participants: { id: string; name?: string; color?: string; photoUrl?: string }[];
  // 29/set (13), pedido do Douglas: "quero a logo da empresa em que
  // ele abriu o chat, porque funcionarios podem participar de mais
  // empresas" -- nome/logo da empresa (sala) onde essa conversa
  // nasceu, congelados na criação (mesmo comentário grande em
  // server/chatStore.js). Só lane "company" tem valor aqui.
  companyName: string | null;
  companyLogoUrl: string | null;
  lastMessage: { senderId: string; senderName: string; kind: string; text: string; ts: number } | null;
};

type ChatMessage = {
  id: string;
  senderId: string;
  senderName: string;
  kind: string;
  text: string;
  ts: number;
  deleted?: boolean;
};

type CallParticipant = { id: string; name: string; status: string };
type CallSummary = {
  id: string;
  title: string;
  startTs: number;
  durationMinutes: number;
  participants: CallParticipant[];
  // já vinham do servidor (enrich() em server/agendaStore.js) mas o
  // cliente não usava -- precisa de createdBy pra saber quem pode
  // editar/apagar o compromisso (só quem criou, ver
  // agendaStore.updateCall/deleteCall) e description pra reaproveitar
  // no formulário de edição (ver LobbyAgendaPanel).
  createdBy: string;
  description: string;
};

type FloorTile = { col: number; row: number; styleId: string };
type FurnitureItem = { col: number; row: number; type: string };
type WallSegment = { col: number; row: number; side: "rowPlus" | "colPlus" };

type RoomShape = {
  floor: FloorTile[];
  furniture: FurnitureItem[];
  walls: WallSegment[];
} | null;

// espaços FIXOS do TIME do Douglas em "Meus espaços" (ver dropdown
// mais abaixo) -- CORRIGIDO 29/set: "seguinte o cliente so vai ver
// Mapa modelo, apenas eu vejo o Mapa Publicado... Cada cliente vai ter
// a sua sala, nao só essa que eu crio... O cara entra, ele tem a sala
// dele la que ele escolher dentre os modelos... A minha e so minha,
// minha equipe vai entrar na minha sala por link de convidado". Isso
// muda o que "Mapa modelo" significa aqui: ele NÃO é mais uma sala
// compartilhada que qualquer visitante entra direto -- é a área onde
// o Douglas (e o time dele) CONSTRÓI/decora os modelos que os
// clientes só COPIAM (ver "Criar minha sala" mais abaixo, POST
// /api/room/create-from-template) -- por isso teamOnly:true nos DOIS
// agora, igual "Sala principal". Um "visitor" de verdade (cliente sem
// convite pro time) não vê NENHUM dos dois aqui -- ele ganha a PRÓPRIA
// sala (myRoom, ver fetch de /api/room/mine mais abaixo) e, antes
// disso, o fluxo de "Criar minha sala" (templateChoices, GET
// /api/room/templates). role "owner" (o Douglas) e "member" (quem
// redimiu o convite dele, ver app/api/room/invite/redeem/route.ts --
// esse convite JÁ existe, não é feature nova) continuam vendo os 2
// daqui, mesmo comportamento de sempre. Isso é só visibilidade de
// TELA (o dropdown não lista/oferece o botão) -- não é uma trava de
// servidor nova (o servidor sempre aceitou qualquer slug, ver
// comentário grande "MULTI-SALA" em server/roomStore.js), então não é
// uma garantia de segurança de verdade contra alguém client-side
// forçando a URL/room manualmente -- é o mesmo nível de confiança que
// canEditRoom em GameRoom.tsx já usa pra esconder o editor de espaço.
const ROOM_SLUGS: { slug: string; label: string; teamOnly: boolean }[] = [
  // 29/set (9), pedido do Douglas: "mude la encima no meu / SAla
  // principal, Mapa Publicado" -- só o RÓTULO em "Meus espaços"
  // mudou, o slug continua "sala-principal" (fixo no servidor
  // WebSocket, ver DEFAULT_ROOM_SLUG em server/roomStore.js e
  // STORE_SLUG em chatStore.js/agendaStore.js).
  { slug: "sala-principal", label: "Mapa Publicado", teamOnly: true },
  // 29/set (6), pedido do Douglas: "ok renomeie Sala Modelo" -- só o
  // RÓTULO mudou (label), o slug continua "mapa-modelo" (usado em
  // vários lugares no servidor/banco, ver comentário grande acima).
  { slug: "mapa-modelo", label: "Sala Modelo", teamOnly: true },
];

// um modelo publicado (ver GET /api/room/templates) -- é o que aparece
// pro cliente escolher em "Criar minha sala".
type RoomTemplate = { id: string; name: string; room_slug: string };
// a sala PRÓPRIA do cliente, se ele já tiver uma (ver GET
// /api/room/mine) -- criada por ele mesmo a partir de um RoomTemplate
// (POST /api/room/create-from-template).
type MyRoom = { id: string; name: string; room_slug: string };
// uma sala de OUTRA pessoa que essa conta já visitou por link (ver
// POST /api/room/visit / GET /api/room/visits) -- mesmo formato de
// MyRoom acima, é literalmente uma linha de `rooms` (nome/slug
// atuais, não uma cópia congelada no momento da visita).
type VisitedRoom = { id: string; name: string; room_slug: string };

const PREVIEW_W = 264;
const PREVIEW_H = 168;
const PREVIEW_PAD = 10;

/** Cor do piso é só decorativa aqui (não é a textura de verdade, ver
 * comentário grande no topo do arquivo) -- hasheia o styleId (mesmo uuid
 * usado no piso de verdade) pra pelo menos variar entre 3 tons
 * violeta, dando uma sensação de "tem mais de um tipo de piso" sem
 * precisar buscar o catálogo (GET /floor-items) só pra isso. */
const FLOOR_TONES = ["#3a2f57", "#42355f", "#372c52"];
function floorTone(styleId: string): string {
  let h = 0;
  for (let i = 0; i < styleId.length; i++) h = (h * 31 + styleId.charCodeAt(i)) >>> 0;
  return FLOOR_TONES[h % FLOOR_TONES.length];
}

/** Desenha o "mapinha" da sala -- ver comentário grande no topo do
 * arquivo pra entender por que é abstrato (não usa os sprites de
 * verdade). Sem piso nenhum carregado ainda (fetch em andamento ou
 * sala vazia de propósito), mostra um placeholder simples em vez de um
 * SVG vazio esquisito. */
function RoomPreview({ room, loading }: { room: RoomShape; loading: boolean }) {
  // 29/set (2): Douglas mandou o print de referência de novo, agora
  // apontando direto pro card "Entrar na sala": "copie exatamente o
  // que tem aqui... estilo fonte, cores, blur, tudo" -- a caixa de
  // prévia no print é um placeholder de câmera (ícone grande + fundo
  // escuro com um brilho suave desfocado atrás), não o mapinha
  // abstrato de piso/paredes. Só troquei o CONTEÚDO desses dois
  // estados vazios (sem piso ainda / carregando) pelo ícone -- o
  // mapinha de verdade (piso+paredes+móveis, abaixo) continua intocado,
  // ele é a prévia de verdade quando já tem dado real pra mostrar.
  if (loading) {
    return (
      <div className="lobby-preview lobby-preview-empty">
        <span className="lobby-preview-empty-glow" />
        <CamIcon off={false} size={40} />
      </div>
    );
  }
  if (!room || room.floor.length === 0) {
    return (
      <div className="lobby-preview lobby-preview-empty">
        <span className="lobby-preview-empty-glow" />
        <CamIcon off={false} size={40} />
      </div>
    );
  }

  const cols = room.floor.map((t) => t.col);
  const rows = room.floor.map((t) => t.row);
  const minCol = Math.min(...cols);
  const maxCol = Math.max(...cols);
  const minRow = Math.min(...rows);
  const maxRow = Math.max(...rows);
  const gridW = maxCol - minCol + 1;
  const gridH = maxRow - minRow + 1;

  const cell = Math.min((PREVIEW_W - PREVIEW_PAD * 2) / gridW, (PREVIEW_H - PREVIEW_PAD * 2) / gridH);
  const offsetX = (PREVIEW_W - gridW * cell) / 2;
  const offsetY = (PREVIEW_H - gridH * cell) / 2;
  const x = (col: number) => offsetX + (col - minCol) * cell;
  const y = (row: number) => offsetY + (row - minRow) * cell;

  return (
    <div className="lobby-preview">
      <svg width={PREVIEW_W} height={PREVIEW_H} viewBox={`0 0 ${PREVIEW_W} ${PREVIEW_H}`}>
        {room.floor.map((t, i) => (
          <rect
            key={`f-${i}`}
            x={x(t.col)}
            y={y(t.row)}
            width={cell}
            height={cell}
            fill={floorTone(t.styleId)}
            stroke="rgba(0,0,0,0.25)"
            strokeWidth={0.5}
          />
        ))}
        {room.walls.map((w, i) => {
          const x1 = w.side === "rowPlus" ? x(w.col) : x(w.col + 1);
          const y1 = w.side === "rowPlus" ? y(w.row + 1) : y(w.row);
          const x2 = w.side === "rowPlus" ? x(w.col + 1) : x(w.col + 1);
          const y2 = w.side === "rowPlus" ? y(w.row + 1) : y(w.row + 1);
          return (
            <line
              key={`w-${i}`}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="#a893f0"
              strokeWidth={2}
              strokeLinecap="round"
            />
          );
        })}
        {room.furniture.map((f, i) => (
          <rect
            key={`m-${i}`}
            x={x(f.col) + cell * 0.18}
            y={y(f.row) + cell * 0.18}
            width={cell * 0.64}
            height={cell * 0.64}
            rx={cell * 0.14}
            fill="#7c5cff"
            stroke="rgba(255,255,255,0.35)"
            strokeWidth={0.6}
          />
        ))}
      </svg>
    </div>
  );
}

// MESMOS ícones da av-bar de dentro da sala (copiados de GameRoom.tsx
// -- ChatIcon/AgendaIcon lá são funções locais, não exportadas, sem
// como importar direto sem virar dependência cruzada esquisita) --
// pedido do Douglas: "mantenha igual de dentro da sala".
// Setinha do seletor "Meus espaços" na barra de topo (ver comentário
// grande onde spacesMenuOpen é declarado).
function ChevronIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <path d="M5 9l7 7 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// MESMO mapeamento de STATUS_OPTIONS/statusMeta em GameRoom.tsx
// (copiado, não importado -- mesmo motivo dos ícones acima) -- usado
// no "card" da conta (ver accountCardOpen mais abaixo).
const ACCOUNT_STATUS_LABELS: Record<string, string> = {
  online: "Online",
  away: "Ausente",
  focus: "Foco",
};

// "card" da Empresa selecionada -- pedido do Douglas: "nesse canto
// quero o card da Empresa selecionada" (print de referência: card
// estilo perfil do X/Twitter de uma marca real, "Obrazur"). Copiei o
// LAYOUT/estilo exatamente (fundo claro em cima com frase de efeito,
// ícones sociais + botão "Seguir", metade preta embaixo com logo,
// nome + selo verificado, @arroba, bio, seguidores/seguindo, link).
//
// 29/set: pedido do Douglas "quero uma setinha do lado do card da
// empresa, abrindo a aba de edicao: Nome fantasia / cnpj / permissoes
// de exibicao" + "e editar foto de perfil, e foto de banner do card
// da empresa" (CNPJ removido depois) -- virou estado editável
// (companyProfile/setCompanyProfile).
//
// 29/set (7): pedido do Douglas "quero cada card de empresa atrelado
// a um espaco" -- até aqui era um MOLDE fixo (localStorage, mesmo
// navegador, sem ligação com qual sala era qual, ver
// COMPANY_PROFILE_STORAGE_KEY antigo). Virou de VERDADE: cada ESPAÇO
// (linha de rooms, colunas company_*, ver migration
// 0040_room_company_profile.sql e app/api/room/company-profile) tem
// o próprio card, buscado pelo `selectedRoomSlug` atual (mesma
// seleção de "Meus espaços"/"Espaços visitados" -- troca de espaço
// selecionado busca outro card). `name` (Nome fantasia) É a mesma
// `rooms.name` de sempre (aparece em "Meus espaços"/aba "Empresa" do
// chat) -- editar aqui reescreve ela direto no servidor, então nunca
// mais diverge (substitui o sync manual de antes). Só o DONO do
// espaço selecionado pode editar (companyProfileCanEdit, calculado
// pelo servidor em cima do token -- ver rota); quem só tá olhando
// (visitante, ou outro espaço) vê o card mas sem a setinha de editar.
type CompanyProfile = {
  name: string;
  handle: string;
  bio: string;
  followers: number;
  link: string;
  logoUrl: string;
  bannerUrl: string;
  // "Posicione a sua empresa:" (categoria/segmento) -- multi-select,
  // Douglas pediu pra poder marcar varias opcoes. Ver COMPANY_CATEGORIES
  // logo abaixo.
  category: string[];
  // "Permitir exibicao do nome da empresa do perfil dos
  // colaboradores?" -- guardado no banco (company_show_name_on_employee_profiles),
  // o perfil dos colaboradores ainda não lê esse valor de lugar
  // nenhum (fica pronto pra quando isso existir).
  showNameOnEmployeeProfiles: boolean;
};

// estado "em branco" -- usado enquanto o card de verdade ainda não
// chegou do servidor (fetch em andamento/sem espaço selecionado
// ainda) ou quando o espaço ainda não tem NENHUM campo preenchido
// (sala nova, ninguém abriu "Editar Empresa" ainda). Sem molde/dado
// inventado nenhum (era isso que "Empresa Exemplo" fazia antes) --
// os campos vazios aparecem em branco no card mesmo (ver JSX,
// placeholders nos inputs de edição cobrem esse caso).
const BLANK_COMPANY_PROFILE: CompanyProfile = {
  name: "",
  handle: "",
  bio: "",
  followers: 0,
  link: "",
  logoUrl: "",
  bannerUrl: "",
  category: [],
  showNameOnEmployeeProfiles: true,
};

// pedido do Douglas: "uma caixa de selecao, escrita Posicione a sua
// empresa:" + a lista de categorias exata que ele mandou.
const COMPANY_CATEGORIES = [
  "Direct Response",
  "Dropshipping",
  "E-commerce",
  "Disparos SMS",
  "E-mail Marketing",
  "Marketing Digital",
  "Agência de Marketing",
  "Agência de Publicidade",
  "Social Media",
  "Tráfego Pago",
  "Copywriting",
  "Infoprodutos",
  "Afiliados",
  "SaaS",
  "Software / Tecnologia",
  "Desenvolvimento de Software",
  "Desenvolvimento Web",
  "Desenvolvimento de Apps",
  "Inteligência Artificial",
  "Automação",
  "Telecomunicações",
  "Call Center",
  "BPO",
  "Empresas Remotas",
  "Consultoria",
  "Assessoria",
  "Contabilidade",
  "Jurídico",
  "Recursos Humanos",
  "Recrutamento",
  "Educação",
  "Cursos Online",
  "Saúde",
  "Estética e Beleza",
  "Fitness",
  "Alimentação",
  "Restaurantes",
  "Moda e Vestuário",
  "Varejo",
  "Atacado",
  "Distribuidora",
  "Importação e Exportação",
  "Logística",
  "Transportes",
  "Imobiliário",
  "Construção Civil",
  "Arquitetura",
  "Engenharia",
  "Serviços Financeiros",
  "Fintech",
  "Seguros",
  "Turismo",
  "Hotelaria",
  "Eventos",
  "Entretenimento",
  "Games",
  "Produtora Audiovisual",
  "Design",
  "Indústria",
  "Agronegócio",
  "Energia",
  "Serviços Profissionais",
  "Outros",
];

// pedido do Douglas: 4 artes (gradientes) que ele subiu pra por de
// fundo dos "quadradinhos" de posicionamento -- e "faca sorteio
// aleatório" pra decidir qual arte vai em cada quadradinho. Sorteio
// ESTÁVEL (não Math.random() puro): cada categoria sempre cai na
// mesma arte (senão reembaralha a cada digitação/re-render, ficando
// piscando). O "aleatório" está em qual arte cada categoria pegou --
// isso sim foi sorteado (índice inicial abaixo), não numa ordem óbvia
// tipo "primeira categoria = primeira arte".
const COMPANY_POSITION_BACKGROUNDS = [
  "/assets/positions/position-bg-green.jpg",
  "/assets/positions/position-bg-purple.jpg",
  "/assets/positions/position-bg-red.jpg",
  "/assets/positions/position-bg-orange.jpg",
];

function companyPositionBackgroundFor(category: string): string {
  let hash = 0;
  for (let i = 0; i < category.length; i++) {
    hash = (hash * 31 + category.charCodeAt(i)) >>> 0;
  }
  return COMPANY_POSITION_BACKGROUNDS[hash % COMPANY_POSITION_BACKGROUNDS.length];
}

// mesma ideia de compressPhotoToDataUrl em GameRoom.tsx (recorta
// quadrado central, reamostra, exporta JPEG pequeno) -- copiada (não
// importada, GameRoom não exporta essa função, mesmo motivo dos
// ícones acima) e reaproveitada pra logo/foto de perfil da empresa.
function compressSquarePhotoToDataUrl(file: File, target = 240): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      img.onerror = () => reject(new Error("Não deu pra ler a imagem"));
      img.onload = () => {
        const size = Math.min(img.width, img.height);
        const sx = (img.width - size) / 2;
        const sy = (img.height - size) / 2;
        const finalSize = Math.min(target, size);
        const canvas = document.createElement("canvas");
        canvas.width = finalSize;
        canvas.height = finalSize;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Sem contexto 2D"));
        ctx.drawImage(img, sx, sy, size, size, 0, 0, finalSize, finalSize);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

// variante SEM recorte quadrado, pro banner (retangular, largo) --
// só reamostra pra caber num teto de largura/altura, mantendo a
// proporção original da foto (o CSS do card usa background-size:cover
// pra preencher a faixa clara de cima, então não precisa vir
// pré-cortada num formato exato).
//
// 29/set: pedido do Douglas "1200x400 me parece grande demais pro
// tamanho do banner no card" -- 1200x400 (proporção 3:1) era bem mais
// largo/achatado que a faixa de verdade do card (.company-card-top,
// 290px de largura x 130px de altura mínima = proporção ~2.23:1).
// 580x260 é EXATAMENTE 2x esse tamanho real (retina), então
// recomendado/teto de compressão agora batem com o card de verdade.
function compressBannerPhotoToDataUrl(file: File, maxWidth = 580, maxHeight = 260): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      img.onerror = () => reject(new Error("Não deu pra ler a imagem"));
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width, maxHeight / img.height);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Sem contexto 2D"));
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

function ChevronRightIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// mesma seta, apontando pro outro lado -- vira o ícone da setinha do
// card da Empresa quando a aba de edição já tá aberta (fecha em vez
// de abrir).
function ChevronLeftIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ícone de câmera -- pedido do Douglas: print de referência da aba de
// edição usa esse ícone (não um pincel) nos botões de trocar foto de
// perfil/banner. `size` opcional porque é usado em dois tamanhos: nos
// botõezinhos redondos de canto e no convite grande centralizado em
// cima do banner.
function CameraIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path
        d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1-2h7l1 2h2A1.5 1.5 0 0 1 20 8.5v9A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5v-9Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="13" r="3.2" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

// MESMO ícone de "trocar foto" (profile-photo-edit) do editor de
// perfil dentro da sala em GameRoom.tsx -- copiado (não importada,
// mesmo motivo de sempre) pros botões de trocar logo/banner aqui.
function VerifiedBadge() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" className="company-card-verified">
      <path
        d="m12 2 2.4 1.4 2.8-.3 1.1 2.6 2.6 1.1-.3 2.8L22 12l-1.4 2.4.3 2.8-2.6 1.1-1.1 2.6-2.8-.3L12 22l-2.4-1.4-2.8.3-1.1-2.6-2.6-1.1.3-2.8L2 12l1.4-2.4-.3-2.8 2.6-1.1 1.1-2.6 2.8.3L12 2Z"
        fill="#3897f0"
      />
      <path d="m8.2 12.2 2.4 2.4 5-5.2" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <path
        d="M9.5 14.5 14.5 9.5M8 17l-2.5 2.5a3.5 3.5 0 0 1-5-5L3 12M16 7l2.5-2.5a3.5 3.5 0 0 1 5 5L21 12"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

// 29/set (12), pedido do Douglas: "QUERO O CHAT DE FORA IGUAL AO CHAT
// DE DENTRO, ATE NA POSICAO, IGUAL" -- copiados de ChatDrawer/
// ChatMessageRow em components/GameRoom.tsx (mesmo motivo do resto
// dos ícones dessa barra, ver comentário grande no topo do arquivo:
// esse componente não importa nada de GameRoom.tsx, que é gigante e
// só deveria carregar depois que a pessoa entra na sala).
function BackIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M15 5 8 12l7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <path d="M5 5l14 14M19 5 5 19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function GroupIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
      <circle cx="9" cy="9" r="3" stroke="currentColor" strokeWidth="1.7" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="17" cy="9" r="2.6" stroke="currentColor" strokeWidth="1.5" opacity="0.75" />
      <path d="M15.2 12.3A4.6 4.6 0 0 1 20.5 16.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.75" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
      <path
        d="M4 12 20 4l-6.5 16-3-6.5L4 12Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

// 29/set (13), pedido do Douglas: "quero a logo da empresa em que ele
// abriu o chat" -- MESMO CompanyIcon de components/GameRoom.tsx
// (fallback do .chat-conv-company-logo quando a empresa não tem
// company_logo_url ainda).
function CompanyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path
        d="M5 20.5V4.5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v16M14 20.5h5a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1h-5M8 8h2M8 11.5h2M8 15h2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
      <path
        d="M4 5.5h16a1 1 0 0 1 1 1V16a1 1 0 0 1-1 1H9l-4.2 3.2a.5.5 0 0 1-.8-.4V17H4a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AgendaIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="M3.5 9.5h17" stroke="currentColor" strokeWidth="1.7" />
      <path d="M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M7.5 13.5h3M7.5 16.5h5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

// Ícone do botão "Contatos" -- pedido do Douglas: "quero agora, mais
// um icone de contatos" (28/set), MESMO ícone/mesma ideia do botão
// "Contatos" de dentro da sala (copiado de GameRoom.tsx).
function ContactsIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
      <rect x="3" y="5" width="18" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="8.5" cy="11" r="2.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M5.5 16c.4-1.8 1.6-2.7 3-2.7s2.6.9 3 2.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M13.5 9.5h5M13.5 12.5h5M13.5 15.5h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

// MESMOS ícones de mic/câmera/tela/engrenagem da av-bar de dentro da
// sala (copiados de GameRoom.tsx, mesmo motivo do ChatIcon/AgendaIcon
// acima) -- pedido do Douglas vendo a av-bar de dentro da sala: "cade
// o restante, configuracoes, audio, video, tela".
function MicIcon({ off }: { off: boolean }) {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 15a3.5 3.5 0 0 0 3.5-3.5V6a3.5 3.5 0 0 0-7 0v5.5A3.5 3.5 0 0 0 12 15Z"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      {off && <line x1="4.5" y1="4" x2="19.5" y2="20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />}
    </svg>
  );
}

function CamIcon({ off, size = 19 }: { off: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="3" y="6.5" width="12.5" height="11" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="m15.5 10.8 4.4-2.6a.8.8 0 0 1 1.2.7v6.2a.8.8 0 0 1-1.2.7l-4.4-2.6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      {off && <line x1="4.5" y1="4" x2="19.5" y2="20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />}
    </svg>
  );
}

// "tela" (compartilhar tela) -- SEM função aqui no Lobby de propósito
// (ver comentário grande onde o botão é usado): não tem ninguém pra
// ver a tela compartilhada antes de entrar na sala, então o ícone
// aparece pra bater com a barra de dentro da sala, mas fica desligado.
function ScreenIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
      <rect x="3" y="4.5" width="18" height="12" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8.5 20h7M12 16.5V20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M17.7 6.3l-1.6 1.6M7.9 16.1l-1.6 1.6M17.7 17.7l-1.6-1.6M7.9 7.9 6.3 6.3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function formatCallWhen(startTs: number): string {
  return new Date(startTs).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// mesma ideia de pad2/localDateStr/localTimeStr/combineLocalDateTime
// em GameRoom.tsx (copiadas, não importadas -- mesmo motivo dos
// ícones/compressPhotoToDataUrl acima: GameRoom não exporta essas
// funções) -- usadas no formulário de criar/editar compromisso do
// LobbyAgendaPanel (inputs separados de data/hora, igual
// <input type="date">/<input type="time">).
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function localTimeStr(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function combineLocalDateTime(dateStr: string, timeStr: string): number {
  if (!dateStr || !timeStr) return NaN;
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  if (!y || !m || !d || Number.isNaN(hh) || Number.isNaN(mm)) return NaN;
  return new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
}

// pedido do Douglas: "faca uma previa da agenda conforme a foto
// enviada" -- print de referência com 3 cards (um por dia com
// compromisso), cada um com um "selo" de data (29 Set / Terça-feira)
// + a lista de eventos daquele dia. Formatação em pt-BR sem depender
// de toLocaleDateString({month:"short"}) pra não vir com ponto/"de"
// (ex: "29 de set."), que não bate com o print ("29 Set").
const AGENDA_MONTH_ABBR_PT = [
  "Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez",
];

function formatAgendaDayBadge(ts: number): { day: string; month: string; weekday: string } {
  const d = new Date(ts);
  const weekdayRaw = d.toLocaleDateString("pt-BR", { weekday: "long" });
  return {
    day: String(d.getDate()).padStart(2, "0"),
    month: AGENDA_MONTH_ABBR_PT[d.getMonth()],
    weekday: weekdayRaw.charAt(0).toUpperCase() + weekdayRaw.slice(1),
  };
}

function formatAgendaEventTime(startTs: number, durationMinutes: number): string {
  const fmt = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${fmt(new Date(startTs))} - ${fmt(new Date(startTs + durationMinutes * 60000))}`;
}

/** Painel de chat do Lobby -- lista de conversas -> clicar abre o
 * histórico + campo de resposta. Ver comentário grande no topo do
 * arquivo pra entender o porquê de tudo aqui ser REST (sem WebSocket,
 * sem virar presença fantasma na sala). */
function LobbyChatPanel({
  myUserId,
  myName,
  conversations,
  accountAccessToken,
  onClose,
  onSent,
  onStartConversation,
  initialActiveId,
}: {
  myUserId: string;
  myName: string;
  conversations: ConversationSummary[] | null;
  accountAccessToken?: string | null;
  onClose: () => void;
  onSent: (conversationId: string, message: ChatMessage) => void;
  onStartConversation: (targetUserId: string, targetName: string) => void;
  initialActiveId?: string | null;
}) {
  const [activeId, setActiveId] = useState<string | null>(initialActiveId ?? null);
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [laneFilter, setLaneFilter] = useState<"company" | "private">("company");
  const [viewingProfileUserId, setViewingProfileUserId] = useState<string | null>(null);

  useEffect(() => {
    if (!activeId) {
      setMessages(null);
      return;
    }
    let cancelled = false;
    setMessages(null);
    const conversationId = activeId;

    function fetchMessages() {
      fetch(
        `${REALTIME_HTTP_BASE}/chat/messages?conversationId=${encodeURIComponent(conversationId)}&userId=${encodeURIComponent(myUserId)}`
      )
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!cancelled) setMessages(Array.isArray(data?.messages) ? data.messages : []);
        })
        .catch(() => {
          if (!cancelled) setMessages([]);
        });
    }

    fetchMessages();
    const messagesPoll = setInterval(fetchMessages, 4000);

    return () => {
      cancelled = true;
      clearInterval(messagesPoll);
    };
  }, [activeId, myUserId]);

  const activeConversation = conversations?.find((c) => c.id === activeId) ?? null;

  async function sendMessage() {
    const text = draft.trim();
    if (!text || !activeId || sending) return;
    setSending(true);
    try {
      const res = await fetch(`${REALTIME_HTTP_BASE}/chat/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: activeId, userId: myUserId, userName: myName, text }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.message) {
          setMessages((prev) => (prev ? [...prev, data.message] : [data.message]));
          onSent(activeId, data.message);
          setDraft("");
        }
      }
    } catch {
      // rede caiu no meio -- deixa o texto no campo pra pessoa tentar de novo
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="chat-drawer">
      <div className="chat-drawer-header">
        {activeId && (
          <button type="button" className="chat-icon-btn" title="Voltar" onClick={() => setActiveId(null)}>
            <BackIcon />
          </button>
        )}
        {activeId && activeConversation?.kind === "direct" && activeConversation.participants[0] ? (
          <button
            type="button"
            className="chat-drawer-header-identity"
            onClick={() => accountAccessToken && setViewingProfileUserId(activeConversation.participants[0].id)}
            title="Ver perfil"
          >
            <span
              className="chat-drawer-header-avatar"
              style={{ background: activeConversation.participants[0].color || "#5c9bff" }}
            >
              {activeConversation.participants[0].photoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={activeConversation.participants[0].photoUrl} alt="" />
              ) : (
                (activeConversation.participants[0].name || "?").trim().charAt(0).toUpperCase() || "?"
              )}
            </span>
            <h3>{conversationTitle(activeConversation)}</h3>
          </button>
        ) : (
          <h3>{activeId ? conversationTitle(activeConversation) : "Conversas"}</h3>
        )}
        <div className="chat-drawer-header-actions">
          <button type="button" className="chat-icon-btn" title="Fechar" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
      </div>

      {!activeId ? (
        <>
          <div className="chat-lane-tabs">
            <button
              type="button"
              className={`chat-lane-tab${laneFilter === "company" ? " chat-lane-tab-active" : ""}`}
              onClick={() => setLaneFilter("company")}
            >
              Empresa
            </button>
            <button
              type="button"
              className={`chat-lane-tab${laneFilter === "private" ? " chat-lane-tab-active" : ""}`}
              onClick={() => setLaneFilter("private")}
            >
              Conversas privadas
            </button>
          </div>
          {(() => {
            const laneConversations = (conversations ?? []).filter((c) => c.lane === laneFilter);
            if (laneConversations.length === 0) {
              return (
                <p className="chat-empty-hint">
                  {laneFilter === "private"
                    ? "Nenhuma conversa privada ainda. Vire amigo de alguém no painel de Amigos pra conversar aqui."
                    : "Nenhuma conversa ainda. Entre na sala pra começar uma."}
                </p>
              );
            }
            return (
              <div className="chat-conv-list">
                {laneConversations.map((c) => (
                  <button key={c.id} type="button" className="chat-conv-item" onClick={() => setActiveId(c.id)}>
                    {c.lane === "company" && (
                      <span className="chat-conv-company-logo" title={c.companyName || "Empresa"}>
                        {c.companyLogoUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={c.companyLogoUrl} alt="" />
                        ) : (
                          <CompanyIcon />
                        )}
                      </span>
                    )}
                    <span
                      className="chat-conv-avatar"
                      style={{ background: c.kind === "direct" ? c.participants[0]?.color || "#5c9bff" : "#7c5cff" }}
                    >
                      {c.kind === "group" ? <GroupIcon /> : conversationTitle(c).slice(0, 1).toUpperCase()}
                    </span>
                    <span className="chat-conv-info">
                      <span className="chat-conv-name">{conversationTitle(c)}</span>
                      {c.lastMessage && (
                        <span className="chat-conv-preview">
                          {c.lastMessage.senderId === myUserId ? "Você: " : ""}
                          {c.lastMessage.kind === "text" ? c.lastMessage.text : "anexo enviado"}
                        </span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            );
          })()}
        </>
      ) : (
        <>
          <div className="chat-messages">
            {messages === null ? (
              <p className="chat-empty-hint">Carregando…</p>
            ) : messages.length === 0 ? (
              <p className="chat-empty-hint">Nenhuma mensagem ainda.</p>
            ) : (
              messages.map((m) => (
                <div key={m.id} className={m.senderId === myUserId ? "chat-message own" : "chat-message"}>
                  {m.senderId !== myUserId && <span className="chat-message-sender">{m.senderName}</span>}
                  <div className="chat-bubble">
                    <span>{m.deleted ? "Mensagem apagada" : m.kind === "text" ? m.text : "anexo enviado"}</span>
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="chat-composer">
            <input
              className="chat-composer-input"
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") sendMessage();
              }}
              placeholder="Escreva uma mensagem…"
              maxLength={2000}
            />
            <button
              type="button"
              className="chat-composer-btn primary"
              onClick={sendMessage}
              disabled={!draft.trim() || sending}
              title="Enviar"
            >
              <SendIcon />
            </button>
          </div>
        </>
      )}

      {viewingProfileUserId && accountAccessToken && (
        <ProfileViewCard
          userId={viewingProfileUserId}
          accountAccessToken={accountAccessToken}
          onClose={() => setViewingProfileUserId(null)}
          onStartConversation={(targetUserId, targetName) => {
            setViewingProfileUserId(null);
            onStartConversation(targetUserId, targetName);
          }}
        />
      )}
    </div>
  );
}

function conversationTitle(c: ConversationSummary | null | undefined): string {
  if (!c) return "Conversa";
  if (c.kind === "group") return c.name || "Grupo";
  return c.participants[0]?.name || "Conversa";
}

/** Painel de agenda do Lobby -- lista de compromissos, com Aceitar/
 * Recusar pra quem ainda tá pendente (mesma trava de participante do
 * agendaStore, ver POST /agenda/respond em server/index.js). */
type AgendaFormState = {
  title: string;
  date: string;
  time: string;
  durationMinutes: number;
  participantIds: string[];
  description: string;
};

const AGENDA_DURATION_OPTIONS = [15, 30, 45, 60, 90, 120];

/** Painel de agenda do Lobby -- lista de compromissos (Aceitar/Recusar
 * pra quem ainda tá pendente, mesma trava de participante do
 * agendaStore, ver POST /agenda/respond em server/index.js) + CRIAR e
 * EDITAR compromisso (29/set: Douglas reportou "nao me da a agenda
 * mesmo, editavel e criavel" -- antes só tinha leitura/resposta,
 * igual a versão de dentro da sala (av-bar "Marcar compromisso"), mas
 * essa daqui roda via REST (POST /agenda/create,update,delete em
 * server/index.js), sem abrir WebSocket -- MESMO motivo do resto do
 * Lobby ficar em REST (ver comentário grande no topo do arquivo: não
 * virar presença fantasma na sala). Só quem CRIOU o compromisso pode
 * editar/apagar (call.createdBy, ver agendaStore.updateCall/
 * deleteCall) -- participantes continuam só podendo aceitar/recusar.
 * Editar não mexe em quem foi convidado (participantes só se define
 * na criação -- isso também não existe na versão de dentro da sala,
 * não é regressão daqui). */
function LobbyAgendaPanel({
  myUserId,
  calls,
  directory,
  onClose,
  setCalls,
}: {
  myUserId: string;
  calls: CallSummary[] | null;
  directory: ContactUser[] | null;
  onClose: () => void;
  setCalls: (updater: (prev: CallSummary[] | null) => CallSummary[] | null) => void;
}) {
  const [respondingId, setRespondingId] = useState<string | null>(null);
  const [view, setView] = useState<"list" | "form">("list");
  const [editingCallId, setEditingCallId] = useState<string | null>(null);
  const [form, setForm] = useState<AgendaFormState>({
    title: "",
    date: "",
    time: "",
    durationMinutes: 30,
    participantIds: [],
    description: "",
  });
  const [participantPickerOpen, setParticipantPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  async function respond(callId: string, status: "approved" | "declined") {
    if (respondingId) return;
    setRespondingId(callId);
    try {
      const res = await fetch(`${REALTIME_HTTP_BASE}/agenda/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callId, userId: myUserId, status }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.call) setCalls((prev) => (prev ? prev.map((c) => (c.id === data.call.id ? data.call : c)) : prev));
      }
    } catch {
      // rede caiu -- pessoa tenta de novo, botão volta a ficar clicável
    } finally {
      setRespondingId(null);
    }
  }

  function openNewForm() {
    const suggestion = new Date(Date.now() + 30 * 60_000); // meia hora a partir de agora, só ponto de partida
    setForm({
      title: "",
      date: localDateStr(suggestion),
      time: localTimeStr(suggestion),
      durationMinutes: 30,
      participantIds: [],
      description: "",
    });
    setEditingCallId(null);
    setFormError(null);
    setParticipantPickerOpen(false);
    setView("form");
  }

  function openEditForm(call: CallSummary) {
    const d = new Date(call.startTs);
    setForm({
      title: call.title,
      date: localDateStr(d),
      time: localTimeStr(d),
      durationMinutes: call.durationMinutes,
      participantIds: call.participants.filter((p) => p.id !== myUserId).map((p) => p.id),
      description: call.description || "",
    });
    setEditingCallId(call.id);
    setFormError(null);
    setParticipantPickerOpen(false);
    setView("form");
  }

  function toggleFormParticipant(userId: string) {
    setForm((prev) => ({
      ...prev,
      participantIds: prev.participantIds.includes(userId)
        ? prev.participantIds.filter((x) => x !== userId)
        : [...prev.participantIds, userId],
    }));
  }

  async function submitForm() {
    const startTs = combineLocalDateTime(form.date, form.time);
    if (!Number.isFinite(startTs)) {
      setFormError("Preenche a data e o horário pra marcar o compromisso.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      if (editingCallId) {
        const res = await fetch(`${REALTIME_HTTP_BASE}/agenda/update`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            callId: editingCallId,
            userId: myUserId,
            title: form.title.trim() || "Call",
            startTs,
            durationMinutes: form.durationMinutes,
            description: form.description.trim(),
          }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.call) {
          setFormError("Não deu pra salvar -- tenta de novo.");
          return;
        }
        setCalls((prev) => (prev ? prev.map((c) => (c.id === data.call.id ? data.call : c)) : prev));
      } else {
        const res = await fetch(`${REALTIME_HTTP_BASE}/agenda/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: myUserId,
            title: form.title.trim() || "Call",
            startTs,
            durationMinutes: form.durationMinutes,
            participantIds: form.participantIds,
            description: form.description.trim(),
          }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.call) {
          setFormError("Não deu pra criar -- tenta de novo.");
          return;
        }
        setCalls((prev) => [...(prev ?? []), data.call]);
      }
      setView("list");
    } catch {
      setFormError("Rede caiu -- tenta de novo.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteCall(callId: string) {
    if (deletingId) return;
    if (!window.confirm("Apagar esse compromisso?")) return;
    setDeletingId(callId);
    try {
      const res = await fetch(`${REALTIME_HTTP_BASE}/agenda/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callId, userId: myUserId }),
      });
      if (res.ok) {
        setCalls((prev) => (prev ? prev.filter((c) => c.id !== callId) : prev));
      }
    } catch {
      // rede caiu -- pessoa tenta de novo
    } finally {
      setDeletingId(null);
    }
  }

  const sorted = calls ? [...calls].sort((a, b) => a.startTs - b.startTs) : null;

  return (
    <div className="lobby-panel-backdrop" onClick={onClose}>
      <div className={view === "form" ? "lobby-panel lobby-panel-wide" : "lobby-panel"} onClick={(e) => e.stopPropagation()}>
        <div className="lobby-panel-header">
          {view === "form" && (
            <button type="button" className="lobby-panel-back" onClick={() => setView("list")} title="Voltar">
              ←
            </button>
          )}
          <h3>{view === "list" ? "Agenda" : editingCallId ? "Editar compromisso" : "Novo compromisso"}</h3>
          {view === "list" && (
            <button type="button" className="lobby-panel-add" onClick={openNewForm} title="Novo compromisso">
              +
            </button>
          )}
          <button type="button" className="lobby-panel-close" onClick={onClose} title="Fechar">
            ✕
          </button>
        </div>

        {view === "list" ? (
          !sorted || sorted.length === 0 ? (
            <div className="lobby-panel-empty-wrap">
              <p className="lobby-panel-empty">Nenhum compromisso agendado.</p>
              <button type="button" className="lobby-agenda-new-btn" onClick={openNewForm}>
                + Marcar compromisso
              </button>
            </div>
          ) : (
            <ul className="lobby-call-list">
              {sorted.map((call) => {
                const mine = call.participants.find((p) => p.id === myUserId);
                const isOwner = call.createdBy === myUserId;
                return (
                  <li key={call.id} className="lobby-call-item">
                    <p className="lobby-call-title">{call.title}</p>
                    <p className="lobby-call-when">
                      {formatCallWhen(call.startTs)} · {call.durationMinutes} min
                    </p>
                    {mine?.status === "pending" ? (
                      <div className="lobby-call-actions">
                        <button
                          type="button"
                          className="lobby-call-accept"
                          disabled={respondingId === call.id}
                          onClick={() => respond(call.id, "approved")}
                        >
                          Aceitar
                        </button>
                        <button
                          type="button"
                          className="lobby-call-decline"
                          disabled={respondingId === call.id}
                          onClick={() => respond(call.id, "declined")}
                        >
                          Recusar
                        </button>
                      </div>
                    ) : (
                      <p className="lobby-call-status">
                        {mine?.status === "declined" ? "Você recusou" : mine?.status === "approved" ? "Confirmado" : ""}
                      </p>
                    )}
                    {isOwner && (
                      <div className="lobby-call-owner-actions">
                        <button type="button" className="lobby-call-edit" onClick={() => openEditForm(call)}>
                          Editar
                        </button>
                        <button
                          type="button"
                          className="lobby-call-delete"
                          disabled={deletingId === call.id}
                          onClick={() => deleteCall(call.id)}
                        >
                          Apagar
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )
        ) : (
          <div className="lobby-agenda-form">
            <label className="lobby-agenda-form-field">
              <span>Título</span>
              <input
                type="text"
                value={form.title}
                maxLength={80}
                placeholder="Reunião, call, compromisso…"
                onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
              />
            </label>

            <div className="lobby-agenda-form-row">
              <label className="lobby-agenda-form-field">
                <span>Data</span>
                <input
                  type="date"
                  value={form.date}
                  onChange={(e) => setForm((prev) => ({ ...prev, date: e.target.value }))}
                />
              </label>
              <label className="lobby-agenda-form-field">
                <span>Horário</span>
                <input
                  type="time"
                  value={form.time}
                  onChange={(e) => setForm((prev) => ({ ...prev, time: e.target.value }))}
                />
              </label>
            </div>

            <label className="lobby-agenda-form-field">
              <span>Duração</span>
              <select
                value={form.durationMinutes}
                onChange={(e) => setForm((prev) => ({ ...prev, durationMinutes: Number(e.target.value) }))}
              >
                {AGENDA_DURATION_OPTIONS.map((min) => (
                  <option key={min} value={min}>
                    {min} min
                  </option>
                ))}
              </select>
            </label>

            {/* participantes só dá pra escolher na CRIAÇÃO -- editar
                não mexe em quem foi convidado (ver comentário grande
                no topo do componente). Ao editar, só mostra quem já
                tá convidado, sem dropdown. */}
            {editingCallId ? (
              <div className="lobby-agenda-form-field">
                <span>Convidados</span>
                <p className="lobby-agenda-invited-readonly">
                  {form.participantIds.length === 0
                    ? "Só você"
                    : form.participantIds
                        .map((id) => directory?.find((u) => u.userId === id)?.name || "Alguém")
                        .join(", ")}
                </p>
              </div>
            ) : (
              <label className="lobby-agenda-form-field">
                <span>Convidar pessoas</span>
                <div className="company-edit-category-select">
                  <button
                    type="button"
                    className="company-edit-input company-edit-category-trigger"
                    onClick={() => setParticipantPickerOpen((v) => !v)}
                    aria-expanded={participantPickerOpen}
                    disabled={!directory}
                  >
                    <span className="company-edit-category-trigger-text">
                      {!directory
                        ? "Carregando pessoas…"
                        : form.participantIds.length > 0
                          ? form.participantIds
                              .map((id) => directory.find((u) => u.userId === id)?.name || "Alguém")
                              .join(", ")
                          : "Só você (opcional)"}
                    </span>
                    <ChevronIcon />
                  </button>
                  {participantPickerOpen && directory && (
                    <>
                      <div className="company-edit-category-catcher" onClick={() => setParticipantPickerOpen(false)} />
                      <div className="company-edit-category-list" onClick={(e) => e.stopPropagation()}>
                        {directory.filter((u) => u.userId !== myUserId).length === 0 ? (
                          <p className="lobby-agenda-invited-readonly">Ninguém mais cadastrado ainda.</p>
                        ) : (
                          directory
                            .filter((u) => u.userId !== myUserId)
                            .map((u) => (
                              <label key={u.userId} className="company-edit-category-option">
                                <input
                                  type="checkbox"
                                  checked={form.participantIds.includes(u.userId)}
                                  onChange={() => toggleFormParticipant(u.userId)}
                                />
                                <span>{u.name}</span>
                              </label>
                            ))
                        )}
                      </div>
                    </>
                  )}
                </div>
              </label>
            )}

            <label className="lobby-agenda-form-field">
              <span>Descrição (opcional)</span>
              <textarea
                className="company-edit-textarea"
                value={form.description}
                maxLength={2000}
                rows={3}
                placeholder="Detalhes do compromisso"
                onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
              />
            </label>

            {formError && <p className="lobby-agenda-form-error">{formError}</p>}

            <button type="button" className="lobby-agenda-form-submit" disabled={saving} onClick={submitForm}>
              {saving ? "Salvando…" : editingCallId ? "Salvar alterações" : "Marcar compromisso"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Lobby({
  accountUserId,
  accountProfile,
  accountAccessToken,
  onEnter,
  onSignOut,
}: {
  accountUserId: string | null;
  accountProfile: Partial<AccountProfile> | null;
  accountAccessToken?: string | null;
  onEnter: (roomSlug: string) => void;
  onSignOut: (() => void) | null;
}) {
  const [presence, setPresence] = useState<PresenceInfo>(null);
  // papel na sala do Douglas (ver comentário grande "teamOnly" em
  // ROOM_SLUGS acima) -- MESMA fonte que GameRoom.tsx já usa pra
  // canEditRoom (GET /api/room/members com o access token, ver efeito
  // logo abaixo), só que buscado aqui no Lobby (ANTES de entrar em
  // sala nenhuma) porque é o que decide quais itens de "Meus espaços"
  // aparecem. Começa "visitor" de propósito (esconde "Sala principal"
  // até confirmar owner/member, nunca o contrário -- evita um flash do
  // botão aparecendo e sumindo pra quem não devia ver).
  const [roomRole, setRoomRole] = useState<"owner" | "member" | "visitor">("visitor");
  const [roomRoleLoading, setRoomRoleLoading] = useState(true);
  // "Sala principal"/"Mapa modelo" são do TIME do Douglas -- só ele
  // (owner) e quem ele convidou (member, ver comentário grande
  // "teamOnly" acima) enxergam eles em "Meus espaços". Um "visitor"
  // (cliente qualquer) nunca vê nenhum dos dois.
  const canSeeSalaPrincipal = roomRole === "owner" || roomRole === "member";
  // a sala PRÓPRIA do cliente (ver MyRoom acima/fetch de
  // /api/room/mine mais abaixo) -- null enquanto ele ainda não criou
  // uma (ver "Criar minha sala" mais abaixo).
  const [myRoom, setMyRoom] = useState<MyRoom | null>(null);
  const [myRoomLoading, setMyRoomLoading] = useState(true);
  // catálogo de modelos publicados (GET /api/room/templates) -- pra
  // tela de "Criar minha sala" escolher um. Busca sempre (é público,
  // barato), só é USADO quando needsToCreateRoom abaixo é true.
  const [templates, setTemplates] = useState<RoomTemplate[] | null>(null);
  // id do template sendo clonado agora (POST
  // /api/room/create-from-template em andamento) -- desabilita os
  // cards enquanto isso, evita clique duplo criando 2 salas.
  const [creatingFromTemplateId, setCreatingFromTemplateId] = useState<string | null>(null);
  const [createRoomError, setCreateRoomError] = useState<string | null>(null);
  // nome da empresa (29/set (2), pedido do Douglas: "'empresa' tem que
  // virar o Nome da empresa / A pessoa so cria o espaco depois que
  // nomeia a empresa") -- passo NOVO antes de escolher o modelo: sem
  // nome confirmado (companyName vazio), mostra o campo de nome em vez
  // do catálogo de modelos (ver JSX de needsToCreateRoom mais abaixo).
  // Confirmar só troca a TELA (pro catálogo) -- a empresa só existe de
  // verdade quando a sala é criada (handleCreateRoomFromTemplate manda
  // esse nome pro servidor, que grava em rooms.name).
  const [companyNameDraft, setCompanyNameDraft] = useState("");
  const [companyName, setCompanyName] = useState("");
  // "Espaços visitados" (pedido do Douglas, 29/set: "se eu entrar na
  // sala de um amigo, a sala dele vai ficar ali, como um link rapido")
  // -- salas de OUTRAS pessoas que essa conta já visitou por link (ver
  // POST /api/room/visit), mais recente primeiro (ver GET
  // /api/room/visits, efeito mais abaixo). visitSlug vem de
  // ?visitar=<slug> na URL, lido direto de window.location (não
  // useSearchParams, pra não precisar de Suspense boundary só por
  // causa disso, ver efeito logo abaixo) -- é o "link de convite" que
  // o dono de uma sala copia (ver handleCopyRoomLink mais abaixo) e
  // manda pra quem quiser, sem precisar gerar código nenhum.
  const [visitedRooms, setVisitedRooms] = useState<VisitedRoom[] | null>(null);
  const [visitedMenuOpen, setVisitedMenuOpen] = useState(false);
  const [visitSlug, setVisitSlug] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  // qual espaço tá selecionado em "Meus espaços" agora (ver dropdown
  // mais abaixo/ROOM_SLUGS acima) -- vazio até confirmar algo válido
  // (nunca cai em "mapa-modelo"/"sala-principal" por padrão pra quem
  // pode não ter acesso a nenhum dos dois, ver efeitos logo abaixo).
  // Vira "sala-principal" sozinho pro time do Douglas, ou o slug da
  // MyRoom sozinho pra quem já tem sala própria -- mas só DEPOIS de
  // confirmar (nunca busca/mostra o preview de uma sala que a pessoa
  // não devia ver, nem por um instante).
  const [selectedRoomSlug, setSelectedRoomSlug] = useState<string>("");
  // true assim que a pessoa mexe no dropdown à mão -- trava os efeitos
  // de auto-seleção acima de rodar de novo depois e atropelar uma
  // escolha manual.
  const userPickedRoomRef = useRef(false);
  const [room, setRoom] = useState<RoomShape>(null);
  const [roomLoading, setRoomLoading] = useState(true);
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const [calls, setCalls] = useState<CallSummary[] | null>(null);
  const [chatPanelOpen, setChatPanelOpen] = useState(false);
  // Contatos (28/set, pedido do Douglas: "quero agora, mais um icone
  // de contatos") -- diretório platform-wide via GET /users/directory
  // (mesma fonte de chatStore.listAllUsers que o WS manda como
  // "users:list" de dentro da sala, ver comentário grande em
  // ContactsPanel.tsx). openChatConversationId é a "ponte" pra abrir o
  // LobbyChatPanel JÁ na conversa certa ao clicar "Conversar" (ver
  // handleStartConversation mais abaixo).
  const [directory, setDirectory] = useState<ContactUser[] | null>(null);
  const [contactsOpen, setContactsOpen] = useState(false);
  const [contactsBusy, setContactsBusy] = useState(false);
  const [openChatConversationId, setOpenChatConversationId] = useState<string | null>(null);

  // Barra de topo (28/set, pedido do Douglas com print de referência
  // do site da Pepsi -- só a DIAGRAMAÇÃO, canto superior esquerdo:
  // logo à esquerda, abas na mesma linha) -- "Meus espaços" é a
  // primeira aba, com setinha seletora: hoje só existe UMA sala no
  // ambiente todo (STORE_SLUG "sala-principal", ver server/chatStore.js
  // -- ainda não existe conceito de múltiplas salas/organizações no
  // backend), então o menu lista só ela; o dropdown já fica pronto pra
  // quando existir mais de uma (aí lista o nome de cada organização,
  // como o Douglas pediu).
  const [spacesMenuOpen, setSpacesMenuOpen] = useState(false);

  // "card" da conta do cliente -- pedido do Douglas (28/set, print de
  // referência de um card "Hello! I'm Max"): "aqui nesse canto, faca o
  // card da conta do cliente" + "faca o 'card' do perfil do usuario
  // aberto". Fica no canto direito da barra (3ª coluna do grid, que já
  // tava vazia/reservada, ver comentário grande em app/globals.css).
  const [accountCardOpen, setAccountCardOpen] = useState(false);

  // card da Empresa selecionada -- pedido do Douglas (29/set (7)):
  // "quero cada card de empresa atrelado a um espaco". Busca o card
  // de VERDADE (GET /api/room/company-profile?slug=...) do espaço
  // atualmente SELECIONADO (mesmo selectedRoomSlug de "Meus
  // espaços"/"Espaços visitados" -- ver dropdown mais abaixo/mais
  // acima) -- troca de espaço selecionado busca outro card, cada um
  // com seus próprios dados (ver migration
  // 0040_room_company_profile.sql/rota, comentário grande no topo do
  // arquivo sobre CompanyProfile). companyProfileCanEdit vem do
  // servidor (é dono de verdade daquele espaço ou não) -- controla se
  // a setinha de editar aparece (ver JSX mais abaixo).
  const [companyProfile, setCompanyProfile] = useState<CompanyProfile>(BLANK_COMPANY_PROFILE);
  const [companyProfileCanEdit, setCompanyProfileCanEdit] = useState(false);
  const [companyProfileLoading, setCompanyProfileLoading] = useState(false);
  const [companyEditOpen, setCompanyEditOpen] = useState(false);
  const [companySaving, setCompanySaving] = useState(false);
  const [companySaveError, setCompanySaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedRoomSlug) {
      setCompanyProfile(BLANK_COMPANY_PROFILE);
      setCompanyProfileCanEdit(false);
      return;
    }
    let cancelled = false;
    setCompanyProfileLoading(true);
    setCompanyEditOpen(false); // troca de espaço fecha a edição do card anterior
    const headers: Record<string, string> = {};
    if (accountAccessToken) headers.Authorization = `Bearer ${accountAccessToken}`;
    fetch(`/api/room/company-profile?slug=${encodeURIComponent(selectedRoomSlug)}`, { headers })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (data?.profile) {
          setCompanyProfile(data.profile);
          setCompanyProfileCanEdit(!!data.canEdit);
        } else {
          setCompanyProfile(BLANK_COMPANY_PROFILE);
          setCompanyProfileCanEdit(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCompanyProfile(BLANK_COMPANY_PROFILE);
          setCompanyProfileCanEdit(false);
        }
      })
      .finally(() => {
        if (!cancelled) setCompanyProfileLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRoomSlug, accountAccessToken]);

  // "Salvar alterações" agora salva DE VERDADE (POST, ver rota) --
  // antes (quando isso era só localStorage) o botão só fechava o
  // painel, porque os campos já aplicavam ao vivo em memória. Chamado
  // pelo botão de salvar lá embaixo.
  async function saveCompanyProfile() {
    if (!selectedRoomSlug || !accountAccessToken || companySaving) return;
    setCompanySaving(true);
    setCompanySaveError(null);
    try {
      const res = await fetch("/api/room/company-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accountAccessToken}` },
        body: JSON.stringify({ slug: selectedRoomSlug, ...companyProfile }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setCompanySaveError(data?.error || "não deu pra salvar, tenta de novo");
        return;
      }
      if (data?.profile) setCompanyProfile(data.profile);
      setCompanyEditOpen(false);
    } catch {
      setCompanySaveError("rede caiu no meio, tenta de novo");
    } finally {
      setCompanySaving(false);
    }
  }

  // dropdown de "Posicione a sua empresa:" -- Douglas pediu multi-seleção
  // ("deixei marcar varias opcoes"), então é um checklist dentro de um
  // dropdown, não um <select> nativo (que só permite uma opção por vez).
  const [companyCategoryOpen, setCompanyCategoryOpen] = useState(false);
  const companyLogoInputRef = useRef<HTMLInputElement>(null);
  const companyBannerInputRef = useRef<HTMLInputElement>(null);

  async function handleCompanyLogoChange(file: File) {
    try {
      const dataUrl = await compressSquarePhotoToDataUrl(file);
      setCompanyProfile((prev) => ({ ...prev, logoUrl: dataUrl }));
    } catch (e) {
      console.warn("Não deu pra processar a foto de perfil da empresa", e);
    }
  }

  async function handleCompanyBannerChange(file: File) {
    try {
      const dataUrl = await compressBannerPhotoToDataUrl(file);
      setCompanyProfile((prev) => ({ ...prev, bannerUrl: dataUrl }));
    } catch (e) {
      console.warn("Não deu pra processar o banner da empresa", e);
    }
  }

  function toggleCompanyCategory(cat: string) {
    setCompanyProfile((prev) => {
      const already = prev.category.includes(cat);
      return {
        ...prev,
        category: already ? prev.category.filter((c) => c !== cat) : [...prev.category, cat],
      };
    });
  }

  const [agendaPanelOpen, setAgendaPanelOpen] = useState(false);

  // --- mic/câmera do Lobby (28/set, pedido do Douglas vendo a av-bar
  // de dentro da sala: "cade o restante, configuracoes, audio, video,
  // tela") -- os botões aqui só guardam a PREFERÊNCIA (localStorage,
  // ver lib/mediaPrefs.ts), sem pedir câmera/mic de verdade -- Douglas
  // pediu pra tirar a prévia de vídeo do Lobby ("tira isso do lobby",
  // reagindo à caixa "Sem acesso à câmera/microfone"), então voltamos
  // ao princípio original: só pede permissão quando a pessoa entra na
  // sala de verdade (ver requestMedia em GameRoom.tsx), que aplica essa
  // mesma preferência salva aqui. Trocar de aparelho em "Configurações"
  // ainda pede stream (só naquele clique, ação explícita). ---
  const [micOn, setMicOn] = useState(() => getStoredMicOn());
  const [camOn, setCamOn] = useState(() => getStoredCamOn());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedMicId, setSelectedMicId] = useState(() => getStoredMicDeviceId());
  const [selectedCamId, setSelectedCamId] = useState(() => getStoredCamDeviceId());
  const [selectedSpeakerId, setSelectedSpeakerId] = useState(() => getStoredSpeakerDeviceId());
  const localStreamRef = useRef<MediaStream | null>(null);

  const myUserId = useMemo(() => resolveUserId(accountUserId), [accountUserId]);
  const myName = accountProfile?.name?.trim() || "Visitante";

  useEffect(() => {
    return () => {
      // solta qualquer stream aberta (só existe se a pessoa mexeu em
      // "Configurações" pra testar um aparelho, ver switchMicDevice/
      // switchCamDevice) ao sair do Lobby de qualquer jeito.
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Sem stream ativa no Lobby por padrão -- os botões só trocam a
  // preferência salva (aplicada de verdade quando entra na sala, ver
  // requestMedia em GameRoom.tsx).
  function toggleMic() {
    localStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = !micOn));
    setMicOn((v) => {
      setStoredMicOn(!v);
      return !v;
    });
  }

  function toggleCam() {
    localStreamRef.current?.getVideoTracks().forEach((t) => (t.enabled = !camOn));
    setCamOn((v) => {
      setStoredCamOn(!v);
      return !v;
    });
  }

  // MESMA ideia de switchMicDevice/switchCamDevice em GameRoom.tsx, só
  // que bem mais simples: sem peers/WebRTC nenhum aqui pra reencaminhar
  // a track nova, é só trocar o preview local mesmo.
  async function switchMicDevice(deviceId: string) {
    if (!deviceId || deviceId === selectedMicId) return;
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
      const newTrack = fresh.getAudioTracks()[0];
      if (!newTrack) return;
      newTrack.enabled = micOn;
      const stream = localStreamRef.current;
      const oldTrack = stream?.getAudioTracks()[0];
      if (stream && oldTrack) {
        stream.removeTrack(oldTrack);
        oldTrack.stop();
        stream.addTrack(newTrack);
      } else {
        localStreamRef.current = fresh;
      }
      setSelectedMicId(deviceId);
      setStoredMicDeviceId(deviceId);
    } catch (e) {
      console.warn("Não deu pra trocar de microfone", e);
    }
  }

  async function switchCamDevice(deviceId: string) {
    if (!deviceId || deviceId === selectedCamId) return;
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } });
      const newTrack = fresh.getVideoTracks()[0];
      if (!newTrack) return;
      newTrack.enabled = camOn;
      const stream = localStreamRef.current;
      const oldTrack = stream?.getVideoTracks()[0];
      if (stream && oldTrack) {
        stream.removeTrack(oldTrack);
        oldTrack.stop();
        stream.addTrack(newTrack);
      } else {
        localStreamRef.current = fresh;
      }
      setSelectedCamId(deviceId);
      setStoredCamDeviceId(deviceId);
    } catch (e) {
      console.warn("Não deu pra trocar de câmera", e);
    }
  }

  function switchSpeakerDevice(deviceId: string) {
    setSelectedSpeakerId(deviceId);
    setStoredSpeakerDeviceId(deviceId);
  }

  function handleEnter() {
    // defesa a mais (o botão já fica disabled sem seleção, ver JSX
    // mais abaixo) -- nunca entra em sala nenhuma sem slug de verdade.
    if (!selectedRoomSlug) return;
    // solta a câmera/mic do Lobby ANTES de entrar -- o GameRoom pede a
    // dele própria (ver requestMedia lá), sem isso os dois ficariam
    // segurando o mesmo dispositivo ao mesmo tempo por um instante.
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    onEnter(selectedRoomSlug);
  }

  useEffect(() => {
    let cancelled = false;
    fetch(`${REALTIME_HTTP_BASE}/room/presence`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data) setPresence({ totalOnline: Number(data.totalOnline) || 0 });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // ?visitar=<room_slug> na URL (ver comentário grande de visitSlug
  // acima) -- lido direto de window.location em vez de useSearchParams
  // de propósito: só client-side (roda uma vez ao montar, igual todo
  // outro fetch aqui), sem exigir Suspense boundary em app/page.tsx só
  // por causa de um parâmetro que a imensa maioria das visitas ao
  // Lobby nem tem.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const v = new URLSearchParams(window.location.search).get("visitar");
    if (v && v.trim()) setVisitSlug(v.trim());
  }, []);

  // refaz a busca do "mapinha" toda vez que a seleção em "Meus espaços"
  // muda (ver selectedRoomSlug acima) -- cada slug tem seu PRÓPRIO piso/
  // parede/mobília agora (ver comentário grande "MULTI-SALA" em
  // server/roomStore.js), então o preview precisa mandar "?room=" igual
  // GameRoom.tsx faz (ver roomApiPath lá), senão mostraria sempre o
  // preview da sala padrão mesmo com outra selecionada. selectedRoomSlug
  // vazio (ainda confirmando acesso, ver efeitos de roomRole/myRoom
  // abaixo, ou cliente sem sala nenhuma ainda) -- não busca NADA, pra
  // nunca vazar sequer o preview de uma sala que a pessoa não devia ver.
  useEffect(() => {
    if (!selectedRoomSlug) {
      setRoom(null);
      setRoomLoading(false);
      return;
    }
    let cancelled = false;
    setRoomLoading(true);
    const qs = `?room=${encodeURIComponent(selectedRoomSlug)}`;
    Promise.all([
      fetch(`${REALTIME_HTTP_BASE}/room/floor${qs}`).then((r) => (r.ok ? r.json() : null)),
      fetch(`${REALTIME_HTTP_BASE}/room/walls${qs}`).then((r) => (r.ok ? r.json() : null)),
      fetch(`${REALTIME_HTTP_BASE}/room/furniture${qs}`).then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([floorData, wallsData, furnitureData]) => {
        if (cancelled) return;
        setRoom({
          floor: Array.isArray(floorData?.items) ? floorData.items : [],
          walls: Array.isArray(wallsData?.items) ? wallsData.items : [],
          furniture: Array.isArray(furnitureData?.items) ? furnitureData.items : [],
        });
      })
      .catch(() => {
        if (!cancelled) setRoom(null);
      })
      .finally(() => {
        if (!cancelled) setRoomLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRoomSlug]);

  // confere o papel na sala do Douglas (ver comentário grande "teamOnly"
  // em ROOM_SLUGS/roomRole acima) -- mesma rota que GameRoom.tsx usa pra
  // canEditRoom (GET /api/room/members), só que chamada aqui no Lobby.
  // Sem token (visitante sem conta, ou conta ainda carregando), fica
  // "visitor" na hora (nada pra esperar).
  useEffect(() => {
    let cancelled = false;
    if (!accountAccessToken) {
      setRoomRole("visitor");
      setRoomRoleLoading(false);
      return;
    }
    fetch("/api/room/members", { headers: { Authorization: `Bearer ${accountAccessToken}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        const role: "owner" | "member" | "visitor" =
          data?.role === "owner" || data?.role === "member" ? data.role : "visitor";
        setRoomRole(role);
        // owner/member (time do Douglas, convidado por link, ver
        // comentário grande "teamOnly" acima) cai direto na Sala
        // principal por padrão (comportamento de sempre), a menos que já
        // tenha escolhido algo no dropdown à mão.
        if (role !== "visitor" && !userPickedRoomRef.current) setSelectedRoomSlug("sala-principal");
      })
      .catch(() => {
        if (!cancelled) setRoomRole("visitor");
      })
      .finally(() => {
        if (!cancelled) setRoomRoleLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountAccessToken]);

  // busca a sala PRÓPRIA do cliente (ver MyRoom/GET /api/room/mine
  // acima) -- sem token, nunca tem (precisa de conta, ver
  // owner_user_id em public.rooms). Pro Douglas essa rota já devolve a
  // própria Sala principal (ver comentário em app/api/room/mine),
  // então esse efeito cai direto pra ela também, sem precisar de
  // tratamento especial aqui.
  useEffect(() => {
    let cancelled = false;
    if (!accountAccessToken) {
      setMyRoom(null);
      setMyRoomLoading(false);
      return;
    }
    fetch("/api/room/mine", { headers: { Authorization: `Bearer ${accountAccessToken}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        const found: MyRoom | null =
          data?.room && typeof data.room.room_slug === "string" && typeof data.room.id === "string"
            ? { id: data.room.id, name: String(data.room.name ?? "Minha sala"), room_slug: data.room.room_slug }
            : null;
        setMyRoom(found);
        if (found && !userPickedRoomRef.current) setSelectedRoomSlug(found.room_slug);
      })
      .catch(() => {
        if (!cancelled) setMyRoom(null);
      })
      .finally(() => {
        if (!cancelled) setMyRoomLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountAccessToken]);

  // busca a lista de "Espaços visitados" (GET /api/room/visits, ver
  // VisitedRoom acima) -- sem token, ninguém tem histórico nenhum
  // (precisa de conta, ver room_visits.user_id).
  useEffect(() => {
    let cancelled = false;
    if (!accountAccessToken) {
      setVisitedRooms(null);
      return;
    }
    fetch("/api/room/visits", { headers: { Authorization: `Bearer ${accountAccessToken}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setVisitedRooms(Array.isArray(data?.visits) ? data.visits : []);
      })
      .catch(() => {
        if (!cancelled) setVisitedRooms([]);
      });
    return () => {
      cancelled = true;
    };
  }, [accountAccessToken]);

  // resolve o ?visitar=<slug> lido acima (ver efeito de visitSlug) --
  // POST /api/room/visit confere se é uma sala de CLIENTE de verdade
  // (recusa sala-principal/mapa-modelo e slugs inventados, ver
  // comentário grande na rota) e só DEPOIS de confirmado é que
  // selectedRoomSlug muda -- nunca confia direto no que veio da URL.
  // Precisa de conta (sem token não tem como registrar a visita nem
  // saber se a sala existe de verdade).
  useEffect(() => {
    if (!visitSlug || !accountAccessToken) return;
    let cancelled = false;
    fetch("/api/room/visit", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accountAccessToken}` },
      body: JSON.stringify({ roomSlug: visitSlug }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || typeof data?.room?.room_slug !== "string") return;
        userPickedRoomRef.current = true;
        setSelectedRoomSlug(data.room.room_slug);
        // já bota o atalho na lista na hora, sem esperar reabrir o
        // Lobby de novo pra ele aparecer em "Espaços visitados"
        // (ownRoom: é a sala de quem tá pedindo, não é "visita" --
        // não deve entrar na lista).
        if (!data.ownRoom) {
          const visited: VisitedRoom = { id: data.room.id, name: String(data.room.name ?? "Sala"), room_slug: data.room.room_slug };
          setVisitedRooms((prev) => [visited, ...(prev ?? []).filter((r) => r.id !== visited.id)]);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [visitSlug, accountAccessToken]);

  // catálogo de modelos publicados (GET /api/room/templates, ver
  // RoomTemplate acima) -- público/barato, busca sempre; só é
  // renderizado de fato quando needsToCreateRoom abaixo é true.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/room/templates")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setTemplates(Array.isArray(data?.templates) ? data.templates : []);
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Copia um modelo publicado pra virar a sala PRÓPRIA do cliente (ver
   * comentário grande em app/api/room/create-from-template/route.ts) --
   * pedido do Douglas: "as pessoas so copiam a sala modelo, pra eles,
   * ai se cria o mapa pra eles vinculado ao id deles". */
  async function handleCreateRoomFromTemplate(templateId: string) {
    if (!accountAccessToken || creatingFromTemplateId || !companyName.trim()) return;
    setCreatingFromTemplateId(templateId);
    setCreateRoomError(null);
    try {
      const res = await fetch("/api/room/create-from-template", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accountAccessToken}` },
        body: JSON.stringify({ templateId, companyName: companyName.trim() }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || typeof data?.room?.room_slug !== "string") {
        setCreateRoomError(typeof data?.error === "string" ? data.error : "Não deu pra criar sua sala agora.");
        return;
      }
      const created: MyRoom = { id: data.room.id, name: String(data.room.name ?? "Minha sala"), room_slug: data.room.room_slug };
      setMyRoom(created);
      setCreatingSpaceFromDropdown(false);
      userPickedRoomRef.current = true;
      setSelectedRoomSlug(created.room_slug);
    } catch {
      setCreateRoomError("Não deu pra criar sua sala agora.");
    } finally {
      setCreatingFromTemplateId(null);
    }
  }

  /** Copia pra área de transferência o link que qualquer conta pode
   * abrir pra visitar a sala PRÓPRIA de quem tá logado agora (ver POST
   * /api/room/visit / comentário grande de visitSlug lá em cima) --
   * pedido do Douglas: "se eu entrar na sala de um amigo, a sala dele
   * vai ficar ali, como um link rapido". Só existe botão pra isso
   * quando a sala selecionada É a própria (myRoom) -- ver JSX mais
   * abaixo -- não faz sentido "convidar" pra Sala Principal/Mapa
   * Modelo por aqui (ver RESERVED_SLUGS na rota, que recusaria mesmo
   * assim). */
  async function handleCopyRoomLink() {
    if (!myRoom || typeof window === "undefined") return;
    const url = `${window.location.origin}${window.location.pathname}?visitar=${encodeURIComponent(myRoom.room_slug)}`;
    try {
      await navigator.clipboard.writeText(url);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      // clipboard bloqueado (permissão do navegador, http sem TLS,
      // etc.) -- sem fallback silencioso melhor que isso hoje; a
      // pessoa pode selecionar o link manualmente se precisar.
    }
  }

  // itens do TIME do Douglas realmente mostrados no dropdown "Meus
  // espaços" (ver comentário grande "teamOnly" em ROOM_SLUGS acima) --
  // quem não é do time (owner/member) não vê nenhum dos dois.
  const visibleRoomSlugs = ROOM_SLUGS.filter((r) => !r.teamOnly || canSeeSalaPrincipal);
  // + a sala PRÓPRIA do cliente, se tiver uma (myRoom) -- exceto pro
  // Douglas, cuja "mine" já É a Sala principal (ver comentário em
  // app/api/room/mine/route.ts) -- sem esse "except" ela apareceria
  // duplicada no dropdown dele.
  //
  // 29/set (5), Douglas: "inclusive lá em meus espaços deve aparecer
  // o nome da empresa" -- já é o caso aqui: label vem de myRoom.name,
  // que é rooms.name direto do banco (ver GET /api/room/mine acima) --
  // e rooms.name agora É o nome da empresa que a pessoa digitou antes
  // de criar a sala (ver companyName em
  // app/api/room/create-from-template/route.ts), não mais o nome
  // auto-gerado de antes ("Sala de {profile.name}"). Nada pra mudar
  // aqui, só documentando que o pedido já fica resolvido por
  // consequência dessa mudança.
  const dropdownEntries =
    myRoom && myRoom.room_slug !== "sala-principal" && myRoom.room_slug !== "mapa-modelo"
      ? [...visibleRoomSlugs, { slug: myRoom.room_slug, label: myRoom.name, teamOnly: false }]
      : visibleRoomSlugs;
  // itens do dropdown "Espaços visitados" (ver VisitedRoom acima) --
  // filtra fora qualquer coisa que já apareça em "Meus espaços" (ex:
  // visitou a própria sala em algum momento por engano, ou virou dono
  // de uma sala que também tinha visitado antes de ser dono).
  const dropdownEntriesVisited = (visitedRooms ?? []).filter(
    (r) => !dropdownEntries.some((d) => d.slug === r.room_slug)
  );
  // ainda checando acesso (papel + sala própria) -- evita mostrar "criar
  // minha sala" só pra sumir 1 segundo depois quando descobre que a
  // pessoa já é do time/já tem sala.
  const stillCheckingRoomAccess = roomRoleLoading || myRoomLoading;
  // cliente de verdade: não é do time do Douglas E ainda não tem sala
  // própria -- mostra "Criar minha sala" (ver JSX mais abaixo) no lugar
  // do preview/"Entrar na sala" normal, SEM escolha (ele não tem outro
  // espaço pra ver enquanto isso).
  const needsToCreateRoom = !stillCheckingRoomAccess && !canSeeSalaPrincipal && !myRoom;
  // 29/set (10), pedido do Douglas: "adicione mais um opcao: Criar
  // espaço +" -- até aqui só quem NÃO era do time (needsToCreateRoom
  // acima) conseguia criar a própria sala; o time (Douglas/membros)
  // ficava travado só com "Sala principal"/"Mapa modelo" pra sempre,
  // sem jeito de ter uma sala própria também. Esse state, ligado pelo
  // item novo "Criar espaço +" no dropdown "Meus espaços" (mais
  // abaixo), força o MESMO fluxo de needsToCreateRoom a aparecer
  // mesmo sendo do time -- ver openCreateRoomFlow no lugar do
  // dropdown. Só faz sentido enquanto ainda não tem myRoom (o mesmo
  // limite de "uma sala por conta" que sempre existiu); assim que a
  // sala nasce, myRoom passa a existir e esse flag fica sem efeito
  // (voltamos a confiar só em needsToCreateRoom, que nunca conta pra
  // quem já tem myRoom).
  const [creatingSpaceFromDropdown, setCreatingSpaceFromDropdown] = useState(false);
  const showCreateRoomFlow = needsToCreateRoom || (creatingSpaceFromDropdown && !myRoom);
  function openCreateRoomFlow() {
    setCreatingSpaceFromDropdown(true);
    setSpacesMenuOpen(false);
  }

  // 29/set, Douglas: "as conversas tambem nao abrem fora da sala" --
  // causa raiz: o Lobby não abre WebSocket de propósito (ver
  // comentário grande no topo de server/index.js -- não virar
  // presença fantasma na sala), então o resumo de conversas só era
  // buscado UMA vez ao montar. Se alguém iniciava uma conversa com
  // você enquanto você tava parado no Lobby, ela simplesmente nunca
  // aparecia até recarregar a página inteira -- não é a mesma causa
  // do bug da agenda (aquele era CSS/breakpoint), mas é a mesma
  // categoria de sintoma ("não aparece fora da sala"). Fix: reconsulta
  // /chat/summary de tempos em tempos (mesmo padrão de polling leve
  // usado no resto do Lobby REST-only, sem abrir socket nenhum).
  useEffect(() => {
    let cancelled = false;
    if (!myUserId) {
      setConversations([]);
      setCalls([]);
      return;
    }

    function fetchConversations() {
      fetch(`${REALTIME_HTTP_BASE}/chat/summary?userId=${encodeURIComponent(myUserId)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!cancelled) setConversations(Array.isArray(data?.conversations) ? data.conversations : []);
        })
        .catch(() => {
          if (!cancelled) setConversations([]);
        });
    }

    fetchConversations();
    const conversationsPoll = setInterval(fetchConversations, 6000);

    fetch(`${REALTIME_HTTP_BASE}/agenda/summary?userId=${encodeURIComponent(myUserId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setCalls(Array.isArray(data?.calls) ? data.calls : []);
      })
      .catch(() => {
        if (!cancelled) setCalls([]);
      });

    return () => {
      cancelled = true;
      clearInterval(conversationsPoll);
    };
  }, [myUserId]);

  // Diretório de Contatos -- não depende de myUserId pra listar (todo
  // mundo cadastrado), só pra filtrar "eu mesmo" (ver ContactsPanel.tsx).
  useEffect(() => {
    let cancelled = false;
    fetch(`${REALTIME_HTTP_BASE}/users/directory`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setDirectory(Array.isArray(data?.users) ? data.users : []);
      })
      .catch(() => {
        if (!cancelled) setDirectory([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // "Conversar" no painel de Amigos (antigo "Contatos", ver
  // FriendsPanel.tsx) -- cria (ou acha) a conversa direta via POST
  // /chat/direct (sem WebSocket, mesma arquitetura do resto do Lobby,
  // ver comentário grande no topo do arquivo), soma o resultado na
  // lista de conversas (upsert por id, pra não duplicar se já
  // existia) e manda o LobbyChatPanel abrir JÁ nela. Lane sempre
  // "private" -- esse painel só lista amigo mútuo (ver aba "Conversas
  // privadas" em LobbyChatPanel mais abaixo e a mesma trava do
  // servidor em POST /chat/direct).
  async function handleStartConversation(targetUserId: string) {
    if (!myUserId || contactsBusy) return;
    setContactsBusy(true);
    try {
      const res = await fetch(`${REALTIME_HTTP_BASE}/chat/direct`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: myUserId, userName: myName, targetUserId, lane: "private" }),
      });
      if (res.ok) {
        const data = await res.json();
        const conv = data?.conversation as ConversationSummary | undefined;
        if (conv) {
          setConversations((prev) => {
            const rest = (prev ?? []).filter((c) => c.id !== conv.id);
            return [conv, ...rest];
          });
          setOpenChatConversationId(conv.id);
          setContactsOpen(false);
          setChatPanelOpen(true);
        }
      }
    } catch {
      // rede caiu -- painel de Contatos continua aberto, pessoa tenta de novo
    } finally {
      setContactsBusy(false);
    }
  }

  // atualiza a prévia da conversa na lista (lastMessage) na hora,
  // sem esperar reabrir o painel -- mesma ideia do "chat:conversation"
  // que o WebSocket manda de dentro da sala.
  function handleMessageSent(conversationId: string, message: ChatMessage) {
    setConversations((prev) =>
      prev
        ? prev
            .map((c) =>
              c.id === conversationId
                ? {
                    ...c,
                    lastMessage: {
                      senderId: message.senderId,
                      senderName: message.senderName,
                      kind: message.kind,
                      text: message.text,
                      ts: message.ts,
                    },
                  }
                : c
            )
            .sort((a, b) => (b.lastMessage?.ts ?? 0) - (a.lastMessage?.ts ?? 0))
        : prev
    );
  }

  const displayName = accountProfile?.name?.trim() || "visitante";
  // "card" da conta (ver accountCardOpen) -- campos que a conta JÁ tem
  // de verdade, sem inventar nada que o print de referência mostrava
  // mas a gente não coleta (idade, skills, localização).
  const accountBio = accountProfile?.bio?.trim() || "";
  const accountInstagram = accountProfile?.instagram?.trim().replace(/^@/, "") || "";
  const accountInitial = displayName.charAt(0).toUpperCase() || "?";
  const accountStatusId = accountProfile?.status || "online";
  const accountStatusLabel = ACCOUNT_STATUS_LABELS[accountStatusId] || ACCOUNT_STATUS_LABELS.online;
  const presenceText =
    presence === null
      ? "Verificando quem tá na sala…"
      : presence.totalOnline === 0
        ? "Ninguém na sala agora -- seja o primeiro a entrar."
        : presence.totalOnline === 1
          ? "1 pessoa na sala agora."
          : `${presence.totalOnline} pessoas na sala agora.`;

  const pendingCallCount = useMemo(
    () => (calls ?? []).filter((c) => c.participants.find((p) => p.id === myUserId)?.status === "pending").length,
    [calls, myUserId]
  );

  // agrupa os compromissos futuros (calls, já vem do /agenda/summary
  // de verdade -- ver useEffect logo acima) por dia, pega os 3
  // próximos dias que têm pelo menos 1 evento, ordenados por data --
  // é a "previa da agenda" pedida pelo Douglas, mostrada no lobby.
  // 29/set (3): "mantenha os cards caso nao tenha evento do mesmo
  // jeito, so com frase, sem eventos hoje e deixe 30 dias rolavel em
  // lateral também" -- antes só listava dias que TINHAM compromisso
  // (até 3); agora é uma janela FIXA de 30 dias (hoje + 29 seguintes),
  // sempre os 30, cada um virando um card mesmo sem nada marcado (ver
  // isToday/items vazio na renderização -- mostra uma frase em vez da
  // lista). O scroll lateral pra caber os 30 já existia (ver
  // .lobby-agenda-preview, overflow-x), só precisava parar de cortar
  // em 3.
  const agendaPreviewDays = useMemo(() => {
    const byDay = new Map<string, CallSummary[]>();
    for (const call of calls ?? []) {
      const d = new Date(call.startTs);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const list = byDay.get(key);
      if (list) list.push(call);
      else byDay.set(key, [call]);
    }
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const days: { key: string; ts: number; isToday: boolean; items: CallSummary[] }[] = [];
    for (let i = 0; i < 30; i++) {
      const d = new Date(todayStart);
      d.setDate(d.getDate() + i);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const items = (byDay.get(key) || []).slice().sort((a, b) => a.startTs - b.startTs);
      days.push({ key, ts: d.getTime(), isToday: i === 0, items });
    }
    return days;
  }, [calls]);

  return (
    <div className="lobby-backdrop">
      {/* barra de topo -- pedido do Douglas (28/set, com print de
          referência do layout da Pepsi): logo no canto esquerdo
          superior + abas na mesma linha, começando por "Meus
          espaços". */}
      <div className="lobby-topbar">
        <div className="lobby-topbar-logo-group">
          {/* semáforo decorativo removido -- pedido do Douglas (28/set):
              "tire isso, esses pontinhos". */}
          {/* logo de verdade (pedido do Douglas, 29/set: "minha logo,
              no lugar de habbo-gather / O x use a loog, o tower,
              escreve / a fonte é: Raleway") -- o "X" é a marca dele
              (public/logo-x-dark.png, recortada da logo "X Tower" que
              ele mandou, recolorida pra escuro porque o topbar aqui é
              claro -- a original é branca, feita pro fundo escuro do
              resto do app) e "Tower" é texto de verdade (não imagem),
              na fonte Raleway (ver --font-raleway em app/layout.tsx). */}
          <span className="lobby-topbar-logo">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo-x-dark.png" alt="" className="lobby-topbar-logo-mark" />
            <span className="lobby-topbar-logo-text">Tower</span>
          </span>
        </div>
        <nav className="lobby-topbar-nav">
          <div className="lobby-topbar-tab-wrap">
            <button
              type="button"
              // sempre "active" -- é a seção atual (mesma ideia da
              // bolinha atrás de "PRODUCTS" no print de referência,
              // que marca a aba selecionada, não se o menu tá aberto;
              // aberto/fechado é só a setinha girar, ver
              // lobby-topbar-chevron logo abaixo).
              className="lobby-topbar-tab active"
              onClick={() => setSpacesMenuOpen((v) => !v)}
              aria-expanded={spacesMenuOpen}
            >
              <span className="lobby-topbar-tab-label">Meus espaços</span>
              <span className={spacesMenuOpen ? "lobby-topbar-chevron open" : "lobby-topbar-chevron"}>
                <ChevronIcon />
              </span>
            </button>
            {spacesMenuOpen && (
              <>
                <div className="lobby-topbar-dropdown-backdrop" onClick={() => setSpacesMenuOpen(false)} />
                <div className="lobby-topbar-dropdown">
                  {/* 29/set, pedido do Douglas -- espaços clicáveis
                      aqui (ver ROOM_SLUGS/dropdownEntries no topo do
                      arquivo), no lugar do único botão fixo "Sala
                      principal" de antes (não reagia a clique nenhum).
                      "Sala principal"/"Mapa modelo" só aparecem pro
                      time do Douglas; a sala PRÓPRIA do cliente
                      (myRoom, quando existe) entra na lista também.
                      Clicar troca só a SELEÇÃO (selectedRoomSlug) --
                      entrar de verdade continua sendo o botão "Entrar
                      na sala" lá embaixo (handleEnter), mesmo fluxo de
                      sempre. Lista vazia (cliente sem time/sala ainda)
                      -- ver "Criar minha sala" no card principal, não
                      aqui. */}
                  {dropdownEntries.length === 0 ? (
                    <p className="lobby-topbar-dropdown-empty">
                      {stillCheckingRoomAccess ? "Carregando…" : "Crie sua sala pra ela aparecer aqui."}
                    </p>
                  ) : (
                    dropdownEntries.map((r) => (
                      <button
                        key={r.slug}
                        type="button"
                        className={
                          r.slug === selectedRoomSlug
                            ? "lobby-topbar-dropdown-item active"
                            : "lobby-topbar-dropdown-item"
                        }
                        onClick={() => {
                          userPickedRoomRef.current = true;
                          setSelectedRoomSlug(r.slug);
                          setSpacesMenuOpen(false);
                        }}
                      >
                        {r.label}
                      </button>
                    ))
                  )}
                  {/* 29/set (10), pedido do Douglas: "adicione mais um
                      opcao: Criar espaço +" -- até aqui só quem não
                      era do time ganhava esse fluxo (forçado, tela
                      inteira, ver needsToCreateRoom). Item extra no
                      fim da lista, sempre que a conta ainda não tem
                      sala própria (mesmo sendo do time) -- abre o
                      MESMO fluxo de nomear empresa + escolher modelo
                      (ver openCreateRoomFlow/showCreateRoomFlow mais
                      acima, JSX no .lobby-card mais abaixo). */}
                  {accountAccessToken && !stillCheckingRoomAccess && !myRoom && (
                    <button
                      type="button"
                      className="lobby-topbar-dropdown-item lobby-topbar-dropdown-item-create"
                      onClick={openCreateRoomFlow}
                    >
                      Criar espaço +
                    </button>
                  )}
                </div>
              </>
            )}
          </div>

          {/* 29/set, pedido do Douglas: "aqui encima, do lado de meus
              espacos, cria uma nova / espacos visitados" -- salas de
              OUTRAS pessoas que essa conta já visitou por link (ver
              VisitedRoom/dropdownEntriesVisited acima e POST
              /api/room/visit). Mesmo padrão de dropdown de "Meus
              espaços" acima (clicar troca só a seleção, "Entrar na
              sala" continua sendo o botão lá embaixo), só que NUNCA
              "active" (não é uma seção fixa como "Meus espaços", só
              mais uma aba clicável, igual visualmente às inertes ao
              lado até ter algo pra mostrar). */}
          <div className="lobby-topbar-tab-wrap">
            <button
              type="button"
              className="lobby-topbar-tab"
              onClick={() => setVisitedMenuOpen((v) => !v)}
              aria-expanded={visitedMenuOpen}
            >
              <span className="lobby-topbar-tab-label">Espaços visitados</span>
              <span className={visitedMenuOpen ? "lobby-topbar-chevron open" : "lobby-topbar-chevron"}>
                <ChevronIcon />
              </span>
            </button>
            {visitedMenuOpen && (
              <>
                <div className="lobby-topbar-dropdown-backdrop" onClick={() => setVisitedMenuOpen(false)} />
                <div className="lobby-topbar-dropdown">
                  {!accountAccessToken ? (
                    <p className="lobby-topbar-dropdown-empty">Crie uma conta pra guardar espaços visitados.</p>
                  ) : dropdownEntriesVisited.length === 0 ? (
                    <p className="lobby-topbar-dropdown-empty">
                      {visitedRooms === null ? "Carregando…" : "Nenhum espaço visitado ainda."}
                    </p>
                  ) : (
                    dropdownEntriesVisited.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        className={
                          r.room_slug === selectedRoomSlug
                            ? "lobby-topbar-dropdown-item active"
                            : "lobby-topbar-dropdown-item"
                        }
                        onClick={() => {
                          userPickedRoomRef.current = true;
                          setSelectedRoomSlug(r.room_slug);
                          setVisitedMenuOpen(false);
                        }}
                      >
                        {r.name}
                      </button>
                    ))
                  )}
                </div>
              </>
            )}
          </div>

          {/* 28/set, pedido do Douglas: "meus espacos | espacos
              publicos | eventos | Empresas Posicionadas" -- essas três
              ainda não têm tela nenhuma por trás (ver comentário
              grande de .lobby-topbar-tab-inert em app/globals.css),
              então ficam visíveis pra fechar o menu pedido mas não
              fazem nada ainda -- mesmo espírito do botão de tela do
              av-bar (ScreenIcon), inclusive sem usar `disabled` nativo
              de propósito, pra não sumir o tooltip. */}
          <button
            type="button"
            className="lobby-topbar-tab lobby-topbar-tab-inert"
            onClick={(e) => e.preventDefault()}
            aria-disabled="true"
            data-tooltip="Em breve"
          >
            <span className="lobby-topbar-tab-label">Espaços públicos</span>
          </button>
          <button
            type="button"
            className="lobby-topbar-tab lobby-topbar-tab-inert"
            onClick={(e) => e.preventDefault()}
            aria-disabled="true"
            data-tooltip="Em breve"
          >
            <span className="lobby-topbar-tab-label">Eventos</span>
          </button>
          <button
            type="button"
            className="lobby-topbar-tab lobby-topbar-tab-inert"
            onClick={(e) => e.preventDefault()}
            aria-disabled="true"
            data-tooltip="Em breve"
          >
            <span className="lobby-topbar-tab-label">Empresas Posicionadas</span>
          </button>
        </nav>

        {/* canto direito do topbar: só o card da conta agora -- o card
            da Empresa saiu daqui (ver .lobby-company-card-pin logo
            abaixo de .lobby-topbar) porque o Douglas apontou que a
            posição certa dele é fixa no canto ESQUERDO da tela, não um
            dropdown do lado direito. */}
        <div className="lobby-topbar-right-group">
          {/* "card" da conta do cliente -- pedido do Douglas (28/set,
              print de referência de um card "Hello! I'm Max"): "aqui
              nesse canto, faca o card da conta do cliente" + "faca o
              'card' do perfil do usuario aberto". */}
          <div className="lobby-topbar-account-wrap">
            <button
              type="button"
              className="lobby-topbar-account"
              onClick={() => setAccountCardOpen((v) => !v)}
              aria-expanded={accountCardOpen}
            >
              <span className="lobby-topbar-account-avatar">
                {accountProfile?.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={accountProfile.photoUrl} alt="" />
                ) : (
                  accountInitial
                )}
              </span>
              <span className="lobby-topbar-account-name">{displayName}</span>
            </button>
            {accountCardOpen && (
              <>
                <div className="lobby-account-card-backdrop" onClick={() => setAccountCardOpen(false)} />
                <div className="lobby-account-card">
                  {/* pedido do Douglas: "tire o olha sou deixe apenas o nome". */}
                  <p className="lobby-account-card-greeting">{displayName}</p>
                  {accountBio && <p className="lobby-account-card-bio">{accountBio}</p>}
                  <div className="lobby-account-card-tags">
                    <span className="lobby-account-card-tag lobby-account-card-tag-status">
                      <span className={`lobby-account-card-status-dot ${accountStatusId}`} />
                      {accountStatusLabel}
                    </span>
                    {accountInstagram && (
                      <a
                        className="lobby-account-card-tag"
                        href={`https://instagram.com/${accountInstagram}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        @{accountInstagram}
                      </a>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* card da Empresa selecionada -- pedido do Douglas: "nesse canto
          quero o card da Empresa selecionada / Copie EXATAMENTE TUDO"
          + depois, ao ver o print de referência de novo: "nao e ali
          que e pra ele estar" (não era pra ficar como dropdown no
          canto direito, do lado da conta). Fixo no canto ESQUERDO da
          tela, sempre visível (sem clique pra abrir) -- combina com o
          nome da aba "Empresas Posicionadas" no topbar: é uma vitrine
          fixa, não um menu (ver comentário grande do CompanyProfile
          lá em cima -- agora dado real por espaço, não mais molde).

          29/set: + a setinha do lado que abre a aba de edição (só pro
          dono, ver companyProfileCanEdit lá em cima). */}
      <div className="lobby-company-card-pin">
        <div className={companyEditOpen ? "company-card company-card-attached" : "company-card"}>
          {/* 29/set: pedido do Douglas "a frase no caso e a imagem do
              banner, nao e um texto" -- tirei o texto/frase de efeito
              que eu tinha desenhado por cima (era conteúdo INVENTADO
              meu, o print de referência só tinha aquele texto porque
              fazia parte do design ORIGINAL do banner da Obrazur, não
              porque o app deveria desenhar um texto ali). Essa faixa
              clara agora é só a moldura da foto de banner mesmo (ver
              companyProfile.bannerUrl) -- sem overlay/tinta em cima
              (não tem mais texto pra proteger a legibilidade de). */}
          <div
            className="company-card-top"
            style={companyProfile.bannerUrl ? { backgroundImage: `url(${companyProfile.bannerUrl})` } : undefined}
          >
            <div className="company-card-logo-box">
              {companyProfile.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={companyProfile.logoUrl} alt="" />
              ) : (
                companyProfile.name.charAt(0)
              )}
            </div>
          </div>
          <div className="company-card-bottom">
            <p className="company-card-name">
              {companyProfile.name}
              <VerifiedBadge />
            </p>
            <p className="company-card-handle">@{companyProfile.handle.replace(/^@/, "")}</p>
            <p className="company-card-bio">{companyProfile.bio}</p>
            {/* pedido do Douglas: "so vai ter Seguidores (o perfil da
                empresa nao segue ninguem)" -- perfil de empresa não
                segue outras contas, então só faz sentido mostrar
                Seguidores (tirei "Seguindo" e o campo `following`
                inteiro do CompanyProfile). */}
            <p className="company-card-stats">
              <span>
                <strong>{companyProfile.followers}</strong> Seguidores
              </span>
            </p>
            <p className="company-card-link">
              <LinkIcon />
              {companyProfile.link}
            </p>

            {/* pedido do Douglas (print de referência com cards
                empilhados tipo carrossel): "abaixo do link, crie cards
                com os posicionamentos da empresa, que rolam pro lado
                direito caso tenha mais de um, com nomes em negrito,
                quadradinhos, e eu vou subir artes pra por de fundo dos
                quadradinhos" -- um quadradinho por categoria marcada
                em companyProfile.category (ver "Posicione a sua
                empresa:" no painel de edição). Por enquanto sem arte
                de fundo (isso o Douglas falou que sobe depois), só o
                fundo placeholder + nome em negrito; quando ele subir
                as artes dá pra plugar via background-image igual já
                é feito com bannerUrl/logoUrl acima. Rola só se não
                couber tudo (overflow-x + nowrap), sem crescer a altura
                do card. */}
            {companyProfile.category.length > 0 && (
              <div className="company-card-positions">
                {companyProfile.category.map((cat) => (
                  <div
                    key={cat}
                    className="company-card-position-card"
                    style={{ backgroundImage: `url(${companyPositionBackgroundFor(cat)})` }}
                  >
                    <span className="company-card-position-name">{cat}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 29/set: pedido do Douglas, com print de referência de uma
            aba "Editar Empresa" (Nome fantasia/CNPJ/permissão/fotos):
            "quero o card de edicao saindo dessa forma da imagem por
            baixo do card da empresa, todo em blur escurecido" -- não é
            mais um modal centralizado com fundo escurecendo a tela
            inteira (era assim antes); agora é um painel ENCOSTADO no
            card, mesma altura (o :50%/translateY abaixo é em relação a
            .lobby-company-card-pin, que já tem a altura certa via
            top+bottom, ver comentário lá em cima), saindo de trás dele
            -- .company-card-attached tira o arredondamento do lado
            direito do card enquanto isso tá aberto, pra emendar sem
            quina com .company-edit-panel (que já nasce só arredondado
            do lado direito). Seta vira pra esquerda (fecha) quando já
            tá aberto. */}
        {/* 29/set (7): só o DONO do espaço selecionado vê a setinha
            de editar (companyProfileCanEdit vem do servidor, ver
            fetch de /api/room/company-profile mais acima) -- antes
            era sempre visível (o card era um molde só seu, sem
            "espaço de outra pessoa" pra sequer existir). */}
        {companyProfileCanEdit && (
          <button
            type="button"
            className="company-card-edit-trigger"
            onClick={() => setCompanyEditOpen((v) => !v)}
            aria-expanded={companyEditOpen}
            title={companyEditOpen ? "Fechar edição" : "Editar empresa"}
            data-tooltip={companyEditOpen ? "Fechar edição" : "Editar empresa"}
          >
            {companyEditOpen ? <ChevronLeftIcon /> : <ChevronRightIcon />}
          </button>
        )}
      </div>

      {companyEditOpen && companyProfileCanEdit && (
        <>
          {/* clique fora fecha -- mas SEM escurecer o resto da tela
              (o pedido foi só o painel em si ficar "em blur
              escurecido", não a sala toda por trás dele). */}
          <div className="company-edit-click-catcher" onClick={() => setCompanyEditOpen(false)} />
          <div className="company-edit-panel" onClick={(e) => e.stopPropagation()}>
            <div className="company-edit-header-row">
              <div>
                <h2 className="company-edit-title">Editar Empresa</h2>
                <p className="company-edit-subtitle">Atualize as informações da sua empresa que serão exibidas na plataforma.</p>
              </div>
              <button type="button" className="items-panel-close" onClick={() => setCompanyEditOpen(false)} title="Fechar">
                ✕
              </button>
            </div>

            <div className="company-edit-section">
              <div className="company-edit-section-head">
                <h3>Foto de banner</h3>
                <span className="company-edit-hint">Tamanho recomendado: 580 x 260</span>
              </div>
              <button
                type="button"
                className="company-edit-banner-drop"
                onClick={() => companyBannerInputRef.current?.click()}
                style={companyProfile.bannerUrl ? { backgroundImage: `url(${companyProfile.bannerUrl})` } : undefined}
              >
                <span className="company-edit-banner-drop-overlay">
                  <CameraIcon size={22} />
                  <strong>Alterar banner</strong>
                  <span>Clique para enviar uma imagem</span>
                </span>
              </button>
              <input
                ref={companyBannerInputRef}
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleCompanyBannerChange(file);
                  e.target.value = "";
                }}
              />
            </div>

            <div className="company-edit-section">
              <div className="company-edit-section-head">
                <h3>Foto de perfil</h3>
                <span className="company-edit-hint">Tamanho recomendado: 400 x 400</span>
              </div>

              <div className="company-edit-profile-row">
                <div className="company-edit-logo-drop-wrap">
                  <button type="button" className="company-edit-logo-drop" onClick={() => companyLogoInputRef.current?.click()}>
                    {companyProfile.logoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={companyProfile.logoUrl} alt="" />
                    ) : (
                      <span>{companyProfile.name.charAt(0)}</span>
                    )}
                  </button>
                  <button
                    type="button"
                    className="company-edit-logo-drop-btn"
                    onClick={() => companyLogoInputRef.current?.click()}
                    title="Trocar foto de perfil"
                  >
                    <CameraIcon />
                  </button>
                  <input
                    ref={companyLogoInputRef}
                    type="file"
                    accept="image/*"
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleCompanyLogoChange(file);
                      e.target.value = "";
                    }}
                  />
                </div>

                <div className="company-edit-fields">
                  <label className="company-edit-field">
                    <span>Nome fantasia *</span>
                    <input
                      className="company-edit-input"
                      value={companyProfile.name}
                      maxLength={60}
                      onChange={(e) => setCompanyProfile((prev) => ({ ...prev, name: e.target.value }))}
                    />
                  </label>

                  {/* pedido do Douglas: "inclusive adiciona preencher
                      o @ nas config" -- campo novo, faltava dar pra
                      editar o @arroba mostrado no card (antes só vinha
                      do molde fixo). Mesmo padrão do campo de
                      Instagram em GameRoom.tsx: guarda como a pessoa
                      digitou (com ou sem @), só tira o @ na hora de
                      EXIBIR (ver company-card-handle acima). */}
                  <label className="company-edit-field">
                    <span>Rede social da empresa</span>
                    <input
                      className="company-edit-input"
                      value={companyProfile.handle}
                      placeholder="empresaexemplo"
                      maxLength={30}
                      onChange={(e) => setCompanyProfile((prev) => ({ ...prev, handle: e.target.value }))}
                    />
                  </label>

                  {/* pedido do Douglas: "o link da empresa tambem,
                      campo pra adicionar" -- companyProfile.link já
                      existia e já aparecia no card (ver
                      company-card-link, ícone + texto embaixo dos
                      stats), só faltava um jeito de editar; antes só
                      vinha do molde fixo. */}
                  <label className="company-edit-field">
                    <span>Link da empresa</span>
                    <input
                      className="company-edit-input"
                      value={companyProfile.link}
                      placeholder="habbo-gather.com/empresas"
                      maxLength={80}
                      onChange={(e) => setCompanyProfile((prev) => ({ ...prev, link: e.target.value }))}
                    />
                  </label>

                  {/* pedido do Douglas: "faltou o campo da bio
                      tambem: Descreve o propósito da sua empresa" --
                      companyProfile.bio já existia e já aparecia no
                      card (company-card-bio), só faltava editar; sem
                      campo nenhum antes, vinha só do molde fixo.
                      Textarea (não input de uma linha) -- mesmo padrão
                      do campo "Bio" do perfil pessoal em
                      GameRoom.tsx. */}
                  <label className="company-edit-field">
                    <span>Bio</span>
                    <textarea
                      className="company-edit-input company-edit-textarea"
                      value={companyProfile.bio}
                      placeholder="Descreve o propósito da sua empresa"
                      maxLength={200}
                      rows={3}
                      onChange={(e) => setCompanyProfile((prev) => ({ ...prev, bio: e.target.value }))}
                    />
                  </label>

                  {/* pedido do Douglas: "uma caixa de selecao, escrita
                      Posicione a sua empresa:" com a lista de ~61
                      categorias -- e depois "deixei marcar varias
                      opcoes", ou seja é multi-seleção (não dá pra usar
                      um <select> nativo, que só permite 1 valor).
                      Dropdown custom: botão mostra as categorias
                      escolhidas (ou um placeholder), clique abre um
                      checklist com todas as opções de
                      COMPANY_CATEGORIES (definida lá em cima, perto de
                      BLANK_COMPANY_PROFILE). Mesmo padrão de
                      catcher/stopPropagation já usado pro próprio
                      painel de edição (company-edit-click-catcher). */}
                  <label className="company-edit-field">
                    <span>Posicione a sua empresa:</span>
                    <div className="company-edit-category-select">
                      <button
                        type="button"
                        className="company-edit-input company-edit-category-trigger"
                        onClick={() => setCompanyCategoryOpen((v) => !v)}
                        aria-expanded={companyCategoryOpen}
                      >
                        <span className="company-edit-category-trigger-text">
                          {companyProfile.category.length > 0
                            ? companyProfile.category.join(", ")
                            : "Selecione uma ou mais categorias"}
                        </span>
                        <ChevronIcon />
                      </button>
                      {companyCategoryOpen && (
                        <>
                          <div className="company-edit-category-catcher" onClick={() => setCompanyCategoryOpen(false)} />
                          <div className="company-edit-category-list" onClick={(e) => e.stopPropagation()}>
                            {COMPANY_CATEGORIES.map((cat) => (
                              <label key={cat} className="company-edit-category-option">
                                <input
                                  type="checkbox"
                                  checked={companyProfile.category.includes(cat)}
                                  onChange={() => toggleCompanyCategory(cat)}
                                />
                                <span>{cat}</span>
                              </label>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  </label>
                </div>
              </div>
            </div>

            <div className="company-edit-divider" />

            <label className="company-edit-permission-row">
              <div className="company-edit-permission-text">
                <p className="company-edit-permission-question">
                  Permitir exibição do nome da empresa do perfil dos colaboradores?
                </p>
                <p className="company-edit-permission-hint">
                  Quando ativado, o nome da sua empresa será exibido no perfil dos colaboradores.
                </p>
              </div>
              <span className="company-edit-toggle">
                <input
                  type="checkbox"
                  checked={companyProfile.showNameOnEmployeeProfiles}
                  onChange={(e) =>
                    setCompanyProfile((prev) => ({ ...prev, showNameOnEmployeeProfiles: e.target.checked }))
                  }
                />
                <span className="company-edit-toggle-track">
                  <span className="company-edit-toggle-thumb" />
                </span>
              </span>
            </label>

            <div className="company-edit-divider" />

            {/* 29/set (7): agora salva DE VERDADE no espaço (POST
                /api/room/company-profile, ver saveCompanyProfile
                acima) -- antes só fechava o painel (era só
                localStorage, já salvo a cada tecla). */}
            {companySaveError && <p className="company-edit-save-error">{companySaveError}</p>}
            <div className="company-edit-save-row">
              <button
                type="button"
                className="company-edit-save-btn"
                onClick={saveCompanyProfile}
                disabled={companySaving}
              >
                {companySaving ? "Salvando…" : "Salvar alterações"}
              </button>
            </div>
          </div>
        </>
      )}

      {/* pedido do Douglas: "remova o botao abrir minha agenda,
          mantenha apenas os cards da agenda, alinhe os cards com o
          card da empresa embaixo, mantenha a altura fixa, se passar
          de 3 eventos, scrol ativa dentro do card" + (29/set 3)
          "mantenha os cards caso nao tenha evento do mesmo jeito, so
          com frase, sem eventos hoje e deixe 30 dias rolavel em
          lateral também" + "use o estilo blur do editar empresa" --
          janela FIXA de 30 dias (agendaPreviewDays acima, sempre 30,
          mesmo os sem nada marcado -- esses mostram só uma frase em
          vez da lista de "Próximos"). Saiu do fluxo do flex de
          .lobby-backdrop (virou position:fixed, mesmo esquema de
          .lobby-company-card-pin) pra alinhar a borda de BAIXO com o
          card da empresa (bottom:100px nos dois -- mesma distância do
          av-bar). Altura de cada card é FIXA (.lobby-agenda-day-card)
          -- a lista de eventos rola por dentro (overflow-y) quando
          passa de 3, e os 30 cards rolam de lado (overflow-x, ver
          .lobby-agenda-preview). Visual do card copiado de
          .company-edit-panel (fundo escuro + blur mais forte), em vez
          do degradê roxo claro de antes. Dados reais, mesmo `calls`
          de sempre. */}
      <div className="lobby-agenda-preview">
        {agendaPreviewDays.map((day) => {
          const badge = formatAgendaDayBadge(day.ts);
          return (
            <div key={day.key} className="lobby-agenda-day-card">
              {/* 29/set (3): Douglas mandou o print de novo, agora
                  reto: "quero o card de data exatamente igual!!!" --
                  no print a coluna da esquerda inteira é um painel
                  escuro (não um "quadradinho" de número + resto
                  claro, como eu tinha) e "X eventos" tem uma setinha
                  (vira botão de verdade agora, abre a agenda completa
                  -- setinha sem função seria só decoração morta). */}
              <div className="lobby-agenda-day-left">
                <div className="lobby-agenda-day-num-wrap">
                  <span className="lobby-agenda-day-badge-num">{badge.day}</span>
                  <span className="lobby-agenda-day-badge-month">{badge.month}</span>
                </div>
                <p className="lobby-agenda-day-weekday">{badge.weekday}</p>
                {day.items.length > 0 && (
                  <button
                    type="button"
                    className="lobby-agenda-day-count"
                    onClick={() => setAgendaPanelOpen(true)}
                  >
                    {day.items.length} {day.items.length === 1 ? "evento" : "eventos"}
                    <ChevronRightIcon />
                  </button>
                )}
              </div>
              <div className="lobby-agenda-day-right">
                {day.items.length > 0 ? (
                  <>
                    <span className="lobby-agenda-day-label">Próximos</span>
                    <ul className="lobby-agenda-day-events">
                      {day.items.map((call, i) => (
                        <li key={call.id} className={`lobby-agenda-event-item tone-${i % 4}`}>
                          <p className="lobby-agenda-event-title">{call.title}</p>
                          <p className="lobby-agenda-event-time">
                            {formatAgendaEventTime(call.startTs, call.durationMinutes)}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="lobby-agenda-day-empty-phrase">
                    {day.isToday ? "Sem eventos hoje" : "Sem eventos"}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="lobby-card">
        {/* 29/set (2): Douglas mandou o print de novo, agora apontando
            pro card "Entrar na sala": "copie exatamente o que tem
            aqui... estilo fonte, cores, blur, tudo" -- ícone de câmera
            na pilula (não tinha), botão preto (era roxo), setinha no
            botão (não tinha). */}
        <div className="lobby-sign">
          <CamIcon off={false} />
          <span className="lobby-sign-text">SALA VIRTUAL</span>
        </div>
        <p className="lobby-greeting">Bem-vindo(a), {displayName}!</p>

        {/* 29/set, pedido do Douglas: "Cada cliente vai ter a sua
            sala... O cara entra, ele tem a sala dele la que ele
            escolher dentre os modelos... as pessoas so copiam a sala
            modelo, pra eles, ai se cria o mapa pra eles vinculado ao id
            deles" -- um cliente de verdade (não é do time do Douglas,
            ver needsToCreateRoom acima) ainda sem sala própria vê ISSO
            no lugar do preview/"Entrar na sala" normais: escolhe um
            modelo publicado (GET /api/room/templates) e
            handleCreateRoomFromTemplate clona ele (POST
            /api/room/create-from-template) -- assim que responde,
            myRoom passa a existir e esse bloco some sozinho (needsToCreateRoom
            vira false), voltando pro fluxo normal de sempre com a sala
            nova já selecionada. */}
        {showCreateRoomFlow ? (
          <div className="lobby-create-room">
            {/* só quem chegou aqui pelo "Criar espaço +" do dropdown
                (ver openCreateRoomFlow) E já tem pra onde voltar (é do
                time, ver canSeeSalaPrincipal) ganha esse "Cancelar" --
                um cliente de verdade em needsToCreateRoom não tem
                outro lugar pra ir (é obrigado a criar a sala). */}
            {creatingSpaceFromDropdown && !needsToCreateRoom && (
              <button
                type="button"
                className="lobby-create-room-cancel-btn"
                onClick={() => {
                  setCreatingSpaceFromDropdown(false);
                  setCompanyName("");
                  setCompanyNameDraft("");
                }}
              >
                ✕ Cancelar
              </button>
            )}
            <p className="lobby-create-room-title">Você ainda não tem uma sala</p>
            {!accountAccessToken ? (
              <p className="lobby-create-room-hint">Crie uma conta pra ganhar a sua.</p>
            ) : !companyName ? (
              // passo novo, ANTES do catálogo (ver comentário grande em
              // companyNameDraft/companyName mais acima): sem nome de
              // empresa confirmado, nem mostra os modelos ainda.
              <>
                <p className="lobby-create-room-hint">Como se chama a sua empresa?</p>
                <input
                  type="text"
                  className="lobby-create-room-company-input"
                  placeholder="Nome da empresa"
                  value={companyNameDraft}
                  maxLength={80}
                  autoFocus
                  onChange={(e) => setCompanyNameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && companyNameDraft.trim()) setCompanyName(companyNameDraft.trim());
                  }}
                />
                <button
                  type="button"
                  className="lobby-create-room-company-btn"
                  disabled={!companyNameDraft.trim()}
                  onClick={() => setCompanyName(companyNameDraft.trim())}
                >
                  Continuar
                </button>
              </>
            ) : templates === null ? (
              <p className="lobby-create-room-hint">Carregando modelos…</p>
            ) : templates.length === 0 ? (
              <p className="lobby-create-room-hint">Nenhum modelo publicado ainda.</p>
            ) : (
              <>
                <p className="lobby-create-room-hint">
                  Escolha um modelo pra começar a sala de <strong>{companyName}</strong>:
                </p>
                <div className="lobby-create-room-templates">
                  {templates.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className="lobby-create-room-template-btn"
                      disabled={creatingFromTemplateId !== null}
                      onClick={() => handleCreateRoomFromTemplate(t.id)}
                    >
                      {creatingFromTemplateId === t.id ? "Criando…" : t.name}
                    </button>
                  ))}
                </div>
                {createRoomError && <p className="lobby-create-room-error">{createRoomError}</p>}
                <button type="button" className="lobby-create-room-back-btn" onClick={() => setCompanyName("")}>
                  ← Trocar nome da empresa
                </button>
              </>
            )}
          </div>
        ) : (
          <>
            <RoomPreview room={room} loading={roomLoading} />

            <p className="lobby-presence">
              <span className={`lobby-presence-dot${presence && presence.totalOnline > 0 ? " lobby-presence-dot-active" : ""}`} />
              {presenceText}
            </p>

            <button type="button" className="lobby-enter-btn" onClick={handleEnter} disabled={!selectedRoomSlug}>
              Entrar na sala
              <ChevronRightIcon />
            </button>

            {/* só aparece com a sala PRÓPRIA selecionada (ver
                handleCopyRoomLink acima) -- é o link que qualquer amigo
                pode abrir pra entrar direto nela e virar um atalho em
                "Espaços visitados" (pedido do Douglas, 29/set). */}
            {myRoom && selectedRoomSlug === myRoom.room_slug && (
              <button type="button" className="lobby-copy-link-btn" onClick={handleCopyRoomLink}>
                {linkCopied ? "Link copiado!" : "Copiar link pra convidar"}
              </button>
            )}
          </>
        )}
        {onSignOut && (
          <button type="button" className="lobby-signout-btn" onClick={onSignOut}>
            Sair da conta
          </button>
        )}
      </div>

      {/* pedido do Douglas (28/set, com print da av-bar de dentro da
          sala): "quero em balao assim, no canto esquerdo mesmo lugar
          que esta" -- MESMA classe .av-bar (pilula de vidro fosco,
          canto inferior esquerdo) que a barra de dentro da sala usa,
          não uma cópia -- fica igual de verdade, não só parecido. Fora
          do .lobby-card de propósito (esse aqui é "absolute" relativo
          à tela inteira, igual dentro da sala; dentro do card ficaria
          preso ao centro). */}
      {/* 29/set (2): "lobby-av-bar-light" só existe pra clarear essa
          barra aqui do Lobby (ver comentário grande em .av-bar.lobby-av-bar-light
          em globals.css) -- a classe base .av-bar continua igual pra
          quando essa mesma barra aparece de dentro da sala de verdade. */}
      <div className="av-bar lobby-av-bar-light">
        <button
          type="button"
          className={micOn ? "av-btn" : "av-btn off"}
          onClick={toggleMic}
          aria-label={micOn ? "Desligar microfone" : "Ligar microfone"}
          data-tooltip={micOn ? "Desligar mic" : "Ligar mic"}
        >
          <MicIcon off={!micOn} />
        </button>
        <button
          type="button"
          className={camOn ? "av-btn" : "av-btn off"}
          onClick={toggleCam}
          aria-label={camOn ? "Desligar câmera" : "Ligar câmera"}
          data-tooltip={camOn ? "Desligar câmera" : "Ligar câmera"}
        >
          <CamIcon off={!camOn} />
        </button>
        {/* "tela" -- pedido do Douglas: "cade o restante... tela",
            mas compartilhar tela SÓ FAZ SENTIDO com alguém do outro
            lado pra ver (WebRTC de verdade, ver toggleScreenShare em
            GameRoom.tsx) -- não existe isso no Lobby. Ícone fica pra
            bater com a barra de dentro da sala, desabilitado com
            tooltip explicando em vez de fingir que funciona. */}
        <button
          type="button"
          className="av-btn lobby-av-btn-inert"
          onClick={(e) => e.preventDefault()}
          aria-disabled="true"
          data-tooltip="Compartilhar tela só dentro da sala"
        >
          <ScreenIcon />
        </button>
        <button
          type="button"
          className={chatPanelOpen ? "av-btn on" : "av-btn"}
          onClick={() => setChatPanelOpen((v) => !v)}
          aria-label={chatPanelOpen ? "Fechar chat" : "Abrir chat"}
          data-tooltip={chatPanelOpen ? "Fechar chat" : "Chat"}
        >
          <span className="lobby-badge-wrap">
            <ChatIcon />
            {conversations && conversations.length > 0 && (
              <span className="lobby-icon-badge">{conversations.length}</span>
            )}
          </span>
        </button>
        <button
          type="button"
          className={agendaPanelOpen ? "av-btn on" : "av-btn"}
          onClick={() => setAgendaPanelOpen((v) => !v)}
          aria-label={agendaPanelOpen ? "Fechar agenda" : "Abrir agenda"}
          data-tooltip={agendaPanelOpen ? "Fechar agenda" : "Agenda"}
        >
          <span className="lobby-badge-wrap">
            <AgendaIcon />
            {pendingCallCount > 0 && <span className="lobby-icon-badge">{pendingCallCount}</span>}
          </span>
        </button>
        <button
          type="button"
          className={contactsOpen ? "av-btn on" : "av-btn"}
          onClick={() => setContactsOpen((v) => !v)}
          aria-label={contactsOpen ? "Fechar amigos" : "Abrir amigos"}
          data-tooltip={contactsOpen ? "Fechar amigos" : "Amigos"}
        >
          <ContactsIcon />
        </button>
        <button
          type="button"
          className={settingsOpen ? "av-btn on" : "av-btn"}
          onClick={() => setSettingsOpen((v) => !v)}
          aria-label={settingsOpen ? "Fechar configurações" : "Configurações"}
          data-tooltip={settingsOpen ? "Fechar configurações" : "Configurações"}
        >
          <GearIcon />
        </button>
      </div>

      {settingsOpen && (
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          micOn={micOn}
          camOn={camOn}
          selectedMicId={selectedMicId}
          selectedCamId={selectedCamId}
          selectedSpeakerId={selectedSpeakerId}
          onSelectMic={switchMicDevice}
          onSelectCam={switchCamDevice}
          onSelectSpeaker={switchSpeakerDevice}
          spaceVolume={1}
          onChangeSpaceVolume={() => {}}
          remoteUsers={[]}
          remoteVolumes={{}}
          onChangeRemoteVolume={() => {}}
        />
      )}

      {chatPanelOpen && (
        <LobbyChatPanel
          myUserId={myUserId}
          myName={myName}
          conversations={conversations}
          accountAccessToken={accountAccessToken}
          onClose={() => {
            setChatPanelOpen(false);
            setOpenChatConversationId(null);
          }}
          onSent={handleMessageSent}
          onStartConversation={(targetUserId) => handleStartConversation(targetUserId)}
          initialActiveId={openChatConversationId}
        />
      )}
      {contactsOpen && (
        <FriendsPanel
          accountAccessToken={accountAccessToken}
          onStartConversation={(targetUserId) => handleStartConversation(targetUserId)}
          onClose={() => setContactsOpen(false)}
        />
      )}
      {agendaPanelOpen && (
        <LobbyAgendaPanel
          myUserId={myUserId}
          calls={calls}
          directory={directory}
          onClose={() => setAgendaPanelOpen(false)}
          setCalls={setCalls}
        />
      )}
    </div>
  );
}
