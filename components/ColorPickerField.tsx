"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

/**
 * Color picker próprio (quadrado de saturação/brilho + barra de matiz +
 * campo hex com conta-gotas), no lugar do seletor NATIVO do sistema
 * (<input type="color">, que abre uma janela do macOS/Chrome fora do
 * controle visual do app). Pedido do Douglas: mandou print de um color
 * picker (abas "Cor sólida"/"Gradiente", quadrado de cor, barra
 * arco-íris embaixo, campo hex com ícone de conta-gotas) com "quero
 * escolher as cores assim". Só a parte "Cor sólida" foi implementada --
 * o app só usa cor sólida em cada campo hoje (piso "padrão" alterna
 * ENTRE cores sólidas da lista, não tem conceito de gradiente na cor de
 * uma tábua só), então a aba "Gradiente" do print não tem pra onde
 * mapear ainda e ficaria morta na tela.
 *
 * Usado nos campos "Cor da linha de junta"/"Cor 1..6" (Criar Piso) e no
 * campo "Cor do botão" do Avatar -- ver ItemEditor.tsx.
 */
export function ColorPickerField({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (hex: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [hexText, setHexText] = useState(value);
  const [hsv, setHsv] = useState(() => hexToHsv(value));
  const svRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);

  // valor mudou por fora (ex.: clicou num tom pré-pronto) -- resincroniza
  useEffect(() => {
    setHsv(hexToHsv(value));
    setHexText(value);
  }, [value]);

  function commit(patch: Partial<{ h: number; s: number; v: number }>) {
    const merged = { ...hsv, ...patch };
    setHsv(merged);
    const newHex = hsvToHex(merged.h, merged.s, merged.v);
    setHexText(newHex);
    onChange(newHex);
  }

  function handleSvDown(e: ReactPointerEvent<HTMLDivElement>) {
    const rect = svRef.current!.getBoundingClientRect();
    const move = (clientX: number, clientY: number) => {
      const x = Math.min(Math.max(clientX - rect.left, 0), rect.width);
      const y = Math.min(Math.max(clientY - rect.top, 0), rect.height);
      commit({ s: x / rect.width, v: 1 - y / rect.height });
    };
    move(e.clientX, e.clientY);
    const onMove = (ev: globalThis.PointerEvent) => move(ev.clientX, ev.clientY);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function handleHueDown(e: ReactPointerEvent<HTMLDivElement>) {
    const rect = hueRef.current!.getBoundingClientRect();
    const move = (clientX: number) => {
      const x = Math.min(Math.max(clientX - rect.left, 0), rect.width);
      commit({ h: (x / rect.width) * 360 });
    };
    move(e.clientX);
    const onMove = (ev: globalThis.PointerEvent) => move(ev.clientX);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function handleHexInput(raw: string) {
    setHexText(raw);
    const normalized = raw.startsWith("#") ? raw : `#${raw}`;
    if (/^#[0-9a-fA-F]{6}$/.test(normalized)) {
      setHsv(hexToHsv(normalized));
      onChange(normalized);
    }
  }

  async function handleEyedropper() {
    try {
      const EyeDropperCtor = (window as unknown as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
      if (!EyeDropperCtor) return;
      const result = await new EyeDropperCtor().open();
      handleHexInput(result.sRGBHex);
    } catch {
      // usuário cancelou (Esc) -- ignora
    }
  }

  const previewHex = hsvToHex(hsv.h, hsv.s, hsv.v);
  const hueColor = `hsl(${hsv.h}, 100%, 50%)`;
  const supportsEyedropper = typeof window !== "undefined" && "EyeDropper" in window;

  return (
    <div className={className ? `color-field ${className}` : "color-field"}>
      <button
        type="button"
        className="color-field-trigger"
        style={{ background: previewHex }}
        onClick={() => setOpen((o) => !o)}
        aria-label="Escolher cor"
      />
      {open && (
        <>
          <div className="color-field-backdrop" onClick={() => setOpen(false)} />
          <div className="color-field-popover">
            <div className="color-field-title">Cor sólida</div>
            <div ref={svRef} className="color-field-sv" style={{ background: hueColor }} onPointerDown={handleSvDown}>
              <div className="color-field-sv-white" />
              <div className="color-field-sv-black" />
              <div
                className="color-field-sv-handle"
                style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }}
              />
            </div>
            <div ref={hueRef} className="color-field-hue" onPointerDown={handleHueDown}>
              <div className="color-field-hue-handle" style={{ left: `${(hsv.h / 360) * 100}%` }} />
            </div>
            <div className="color-field-hex-row">
              <span className="color-field-hex-swatch" style={{ background: previewHex }} />
              <input
                className="color-field-hex-input"
                type="text"
                value={hexText}
                maxLength={7}
                onChange={(e) => handleHexInput(e.target.value)}
              />
              {supportsEyedropper && (
                <button type="button" className="color-field-eyedropper" onClick={handleEyedropper} title="Conta-gotas">
                  🎨
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const clean = hex.replace("#", "").padEnd(6, "0");
  const r = parseInt(clean.substring(0, 2), 16) / 255;
  const g = parseInt(clean.substring(2, 4), 16) / 255;
  const b = parseInt(clean.substring(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  const v = max;
  return { h, s, v };
}

function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const toHex = (n: number) =>
    Math.round((n + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
