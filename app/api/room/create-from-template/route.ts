// POST /api/room/create-from-template -- pedido do Douglas (29/set):
// "as pessoas so copiam a sala modelo, pra eles, ai se cria o mapa pra
// eles vinculado ao id deles". Corpo: { templateId }. Cria a sala
// própria do cliente (linha nova em public.rooms, ver comentário
// grande em supabase/migrations/0032_rooms.sql) a partir de um modelo
// publicado (GET /api/room/templates), e clona o LAYOUT inicial dele
// (piso/parede/porta/área/mobília -- ver room_layout_state, migration
// 0034) pra um slug novo. Dali em diante as duas salas vivem cada uma
// por si -- editar o template depois não muda a sala já criada (mesmo
// contrato descrito no comentário original de source_template_id em
// 0032_rooms.sql).
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

export async function POST(req: NextRequest) {
  const userId = await getVerifiedUserId(req);
  if (!userId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const body = await req.json().catch(() => null);
  const templateId = typeof body?.templateId === "string" ? body.templateId.trim() : "";
  if (!templateId) return NextResponse.json({ error: "templateId é obrigatório" }, { status: 400 });

  // idempotente -- se a pessoa já tem sala própria (ex: clicou 2x,
  // ou deu refresh no meio do fluxo), devolve ela de novo em vez de
  // criar uma segunda (pedido implícito do Douglas: "ele ainda nao
  // tem" -- só faz sentido escolher template ENQUANTO não tem sala).
  const existing = await admin
    .from("rooms")
    .select("id, name, room_slug")
    .eq("owner_user_id", userId)
    .eq("is_template", false)
    .not("room_slug", "is", null)
    .maybeSingle();
  if (existing.data) return NextResponse.json({ room: existing.data });

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

  // nome amigável pra sala nova -- melhor esforço (nome do perfil, se
  // tiver conta com perfil preenchido); sem isso, cai num genérico
  // simples, nunca bloqueia a criação por causa disso.
  const profile = await admin.from("profiles").select("name").eq("id", userId).maybeSingle();
  const ownerName = typeof profile.data?.name === "string" && profile.data.name.trim() ? profile.data.name.trim() : null;
  const roomName = ownerName ? `Sala de ${ownerName}` : "Minha sala";

  const newRoomId = randomUUID();
  const inserted = await admin
    .from("rooms")
    .insert({
      id: newRoomId,
      name: roomName,
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
