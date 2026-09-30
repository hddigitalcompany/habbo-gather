// POST /api/room/create-from-template -- pedido do Douglas (29/set):
// "as pessoas so copiam a sala modelo, pra eles, ai se cria o mapa pra
// eles vinculado ao id deles". Corpo: { templateId, companyName }.
// Cria a sala própria do cliente (linha nova em public.rooms, ver
// comentário grande em supabase/migrations/0032_rooms.sql) a partir de
// um modelo publicado (GET /api/room/templates), e clona o LAYOUT
// inicial dele (piso/parede/porta/área/mobília -- ver
// room_layout_state, migration 0034) pra um slug novo. Dali em diante
// as duas salas vivem cada uma por si -- editar o template depois não
// muda a sala já criada (mesmo contrato descrito no comentário
// original de source_template_id em 0032_rooms.sql).
//
// companyName É OBRIGATÓRIO (29/set (2), pedido do Douglas: "'empresa'
// tem que virar o Nome da empresa / A pessoa so cria o espaco depois
// que nomeia a empresa") -- vira o `name` da sala direto (ver comment
// grande onde é usado, mais abaixo), que por sua vez é o que aparece
// como rótulo da aba "Empresa" do chat (ver companyName em
// components/GameRoom.tsx/ChatDrawer e myRoom?.name em
// components/Lobby.tsx/LobbyChatPanel) -- é por isso que precisa
// existir ANTES da sala: sem nome de empresa, não tem o que mostrar
// naquela aba.
//
// room_slug da sala nova = o PRÓPRIO id (uuid) dela -- gerado aqui
// (crypto.randomUUID()) em vez de deixar o Postgres gerar sozinho, só
// pra poder gravar `id` e `room_slug` iguais num insert só (ver
// migration 0037_rooms_slug_and_first_template.sql). O servidor
// WebSocket (server/roomStore.js) nunca precisa saber que esse slug
// "nasceu" de um template -- ele só vê um room_slug novo na primeira
// vez que alguém entra nele (GameRoom.tsx com roomSlug=<esse id>,
// ver Lobby.tsx) e carrega o que já tiver salvo em room_layout_state
// pra ele, exatamente como carregaria qualquer outra sala.
import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { getVerifiedUserId } from "@/lib/supabase/roomAuth";

export const dynamic = "force-dynamic";

// 29/set (10): mesma lista de app/api/room/visit/route.ts e
// app/api/room/mine/route.ts -- Sala Principal/Mapa Modelo são fixas
// do time, não contam como "já tem sala própria" pro check de
// idempotência logo abaixo (senão o time nunca conseguiria criar uma
// sala de verdade: essa rota devolveria Sala Principal de novo pra
// sempre, achando que já era "a sala" da pessoa).
const RESERVED_SLUGS = new Set(["sala-principal", "mapa-modelo"]);

export async function POST(req: NextRequest) {
  const userId = await getVerifiedUserId(req);
  if (!userId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const body = await req.json().catch(() => null);
  const templateId = typeof body?.templateId === "string" ? body.templateId.trim() : "";
  if (!templateId) return NextResponse.json({ error: "templateId é obrigatório" }, { status: 400 });
  const companyName = typeof body?.companyName === "string" ? body.companyName.trim().slice(0, 80) : "";
  if (!companyName) return NextResponse.json({ error: "nome da empresa é obrigatório" }, { status: 400 });

  // idempotente -- se a pessoa já tem sala própria (ex: clicou 2x,
  // ou deu refresh no meio do fluxo), devolve ela de novo em vez de
  // criar uma segunda (pedido implícito do Douglas: "ele ainda nao
  // tem" -- só faz sentido escolher template ENQUANTO não tem sala).
  // Sala Principal/Mapa Modelo (RESERVED_SLUGS) não contam aqui --
  // ver comentário grande no topo do arquivo.
  const existing = await admin
    .from("rooms")
    .select("id, name, room_slug")
    .eq("owner_user_id", userId)
    .eq("is_template", false)
    .not("room_slug", "is", null);
  if (existing.error) return NextResponse.json({ error: existing.error.message }, { status: 500 });
  const existingReal = (existing.data ?? []).find((r) => !RESERVED_SLUGS.has(r.room_slug));
  if (existingReal) return NextResponse.json({ room: existingReal });

  const template = await admin
    .from("rooms")
    .select("id, name, room_slug")
    .eq("id", templateId)
    .eq("is_template", true)
    .eq("template_status", "published")
    .not("room_slug", "is", null)
    .maybeSingle();
  if (!template.data) {
    return NextResponse.json({ error: "modelo não encontrado (ou ainda não publicado)" }, { status: 404 });
  }

  // `name` da sala É o nome da empresa que a pessoa acabou de digitar
  // (ver comentário grande no topo do arquivo) -- antes era um nome
  // genérico ("Sala de Fulano"/"Minha sala"); agora é sempre o que a
  // pessoa nomeou, porque esse mesmo campo é o que aparece pros outros
  // como rótulo da aba "Empresa" do chat.
  const newRoomId = randomUUID();
  const inserted = await admin
    .from("rooms")
    .insert({
      id: newRoomId,
      name: companyName,
      owner_user_id: userId,
      is_template: false,
      source_template_id: template.data.id,
      room_slug: newRoomId,
    })
    .select("id, name, room_slug")
    .single();
  if (inserted.error) return NextResponse.json({ error: inserted.error.message }, { status: 500 });

  // clona o layout inicial do template (ver comentário grande no topo
  // do arquivo) -- melhor esforço: se o template ainda não tem NENHUM
  // estado salvo (ninguém nunca abriu ele de verdade no servidor
  // WebSocket ainda), ou se essa gravação falhar por qualquer motivo,
  // a sala nova continua válida (dona = quem pediu) -- só nasce sem a
  // decoração do modelo, com o retângulo padrão de sempre (ver
  // defaultRoomTiles/normalizeStore em server/roomStore.js, que
  // preenche sozinho quando não acha nada salvo pra um slug).
  let clonedLayout = false;
  const templateState = await admin
    .from("room_layout_state")
    .select("data")
    .eq("room_slug", template.data.room_slug)
    .maybeSingle();
  if (templateState.data?.data) {
    const cloned = JSON.parse(JSON.stringify(templateState.data.data));
    const clone = await admin.from("room_layout_state").insert({ room_slug: newRoomId, data: cloned });
    clonedLayout = !clone.error;
  }

  return NextResponse.json({ room: inserted.data, clonedLayout });
}
