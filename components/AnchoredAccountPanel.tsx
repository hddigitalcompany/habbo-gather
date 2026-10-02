"use client";

// Wrapper compartilhado pelos 3 painéis "ancorados" no canto do
// AccountCard (Meu perfil público -- ProfileViewCard modo `anchored`,
// Dados da conta -- AccountDataPanel, Selo de verificação --
// VerificationPanel). Antes cada um tinha sua PRÓPRIA cópia solta do
// mesmo par .account-card-anchor-backdrop/.account-card-anchor (ver
// app/globals.css), 3 implementações soltas do mesmo recurso --
// contra a regra de "um motor só" do projeto.
//
// BUG 1 (achado com o Douglas, 2/out, via log temporário): o fundo
// transparente que fecha "ao clicar fora" fechava SOZINHO, na hora,
// pelo MESMO clique que abriu o painel -- o botão do menu que chama
// openPanel() mora dentro do dropdown .lobby-account-card, que é
// removido do DOM na MESMA atualização de estado que monta esse
// backdrop. Fix: só liga o onClick do fundo depois de passar 1 frame
// da montagem (requestAnimationFrame).
//
// BUG 2, o de verdade por trás de "não abre" (achado depois, com o
// Douglas inspecionando o DOM ao vivo -- Computed mostrou
// top:1005px!): .account-card-anchor (o card) estava DENTRO de
// .account-card-anchor-backdrop (o fundo, position:fixed cobrindo a
// tela inteira) em vez de IRMÃO dele. position:absolute usa o
// ANCESTRAL POSICIONADO mais PRÓXIMO como régua -- com o card dentro
// do fundo, essa régua virava o FUNDO (tela inteira), não o
// balãozinho pequeno da conta (.lobby-topbar-account-wrap,
// position:relative, seria a régua certa) -- "top: calc(100% + 10px)"
// saía calculado como "100% da ALTURA DA TELA + 10px", jogando o card
// bem abaixo da área visível (que tem overflow:hidden, nunca dava pra
// rolar até lá). Ficava ESCONDIDO essa conta errada dentro do Lobby
// por coincidência: lá o fundo tem OUTRO bug (containing-block do
// position:fixed preso pelo backdrop-filter de .lobby-topbar) que
// encolhe o próprio fundo pro tamanho da barra do topo -- por acaso
// isso fazia a conta "100%" dar perto do topo de novo. Dentro do jogo
// (.room-account-card-pin, sem esse backdrop-filter) o fundo cobre a
// tela de verdade, e o cálculo errado parava de ser mascarado.
//
// Fix: fundo e card viram IRMÃOS (mesma estrutura que o dropdown
// .lobby-account-card-backdrop/.lobby-account-card, que sempre
// funcionou certo) -- o card volta a usar .lobby-topbar-account-wrap
// como régua de posição, igual o comentário original em
// app/globals.css sempre descreveu que deveria ser.
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
    <>
      <div
        className="account-card-anchor-backdrop"
        onClick={() => {
          if (readyRef.current) onClose();
        }}
      />
      <div className="account-card-anchor">{children}</div>
    </>
  );
}
