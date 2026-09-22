import type { Metadata } from "next";
import "./globals.css";

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
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
