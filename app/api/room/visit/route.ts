// POST /api/room/visit -- registra que o usuário logado visitou a sala
// de OUTRA pessoa (pedido do Douglas, 29/set: "se eu entrar na sala de
// um amigo, a sala dele vai ficar ali, como um link rapido"). Corpo:
// { roomSlug }. Chamado pelo Lobby quando a página abre com
// ?visitar=<slug> na URL (ver comentário grande em components/
// Lobby.tsx sobre handleCopyRoomLink/visitSlug) -- ou seja, o "convite"
// aqui é literalmente o link: o dono compartilha
// .../?visitar=<room_slug da sala dele> com quem quiser, sem precisar
// gerar código nenhum (diferente do convite de time em
// app/api/room/invite/route.ts, que continua só pro Douglas).
//
// Recusa de propósito: sala-principal/mapa-modelo (ver ROOM_SLUGS em
// components/Lobby.tsx) e qualquer coisa que não seja uma sala de
// CLIENTE de verdade (is_template=false) -- sem essa trava, um link
// ?visitar=sala-principal furaria a visibilidade que o Douglas acabou
// de pedir (só ele + time vê a Sala Principal). A sala só entra em
// "Espaços visitados" se REALMENTE existir e não for a do próprio
// visitante (ver ownRoom abaixo).
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { getVerifiedUserId } from "@/lib/supabase/roomAuth";

export const dynamic = "force-dynamic";

const RESERVED_SLUGS = new Set(["sala-principal", "mapa-modelo"]);

export async function POST(req: NextRequest) {
  const userId = await getVerifiedUserId(req);
  if (!userId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const roomSlug = typeof body?.roomSlug === "string" ? body.roomSlug.trim() : "";
  if (!roomSlug) return NextResponse.json({ error: "roomSlug é obrigatório" }, { status: 400 });
  if (RESERVED_SLUGS.has(roomSlug)) {
    return NextResponse.json({ error: "esse espaço não é visitável por link" }, { status: 400 });
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase não configurado" }, { status: 500 });

  const room = await admin
    .from("rooms")
    .select("id, name, room_slug, owner_user_id")
    .eq("room_slug", roomSlug)
    .eq("is_template", false)
    .maybeSingle();
  if (!room.data) return NextResponse.json({ error: "sala não encontrada" }, { status: 404 });

  // é a PRÓPRIA sala de quem tá pedindo -- não faz sentido "visitar"
  // (já aparece em "Meus espaços"), não grava linha nenhuma em
  // room_visits. Devolve o quarto do mesmo jeito -- o Lobby usa essa
  // resposta pra selecionar a sala na hora, mesmo nesse caso.
  const ownRoom = room.data.owner_user_id === userId;
  if (!ownRoom) {
    const { error } = await admin
      .from("room_visits")
      .upsert({ user_id: userId, room_id: room.data.id, visited_at: new Date().toISOString() }, { onConflict: "user_id,room_id" });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    room: { id: room.data.id, name: room.data.name, room_slug: room.data.room_slug },
    ownRoom,
  });
}
