// Página de Política de Privacidade -- pedido do Douglas (29/set): o
// Google Cloud (Branding do OAuth) passou a EXIGIR um link de política
// de privacidade pública pra liberar salvar/criar o cliente OAuth do
// login com Google (ver conversa sobre "Domínio do app" travando sem
// URL nenhuma preenchida). Página estática simples, sem "use client"
// (não precisa de estado nenhum), fora do game/lobby de propósito --
// só precisa existir e ser pública, não faz parte do fluxo do produto.
//
// Conteúdo descreve o que o app REALMENTE coleta hoje (ver
// components/AuthGate.tsx -- email/senha ou Google; components/
// Lobby.tsx/GameRoom.tsx -- nome/status/instagram/bio/foto de perfil;
// câmera/mic pra vídeo por proximidade; mensagens de chat e
// compromissos de agenda, tudo via Supabase) -- não é um texto
// jurídico genérico copiado de algum lugar, mas também não é
// aconselhamento jurídico de verdade (ver aviso no rodapé da página).
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Política de Privacidade — X Tower",
  description: "Como o X Tower coleta, usa e guarda os dados de quem usa o app.",
};

export default function PrivacidadePage() {
  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#14101f",
        color: "#f5f0ff",
        padding: "48px 20px",
        display: "flex",
        justifyContent: "center",
      }}
    >
      <div style={{ maxWidth: 640, width: "100%" }}>
        <h1 style={{ fontSize: 26, fontWeight: 700, marginBottom: 4 }}>Política de Privacidade</h1>
        <p style={{ color: "#9d91c2", fontSize: 13, marginBottom: 32 }}>X Tower · última atualização: 29/09/2026</p>

        <Section title="O que é o X Tower">
          <p>
            O X Tower é um espaço virtual (sala estilo Habbo, com vídeo e áudio por proximidade) onde você pode
            entrar com uma conta, personalizar seu avatar/perfil e interagir com outras pessoas em tempo real.
          </p>
        </Section>

        <Section title="Quais dados a gente coleta">
          <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
            <li>
              <strong>Conta:</strong> email e senha, ou, se você entrar com o Google, o nome e email associados à
              sua conta Google (a gente nunca vê sua senha do Google, nem posta nada em seu nome lá).
            </li>
            <li>
              <strong>Perfil:</strong> nome de exibição, status, Instagram e bio, se você preencher -- tudo
              opcional além do nome.
            </li>
            <li>
              <strong>Câmera e microfone:</strong> usados só pra chamada de vídeo/áudio por proximidade dentro da
              sala, com sua permissão do navegador -- a gente não grava nem guarda esse vídeo/áudio em servidor
              nenhum.
            </li>
            <li>
              <strong>Uso dentro da sala:</strong> mensagens de chat, compromissos de agenda e presença (quem tá
              online), pra fazer essas funções funcionarem.
            </li>
          </ul>
        </Section>

        <Section title="Como a gente usa esses dados">
          <p>
            Só pra fazer o app funcionar: te autenticar, mostrar seu perfil/avatar pros outros na sala, entregar
            suas mensagens e compromissos, e lembrar suas preferências (como microfone/câmera selecionados). A
            gente não vende nem compartilha seus dados com terceiros pra publicidade.
          </p>
        </Section>

        <Section title="Onde os dados ficam guardados">
          <p>
            Num banco de dados Supabase (com controle de acesso -- Row Level Security -- e protegido por senha de
            serviço, sem acesso público direto às tabelas).
          </p>
        </Section>

        <Section title="Seus direitos">
          <p>
            Você pode pedir pra ver, corrigir ou apagar seus dados (incluindo excluir sua conta) escrevendo pra
            gente em <a style={{ color: "#9fb4ff" }} href="mailto:hd.digitalsuporte2@gmail.com">hd.digitalsuporte2@gmail.com</a>.
          </p>
        </Section>

        <p style={{ color: "#8b7fae", fontSize: 12, marginTop: 40, lineHeight: 1.6 }}>
          Este texto é uma descrição simples e direta das nossas práticas, não uma peça jurídica revisada por
          advogado -- se seu uso do app crescer ou envolver dados mais sensíveis, vale ter um profissional
          revisando essa política.
        </p>
      </div>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 8, color: "#f5f0ff" }}>{title}</h2>
      <div style={{ color: "#cfc4e6", fontSize: 14, lineHeight: 1.6 }}>{children}</div>
    </section>
  );
}
