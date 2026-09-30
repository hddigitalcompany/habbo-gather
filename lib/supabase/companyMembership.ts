// Empresas (linhas de public.rooms, is_template=false) que uma conta é
// DONA (rooms.owner_user_id) ou MEMBRO (public.company_members, ver
// migration 0044_company_members_and_profile_card.sql) -- pedido do
// Douglas, 30/set (8): "as empresas que a pessoa é dona/membro vao
// aparecer no perfil dela". Compartilhado entre:
// - app/api/account/companies/route.ts (lista pro seletor "qual
//   empresa mostrar" na edição do próprio perfil)
// - app/api/account/featured-company/route.ts (valida ANTES de gravar
//   qual empresa a pessoa escolheu destacar -- nunca confia só no que
//   o cliente mandou)
// - app/api/profile/view/route.ts (confere de novo, na hora, se a
//   empresa já destacada ANTES ainda é válida, antes de mostrar o
//   card no perfil de qualquer um -- ver comentário na migration)
//
// "is_template" -- nunca conta o molde de mapa (mapa-modelo) como
// "empresa de verdade", mesmo filtro de getOwnedRealRooms em
// app/api/account/verification/route.ts.
//
// Só "mapa-modelo" fica de fora aqui -- DIFERENTE do RESERVED_SLUGS
// de verification.ts (que também exclui "mapa-publicado"). Lá faz
// sentido: "mapa-publicado" não pode ser usada pra pedir o selo de
// empresa verificada (exige contrato social/sócio de verdade). Mas
// "mapa-publicado" É a sala oficial única do time do Douglas (Mapa
// Publicado/"X Tower", ver ROOM_SLUGS em Lobby.tsx) -- já vem com
// nome/logo/categoria de empresa preenchidos de verdade (bug
// encontrado 30/set: Hualison configurou tudo isso nela e o card
// nunca aparecia no perfil por causa desse filtro emprestado sem
// necessidade, sem motivo real pra continuar excluindo ela aqui).
import type { SupabaseClient } from "@supabase/supabase-js";

const RESERVED_SLUGS = new Set(["mapa-modelo"]);

export type CompanyMembership = {
  roomId: string;
  slug: string;
  name: string;
  logoUrl: string;
  relation: "owner" | "member";
};

type RoomRow = { id: string; room_slug: string | null; name: string | null; company_logo_url: string | null };

function toMembership(r: RoomRow, relation: CompanyMembership["relation"]): CompanyMembership {
  return {
    roomId: r.id,
    slug: r.room_slug ?? "",
    name: r.name ?? "",
    logoUrl: r.company_logo_url ?? "",
    relation,
  };
}

/** Todas as empresas que `userId` é dona OU membro -- dona primeiro
 * (mais relevante). */
export async function getUserCompanies(admin: SupabaseClient, userId: string): Promise<CompanyMembership[]> {
  const [ownedRes, memberRes] = await Promise.all([
    admin
      .from("rooms")
      .select("id, room_slug, name, company_logo_url")
      .eq("owner_user_id", userId)
      .eq("is_template", false)
      .not("room_slug", "is", null),
    admin.from("company_members").select("rooms(id, room_slug, name, company_logo_url, is_template)").eq("user_id", userId),
  ]);

  const owned = ((ownedRes.data as RoomRow[] | null) ?? [])
    .filter((r) => !RESERVED_SLUGS.has(r.room_slug as string))
    .map((r) => toMembership(r, "owner"));

  type MemberRow = { rooms: (RoomRow & { is_template: boolean | null }) | null };
  const member = ((memberRes.data as unknown as MemberRow[] | null) ?? [])
    .map((row) => row.rooms)
    .filter((r): r is RoomRow & { is_template: boolean | null } => !!r && r.is_template === false && !!r.room_slug)
    .filter((r) => !RESERVED_SLUGS.has(r.room_slug as string))
    .map((r) => toMembership(r, "member"));

  return [...owned, ...member];
}

/** Confere se `userId` ainda é dona OU membro de UM espaço específico
 * (ver comentário na migration sobre nunca confiar só no que já foi
 * salvo antes -- usado tanto pra VALIDAR a escolha na hora de gravar
 * quanto pra RE-CONFERIR na hora de exibir). Devolve a relação (dona/
 * membro) ou null se não for nenhum dos dois (mais). */
export async function getUserRelationToRoom(
  admin: SupabaseClient,
  userId: string,
  roomId: string
): Promise<"owner" | "member" | null> {
  const room = await admin.from("rooms").select("owner_user_id").eq("id", roomId).maybeSingle();
  if (room.data?.owner_user_id === userId) return "owner";
  const member = await admin
    .from("company_members")
    .select("user_id")
    .eq("room_id", roomId)
    .eq("user_id", userId)
    .maybeSingle();
  return member.data ? "member" : null;
}
