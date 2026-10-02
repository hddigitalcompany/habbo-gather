"use client";

// Painel "Amigos" -- ANTES era "Contatos" (listava todo mundo já
// cadastrado no ambiente, ver comentário antigo abaixo em
// GET /users/directory). MUDOU (29/set, pedido do Douglas: "eu quero
// que as pessoas possam adicionar como amigo [...] as pessoas podem
// ter Seguidores, quando os dois se seguem mutuamente, viram amigos /
// Aquela aba contatos, vai virar amigos / nao necessariamente quem ta
// na empresa dele, vira amigo") pra um sistema de seguidor de
// verdade: "amigo" é CALCULADO (eu sigo E sou seguido -- ver
// areMutualFriends em server/chatStore.js e a tabela
// public.followers/0039_followers.sql), não um pedido que precisa ser
// aceito.
//
// Duas abas internas:
// - "Amigos" (padrão): só amigo mútuo (GET /api/friends/list) --
//   "Conversar" aqui abre uma conversa PRIVADA (lane "private", ver
//   startConversationFromContacts em GameRoom.tsx/handleStartConversation
//   em Lobby.tsx e o comentário grande sobre lane em
//   server/chatStore.js/getOrCreateDirectConversation). É a ÚNICA
//   forma de conversa privada no app -- diferente da aba "Empresa" do
//   chat (qualquer um com qualquer um, sem essa trava, ver
//   ChatDrawer/LobbyChatPanel).
// - "Buscar pessoas" (GET /api/friends/search): toda CONTA de
//   verdade da plataforma (public.profiles), com botão "Seguir"/
//   "Seguindo" -- vira amigo sozinho, na hora, quando o outro também
//   seguir de volta (sem pedido pra aceitar).
//
// Diferente do "Contatos" antigo, que qualquer visitante sem conta
// podia abrir (fonte era chatStore, indexado por qualquer userId que
// mandasse "identify"): "amigo" é conceito de CONTA -- precisa estar
// logado (accountAccessToken) pra usar esse painel. Reaproveita as
// MESMAS classes .members-panel-* do painel de Membros pra ter a cara
// idêntica (fundo/borda/cabeçalho/lista) -- busca/avatar/abas são
// próprias daqui (.contacts-panel-*), ver app/globals.css.
import { useEffect, useState } from "react";
import ProfileViewCard from "@/components/ProfileViewCard";

// mantido pro resto do app (Lobby.tsx/GameRoom.tsx) continuar tipando
// o diretório platform-wide de GET /users/directory, que NÃO mudou --
// esse painel é que parou de usar esse diretório (ver comentário
// grande acima).
export type ContactUser = { userId: string; name: string; color?: string; photoUrl?: string };

type FriendUser = { userId: string; name: string; photoUrl: string };
type SearchUser = FriendUser & { following: boolean };

