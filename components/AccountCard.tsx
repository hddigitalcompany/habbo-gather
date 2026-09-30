"use client";

// Card da conta -- pedido do Douglas, 28/set (Lobby.tsx): "aqui nesse
// canto, faca o card da conta do cliente" + "faca o 'card' do perfil
// do usuario aberto". Existia só dentro de Lobby.tsx (canto do
// topbar). Pedido novo, 30/set: "esse card, mantenha ele em toda tela
// que o usuario vai inclusive no jogo, ele vai abrir, 1 - Meu perfil
// público ... Dados da conta ... Selo de verificação" -- virou um
// componente À PARTE (não importa nada de Lobby.tsx/GameRoom.tsx, MESMO
// motivo de ProfileViewCard/FriendsPanel/SettingsPanel serem
// arquivos próprios) pra dar pra montar nas DUAS telas sem duplicar
// ~200 linhas de JSX/estado -- ver <AccountCard /> em Lobby.tsx
// (dentro de .lobby-topbar-right-group) e GameRoom.tsx (canto,
// mesmo lugar do antigo botão avulso de sair).
//
// Reaproveita as MESMAS classes .lobby-topbar-account*/.lobby-account-card*
// que já existiam só em Lobby.tsx (globals.css é um arquivo global só,
// não é "de" nenhum componente) -- pra ficar com a cara idêntica nas
// duas telas, sem escrever CSS novo pra isso.
import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import ProfileViewCard from "@/components/ProfileViewCard";

type ProfileStatus = "online" | "away" | "focus";
type AccountProfile = {
  name: string;
  status: ProfileStatus;
  instagram: string;
  bio: string;
  photoUrl: string;
};

const ACCOUNT_STATUS_LABELS: Record<string, string> = {
  online: "Online",
  away: "Ausente",
  focus: "Foco",
};

type MenuPanel = "profile" | "account" | "verification" | null;

