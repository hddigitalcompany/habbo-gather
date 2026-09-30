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
import { useEffect, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

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

// pedido do Douglas, 30/set (4): "o perfil deve abrir a opcao de
// edicao ali tambem" -- editar nome/status/insta/bio/foto até aqui só
// dava dentro da sala (ProfileCard/updateMyProfile+syncProfileToAccount
// em components/GameRoom.tsx, que escreve direto em public.profiles
// pelo client do Supabase). "Meu perfil público" (ver AccountCard.tsx)
// agora abre em QUALQUER tela, inclusive fora da sala -- precisa poder
// editar dali também, sem depender de entrar numa sala. Mesmo padrão
// (escreve direto em public.profiles pelo client, RLS já libera o
// dono) -- helper de comprimir foto duplicado de compressPhotoToDataUrl
// em GameRoom.tsx (mesmo motivo de sempre: esse arquivo não importa
// nada de lá).
function compressPhotoToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      img.onerror = () => reject(new Error("Não deu pra ler a imagem"));
      img.onload = () => {
        const size = Math.min(img.width, img.height);
        const sx = (img.width - size) / 2;
        const sy = (img.height - size) / 2;
        const target = Math.min(240, size);
        const canvas = document.createElement("canvas");
        canvas.width = target;
        canvas.height = target;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Sem contexto 2D"));
        ctx.drawImage(img, sx, sy, size, size, 0, 0, target, target);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
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

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editStatus, setEditStatus] = useState("online");
  const [editInstagram, setEditInstagram] = useState("");
  const [editBio, setEditBio] = useState("");
  const [editPhotoUrl, setEditPhotoUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  function startEditing(p: ViewedProfile) {
    setEditName(p.name);
    setEditStatus(p.status || "online");
    setEditInstagram(p.instagram);
    setEditBio(p.bio);
    setEditPhotoUrl(p.photoUrl);
    setSaveErr(null);
    setEditing(true);
  }

  async function handleEditPhoto(file: File) {
    try {
      setEditPhotoUrl(await compressPhotoToDataUrl(file));
    } catch {
      // arquivo não é uma imagem legível -- ignora, mantém a foto de antes
    }
  }

  // mesmo padrão de syncProfileToAccount em GameRoom.tsx: escreve
  // direto em public.profiles pelo client do Supabase (RLS já garante
  // que só o dono grava na própria linha, ver 0001_accounts.sql) --
  // sem rota de API nova só pra isso.
  async function saveProfileEdit() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setSaveErr("Login não configurado.");
      return;
    }
    setSaving(true);
    setSaveErr(null);
    try {
      const { error } = await supabase
        .from("profiles")
        .update({
          name: editName.trim().slice(0, 80),
          status: editStatus,
          instagram: editInstagram.trim().slice(0, 80),
          bio: editBio.trim().slice(0, 280),
          photo_url: editPhotoUrl,
          updated_at: new Date().toISOString(),
        })
        .eq("id", userId);
      if (error) {
        setSaveErr(error.message);
        return;
      }
      setProfile((prev) =>
        prev
          ? { ...prev, name: editName.trim(), status: editStatus, instagram: editInstagram.trim(), bio: editBio.trim(), photoUrl: editPhotoUrl }
          : prev
      );
      setEditing(false);
    } catch {
      setSaveErr("Não deu pra salvar agora.");
    } finally {
      setSaving(false);
    }
  }

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
                style={{ backgroundImage: (editing ? editPhotoUrl : profile.photoUrl) ? `url(${editing ? editPhotoUrl : profile.photoUrl})` : undefined }}
              >
                {!(editing ? editPhotoUrl : profile.photoUrl) && (
                  <span className="profile-photo-fallback">{(editing ? editName : displayName).slice(0, 1).toUpperCase()}</span>
                )}
                <div className="profile-photo-fade" />
                <div className="profile-photo-text">
                  <span className="profile-name-row">
                    {status && !editing && (
                      <span className="profile-status-dot" style={{ background: status.dot }} title={status.label} />
                    )}
                    <span className="profile-name">{editing ? editName || "(sem nome)" : displayName}</span>
                  </span>
                </div>
              </div>
            </div>

            <div className="profile-body">
              {editing ? (
                // pedido do Douglas, 30/set (4): "o perfil deve abrir a
                // opcao de edicao ali tambem" -- mesmos 5 campos que o
                // editor de dentro da sala (ProfileCard em GameRoom.tsx)
                // grava, só que dá pra abrir de qualquer tela agora.
                <div className="profile-fields">
                  <button
                    type="button"
                    className="profile-action-btn"
                    onClick={() => photoInputRef.current?.click()}
                  >
                    Trocar foto
                  </button>
                  <input
                    ref={photoInputRef}
                    type="file"
                    accept="image/*"
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (file) handleEditPhoto(file);
                    }}
                  />
                  <label className="profile-field">
                    Nome
                    <input type="text" value={editName} maxLength={80} onChange={(e) => setEditName(e.target.value)} />
                  </label>
                  <label className="profile-field">
                    Status
                    <select value={editStatus} onChange={(e) => setEditStatus(e.target.value)}>
                      {Object.entries(STATUS_META).map(([id, meta]) => (
                        <option key={id} value={id}>
                          {meta.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="profile-field">
                    Instagram
                    <input
                      type="text"
                      value={editInstagram}
                      maxLength={80}
                      placeholder="@usuario"
                      onChange={(e) => setEditInstagram(e.target.value)}
                    />
                  </label>
                  <label className="profile-field">
                    Bio
                    <textarea value={editBio} maxLength={280} onChange={(e) => setEditBio(e.target.value)} />
                  </label>
                  {saveErr && <p className="account-panel-error">{saveErr}</p>}
                  <div className="profile-actions-row">
                    <button className="profile-action-btn" onClick={() => setEditing(false)}>
                      Cancelar
                    </button>
                    <button className="profile-action-btn primary" disabled={saving} onClick={saveProfileEdit}>
                      {saving ? "Salvando..." : "Salvar"}
                    </button>
                  </div>
                </div>
              ) : (
                <>
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

                  <div className="profile-actions">
                    {isSelf ? (
                      <div className="profile-actions-row">
                        <button className="profile-action-btn primary" onClick={() => startEditing(profile)}>
                          Editar perfil
                        </button>
                      </div>
                    ) : (
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
                    )}
                  </div>
                </>
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
