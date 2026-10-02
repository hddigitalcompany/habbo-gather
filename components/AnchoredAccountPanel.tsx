"use client";

// Wrapper compartilhado pelos 3 painéis "ancorados" no canto do
// AccountCard (Meu perfil público -- ProfileViewCard modo `anchored`,
// Dados da conta -- AccountDataPanel, Selo de verificação --
// VerificationPanel). Antes cada um tinha sua PRÓPRIA cópia solta do
// mesmo par .account-card-anchor-backdrop/.account-card-anchor (ver
// app/globals.css), 3 implementações soltas do mesmo recurso --
// contra a regra de "um motor só" do projeto, e com exatamente o
// MESMO bug nos 3: o fundo transparente que fecha "ao clicar fora"
// fechava SOZINHO, na hora, pelo MESMO clique que abriu o painel.
//
// Causa (achada com o Douglas, 2/out, via log temporário em
// AccountCard.tsx): o botão do menu que chama openPanel() mora DENTRO
// do dropdown .lobby-account-card, que é removido do DOM na MESMA
// atualização de estado que monta esse backdrop (cardOpen vira false
// junto com panel virando "profile"/"account"/"verification") --
// console confirmou "onClose chamado" disparando sozinho, sem nenhum
// clique novo do Douglas, logo depois de "openPanel ->". O elemento
// que originou o clique sumindo do DOM no mesmo instante em que esse
// backdrop nasce deixa margem pro clique "vazar" pro onClick dele.
//
// Fix: só liga o onClick do fundo depois de passar 1 frame da
// montagem (requestAnimationFrame) -- qualquer resquício do clique
// que abriu o painel já terminou de se propagar bem antes disso, então
// um clique de verdade (fora do card, depois do painel já aberto)
// continua fechando normal.
import { useEffect, useRef } from "react";

export default function AnchoredAccountPanel({
  onClose,
  children,
}: {
  onClose: () => void;
  children: React.ReactNode;
}) {
  const readyRef = useRef(false);

  useEffect(() => {
    readyRef.current = false;
    const raf = requestAnimationFrame(() => {
      readyRef.current = true;
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      className="account-card-anchor-backdrop"
      onClick={() => {
        if (readyRef.current) onClose();
      }}
    >
      <div className="account-card-anchor">{children}</div>
    </div>
  );
}
