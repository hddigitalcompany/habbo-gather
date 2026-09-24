"use client";

// Painel "área de configuração de membros da sala" -- só aparece pro
// dono (ver isOwner/fetchRole em GameRoom.tsx). Mistura duas fontes:
// - membros/banidos JÁ registrados -- GET /api/room/members?list=1
//   (Next.js, ver app/api/room/members/route.ts)
// - visitante com conta ONLINE agora, ainda não promovido -- GET
//   <REALTIME_HTTP_BASE>/room/presence?detail=1 (servidor WebSocket,
//   ver handleGetPresence em server/index.js) -- é isso que alimenta o
//   botão "Promover" sem precisar de um "buscar por email" à parte.
import { useEffect, useState } from "react";

type MemberRow = {
  user_id: string;
  role: "owner" | "member";
  status: "active" | "banned";
  profiles: { name: string; photo_url: string } | null;
};

type OnlineVisitor = { userId: string; name: string };

export default function RoomMembersPanel({
  accessToken,
  httpBase,
  onClose,
}: {
  accessToken: string;
  httpBase: string;
  onClose: () => void;
}) {
  const [members, setMembers] = useState<MemberRow[] | null>(null);
  const [onlineVisitors, setOnlineVisitors] = useState<OnlineVisitor[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [creatingInvite, setCreatingInvite] = useState(false);

  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  async function loadAll() {
    setError(null);
    try {
      const [membersRes, presenceRes] = await Promise.all([
        fetch("/api/room/members?list=1", { headers: authHeaders }),
        fetch(`${httpBase}/room/presence?detail=1`, { headers: authHeaders }),
      ]);
      const membersData = await membersRes.json();
      if (!membersRes.ok) throw new Error(membersData.error || "erro ao carregar membros");
      setMembers(membersData.members);

      const presenceData = await presenceRes.json();
      if (presenceRes.ok) setOnlineVisitors(presenceData.onlineVisitors ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "erro ao carregar");
    }
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runAction(targetUserId: string, action: "promote" | "demote" | "ban" | "unban") {
    setBusyId(targetUserId);
    setError(null);
    try {
      const res = await fetch("/api/room/members", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ action, targetUserId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "erro");
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "erro");
    } finally {
      setBusyId(null);
    }
  }

  async function createInvite() {
    setCreatingInvite(true);
    setError(null);
    try {
      const res = await fetch("/api/room/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "erro");
      setInviteCode(data.code);
    } catch (e) {
      setError(e instanceof Error ? e.message : "erro");
    } finally {
      setCreatingInvite(false);
    }
  }

  const activeMembers = (members ?? []).filter((m) => m.status === "active");
  const bannedMembers = (members ?? []).filter((m) => m.status === "banned");
  const memberIds = new Set((members ?? []).map((m) => m.user_id));
  const promotable = onlineVisitors.filter((v) => !memberIds.has(v.userId));

  return (
    <div className="members-panel-backdrop" onClick={onClose}>
      <div className="members-panel" onClick={(e) => e.stopPropagation()}>
        <div className="members-panel-header">
          <h2>Membros da sala</h2>
          <button type="button" className="members-panel-close" onClick={onClose} title="Fechar">
            ✕
          </button>
        </div>

        <div className="members-invite-row">
          <button type="button" className="members-invite-btn" onClick={createInvite} disabled={creatingInvite}>
            {creatingInvite ? "Gerando..." : "Gerar convite"}
          </button>
          {inviteCode && (
            <p className="members-invite-code">
              Código: <strong>{inviteCode}</strong>
            </p>
          )}
        </div>

        {error && <p className="members-panel-error">{error}</p>}

        {!members ? (
          <p className="members-panel-loading">Carregando...</p>
        ) : (
          <>
            {promotable.length > 0 && (
              <section className="members-panel-section">
                <h3>Visitante online agora</h3>
                <ul className="members-panel-list">
                  {promotable.map((v) => (
                    <li key={v.userId} className="members-panel-row">
                      <span className="members-panel-name">{v.name || "(sem nome)"}</span>
                      <button
                        type="button"
                        disabled={busyId === v.userId}
                        onClick={() => runAction(v.userId, "promote")}
                      >
                        Promover
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="members-panel-section">
              <h3>Membros ({activeMembers.length})</h3>
              {activeMembers.length === 0 ? (
                <p className="members-panel-loading">Ninguém foi promovido ainda.</p>
              ) : (
                <ul className="members-panel-list">
                  {activeMembers.map((m) => (
                    <li key={m.user_id} className="members-panel-row">
                      <span className="members-panel-name">
                        {m.profiles?.name || "(sem nome)"}
                        {m.role === "owner" && " · dono"}
                      </span>
                      {m.role !== "owner" && (
                        <div className="members-panel-actions">
                          <button type="button" disabled={busyId === m.user_id} onClick={() => runAction(m.user_id, "demote")}>
                            Rebaixar
                          </button>
                          <button type="button" disabled={busyId === m.user_id} onClick={() => runAction(m.user_id, "ban")}>
                            Banir
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {bannedMembers.length > 0 && (
              <section className="members-panel-section">
                <h3>Banidos ({bannedMembers.length})</h3>
                <ul className="members-panel-list">
                  {bannedMembers.map((m) => (
                    <li key={m.user_id} className="members-panel-row">
                      <span className="members-panel-name">{m.profiles?.name || "(sem nome)"}</span>
                      <button type="button" disabled={busyId === m.user_id} onClick={() => runAction(m.user_id, "unban")}>
                        Desbanir
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
