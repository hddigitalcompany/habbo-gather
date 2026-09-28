// Diz pro CLIENTE (GameRoom.tsx) se quem tá logado é admin da
// PLATAFORMA (tabela platform_admins, ver lib/supabase/roomAuth.ts e
// supabase/migrations/0031_platform_admins.sql) -- usado só pra
// decidir se mostra o botão "+Criar" (abre o Editor de Itens). É uma
// pergunta DIFERENTE de "sou dono da sala" (isso continua vindo de
// GET /api/room/members, sem mudança -- controla "Editar espaço").
// A conferência de verdade (o que trava de fato quem pode gravar no
// catálogo) é sempre refeita no servidor em cada rota de
// door-items/floor-items/items/wall-items/avatar-*/**, ver
// isPlatformAdmin ali -- esse endpoint aqui só existe pra pintar a UI
// certa, nunca é a defesa em si.
import { NextRequest, NextResponse } from "next/server";
import { getVerifiedUserId, isPlatformAdmin } from "@/lib/supabase/roomAuth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const userId = await getVerifiedUserId(req);
  if (!userId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const isAdmin = await isPlatformAdmin(userId);
  return NextResponse.json({ isPlatformAdmin: isAdmin });
}
