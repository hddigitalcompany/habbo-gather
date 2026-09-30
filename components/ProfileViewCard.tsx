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
import { createPortal } from "react-dom";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

type ViewedProfile = {
  userId: string;
  name: string;
  status: string;
  instagram: string;
  bio: string;
  photoUrl: string;
  // empresa destacada (ver profiles.featured_company_room_id, migration
  // 0044_company_members_and_profile_card.sql) -- pedido do Douglas,
  // 30/set (8): "as empresas que a pessoa é dona/membro vao aparecer no
  // perfil dela, [...] a logo da empresa [...] a funcao dela na
  // empresa". null quando não escolheu nenhuma (ou deixou de ser
  // dona/membro da que tinha escolhido -- ver GET /api/profile/view,
  // que já confere de novo antes de mandar isso).
  company: {
    roomId: string;
    slug: string;
    name: string;
    logoUrl: string;
    relation: "owner" | "member";
    cargo: string;
    // "Tagline" -- pedido do Douglas, 30/set (17): "essa frase,
    // aparecera no perfil do membro ao lado do icone da empresa".
    tagline: string;
  } | null;
  // pedido do Douglas, 30/set (12): "perfil de usuario publico, quero
  // seguidores e seguindo" -- só a CONTAGEM vem junto do perfil; a
  // lista em si (pra abrir clicando) é buscada à parte (ver
  // followPanel/GET /api/profile/followers mais abaixo), só quando a
  // pessoa realmente clica.
  followerCount: number;
  followingCount: number;
};

type FollowUser = { userId: string; name: string; photoUrl: string };

