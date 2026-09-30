import type { Metadata } from "next";
import { Raleway, Anton } from "next/font/google";
import "./globals.css";

// fonte da logo "X Tower" (pedido do Douglas, 29/set: "a fonte é:
// Raleway", junto com a logo em si -- ver .lobby-topbar-logo-text em
// app/globals.css e o <img>+texto em components/Lobby.tsx, que
// substituiu o "Habbo-gather" de texto puro que tinha ali antes).
// next/font baixa e otimiza a fonte em build time (sem "flash" de
// fonte errada) e expõe como variável CSS -- só essa var some usada
// no lugar certo, o resto do site continua na fonte de sempre.
const raleway = Raleway({
  subsets: ["latin"],
  weight: ["700", "800"],
  variable: "--font-raleway",
});

// fonte da "Tagline" da empresa -- pedido do Douglas, 30/set (18):
// "a fonte da tagline nao foi a mesma que mandei na foto" -- o print
// de referência usa uma fonte de impacto (caixa alta, super
// condensada/preta, tipo cartaz), bem diferente da Raleway do resto
// do site. Anton (Google Fonts) é exatamente esse estilo -- só ela
// muda, o resto do site continua igual (mesmo padrão da raleway
// acima, variável CSS à parte).
const anton = Anton({
  subsets: ["latin"],
  weight: ["400"],
  variable: "--font-tagline",
});

export const metadata: Metadata = {
  title: "Sala Virtual — Protótipo",
  description:
    "Protótipo de espaço virtual estilo Habbo com vídeo por proximidade (inspirado no Gather)",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR" className={`${raleway.variable} ${anton.variable}`}>
      <body>{children}</body>
    </html>
  );
}
