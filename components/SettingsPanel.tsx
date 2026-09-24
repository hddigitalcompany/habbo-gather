"use client";

// Painel de "Configurações" (ícone de engrenagem na barra de baixo, ver
// av-bar em GameRoom.tsx) -- pedido do Douglas: um lugar só pra pessoa
// ajustar áudio/vídeo (de onde puxa o microfone/câmera, pra onde vai o
// som), volume de cada colega e "som do espaço" (volume geral), mais
// assinatura/idioma/atalhos. Reaproveita o mesmo visual dos outros
// painéis flutuantes (.items-panel-*, ver ItemEditor.tsx) -- só troca
// pra .settings-panel (mais largo, tem mais coisa aqui dentro).
//
// A troca de aparelho em si (getUserMedia de novo + replaceTrack nos
// peers já conectados) mora em GameRoom.tsx (switchMicDevice/
// switchCamDevice/switchSpeakerDevice) -- esse componente só LISTA os
// dispositivos (navigator.mediaDevices.enumerateDevices) e chama de
// volta o que a pessoa escolheu.
import { useEffect, useState } from "react";

type DeviceOption = { deviceId: string; label: string };

type RemoteUser = { id: string; name: string };

// setSinkId (escolher saída de áudio) só existe em navegadores
// baseados em Chromium -- Safari/Firefox não implementam. Confere no
// protótipo em vez de assumir, pra não sumir a seção inteira à toa nem
// mostrar uma opção que não vai funcionar.
function supportsAudioOutputSelection(): boolean {
  if (typeof window === "undefined" || typeof HTMLMediaElement === "undefined") return false;
  return typeof (HTMLMediaElement.prototype as unknown as { setSinkId?: unknown }).setSinkId === "function";
}

