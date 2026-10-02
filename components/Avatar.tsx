"use client";

// Avatar -- UMA implementação só pra "foto de perfil, com fallback pra
// inicial do nome" (pedido do Douglas, 2/out, depois de ver o ícone de
// imagem quebrada no lugar da foto: "A foto de perfil ta corrompida").
// Esse padrão ({photoUrl ? <img/> : inicial}) tava copiado em 6 lugares
// diferentes (ChatDrawer.tsx, FriendsPanel.tsx, ProfileViewCard.tsx,
// AccountCard.tsx) -- nenhum deles tratava a foto FALHAR AO CARREGAR
// (URL quebrada/apagada/arquivo corrompido de verdade): o <img> sem
// `onError` simplesmente mostra o ícone de imagem quebrada do próprio
// navegador em vez de cair pra inicial, que é o bug que apareceu.
//
// Esse componente faz as duas coisas de uma vez: UMA implementação
// (reusada em todo canto, nunca mais copiada) e com fallback de
// verdade pra quando a imagem existe mas não carrega, não só quando
// `photoUrl` tá vazio.
import { useEffect, useState } from "react";

export function Avatar({
  photoUrl,
  name,
  background,
  className,
}: {
  photoUrl?: string | null;
  name?: string | null;
  background?: string;
  className: string;
}) {
  const [failed, setFailed] = useState(false);
  // reseta o "falhou" se a FOTO mudar (mesmo <Avatar/> reaproveitado
  // pra pessoa diferente, ex: ProfileViewCard trocando de perfil sem
  // desmontar) -- senão uma foto quebrada de alguém deixava a inicial
  // travada mesmo depois de trocar pra alguém com foto válida.
  useEffect(() => {
    setFailed(false);
  }, [photoUrl]);

  const initial = (name || "?").trim().charAt(0).toUpperCase() || "?";
  const showImage = !!photoUrl && !failed;

  return (
    <span className={className} style={background ? { background } : undefined}>
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={photoUrl as string} alt="" onError={() => setFailed(true)} />
      ) : (
        initial
      )}
    </span>
  );
}