export default function FriendsPanel({
  accountAccessToken,
  onStartConversation,
  onClose,
}: {
  accountAccessToken?: string | null;
  onStartConversation: (targetUserId: string, targetName: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"friends" | "search">("friends");
  const [friends, setFriends] = useState<FriendUser[] | null>(null);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchUser[] | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  // clicar numa linha (fora do botão) abre o perfil da pessoa --
  // pedido do Douglas, 29/set: "quero clicar, e abrir o perfil da
  // pessoa" (ver components/ProfileViewCard.tsx).
  const [viewingUserId, setViewingUserId] = useState<string | null>(null);

  // 2/out: cache: "no-store" nos GETs abaixo (ver comentário grande
  // igual em ProfileViewCard.tsx, investigando "Seguir precisa clicar
  // varias vezes") -- garante que reabrir/recarregar sempre busca o
  // following/friends de VERDADE, nunca uma resposta antiga do cache
  // do navegador.
  function reloadFriends() {
    if (!accountAccessToken) return;
    fetch("/api/friends/list", { headers: { Authorization: `Bearer ${accountAccessToken}` }, cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setFriends(Array.isArray(data?.friends) ? data.friends : []))
      .catch(() => setFriends([]));
  }

  // carrega os amigos assim que o painel abre (mesmo antes de trocar
  // de aba) -- é a aba padrão.
  useEffect(() => {
    if (!accountAccessToken) {
      setFriends([]);
      return;
    }
    let cancelled = false;
    fetch("/api/friends/list", { headers: { Authorization: `Bearer ${accountAccessToken}` }, cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setFriends(Array.isArray(data?.friends) ? data.friends : []);
      })
      .catch(() => {
        if (!cancelled) setFriends([]);
      });
    return () => {
      cancelled = true;
    };
  }, [accountAccessToken]);

  // busca com debounce -- só roda na aba "Buscar pessoas" (sem gastar
  // chamada nenhuma enquanto a pessoa só olha os amigos).
  useEffect(() => {
    if (tab !== "search" || !accountAccessToken) return;
    let cancelled = false;
    const t = setTimeout(() => {
      fetch(`/api/friends/search?q=${encodeURIComponent(query.trim())}`, {
        headers: { Authorization: `Bearer ${accountAccessToken}` },
        cache: "no-store",
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!cancelled) setSearchResults(Array.isArray(data?.users) ? data.users : []);
        })
        .catch(() => {
          if (!cancelled) setSearchResults([]);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [tab, query, accountAccessToken]);

  async function toggleFollow(targetUserId: string) {
    if (!accountAccessToken || busyUserId) return;
    setBusyUserId(targetUserId);
    try {
      const res = await fetch("/api/friends/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accountAccessToken}` },
        body: JSON.stringify({ targetUserId }),
      });
      if (res.ok) {
        const data = await res.json();
        setSearchResults((prev) =>
          prev ? prev.map((u) => (u.userId === targetUserId ? { ...u, following: !!data.following } : u)) : prev
        );
        // pode ter virado (ou deixado de ser) amigo mútuo agora --
        // recarrega a aba "Amigos" em segundo plano.
        reloadFriends();
      }
    } catch {
      // rede caiu no meio -- botão volta pro estado de antes, pessoa tenta de novo
    } finally {
      setBusyUserId(null);
    }
  }

  if (!accountAccessToken) {
    return (
      <div className="members-panel-backdrop" onClick={onClose}>
        <div className="members-panel" onClick={(e) => e.stopPropagation()}>
          <div className="members-panel-header">
            <h2>Amigos</h2>
            <button type="button" className="members-panel-close" onClick={onClose} title="Fechar">
              ✕
            </button>
          </div>
          <p className="members-panel-loading">Entra ou cria uma conta pra seguir gente e ter amigos.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="members-panel-backdrop" onClick={onClose}>
      <div className="members-panel" onClick={(e) => e.stopPropagation()}>
        <div className="members-panel-header">
          <h2>Amigos</h2>
          <button type="button" className="members-panel-close" onClick={onClose} title="Fechar">
            ✕
          </button>
        </div>

        <div className="contacts-panel-tabs">
          <button
            type="button"
            className={tab === "friends" ? "contacts-panel-tab on" : "contacts-panel-tab"}
            onClick={() => setTab("friends")}
          >
            Amigos
          </button>
          <button
            type="button"
            className={tab === "search" ? "contacts-panel-tab on" : "contacts-panel-tab"}
            onClick={() => setTab("search")}
          >
            Buscar pessoas
          </button>
        </div>

        {tab === "search" && (
          <input
            type="text"
            className="contacts-panel-search"
            placeholder="Buscar pelo nome..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}

        {tab === "friends" ? (
          friends === null ? (
            <p className="members-panel-loading">Carregando...</p>
          ) : friends.length === 0 ? (
            <p className="members-panel-loading">
              Nenhum amigo ainda. Busca alguém pra seguir na aba &quot;Buscar pessoas&quot;.
            </p>
          ) : (
            <ul className="members-panel-list">
              {friends.map((u) => (
                <li
                  key={u.userId}
                  className="members-panel-row members-panel-row-clickable"
                  onClick={() => setViewingUserId(u.userId)}
                >
                  <span className="contacts-panel-identity">
                    <span className="contacts-panel-avatar" style={{ background: "#5a4b7c" }}>
                      {u.photoUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={u.photoUrl} alt="" />
                      ) : (
                        (u.name || "?").trim().charAt(0).toUpperCase() || "?"
                      )}
                    </span>
                    <span className="members-panel-name">{u.name || "(sem nome)"}</span>
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onStartConversation(u.userId, u.name);
                    }}
                  >
                    Conversar
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : searchResults === null ? (
          <p className="members-panel-loading">Buscando...</p>
        ) : searchResults.length === 0 ? (
          <p className="members-panel-loading">{query ? "Ninguém encontrado." : "Ninguém cadastrado ainda."}</p>
        ) : (
          <ul className="members-panel-list">
            {searchResults.map((u) => (
              <li
                key={u.userId}
                className="members-panel-row members-panel-row-clickable"
                onClick={() => setViewingUserId(u.userId)}
              >
                <span className="contacts-panel-identity">
                  <span className="contacts-panel-avatar" style={{ background: "#5a4b7c" }}>
                    {u.photoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={u.photoUrl} alt="" />
                    ) : (
                      (u.name || "?").trim().charAt(0).toUpperCase() || "?"
                    )}
                  </span>
                  <span className="members-panel-name">{u.name || "(sem nome)"}</span>
                </span>
                <button
                  type="button"
                  disabled={busyUserId === u.userId}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleFollow(u.userId);
                  }}
                >
                  {u.following ? "Seguindo" : "Seguir"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {viewingUserId && accountAccessToken && (
        <ProfileViewCard
          userId={viewingUserId}
          accountAccessToken={accountAccessToken}
          onClose={() => setViewingUserId(null)}
          onStartConversation={(targetUserId, targetName) => {
            setViewingUserId(null);
            onStartConversation(targetUserId, targetName);
          }}
          onFollowChanged={reloadFriends}
        />
      )}
    </div>
  );
}
