"use client";

// Card de perfil de UMA CONTA (nome/status/instagram/bio/foto, via
// GET /api/profile/view -- ver comentário grande lá) -- pedido do
// Douglas 29/set, clicando numa linha do painel de Amigos ("quero
// clicar, e abrir o perfil da pessoa"). Reaproveita as MESMAS classes
// .profile-* do card de perfil de dentro da sala (ver ProfileCard em
// components/GameRoom.tsx) pra ter a cara idêntica -- só que esse
// aqui funciona com QUALQUER conta, online ou não, dentro ou fora da
// sala, porque lê direto de public.profiles em vez do WebSocket ao
// vivo (remoteProfile). Sem editor de avatar/traje -- é só leitura +
// Seguir/Conversar.
import { useEffect, useState } from "react";

type ViewedProfile = {
  userId: string;
  name: string;
  status: string;
  instagram: string;
  bio: string;
  photoUrl: string;
};

// mesma paleta/rótulo do card de dentro da sala (ver STATUS_DOT_COLORS/
// STATUS_OPTIONS em components/GameRoom.tsx) -- duplicado aqui de
// propósito, pra esse arquivo não depender de importar nada de dentro
// de GameRoom.tsx (arquivo gigante, feito pra rodar só dentro da
// sala). Perfil sem status reconhecido (conta que nunca abriu a sala
// pra definir um) simplesmente não mostra a bolinha.
const STATUS_META: Record<string, { label: string; dot: string }> = {
  online: { label: "Online", dot: "#4fd97a" },
  away: { label: "Ausente", dot: "#9a9aa5" },
  focus: { label: "Foco", dot: "#f5c542" },
};

function instagramHref(handle: string) {
  return `https://instagram.com/${handle.replace(/^@/, "").trim()}`;
}

export default function ProfileViewCard({
  userId,
  accountAccessToken,
  onClose,
  onStartConversation,
  onFollowChanged,
  anchored = false,
}: {
  userId: string;
  accountAccessToken: string;
  onClose: () => void;
  onStartConversation: (targetUserId: string, targetName: string) => void;
  onFollowChanged?: () => void;
  // Douglas 30/set (2): "quero essas opcoes abrindo ali naquele canto,
  // prendidas pelo card com nome e foto ali" -- só o AccountCard.tsx
  // ("Meu perfil público") passa true; FriendsPanel.tsx/Lobby.tsx (ver
  // outros dois usos de <ProfileViewCard>) continuam com o modal
  // centralizado de sempre (.profile-backdrop), que faz mais sentido
  // lá -- podem abrir de QUALQUER lugar da tela (uma linha da lista de
  // amigos, um avatar na sala), não tem "canto" fixo pra ancorar. Ver
  // .account-card-anchor/-backdrop em globals.css pro porquê do bug
  // (.profile-backdrop position:fixed preso pelo backdrop-filter da
  // topbar) + a explicação de ancorar em vez de centralizar.
  anchored?: boolean;
}) {
  const [profile, setProfile] = useState<ViewedProfile | null>(null);
  const [following, setFollowing] = useState(false);
  const [mutual, setMutual] = useState(false);
  // pedido implícito ao reaproveitar esse card pra "Meu perfil público"
  // (ver AccountCard.tsx, item 1 do card da conta) -- abrir o PRÓPRIO
  // perfil não deveria oferecer "Seguir a si mesmo"/"Conversar
  // consigo mesmo". A rota GET /api/profile/view já devolvia isSelf,
  // só não tinha ninguém usando ainda.
  const [isSelf, setIsSelf] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/profile/view?userId=${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${accountAccessToken}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data?.profile) return;
        setProfile(data.profile);
        setFollowing(!!data.following);
        setMutual(!!data.mutual);
        setIsSelf(!!data.isSelf);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, accountAccessToken]);

  async function toggleFollow() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/friends/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accountAccessToken}` },
        body: JSON.stringify({ targetUserId: userId }),
      });
      if (res.ok) {
        const data = await res.json();
        setFollowing(!!data.following);
        setMutual(!!data.mutual);
        onFollowChanged?.();
      }
    } catch {
      // rede caiu -- botão continua no estado de antes, pessoa tenta de novo
    } finally {
      setBusy(false);
    }
  }

  const status = profile ? STATUS_META[profile.status] : null;
  const displayName = profile?.name || "(sem nome)";

  const card = (
      <div className="profile-card" onClick={(e) => e.stopPropagation()}>
        <button className="profile-close" onClick={onClose} title="Fechar">
          ✕
        </button>

        {loading || !profile ? (
          <div className="profile-body">
            <p className="members-panel-loading">Carregando...</p>
          </div>
        ) : (
          <>
            <div className="profile-photo-wrap">
              <div
                className="profile-photo"
                style={{ backgroundImage: profile.photoUrl ? `url(${profile.photoUrl})` : undefined }}
              >
                {!profile.photoUrl && (
                  <span className="profile-photo-fallback">{displayName.slice(0, 1).toUpperCase()}</span>
                )}
                <div className="profile-photo-fade" />
                <div className="profile-photo-text">
                  <span className="profile-name-row">
                    {status && (
                      <span className="profile-status-dot" style={{ background: status.dot }} title={status.label} />
                    )}
                    <span className="profile-name">{displayName}</span>
                  </span>
                </div>
              </div>
            </div>

            <div className="profile-body">
              <div className="profile-view">
                {status && (
                  <span className="profile-status-line">
                    <span className="profile-status-dot" style={{ background: status.dot }} />
                    {status.label}
                  </span>
                )}
                {profile.instagram && (
                  <a
                    className="profile-instagram-link"
                    href={instagramHref(profile.instagram)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    @{profile.instagram.replace(/^@/, "")}
                  </a>
                )}
                {profile.bio && <p className="profile-bio">{profile.bio}</p>}
              </div>

              {!isSelf && (
                <div className="profile-actions">
                  <div className="profile-actions-row">
                    <button className="profile-action-btn" disabled={busy} onClick={toggleFollow}>
                      {following ? "Seguindo" : "Seguir"}
                    </button>
                    {mutual && (
                      <button
                        className="profile-action-btn primary"
                        onClick={() => onStartConversation(profile.userId, displayName)}
                      >
                        Conversar
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
  );

  if (anchored) {
    return (
      <div className="account-card-anchor-backdrop" onClick={onClose}>
        <div className="account-card-anchor">{card}</div>
      </div>
    );
  }
  return (
    <div className="profile-backdrop" onClick={onClose}>
      {card}
    </div>
  );
}
