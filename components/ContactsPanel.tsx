"use client";

// Painel "Contatos" -- pedido do Douglas: "quero agora, mais um icone
// de contatos" (28/set). Lista TODO MUNDO já cadastrado na plataforma
// (ver chatStore.listAllUsers no servidor -- mesma fonte do WS
// "users:list" que alimenta allUsers em GameRoom.tsx, ou GET
// /users/directory pro Lobby, que não tem WebSocket -- ver comentário
// grande no topo de Lobby.tsx), online ou não -- DIFERENTE de
// RoomMembersPanel (que é só quem tem cargo/acesso NESTA sala).
// Clicar em "Conversar" abre a conversa direta com a pessoa (mesma
// ação de "Enviar mensagem" no card de perfil, ver sendMessageTo em
// GameRoom.tsx / handleStartChat em Lobby.tsx). Reaproveita as MESMAS
// classes .members-panel-* do painel de Membros pra ter a cara
// idêntica (fundo/borda/cabeçalho/lista) -- só busca/avatar são
// próprias daqui (.contacts-panel-*), ver app/globals.css.
import { useMemo, useState } from "react";

export type ContactUser = { userId: string; name: string; color?: string; photoUrl?: string };

export default function ContactsPanel({
  users,
  myUserId,
  onStartConversation,
  onClose,
  loading,
}: {
  users: ContactUser[];
  myUserId: string;
  onStartConversation: (targetUserId: string, targetName: string) => void;
  onClose: () => void;
  loading?: boolean;
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users
      .filter((u) => u.userId !== myUserId)
      .filter((u) => !q || (u.name || "").toLowerCase().includes(q))
      .sort((a, b) => (a.name || "").localeCompare(b.name || "", "pt-BR"));
  }, [users, myUserId, query]);

  return (
    <div className="members-panel-backdrop" onClick={onClose}>
      <div className="members-panel" onClick={(e) => e.stopPropagation()}>
        <div className="members-panel-header">
          <h2>Contatos</h2>
          <button type="button" className="members-panel-close" onClick={onClose} title="Fechar">
            ✕
          </button>
        </div>

        <input
          type="text"
          className="contacts-panel-search"
          placeholder="Buscar contato..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        {loading ? (
          <p className="members-panel-loading">Carregando...</p>
        ) : filtered.length === 0 ? (
          <p className="members-panel-loading">{query ? "Ninguém encontrado." : "Ninguém cadastrado ainda."}</p>
        ) : (
          <ul className="members-panel-list">
            {filtered.map((u) => (
              <li key={u.userId} className="members-panel-row">
                <span className="contacts-panel-identity">
                  <span className="contacts-panel-avatar" style={{ background: u.color || "#5a4b7c" }}>
                    {u.photoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={u.photoUrl} alt="" />
                    ) : (
                      (u.name || "?").trim().charAt(0).toUpperCase() || "?"
                    )}
                  </span>
                  <span className="members-panel-name">{u.name || "(sem nome)"}</span>
                </span>
                <button type="button" onClick={() => onStartConversation(u.userId, u.name)}>
                  Conversar
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
