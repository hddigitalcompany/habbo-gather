"use client";

// Portão de login/cadastro (email+senha, via Supabase Auth) mostrado
// ANTES da sala -- pedido do Douglas: "vamos criar acessos de contas
// agora, criação de perfil". Fica de fora do GameRoom.tsx de propósito
// (que já é enorme) -- só resolve quem é a pessoa (accountUserId) e
// entrega pro GameRoom via props, que continua funcionando 100% igual
// pra quem não loga (accountUserId null = mesmo fluxo anônimo de
// sempre, ver getOrCreateUserId em GameRoom.tsx).
//
// Se as variáveis NEXT_PUBLIC_SUPABASE_URL/NEXT_PUBLIC_SUPABASE_ANON_KEY
// (ver .env.local.example) ainda não tiverem sido configuradas, esse
// portão nem aparece -- entra direto como visitante, pra não travar
// ninguém enquanto o Supabase não tiver sido criado/configurado.
//
// "Membro" de verdade (promovido, ver supabase/migrations/0001_accounts.sql)
// é decidido DEPOIS, dentro da sala (ver app/api/room/members) -- ter
// conta aqui não torna ninguém membro sozinho, só dá uma identidade
// estável (accountUserId = auth.users.id de verdade, confirmável pelo
// servidor -- ver server/roomAuth.js) em vez do id aleatório de
// localStorage.

