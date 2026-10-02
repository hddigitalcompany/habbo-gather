// useRoomCompanyProfile -- hook isolado de propósito (ver comentário
// grande de roomContext/setRoomContext em usePlatformChat.ts, 2/out:
// Douglas, depois do loop que derrubou as conversas: "toda hora
// aparece um novo, porque voce nao isola esse chat cara ja falei, o
// chat tem que ser uma coisa só").
//
// Antes, "buscar nome+logo da empresa de um slug" morava DENTRO do
// motor único do chat (usePlatformChat) -- um bug nessa busca (objeto
// novo a cada render) conseguia derrubar a lista de conversas JUNTO,
// porque os dois viviam no mesmo componente/mesmo ciclo de render.
// Antes AINDA disso, cada tela (Lobby.tsx/GameRoom.tsx) tinha sua
// PRÓPRIA cópia dessa busca -- duas implementações da mesma coisa.
//
// Esse hook resolve as duas coisas de uma vez: é UMA implementação só
// (Lobby e Sala chamam exatamente a mesma função, não duas cópias
// parecidas), mas cada CHAMADA dela cria sua própria instância de
// estado, isolada -- um problema aqui nunca pode derrubar o motor do
// chat (usePlatformChat), porque não moram no mesmo componente nem no
// mesmo estado. Só devolve name/logoUrl (string primitivas, nunca um
// objeto novo por render) -- quem precisa mandar isso pro motor do
// chat (pra carimbar "Empresa" numa conversa nova) usa
// chat.setRoomContext(slug, name, logoUrl), que também só guarda
// primitivas (ver lá) -- nenhum dos dois lados nunca mais consegue
// entrar em loop por causa disso, mesmo que alguém erre o array de
// dependências de novo no futuro.
import { useEffect, useState } from "react";

export function useRoomCompanyProfile(slug: string | null): { name: string | null; logoUrl: string | null } {
  const [name, setName] = useState<string | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) {
      setName((prev) => (prev === null ? prev : null));
      setLogoUrl((prev) => (prev === null ? prev : null));
      return;
    }
    let cancelled = false;
    fetch(`/api/room/company-profile?slug=${encodeURIComponent(slug)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        setName(data?.profile?.name || null);
        setLogoUrl(data?.profile?.logoUrl || null);
      })
      .catch(() => {
        if (cancelled) return;
        setName(null);
        setLogoUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  return { name, logoUrl };
}
