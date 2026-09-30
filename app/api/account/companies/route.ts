// GET /api/account/companies -- empresas que EU (usuário logado) sou
// dona ou membro (ver lib/supabase/companyMembership.ts) -- lista o
// seletor "qual empresa mostrar" na edição do "Meu perfil público"
// (ver ProfileViewCard.tsx, pedido do Douglas 30/set (8)).
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { getVerifiedUserId } from "@/lib/supabase/roomAuth";
import { getUserCompanies } from "@/lib/supabase/companyMembership";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const userId = await getVerifiedUserId(req);
  if (!userId) return NextResponse.json({ error: "não autenticado" }, { status: 401 });

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ companies: [] });

  const companies = await getUserCompanies(admin, userId);
  return NextResponse.json({ companies });
}
