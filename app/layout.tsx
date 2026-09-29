import type { Metadata } from "next";
import { Raleway } from "next/font/google";
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
    <html lang="pt-BR" className={raleway.variable}>
      <body>{children}</body>
    </html>
  );
}