// mesma empresa acima, mas na forma que o seletor de edição usa (ver
// GET /api/account/companies) -- TODAS as que a pessoa é dona/membro,
// não só a destacada.
type MyCompany = { roomId: string; slug: string; name: string; logoUrl: string; relation: "owner" | "member" };

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

  // seletor "qual empresa mostrar" (ver comentário grande em
  // ViewedProfile/MyCompany acima) -- só busca (GET
  // /api/account/companies) quando entra no modo de edição do PRÓPRIO
  // perfil, não em toda visita a essa tela. editFeaturedCompanyRoomId
  // vazio ("") = "Nenhuma" no <select> (equivale a null ao salvar).
  const [myCompanies, setMyCompanies] = useState<MyCompany[] | null>(null);
  const [editFeaturedCompanyRoomId, setEditFeaturedCompanyRoomId] = useState("");

  // "Seguidores"/"Seguindo" clicáveis (ver profile-follow-counts mais
  // abaixo) -- followPanel controla qual lista tá aberta (ou nenhuma);
  // followUsers só busca quando abre uma (GET /api/profile/followers),
  // não em toda visita ao perfil. followPanelViewingUserId é o MESMO
  // padrão de viewingUserId em FriendsPanel.tsx: clicar numa linha da
  // lista abre outro <ProfileViewCard> por cima (empilhado), inclusive
  // o do próprio ProfileViewCard de novo -- funciona liso porque é só
  // um componente React se referenciando, sem import circular nenhum.
  const [followPanel, setFollowPanel] = useState<"followers" | "following" | null>(null);
  const [followUsers, setFollowUsers] = useState<FollowUser[] | null>(null);
  const [followPanelViewingUserId, setFollowPanelViewingUserId] = useState<string | null>(null);

  useEffect(() => {
    if (!followPanel) {
      setFollowUsers(null);
      return;
    }
    let cancelled = false;
    setFollowUsers(null);
    fetch(`/api/profile/followers?userId=${encodeURIComponent(userId)}&type=${followPanel}`, {
      headers: { Authorization: `Bearer ${accountAccessToken}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setFollowUsers(Array.isArray(data?.users) ? data.users : []);
      })
      .catch(() => {
        if (!cancelled) setFollowUsers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [followPanel, userId, accountAccessToken]);

  function startEditing(p: ViewedProfile) {
    setEditName(p.name);
    setEditStatus(p.status || "online");
    setEditInstagram(p.instagram);
    setEditBio(p.bio);
    setEditPhotoUrl(p.photoUrl);
    setEditFeaturedCompanyRoomId(p.company?.roomId ?? "");
    setSaveErr(null);
    setEditing(true);
    if (myCompanies === null) {
      fetch("/api/account/companies", { headers: { Authorization: `Bearer ${accountAccessToken}` } })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => setMyCompanies(Array.isArray(data?.companies) ? data.companies : []))
        .catch(() => setMyCompanies([]));
    }
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

      // empresa destacada (ver comentário grande em ViewedProfile
      // acima) -- rota própria (não é public.profiles direto pelo
      // browser client como o resto): precisa validar que a pessoa
      // ainda é dona/membro da empresa escolhida, e RLS nem deixa o
      // browser client ler company_members pra conferir sozinho (ver
      // app/api/account/featured-company/route.ts).
      const chosen = myCompanies?.find((c) => c.roomId === editFeaturedCompanyRoomId) ?? null;
      const companyRes = await fetch("/api/account/featured-company", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accountAccessToken}` },
        body: JSON.stringify({ roomId: editFeaturedCompanyRoomId || null }),
      });
      if (!companyRes.ok) {
        const companyErr = await companyRes.json().catch(() => null);
        setSaveErr(companyErr?.error || "Perfil salvo, mas não deu pra atualizar a empresa destacada.");
        return;
      }

      setProfile((prev) =>
        prev
          ? {
              ...prev,
              name: editName.trim(),
              status: editStatus,
              instagram: editInstagram.trim(),
              bio: editBio.trim(),
              photoUrl: editPhotoUrl,
              // cargo "" aqui de propósito (não vem de myCompanies,
              // que não carrega isso) -- é só o patch OTIMISTA local
              // logo depois de escolher a empresa destacada; o valor
              // de verdade (definido pelo dono da empresa em
              // Lobby.tsx) chega na próxima vez que esse perfil for
              // buscado do zero (GET /api/profile/view, que já lê
              // certo -- ver comentário grande lá).
              // tagline "" aqui pelo mesmo motivo do cargo acima --
              // myCompanies não carrega isso, valor de verdade chega
              // no próximo fetch do zero.
              company: chosen
                ? { roomId: chosen.roomId, slug: chosen.slug, name: chosen.name, logoUrl: chosen.logoUrl, relation: chosen.relation, cargo: "", tagline: "" }
                : null,
            }
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
                  {/* "qual empresa mostrar" -- só aparece se a pessoa
                      for dona/membro de alguma (ver myCompanies acima);
                      sem nenhuma, nem mostra o campo (nada pra
                      escolher). Native <select>: é seleção ÚNICA
                      mesmo, "ele vai escolher qual empresa mostrar"
                      (diferente do multi-select de categoria da
                      empresa, que é dropdown custom com checklist). */}
                  {myCompanies && myCompanies.length > 0 && (
                    <label className="profile-field">
                      Empresa em destaque
                      <select
                        value={editFeaturedCompanyRoomId}
                        onChange={(e) => setEditFeaturedCompanyRoomId(e.target.value)}
                      >
                        <option value="">Nenhuma</option>
                        {myCompanies.map((c) => (
                          <option key={c.roomId} value={c.roomId}>
                            {c.name || "(sem nome)"} -- {c.relation === "owner" ? "Dona" : "Membro"}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
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
                    {/* pedido do Douglas, 30/set (12): "perfil de
                        usuario publico, quero seguidores e seguindo" --
                        contagem sempre visível, clica pra abrir a
                        lista (ver followPanel acima). Sem "Seguindo"
                        quando é o card da própria conta não muda nada
                        aqui -- diferente do card de empresa (que só
                        tem Seguidores porque não segue ninguém), CONTA
                        de pessoa segue outras contas de verdade, os
                        dois números sempre fazem sentido. */}
                    <div className="profile-follow-counts">
                      <button type="button" className="profile-follow-count-btn" onClick={() => setFollowPanel("followers")}>
                        <strong>{profile.followerCount}</strong> Seguidores
                      </button>
                      <button type="button" className="profile-follow-count-btn" onClick={() => setFollowPanel("following")}>
                        <strong>{profile.followingCount}</strong> Seguindo
                      </button>
                    </div>
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

                    {/* card da empresa em destaque -- pedido do
                        Douglas, 30/set (8): "vamos adicionar o mesmo
                        sistema de cards que tem no da empresa [...]
                        vai ser a logo da empresa que aaprecera no
                        lugar do campo" -- mesmas classes CSS do
                        "quadradinho" de posicionamento em Lobby.tsx
                        (company-card-positions/company-card-position-
                        card/company-card-position-name), reaproveitadas
                        de verdade, não uma cópia: aqui a logo da
                        empresa entra no lugar do gradiente de fundo, e
                        "Dona"/"Membro" no lugar do nome da categoria. */}
                    {profile.company && (
                      // "Tagline ao lado do icone" -- pedido do Douglas,
                      // 30/set (17): "essa frase, aparecera no perfil do
                      // membro ao lado do icone da empresa" -- wrapper
                      // próprio (profile-company-badge), NÃO mexe no
                      // .company-card-positions original (Lobby.tsx
                      // reaproveita a mesma classe pra outra coisa, o
                      // scroll horizontal de categorias).
                      <>
                        {/* "Founder:" -- pedido do Douglas, 30/set
                            (19): "antes da foto da empresa+tagline,
                            titulo de apresentacao / Founder:" -- mesmo
                            padrão de "Founders:" no card da empresa
                            (ver company-card-founders-label em
                            Lobby.tsx/app/globals.css), só que aqui no
                            singular (é UMA pessoa mostrando a empresa
                            dela). FORA do .profile-company-badge (que
                            é flex-row ícone+tagline lado a lado) --
                            esse rótulo é um título em CIMA do bloco
                            inteiro, não mais um item lado a lado. */}
                        <p className="profile-company-founder-label">Founder:</p>
                        <div className="profile-company-badge">
                        <div className="company-card-positions">
                          <div
                            className="company-card-position-card"
                            title={profile.company.name || undefined}
                            style={{
                              backgroundImage: profile.company.logoUrl ? `url(${profile.company.logoUrl})` : undefined,
                            }}
                          >
                            <span className="company-card-position-name">
                              {/* "Cargo" (pedido do Douglas, 30/set (16)) --
                                  completa "a funcao dela na empresa" (30/set
                                  (8)), que até aqui só mostrava "Membro" fixo.
                                  Dona continua "Dona" (não tem cargo, ver
                                  comentário grande em GET /api/profile/view);
                                  Membro mostra o cargo escolhido pelo dono
                                  quando tiver um, senão cai no genérico
                                  "Membro" de sempre. */}
                              {profile.company.relation === "owner"
                                ? "Dona"
                                : profile.company.cargo || "Membro"}
                            </span>
                          </div>
                        </div>
                        {/* pedido do Douglas, 30/set (20): "cade o
                            nome? poe o nome da empresa nos dois" -- até
                            aqui esse badge nunca mostrava o NOME da
                            empresa (só a logo + Dona/cargo + tagline);
                            entra como uma colunazinha ao lado da logo,
                            nome em negrito em cima da tagline. */}
                        <div className="profile-company-text">
                          <p className="profile-company-name">{profile.company.name}</p>
                          {profile.company.tagline && (
                            <p className="profile-company-tagline">{profile.company.tagline}</p>
                          )}
                        </div>
                        </div>
                      </>
                    )}
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

  // painel "Seguidores"/"Seguindo" (ver followPanel acima) -- mesmas
  // classes .members-panel-*/.contacts-panel-* do painel de Amigos
  // (components/FriendsPanel.tsx), pra ter a cara idêntica. Fica FORA
  // de `card` de propósito -- se entrasse dentro, o .account-card-anchor
  // (modo `anchored`) ia espremer essa lista no mesmo cantinho pequeno
  // do card de perfil, em vez de abrir como modal centralizado de
  // verdade.
  //
  // 30/set (20): "cade aonde aparece o seguindo" -- bug: mesmo FORA de
  // `card`, esse modal (.members-panel-backdrop, position:fixed)
  // continuava nascendo espremido no topo da tela quando aberto pelo
  // PRÓPRIO card da conta (AccountCard "Meu perfil público", que abre
  // com anchored=true) -- porque o <AccountCard/> que monta esse
  // <ProfileViewCard/> vive DENTRO de .lobby-topbar/.room-topbar (ver
  // Lobby.tsx/GameRoom.tsx), que tem backdrop-filter: blur(); um
  // ancestral com backdrop-filter vira o "containing block" de
  // qualquer descendente `position:fixed` (regra de CSS, não bug do
  // React) -- então o "viewport inteiro" desse fixed virava só a
  // faixinha de 84px de altura da topbar, mesmo bug já documentado em
  // .account-card-anchor-backdrop acima, só que esse aqui ninguém
  // tinha consertado ainda. `position: fixed` sozinho (mesmo em
  // .lobby-backdrop) NÃO causa isso -- só transform/filter/
  // backdrop-filter/perspective/will-change num ancestral. Fix: portal
  // pra fora da árvore inteira, direto pra <body> (ver render() do
  // portal mais abaixo) -- garante viewport de verdade sempre, não
  // importa de onde o ProfileViewCard foi aberto.
  const followListModal = followPanel && (
    <div
      className="members-panel-backdrop"
      // z-index inline (só aqui, não na classe .members-panel-backdrop
      // compartilhada com FriendsPanel.tsx/RoomMembersPanel.tsx, pra
      // não bagunçar a camada deles) -- agora que isso é um portal
      // direto pro <body> (ver followListPortal mais abaixo), o
      // z-index:400 da classe passa a competir com .lobby-backdrop/
      // .auth-gate-backdrop/.room-loading-screen (que são 500) no
      // MESMO nível (filhos diretos do body), em vez de já nascer por
      // cima deles como descendente. 550 garante que fica acima de
      // tudo isso, de qualquer tela (Lobby ou dentro da sala).
      style={{ zIndex: 550 }}
      onClick={() => setFollowPanel(null)}
    >
      <div className="members-panel" onClick={(e) => e.stopPropagation()}>
        <div className="members-panel-header">
          <h2>{followPanel === "followers" ? "Seguidores" : "Seguindo"}</h2>
          <button type="button" className="members-panel-close" onClick={() => setFollowPanel(null)} title="Fechar">
            ✕
          </button>
        </div>
        {followUsers === null ? (
          <p className="members-panel-loading">Carregando...</p>
        ) : followUsers.length === 0 ? (
          <p className="members-panel-loading">
            {followPanel === "followers" ? "Ninguém segue essa conta ainda." : "Não segue ninguém ainda."}
          </p>
        ) : (
          <ul className="members-panel-list">
            {followUsers.map((u) => (
              <li
                key={u.userId}
                className="members-panel-row members-panel-row-clickable"
                onClick={() => setFollowPanelViewingUserId(u.userId)}
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
              </li>
            ))}
          </ul>
        )}
      </div>
      {followPanelViewingUserId && (
        <ProfileViewCard
          userId={followPanelViewingUserId}
          accountAccessToken={accountAccessToken}
          onClose={() => setFollowPanelViewingUserId(null)}
          onStartConversation={(targetUserId, targetName) => {
            setFollowPanelViewingUserId(null);
            setFollowPanel(null);
            onStartConversation(targetUserId, targetName);
          }}
        />
      )}
    </div>
  );

  // portal pro <body> -- ver comentário grande em followListModal
  // acima (o "porquê" do bug). typeof document !== "undefined" só é
  // guarda de SSR (esse componente é "use client", mas o Next ainda
  // faz um primeiro render no servidor); followPanel só liga depois
  // de um clique do usuário, ou seja, sempre em cima de um DOM real.
  const followListPortal =
    followListModal && typeof document !== "undefined" ? createPortal(followListModal, document.body) : null;

  if (anchored) {
    return (
      <>
        <div className="account-card-anchor-backdrop" onClick={onClose}>
          <div className="account-card-anchor">{card}</div>
        </div>
        {followListPortal}
      </>
    );
  }
  return (
    <>
      <div className="profile-backdrop" onClick={onClose}>
        {card}
      </div>
      {followListPortal}
    </>
  );
}
