// identidade PERSISTENTE do usuário nesse navegador -- NÃO é login de
// verdade, só um id salvo no localStorage, gerado uma vez e reusado
// pra sempre nesse navegador. Extraído de components/GameRoom.tsx
// (28/set) pro Lobby.tsx poder usar o MESMO id sem duplicar a lógica
// -- pedido do Douglas: chat/agenda/configurações "acompanham a
// pessoa por toda a plataforma" (Lobby + sala, não só dentro da
// sala), então o Lobby precisa saber "quem é" a pessoa da MESMA forma
// que a sala sabe, antes mesmo dela clicar "Entrar na sala" (ver
// Lobby.tsx: busca /chat/summary e /agenda/summary com esse id).
//
// É o que faz o histórico de conversa direta/grupo e a agenda
// sobreviverem a um F5 -- sem isso, cada visita pareceria uma pessoa
// nova (ver "userId" vs "id" de conexão no comentário grande em
// server/index.js).
export const USER_ID_STORAGE_KEY = "habbo-gather-user-id";

export function getOrCreateUserId(): string {
  if (typeof window === "undefined") return "";
  try {
    let id = window.localStorage.getItem(USER_ID_STORAGE_KEY);
    if (!id) {
      id = crypto.randomUUID?.() ?? `u-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      window.localStorage.setItem(USER_ID_STORAGE_KEY, id);
    }
    return id;
  } catch {
    return `u-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

/** Mesma regra usada em GameRoom.tsx: quem tem conta de verdade usa o
 * id da conta; visitante anônimo usa o id persistido no localStorage. */
export function resolveUserId(accountUserId: string | null | undefined): string {
  return accountUserId || getOrCreateUserId();
}