export default function SettingsPanel({
  onClose,
  micOn,
  camOn,
  selectedMicId,
  selectedCamId,
  selectedSpeakerId,
  onSelectMic,
  onSelectCam,
  onSelectSpeaker,
  spaceVolume,
  onChangeSpaceVolume,
  remoteUsers,
  remoteVolumes,
  onChangeRemoteVolume,
}: {
  onClose: () => void;
  micOn: boolean;
  camOn: boolean;
  selectedMicId: string;
  selectedCamId: string;
  selectedSpeakerId: string;
  onSelectMic: (deviceId: string) => void;
  onSelectCam: (deviceId: string) => void;
  onSelectSpeaker: (deviceId: string) => void;
  spaceVolume: number;
  onChangeSpaceVolume: (volume: number) => void;
  remoteUsers: RemoteUser[];
  remoteVolumes: Record<string, number>;
  onChangeRemoteVolume: (id: string, volume: number) => void;
}) {
  const [mics, setMics] = useState<DeviceOption[]>([]);
  const [cams, setCams] = useState<DeviceOption[]>([]);
  const [speakers, setSpeakers] = useState<DeviceOption[]>([]);
  const canPickSpeaker = supportsAudioOutputSelection();

  useEffect(() => {
    let cancelled = false;
    async function loadDevices() {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      try {
        const list = await navigator.mediaDevices.enumerateDevices();
        if (cancelled) return;
        // sem permissão CONCEDIDA ainda, o navegador esconde o label de
        // verdade (vem "" -- só o deviceId aparece) -- como a sala já
        // pede câmera/mic assim que abre (ver requestMedia em
        // GameRoom.tsx), na prática isso só acontece se a pessoa negou.
        setMics(
          list
            .filter((d) => d.kind === "audioinput")
            .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microfone ${i + 1}` }))
        );
        setCams(
          list
            .filter((d) => d.kind === "videoinput")
            .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Câmera ${i + 1}` }))
        );
        setSpeakers(
          list
            .filter((d) => d.kind === "audiooutput")
            .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Saída ${i + 1}` }))
        );
      } catch (e) {
        console.warn("Não deu pra listar os dispositivos de áudio/vídeo", e);
      }
    }
    loadDevices();
    // plugou/desplugou um fone ou webcam com o painel já aberto --
    // atualiza a lista sozinho, sem precisar fechar e abrir de novo.
    navigator.mediaDevices?.addEventListener?.("devicechange", loadDevices);
    return () => {
      cancelled = true;
      navigator.mediaDevices?.removeEventListener?.("devicechange", loadDevices);
    };
  }, []);

  return (
    <div className="items-panel-backdrop" onClick={onClose}>
      <div className="items-panel settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="items-panel-header">
          <h2>Configurações</h2>
          <button type="button" className="items-panel-close" onClick={onClose} title="Fechar">
            ✕
          </button>
        </div>

        <section className="items-panel-section">
          <h3>Áudio e vídeo</h3>

          <label className="settings-field">
            <span>Microfone {!micOn && "(desligado)"}</span>
            <select
              className="items-panel-input"
              value={selectedMicId}
              onChange={(e) => onSelectMic(e.target.value)}
            >
              <option value="" disabled>
                {mics.length ? "Escolher microfone..." : "Nenhum microfone encontrado"}
              </option>
              {mics.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>

          <label className="settings-field">
            <span>Câmera {!camOn && "(desligada)"}</span>
            <select
              className="items-panel-input"
              value={selectedCamId}
              onChange={(e) => onSelectCam(e.target.value)}
            >
              <option value="" disabled>
                {cams.length ? "Escolher câmera..." : "Nenhuma câmera encontrada"}
              </option>
              {cams.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>

          {canPickSpeaker ? (
            <label className="settings-field">
              <span>Saída de áudio (onde o som sai)</span>
              <select
                className="items-panel-input"
                value={selectedSpeakerId}
                onChange={(e) => onSelectSpeaker(e.target.value)}
              >
                <option value="">Padrão do sistema</option>
                {speakers.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="settings-hint">Seu navegador não deixa escolher a saída de áudio (fone/caixa) por aqui.</p>
          )}
        </section>

        <section className="items-panel-section">
          <h3>Volume</h3>

          <div className="settings-slider-row">
            <span>Som do espaço</span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(spaceVolume * 100)}
              onChange={(e) => onChangeSpaceVolume(Number(e.target.value) / 100)}
            />
            <span className="settings-slider-value">{Math.round(spaceVolume * 100)}%</span>
          </div>

          {remoteUsers.length === 0 ? (
            <p className="settings-hint">Ninguém por perto agora pra ajustar o volume de cada pessoa.</p>
          ) : (
            remoteUsers.map((user) => {
              const value = remoteVolumes[user.id] ?? 1;
              return (
                <div className="settings-slider-row" key={user.id}>
                  <span className="settings-slider-name">{user.name}</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(value * 100)}
                    onChange={(e) => onChangeRemoteVolume(user.id, Number(e.target.value) / 100)}
                  />
                  <span className="settings-slider-value">{Math.round(value * 100)}%</span>
                </div>
              );
            })
          )}
        </section>

        <section className="items-panel-section">
          <h3>Assinatura</h3>
          <p className="settings-hint">Essa sala ainda não tem um plano pago configurado -- gerenciar assinatura por aqui deve chegar numa próxima atualização.</p>
        </section>

        <section className="items-panel-section">
          <h3>Idioma</h3>
          <select className="items-panel-input" value="pt-BR" disabled>
            <option value="pt-BR">Português (Brasil)</option>
          </select>
          <p className="settings-hint">Mais idiomas em breve.</p>
        </section>

        <section className="items-panel-section">
          <h3>Atalhos do teclado</h3>
          <ul className="settings-shortcut-list">
            <li>
              <span>Mover o boneco</span>
              <span className="settings-shortcut-keys">WASD ou setas</span>
            </li>
            <li>
              <span>Zoom no mapa</span>
              <span className="settings-shortcut-keys">Roda do mouse / dois dedos no trackpad</span>
            </li>
            <li>
              <span>Ajuste fino do assento (editor)</span>
              <span className="settings-shortcut-keys">Setas -- com Shift, passo maior</span>
            </li>
            <li>
              <span>Enviar mensagem no chat</span>
              <span className="settings-shortcut-keys">Enter</span>
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
}