export default function AccountCard({
  accountUserId,
  accountProfile,
  accountAccessToken,
  onStartConversation,
}: {
  accountUserId: string | null;
  accountProfile: Partial<AccountProfile> | null;
  accountAccessToken: string | null;
  // ProfileViewCard exige esse callback (Conversar num perfil mútuo) --
  // aqui dentro nunca dispara de verdade (isSelf sempre esconde o
  // botão "Conversar", ver comentário grande em ProfileViewCard.tsx),
  // mas o prop continua obrigatório lá, então aceita opcional aqui e
  // cai num no-op se quem montou não passou nada.
  onStartConversation?: (targetUserId: string, targetName: string) => void;
}) {
  const [cardOpen, setCardOpen] = useState(false);
  const [panel, setPanel] = useState<MenuPanel>(null);

  const displayName = accountProfile?.name?.trim() || "visitante";
  const accountBio = accountProfile?.bio?.trim() || "";
  const accountInstagram = accountProfile?.instagram?.trim().replace(/^@/, "") || "";
  const accountInitial = displayName.charAt(0).toUpperCase() || "?";
  const accountStatusId = accountProfile?.status || "online";
  const accountStatusLabel = ACCOUNT_STATUS_LABELS[accountStatusId] || ACCOUNT_STATUS_LABELS.online;

  function openPanel(p: MenuPanel) {
    setPanel(p);
    setCardOpen(false);
  }

  return (
    <div className="lobby-topbar-account-wrap">
      <button
        type="button"
        className="lobby-topbar-account"
        onClick={() => setCardOpen((v) => !v)}
        aria-expanded={cardOpen}
      >
        <span className="lobby-topbar-account-avatar">
          {accountProfile?.photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={accountProfile.photoUrl} alt="" />
          ) : (
            accountInitial
          )}
        </span>
        <span className="lobby-topbar-account-name">{displayName}</span>
      </button>
      {cardOpen && (
        <>
          <div className="lobby-account-card-backdrop" onClick={() => setCardOpen(false)} />
          <div className="lobby-account-card">
            <p className="lobby-account-card-greeting">{displayName}</p>
            {accountBio && <p className="lobby-account-card-bio">{accountBio}</p>}
            <div className="lobby-account-card-tags">
              <span className="lobby-account-card-tag lobby-account-card-tag-status">
                <span className={`lobby-account-card-status-dot ${accountStatusId}`} />
                {accountStatusLabel}
              </span>
              {accountInstagram && (
                <a
                  className="lobby-account-card-tag"
                  href={`https://instagram.com/${accountInstagram}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  @{accountInstagram}
                </a>
              )}
            </div>
            {/* pedido do Douglas, 30/set: "ele vai abrir, 1 - Meu
                perfil público ... Dados da conta ... Selo de
                verificação" -- os 3 itens (menu clicável dentro do
                próprio card, ver painéis logo abaixo). */}
            <div className="account-card-menu">
              <button
                type="button"
                className="account-card-menu-item"
                disabled={!accountUserId || !accountAccessToken}
                onClick={() => openPanel("profile")}
              >
                Meu perfil público
              </button>
              <button
                type="button"
                className="account-card-menu-item"
                disabled={!accountAccessToken}
                onClick={() => openPanel("account")}
              >
                Dados da conta
              </button>
              <button
                type="button"
                className="account-card-menu-item"
                disabled={!accountAccessToken}
                onClick={() => openPanel("verification")}
              >
                Selo de verificação
              </button>
            </div>
          </div>
        </>
      )}

      {panel === "profile" && accountUserId && accountAccessToken && (
        <ProfileViewCard
          userId={accountUserId}
          accountAccessToken={accountAccessToken}
          onClose={() => setPanel(null)}
          onStartConversation={(targetUserId, targetName) => onStartConversation?.(targetUserId, targetName)}
          anchored
        />
      )}
      {panel === "account" && accountAccessToken && (
        <AccountDataPanel accountAccessToken={accountAccessToken} onClose={() => setPanel(null)} />
      )}
      {panel === "verification" && accountAccessToken && (
        <VerificationPanel accountAccessToken={accountAccessToken} onClose={() => setPanel(null)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------
// "Dados da conta" -- pedido do Douglas: "Dados da conta: nome
// completo, cpf, data de nascimento, email da conta, senha, alterar
// senha". Nome completo/CPF/nascimento via GET/POST /api/account
// (tabela account_private, NUNCA public.profiles -- ver comentário
// grande na migration 0041_account_and_verification.sql). Email/senha
// não passam pela API própria do app -- são geridos pelo Supabase
// Auth direto (supabase.auth.updateUser), o mesmo client que já loga
// a pessoa (ver lib/supabase/client.ts).
// ---------------------------------------------------------------
function AccountDataPanel({ accountAccessToken, onClose }: { accountAccessToken: string; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [fullName, setFullName] = useState("");
  const [cpf, setCpf] = useState("");
  const [birthdate, setBirthdate] = useState("");
  const [email, setEmail] = useState("");
  const [savingData, setSavingData] = useState(false);
  const [dataSaved, setDataSaved] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);

  const [changingPassword, setChangingPassword] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordMsg, setPasswordMsg] = useState<string | null>(null);
  const [passwordErr, setPasswordErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetch("/api/account", { headers: { Authorization: `Bearer ${accountAccessToken}` } }).then((r) =>
        r.ok ? r.json() : null
      ),
      getSupabaseBrowserClient()?.auth.getSession() ?? Promise.resolve(null),
    ]).then(([accountData, sessionRes]) => {
      if (cancelled) return;
      if (accountData?.account) {
        setFullName(accountData.account.fullName || "");
        setCpf(accountData.account.cpf || "");
        setBirthdate(accountData.account.birthdate || "");
      }
      const sessionEmail = (sessionRes as { data?: { session?: { user?: { email?: string } } } } | null)?.data
        ?.session?.user?.email;
      if (sessionEmail) setEmail(sessionEmail);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [accountAccessToken]);

  function formatCpf(v: string): string {
    const digits = v.replace(/\D/g, "").slice(0, 11);
    const p1 = digits.slice(0, 3);
    const p2 = digits.slice(3, 6);
    const p3 = digits.slice(6, 9);
    const p4 = digits.slice(9, 11);
    let out = p1;
    if (p2) out += `.${p2}`;
    if (p3) out += `.${p3}`;
    if (p4) out += `-${p4}`;
    return out;
  }

  async function saveAccountData() {
    setSavingData(true);
    setDataError(null);
    setDataSaved(false);
    try {
      const res = await fetch("/api/account", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accountAccessToken}` },
        body: JSON.stringify({ fullName, cpf, birthdate: birthdate || null }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setDataError(typeof data?.error === "string" ? data.error : "Não deu pra salvar agora.");
        return;
      }
      setDataSaved(true);
      setTimeout(() => setDataSaved(false), 2500);
    } catch {
      setDataError("Não deu pra salvar agora.");
    } finally {
      setSavingData(false);
    }
  }

  async function submitNewPassword() {
    if (newPassword.trim().length < 6) {
      setPasswordErr("A senha precisa ter pelo menos 6 caracteres.");
      return;
    }
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setPasswordErr("Login não configurado.");
      return;
    }
    setPasswordBusy(true);
    setPasswordErr(null);
    setPasswordMsg(null);
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword.trim() });
      if (error) {
        setPasswordErr(error.message);
        return;
      }
      setPasswordMsg("Senha alterada.");
      setNewPassword("");
      setChangingPassword(false);
    } catch {
      setPasswordErr("Não deu pra trocar a senha agora.");
    } finally {
      setPasswordBusy(false);
    }
  }

  return (
    <div className="account-card-anchor-backdrop" onClick={onClose}>
      <div className="account-card-anchor">
      <div className="profile-card account-data-card" onClick={(e) => e.stopPropagation()}>
        <button className="profile-close" onClick={onClose} title="Fechar">
          ✕
        </button>
        <div className="profile-body">
          <h3 className="account-panel-title">Dados da conta</h3>
          {loading ? (
            <p className="members-panel-loading">Carregando...</p>
          ) : (
            <>
              <div className="profile-fields">
                <label className="profile-field">
                  Nome completo
                  <input
                    type="text"
                    value={fullName}
                    maxLength={150}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Seu nome completo"
                  />
                </label>
                <label className="profile-field">
                  CPF
                  <input
                    type="text"
                    value={formatCpf(cpf)}
                    maxLength={14}
                    onChange={(e) => setCpf(e.target.value)}
                    placeholder="000.000.000-00"
                    inputMode="numeric"
                  />
                </label>
                <label className="profile-field">
                  Data de nascimento
                  <input type="date" value={birthdate} onChange={(e) => setBirthdate(e.target.value)} />
                </label>
                <label className="profile-field">
                  Email da conta
                  <input type="email" value={email} disabled title="Pra trocar o email, fale com o suporte." />
                </label>
              </div>
              {dataError && <p className="account-panel-error">{dataError}</p>}
              <button className="profile-action-btn primary" disabled={savingData} onClick={saveAccountData}>
                {savingData ? "Salvando..." : dataSaved ? "Salvo!" : "Salvar dados"}
              </button>

              <div className="account-panel-divider" />

              {changingPassword ? (
                <div className="profile-fields">
                  <label className="profile-field">
                    Nova senha
                    <input
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      autoComplete="new-password"
                      placeholder="Pelo menos 6 caracteres"
                    />
                  </label>
                  {passwordErr && <p className="account-panel-error">{passwordErr}</p>}
                  <div className="profile-actions-row">
                    <button
                      className="profile-action-btn"
                      onClick={() => {
                        setChangingPassword(false);
                        setNewPassword("");
                        setPasswordErr(null);
                      }}
                    >
                      Cancelar
                    </button>
                    <button className="profile-action-btn primary" disabled={passwordBusy} onClick={submitNewPassword}>
                      {passwordBusy ? "Salvando..." : "Confirmar"}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {passwordMsg && <p className="account-panel-hint">{passwordMsg}</p>}
                  <button className="profile-action-btn" onClick={() => setChangingPassword(true)}>
                    Alterar senha
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------
// "Selo de verificação" -- pedido do Douglas: "aqui dentro vai ter um
// campo, ativar selo de verificado, pessoal e empresa, essa opcao vai
// estar disponivel pra preencher/ativar, apenas se a pessoa paga
// algum plano em uma sala ... ele tem que enviar foto segurando doc
// pra analise, e na empresa, tem que enviar o contrato social da
// empresa constando ele como socio". `eligible` (o "gate" de plano)
// vem do servidor -- ver comentário grande em
// app/api/account/verification/route.ts sobre esse app ainda NÃO ter
// sistema de plano de verdade (usa "é dono de sala" como substituto
// até existir).
// ---------------------------------------------------------------
type OwnedRoom = { id: string; slug: string; name: string; companyVerified: boolean };
type VerificationData = {
  eligible: boolean;
  verifiedPersonal: boolean;
  verifiedCompany: boolean;
  ownedRooms: OwnedRoom[];
  requests: {
    id: string;
    type: "personal" | "company";
    status: "pending" | "approved" | "rejected";
    createdAt: string;
    roomId: string | null;
  }[];
};

function VerificationPanel({ accountAccessToken, onClose }: { accountAccessToken: string; onClose: () => void }) {
  const [data, setData] = useState<VerificationData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyType, setBusyType] = useState<"personal" | "company" | null>(null);
  const [errByType, setErrByType] = useState<Record<string, string>>({});
  // pedido do Douglas, 30/set (2): "quando a pessoa for verificar a
  // empresa, aparece a selecao do espaco que essa empresa esta" --
  // qual dos ownedRooms tá escolhido no seletor do bloco "Empresa"
  // agora (nasce no primeiro espaço ainda sem selo, ver useEffect
  // abaixo).
  const [selectedRoomId, setSelectedRoomId] = useState<string>("");

  function load() {
    setLoading(true);
    fetch("/api/account/verification", { headers: { Authorization: `Bearer ${accountAccessToken}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: VerificationData | null) => {
        if (!d) return;
        setData(d);
        // seleciona automaticamente o primeiro espaço que ainda não
        // tem o selo (o mais provável de ser o que a pessoa quer
        // verificar agora) -- só na primeira carga, pra não pular a
        // escolha de quem já tinha mudado o seletor e só tá recarregando
        // depois de enviar um documento (ver load() chamado de novo em
        // submitDoc).
        setSelectedRoomId((prev) => {
          if (prev && d.ownedRooms.some((r) => r.id === prev)) return prev;
          return d.ownedRooms.find((r) => !r.companyVerified)?.id ?? d.ownedRooms[0]?.id ?? "";
        });
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountAccessToken]);

  // "personal" -- status da CONTA (sem espaço). "company" -- status do
  // ESPAÇO escolhido no seletor (cada espaço tem seu próprio pedido/
  // selo, ver migration 0043_company_verification_per_room.sql).
  function statusFor(type: "personal" | "company") {
    if (type === "personal") return data?.requests.find((r) => r.type === "personal")?.status ?? null;
    return data?.requests.find((r) => r.type === "company" && r.roomId === selectedRoomId)?.status ?? null;
  }

  async function submitDoc(type: "personal" | "company", file: File) {
    setBusyType(type);
    setErrByType((prev) => ({ ...prev, [type]: "" }));
    try {
      const form = new FormData();
      form.set("type", type);
      if (type === "company") form.set("roomId", selectedRoomId);
      form.set("file", file);
      const res = await fetch("/api/account/verification", {
        method: "POST",
        headers: { Authorization: `Bearer ${accountAccessToken}` },
        body: form,
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setErrByType((prev) => ({ ...prev, [type]: typeof body?.error === "string" ? body.error : "Não deu pra enviar agora." }));
        return;
      }
      load();
    } catch {
      setErrByType((prev) => ({ ...prev, [type]: "Não deu pra enviar agora." }));
    } finally {
      setBusyType(null);
    }
  }

  return (
    <div className="account-card-anchor-backdrop" onClick={onClose}>
      <div className="account-card-anchor">
      <div className="profile-card account-data-card" onClick={(e) => e.stopPropagation()}>
        <button className="profile-close" onClick={onClose} title="Fechar">
          ✕
        </button>
        <div className="profile-body">
          <h3 className="account-panel-title">Selo de verificação</h3>
          {loading || !data ? (
            <p className="members-panel-loading">Carregando...</p>
          ) : !data.eligible ? (
            <p className="account-panel-hint">
              O selo de verificação só fica disponível pra quem tem um plano pago em alguma sala.
            </p>
          ) : (
            <>
              <VerificationTypeBlock
                title="Pessoal"
                description="Envie uma foto sua segurando um documento de identidade, pra análise."
                verified={data.verifiedPersonal}
                status={statusFor("personal")}
                busy={busyType === "personal"}
                error={errByType.personal}
                onPick={(file) => submitDoc("personal", file)}
              />
              <div className="account-panel-divider" />
              <VerificationTypeBlock
                title="Empresa"
                description="Envie o contrato social da empresa, constando você como sócio."
                verified={data.ownedRooms.find((r) => r.id === selectedRoomId)?.companyVerified ?? false}
                status={statusFor("company")}
                busy={busyType === "company"}
                error={errByType.company}
                onPick={(file) => submitDoc("company", file)}
                extra={
                  // pedido do Douglas, 30/set (2): "quando a pessoa for
                  // verificar a empresa, aparece a selecao do espaco que
                  // essa empresa esta" -- sem esse seletor não dá pra
                  // saber QUAL dos espaços da pessoa é essa "empresa"
                  // (sem CNPJ, ver comentário grande em
                  // app/api/account/verification/route.ts).
                  <label className="profile-field">
                    Espaço
                    <select value={selectedRoomId} onChange={(e) => setSelectedRoomId(e.target.value)}>
                      {data.ownedRooms.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                          {r.companyVerified ? " (verificado)" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                }
              />
            </>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}

function VerificationTypeBlock({
  title,
  description,
  verified,
  status,
  busy,
  error,
  onPick,
  extra,
  disabled,
}: {
  title: string;
  description: string;
  verified: boolean;
  status: "pending" | "approved" | "rejected" | null;
  busy: boolean;
  error?: string;
  onPick: (file: File) => void;
  // pedido do Douglas, 30/set (2): seletor de espaço do bloco "Empresa"
  // (ver VerificationPanel) -- Pessoal não usa, fica null.
  extra?: React.ReactNode;
  // sem espaço nenhum selecionado (conta sem espaço próprio ainda) --
  // não faz sentido deixar enviar documento sem saber pra qual espaço é.
  disabled?: boolean;
}) {
  return (
    <div className="verification-block">
      <p className="verification-block-title">
        {title}
        {verified && <span className="verification-badge-pill">Verificado</span>}
      </p>
      <p className="account-panel-hint">{description}</p>
      {extra}
      {error && <p className="account-panel-error">{error}</p>}
      {verified ? null : status === "pending" ? (
        <p className="account-panel-hint">Em análise...</p>
      ) : (
        <label className={`profile-action-btn verification-upload-btn${disabled ? " disabled" : ""}`}>
          {busy ? "Enviando..." : status === "rejected" ? "Enviar de novo" : "Enviar documento"}
          <input
            type="file"
            accept="image/*,application/pdf"
            style={{ display: "none" }}
            disabled={busy || disabled}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) onPick(file);
            }}
          />
        </label>
      )}
    </div>
  );
}