import { useEffect, useState, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { getSupabaseBrowserClient, isSupabaseConfigured } from "@/lib/supabase/client";

type ProfileStatus = "online" | "away" | "focus";

// MESMO formato de game/components/GameRoom.tsx (ProfileFields) --
// estruturalmente igual de propósito, pra dar pra passar direto como
// prop sem precisar importar tipo de um arquivo pro outro.
export type AccountProfile = {
  name: string;
  status: ProfileStatus;
  instagram: string;
  bio: string;
  photoUrl: string;
};

type AuthResult = {
  accountUserId: string | null;
  accountProfile: Partial<AccountProfile> | null;
  accountAccessToken: string | null;
  onSignOut: (() => void) | null;
};

type Stage =
  | { kind: "loading" }
  | { kind: "gate" } // formulário de login/cadastro
  | { kind: "check-email" } // acabou de cadastrar, esperando confirmação por email
  | { kind: "setup-profile"; session: Session }
  | { kind: "ready"; result: AuthResult };

export default function AuthGate({ children }: { children: (auth: AuthResult) => React.ReactNode }) {
  const configured = isSupabaseConfigured();
  const [stage, setStage] = useState<Stage>(configured ? { kind: "loading" } : { kind: "loading" });
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // sem Supabase configurado ainda -- pula o portão inteiro, mesmo
  // comportamento de sempre (visitante anônimo por localStorage).
  useEffect(() => {
    if (!configured) {
      setStage({ kind: "ready", result: { accountUserId: null, accountProfile: null, accountAccessToken: null, onSignOut: null } });
      return;
    }
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;

    let cancelled = false;
    async function resolveSession(session: Session | null) {
      if (cancelled) return;
      if (!session) {
        setStage({ kind: "gate" });
        return;
      }
      const { data: profile } = await supabase!
        .from("profiles")
        .select("name, status, instagram, bio, photo_url")
        .eq("id", session.user.id)
        .maybeSingle();
      if (cancelled) return;
      if (!profile || !profile.name) {
        setNameDraft(profile?.name ?? "");
        setStage({ kind: "setup-profile", session });
        return;
      }
      setStage({
        kind: "ready",
        result: {
          accountUserId: session.user.id,
          accountProfile: {
            name: profile.name,
            status: (profile.status as ProfileStatus) || "online",
            instagram: profile.instagram ?? "",
            bio: profile.bio ?? "",
            photoUrl: profile.photo_url ?? "",
          },
          accountAccessToken: session.access_token,
          onSignOut: () => {
            supabase!.auth.signOut();
          },
        },
      });
    }

    supabase.auth.getSession().then(({ data }) => resolveSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      resolveSession(session);
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured]);

  async function handleSubmitAuth(e: FormEvent) {
    e.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setAuthError(null);
    setSubmitting(true);
    try {
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        if (!data.session) {
          // projeto exige confirmação por email antes de liberar login
          setStage({ kind: "check-email" });
          return;
        }
        // confirmação por email desligada no projeto -- já entra direto
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
      // onAuthStateChange acima já cuida de avançar o stage sozinho
    } catch (err) {
      setAuthError(err instanceof Error ? traduzErroAuth(err.message) : "Não deu pra entrar, tenta de novo.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSaveProfileName(e: FormEvent, session: Session) {
    e.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const trimmed = nameDraft.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setAuthError(null);
    try {
      const { error } = await supabase.from("profiles").update({ name: trimmed }).eq("id", session.user.id);
      if (error) throw error;
      setStage({
        kind: "ready",
        result: {
          accountUserId: session.user.id,
          accountProfile: { name: trimmed, status: "online", instagram: "", bio: "", photoUrl: "" },
          accountAccessToken: session.access_token,
          onSignOut: () => {
            supabase.auth.signOut();
          },
        },
      });
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Não deu pra salvar o nome, tenta de novo.");
    } finally {
      setSubmitting(false);
    }
  }

  function continueAsGuest() {
    setStage({ kind: "ready", result: { accountUserId: null, accountProfile: null, accountAccessToken: null, onSignOut: null } });
  }

  if (stage.kind === "ready") return <>{children(stage.result)}</>;

  if (stage.kind === "loading") {
    return (
      <div className="auth-gate-backdrop">
        <div className="auth-gate-card">
          <p className="auth-gate-loading">Carregando...</p>
        </div>
      </div>
    );
  }

  if (stage.kind === "check-email") {
    return (
      <div className="auth-gate-backdrop">
        <div className="auth-gate-card">
          <h1 className="auth-gate-title">Confirme seu email</h1>
          <p className="auth-gate-subtitle">
            Mandamos um link de confirmação pra <strong>{email}</strong>. Depois de confirmar, volte aqui e entre
            normalmente.
          </p>
          <button type="button" className="auth-gate-link-btn" onClick={() => setStage({ kind: "gate" })}>
            Voltar pro login
          </button>
        </div>
      </div>
    );
  }

  if (stage.kind === "setup-profile") {
    return (
      <div className="auth-gate-backdrop">
        <div className="auth-gate-card">
          <h1 className="auth-gate-title">Como você quer ser chamado?</h1>
          <p className="auth-gate-subtitle">Você pode ajustar foto, bio e Instagram depois, direto no seu perfil dentro da sala.</p>
          <form className="auth-gate-form" onSubmit={(e) => handleSaveProfileName(e, stage.session)}>
            <input
              className="auth-gate-input"
              type="text"
              placeholder="Seu nome"
              value={nameDraft}
              maxLength={40}
              autoFocus
              onChange={(e) => setNameDraft(e.target.value)}
            />
            {authError && <p className="auth-gate-error">{authError}</p>}
            <button type="submit" className="auth-gate-submit" disabled={submitting || !nameDraft.trim()}>
              {submitting ? "Salvando..." : "Entrar na sala"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // stage.kind === "gate"
  return (
    <div className="auth-gate-backdrop">
      <div className="auth-gate-card">
        <h1 className="auth-gate-title">{mode === "login" ? "Entrar" : "Criar conta"}</h1>
        <div className="auth-gate-tabs">
          <button type="button" className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>
            Entrar
          </button>
          <button type="button" className={mode === "signup" ? "active" : ""} onClick={() => setMode("signup")}>
            Criar conta
          </button>
        </div>
        <form className="auth-gate-form" onSubmit={handleSubmitAuth}>
          <input
            className="auth-gate-input"
            type="email"
            placeholder="Email"
            value={email}
            autoComplete="email"
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <input
            className="auth-gate-input"
            type="password"
            placeholder="Senha"
            value={password}
            minLength={6}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {authError && <p className="auth-gate-error">{authError}</p>}
          <button type="submit" className="auth-gate-submit" disabled={submitting}>
            {submitting ? "Um instante..." : mode === "login" ? "Entrar" : "Criar conta"}
          </button>
        </form>
        <button type="button" className="auth-gate-link-btn" onClick={continueAsGuest}>
          Continuar como visitante
        </button>
      </div>
    </div>
  );
}

// mensagens de erro do Supabase vêm em inglês -- traduz só as mais
// comuns, o resto passa direto (melhor que nada, não trava o fluxo).
function traduzErroAuth(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("invalid login credentials")) return "Email ou senha errados.";
  if (lower.includes("user already registered")) return "Já existe uma conta com esse email -- tenta entrar.";
  if (lower.includes("password should be at least")) return "A senha precisa ter pelo menos 6 caracteres.";
  if (lower.includes("unable to validate email")) return "Esse email não parece válido.";
  return message;
}
