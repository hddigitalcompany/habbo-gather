"use client";

// "Gerador de cor" -- pedido do Douglas: "cria essa ferramenta por
// seleção" (depois de recusar máscara fixa por coordenada, que "limita
// mt", E redesenhar cada peça em cada quadro à mão, "nao tem ia que me
// da isso sem errar"). Ver conversa no chat + game/colorTint.ts pro
// algoritmo (colorize com deslocamento de luminância, zona escolhida
// por AMOSTRA DE COR pintada, não por coordenada fixa).
//
// Fluxo: abre em cima de um item JÁ cadastrado (cabelo/acessório/traje,
// ver ColorZoneToolButton mais abaixo, usado dentro do
// AvatarCreatorPanel em ItemEditor.tsx) -- pinta zonas em cima do
// quadro de FRENTE/PARADO (quadro 0 da folha 8x2), escolhe o hex alvo
// de cada zona, gera uma prévia, e ao salvar sobe uma folha NOVA
// (recolorida inteira, todos os 15 quadros) pro Storage, virando uma
// entrada em `colors` do item (mesmo formato de ColorOption em
// game/customization.ts) via PATCH /api/avatar-items/[id].
import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { FRAME_W, FRAME_H } from "@/game/MainScene";
import { applyZoneTint, luminance, OUTLINE_LUMINANCE_CUTOFF, type RGB, type ZoneDef } from "@/game/colorTint";
import type { ColorOption } from "@/game/customization";

// mesmo layout de folha (8 colunas, 2 linhas, 2px de espaçamento) de
// SKIN_SHEET_COLS/SKIN_SHEET_SPACING em ItemEditor.tsx -- duplicado de
// propósito (mesmo motivo de avatarAssetUrl logo abaixo: evita import
// cruzado entre os dois arquivos).
const SHEET_COLS = 8;
const SHEET_SPACING = 2;
const SHEET_W = SHEET_COLS * (FRAME_W + SHEET_SPACING) - SHEET_SPACING;
const SHEET_H = 2 * (FRAME_H + SHEET_SPACING) - SHEET_SPACING;

// ampliação do quadro de pintura na tela (200x260 fica pequeno demais
// pra pintar com precisão) -- só afeta a TELA, as amostras são sempre
// lidas na resolução ORIGINAL da imagem.
const PAINT_SCALE = 2.4;
// raio do pincel, em px da imagem ORIGINAL (não da tela).
const BRUSH_RADIUS = 4;
// não guarda uma amostra nova se já tiver uma "parecida" (distância em
// RGB) na mesma zona -- pintar em cima do mesmo lugar várias vezes não
// deveria inflar a lista de amostras sem necessidade (ver
// applyZoneTint em colorTint.ts -- o custo cresce com o total de
// amostras de TODAS as zonas, então manter isso enxuto importa pra
// "Gerar prévia" não travar a tela).
const MIN_SAMPLE_SEPARATION = 14;
// teto baixo de propósito -- "Gerar prévia" roda uma distância contra
// CADA amostra de CADA zona pra CADA pixel da folha inteira (~840mil
// pixels), então o tempo cresce direto com esse total -- 80x4 zonas já
// dá variação de sombra/luz suficiente sem deixar isso lento.
const MAX_SAMPLES_PER_ZONE = 80;

const ZONE_BRUSH_COLORS = ["#ff4d6d", "#3fa9f5", "#ffd23f", "#6bcf63"];
const DEFAULT_TARGET_HEXES = ["#2f6fe0", "#1a1a1a", "#c94f4f", "#2f8f5b"];

function avatarAssetUrl(file: string): string {
  return file.startsWith("http") ? file : `/assets/${file}`;
}

function slugify(text: string): string {
  return (
    text
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "cor"
  );
}

type Zone = {
  key: string;
  label: string;
  targetHex: string;
  brushHex: string;
  samples: RGB[];
  // pontos já pintados (em px da imagem original, frame 0) -- só pra
  // DESENHAR o overlay de novo quando o React re-renderiza, a amostra
  // de cor em si mora em `samples`.
  paintedPoints: { x: number; y: number }[];
};

function addSampleIfNew(zone: Zone, r: number, g: number, b: number) {
  if (zone.samples.length >= MAX_SAMPLES_PER_ZONE) return;
  for (const [sr, sg, sb] of zone.samples) {
    const d = Math.hypot(r - sr, g - sg, b - sb);
    if (d < MIN_SAMPLE_SEPARATION) return;
  }
  zone.samples.push([r, g, b]);
}

export interface AvatarItemForColorTool {
  id: string;
  label: string;
  sheet_url: string;
  colors?: ColorOption[] | null;
}

export default function ColorZoneTool({
  item,
  accessToken,
  onClose,
  onSaved,
}: {
  item: AvatarItemForColorTool;
  accessToken: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [zones, setZones] = useState<Zone[]>([]);
  const [activeZoneKey, setActiveZoneKey] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [previewCounts, setPreviewCounts] = useState<number[] | null>(null);
  const [saveLabel, setSaveLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // canvas ESCONDIDO com a folha inteira original, em resolução real --
  // é daqui que lê tanto as amostras do pincel (recorte do quadro 0)
  // quanto o pixel-a-pixel na hora de gerar a prévia/folha final.
  const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // canvas visível (ampliado por PAINT_SCALE) só do quadro 0, pra
  // pintar em cima -- puramente decorativo (mostra a arte), o pincel
  // lê a cor de baixo no sourceCanvas.
  const paintBgCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // overlay transparente por cima do paintBgCanvas -- só os pontinhos
  // de pintura (feedback visual de "onde já marquei").
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // canvas de prévia (quadro 0 recolorido) -- preenchido ao clicar
  // "Gerar prévia".
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const isPaintingRef = useRef(false);

  const activeZone = zones.find((z) => z.key === activeZoneKey) ?? null;

  // carrega a folha original 1x (crossOrigin: o bucket "room-items" é
  // público, mesma URL que o jogo já usa pra exibir o item -- sem isso
  // o canvas fica "tainted" e getImageData falha).
  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (cancelled) return;
      const canvas = sourceCanvasRef.current;
      if (!canvas) return;
      canvas.width = SHEET_W;
      canvas.height = SHEET_H;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        setLoadError("Navegador sem suporte a canvas 2D.");
        return;
      }
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, SHEET_W, SHEET_H);
      ctx.drawImage(img, 0, 0, SHEET_W, SHEET_H);

      const bg = paintBgCanvasRef.current;
      if (bg) {
        bg.width = FRAME_W * PAINT_SCALE;
        bg.height = FRAME_H * PAINT_SCALE;
        const bgCtx = bg.getContext("2d");
        if (bgCtx) {
          bgCtx.imageSmoothingEnabled = false;
          bgCtx.drawImage(
            canvas,
            0,
            0,
            FRAME_W,
            FRAME_H,
            0,
            0,
            FRAME_W * PAINT_SCALE,
            FRAME_H * PAINT_SCALE
          );
        }
      }
      const overlay = overlayCanvasRef.current;
      if (overlay) {
        overlay.width = FRAME_W * PAINT_SCALE;
        overlay.height = FRAME_H * PAINT_SCALE;
      }
      setReady(true);
    };
    img.onerror = () => {
      if (!cancelled) setLoadError("Não deu pra carregar a arte desse item pra pintar em cima.");
    };
    img.src = avatarAssetUrl(item.sheet_url);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.sheet_url]);

  function addZone() {
    const idx = zones.length;
    const key = `z${Date.now()}${idx}`;
    const zone: Zone = {
      key,
      label: `Zona ${idx + 1}`,
      targetHex: DEFAULT_TARGET_HEXES[idx % DEFAULT_TARGET_HEXES.length],
      brushHex: ZONE_BRUSH_COLORS[idx % ZONE_BRUSH_COLORS.length],
      samples: [],
      paintedPoints: [],
    };
    setZones((prev) => [...prev, zone]);
    setActiveZoneKey(key);
    setPreviewCounts(null);
  }

  function removeZone(key: string) {
    setZones((prev) => prev.filter((z) => z.key !== key));
    setActiveZoneKey((prev) => (prev === key ? null : prev));
    setPreviewCounts(null);
    redrawOverlay(zones.filter((z) => z.key !== key));
  }

  function updateZone(key: string, patch: Partial<Zone>) {
    setZones((prev) => prev.map((z) => (z.key === key ? { ...z, ...patch } : z)));
    setPreviewCounts(null);
  }

  function clearZonePaint(key: string) {
    setZones((prev) => prev.map((z) => (z.key === key ? { ...z, samples: [], paintedPoints: [] } : z)));
    setPreviewCounts(null);
    redrawOverlay(zones.map((z) => (z.key === key ? { ...z, samples: [], paintedPoints: [] } : z)));
  }

  function redrawOverlay(zonesToDraw: Zone[]) {
    const overlay = overlayCanvasRef.current;
    if (!overlay) return;
    const ctx = overlay.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    for (const zone of zonesToDraw) {
      ctx.fillStyle = zone.brushHex;
      for (const p of zone.paintedPoints) {
        ctx.beginPath();
        ctx.arc(p.x * PAINT_SCALE, p.y * PAINT_SCALE, BRUSH_RADIUS * PAINT_SCALE * 0.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function paintAt(imgX: number, imgY: number) {
    if (!activeZone) return;
    const source = sourceCanvasRef.current;
    if (!source) return;
    const ctx = source.getContext("2d");
    if (!ctx) return;
    if (imgX < 0 || imgY < 0 || imgX >= FRAME_W || imgY >= FRAME_H) return;

    const r0 = Math.max(0, Math.floor(imgX - BRUSH_RADIUS));
    const g0 = Math.max(0, Math.floor(imgY - BRUSH_RADIUS));
    const w = Math.min(FRAME_W, Math.ceil(imgX + BRUSH_RADIUS)) - r0;
    const h = Math.min(FRAME_H, Math.ceil(imgY + BRUSH_RADIUS)) - g0;
    if (w <= 0 || h <= 0) return;
    const patch = ctx.getImageData(r0, g0, w, h);
    let touched = false;
    setZones((prev) =>
      prev.map((z) => {
        if (z.key !== activeZone.key) return z;
        const nextZone: Zone = { ...z, samples: [...z.samples], paintedPoints: [...z.paintedPoints, { x: imgX, y: imgY }] };
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const dx = x + r0 - imgX;
            const dy = y + g0 - imgY;
            if (dx * dx + dy * dy > BRUSH_RADIUS * BRUSH_RADIUS) continue;
            const idx = (y * w + x) * 4;
            const a = patch.data[idx + 3];
            if (a < 200) continue; // transparente/borda -- ignora
            const r = patch.data[idx];
            const g = patch.data[idx + 1];
            const b = patch.data[idx + 2];
            if (luminance(r, g, b) < OUTLINE_LUMINANCE_CUTOFF) continue; // contorno -- ignora
            addSampleIfNew(nextZone, r, g, b);
            touched = true;
          }
        }
        return nextZone;
      })
    );
    if (touched) {
      const overlay = overlayCanvasRef.current;
      const octx = overlay?.getContext("2d");
      if (octx && activeZone) {
        octx.fillStyle = activeZone.brushHex;
        octx.beginPath();
        octx.arc(imgX * PAINT_SCALE, imgY * PAINT_SCALE, BRUSH_RADIUS * PAINT_SCALE * 0.6, 0, Math.PI * 2);
        octx.fill();
      }
    }
    setPreviewCounts(null);
  }

  function pointerToImageXY(e: ReactPointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = e.currentTarget.width / rect.width;
    const scaleY = e.currentTarget.height / rect.height;
    const x = ((e.clientX - rect.left) * scaleX) / PAINT_SCALE;
    const y = ((e.clientY - rect.top) * scaleY) / PAINT_SCALE;
    return { x, y };
  }

  function handlePointerDown(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (!activeZone) return;
    e.preventDefault();
    isPaintingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    const { x, y } = pointerToImageXY(e);
    paintAt(x, y);
  }
  function handlePointerMove(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (!isPaintingRef.current || !activeZone) return;
    const { x, y } = pointerToImageXY(e);
    paintAt(x, y);
  }
  function handlePointerUp(e: ReactPointerEvent<HTMLCanvasElement>) {
    isPaintingRef.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }

  function generatePreview() {
    const source = sourceCanvasRef.current;
    const preview = previewCanvasRef.current;
    if (!source || !preview) return;
    const zonesWithSamples = zones.filter((z) => z.samples.length > 0);
    if (zonesWithSamples.length === 0) {
      setSaveError("Pinte pelo menos uma zona antes de gerar a prévia.");
      return;
    }
    setSaveError(null);
    setGenerating(true);
    // setTimeout 0 -- dá um respiro pro React pintar o estado
    // "Gerando..." antes do loop pixel-a-pixel (síncrono, pode levar
    // um instante numa folha grande) travar a thread principal.
    setTimeout(() => {
      const ctx = source.getContext("2d");
      preview.width = FRAME_W * PAINT_SCALE;
      preview.height = FRAME_H * PAINT_SCALE;
      const pctx = preview.getContext("2d");
      if (!ctx || !pctx) {
        setGenerating(false);
        return;
      }
      const fullData = ctx.getImageData(0, 0, SHEET_W, SHEET_H);
      const zoneDefs: ZoneDef[] = zonesWithSamples.map((z) => ({ samples: z.samples, targetHex: z.targetHex }));
      const { zonePixelCounts } = applyZoneTint(fullData, zoneDefs);
      // desenha só o quadro 0 recolorido na prévia (o resto some no
      // resto da folha, mas foi recolorido igual -- ver handleSave).
      const tmp = document.createElement("canvas");
      tmp.width = SHEET_W;
      tmp.height = SHEET_H;
      const tctx = tmp.getContext("2d");
      if (tctx) {
        tctx.putImageData(fullData, 0, 0);
        pctx.imageSmoothingEnabled = false;
        pctx.clearRect(0, 0, preview.width, preview.height);
        pctx.drawImage(tmp, 0, 0, FRAME_W, FRAME_H, 0, 0, preview.width, preview.height);
      }
      // guarda a folha inteira recolorida (fora do state, ImageData não
      // é serializável de forma barata) num atributo do próprio canvas
      // escondido de resultado -- handleSave lê de lá.
      resultSheetDataRef.current = fullData;
      setPreviewCounts(zonePixelCounts);
      setGenerating(false);
    }, 0);
  }

  const resultSheetDataRef = useRef<ImageData | null>(null);

  async function handleSave() {
    const label = saveLabel.trim();
    if (!label) {
      setSaveError("Dá um nome pra essa variante (ex: Azul/Preto).");
      return;
    }
    if (!resultSheetDataRef.current) {
      setSaveError("Gera a prévia antes de salvar.");
      return;
    }
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setSaveError("Supabase não configurado.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const tmp = document.createElement("canvas");
      tmp.width = SHEET_W;
      tmp.height = SHEET_H;
      const tctx = tmp.getContext("2d");
      if (!tctx) throw new Error("erro ao montar a folha final");
      tctx.putImageData(resultSheetDataRef.current, 0, 0);
      const blob: Blob | null = await new Promise((resolve) => tmp.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("erro ao gerar PNG");

      const stamp = Date.now();
      const path = `avatar-items/colors/${item.id}-${slugify(label)}-${stamp}.png`;
      const { error: uploadError } = await supabase.storage
        .from("room-items")
        .upload(path, blob, { upsert: false, contentType: "image/png" });
      if (uploadError) throw uploadError;
      const { data: urlData } = supabase.storage.from("room-items").getPublicUrl(path);

      const primaryZone = zones.find((z) => z.samples.length > 0);
      const newColor: ColorOption = {
        id: crypto.randomUUID(),
        label,
        file: urlData.publicUrl,
        hex: primaryZone?.targetHex,
      };
      const nextColors = [...(item.colors ?? []), newColor];

      const res = await fetch(`/api/avatar-items/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ colors: nextColors }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "erro ao salvar variante de cor");

      setSaveLabel("");
      onSaved();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "erro ao salvar variante de cor");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="color-zone-tool">
      <div className="color-zone-tool-header">
        <h4>Gerar cor -- {item.label}</h4>
        <button type="button" onClick={onClose}>
          Fechar
        </button>
      </div>
      <p className="color-zone-tool-help">
        Pinte por cima do desenho marcando cada parte que vai virar uma cor (ex: uma zona pra camisa, outra pra
        calça). Não precisa acertar a borda certinha -- o sistema acha o resto pela cor. Pixel bem escuro (contorno)
        nunca é tocado.
      </p>
      {loadError && <p className="color-zone-tool-error">{loadError}</p>}

      <div className="color-zone-tool-body">
        <div className="color-zone-tool-paint-col">
          <div
            className="color-zone-tool-canvas-stack"
            style={{ width: FRAME_W * PAINT_SCALE, height: FRAME_H * PAINT_SCALE }}
          >
            <canvas ref={paintBgCanvasRef} className="color-zone-tool-bg-canvas" />
            <canvas
              ref={overlayCanvasRef}
              className="color-zone-tool-overlay-canvas"
              style={{ cursor: activeZone ? "crosshair" : "not-allowed" }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
            />
          </div>
          {!ready && !loadError && <p className="color-zone-tool-loading">Carregando arte...</p>}
        </div>

        <div className="color-zone-tool-zones-col">
          <div className="color-zone-tool-zones-list">
            {zones.map((zone) => (
              <div
                key={zone.key}
                className={zone.key === activeZoneKey ? "color-zone-row color-zone-row-active" : "color-zone-row"}
                onClick={() => setActiveZoneKey(zone.key)}
              >
                <span className="color-zone-brush-dot" style={{ background: zone.brushHex }} />
                <input
                  className="color-zone-label-input"
                  value={zone.label}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => updateZone(zone.key, { label: e.target.value })}
                />
                <input
                  type="color"
                  value={zone.targetHex}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => updateZone(zone.key, { targetHex: e.target.value })}
                  title="Cor alvo dessa zona"
                />
                <span className="color-zone-sample-count">{zone.samples.length}px amostrado</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    clearZonePaint(zone.key);
                  }}
                >
                  Limpar pintura
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeZone(zone.key);
                  }}
                >
                  Remover zona
                </button>
              </div>
            ))}
          </div>
          <button type="button" className="color-zone-add-btn" onClick={addZone} disabled={zones.length >= 4}>
            + Nova zona
          </button>

          <div className="color-zone-tool-actions">
            <button type="button" onClick={generatePreview} disabled={!ready || generating}>
              {generating ? "Gerando..." : "Gerar prévia"}
            </button>
          </div>

          {previewCounts && (
            <div className="color-zone-tool-preview">
              <canvas
                ref={previewCanvasRef}
                className="color-zone-tool-preview-canvas"
                style={{ width: FRAME_W * PAINT_SCALE * 0.6, height: FRAME_H * PAINT_SCALE * 0.6 }}
              />
              <ul className="color-zone-tool-counts">
                {zones
                  .filter((z) => z.samples.length > 0)
                  .map((z, i) => (
                    <li key={z.key}>
                      {z.label}: {previewCounts[i] ?? 0}px recoloridos
                    </li>
                  ))}
              </ul>
            </div>
          )}

          <div className="color-zone-tool-save">
            <input
              placeholder="Nome da variante (ex: Azul/Preto)"
              value={saveLabel}
              onChange={(e) => setSaveLabel(e.target.value)}
            />
            <button type="button" onClick={handleSave} disabled={saving || !previewCounts}>
              {saving ? "Salvando..." : "Salvar variante de cor"}
            </button>
          </div>
          {saveError && <p className="color-zone-tool-error">{saveError}</p>}

          {item.colors && item.colors.length > 0 && (
            <div className="color-zone-tool-existing">
              <span>Já cadastradas:</span>
              {item.colors.map((c) => (
                <span key={c.id} className="skin-swatch" style={{ background: c.hex ?? "#8a7ca8" }} title={c.label} />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* fora de tela -- só pra manipular pixels, nunca aparece direto. */}
      <canvas ref={sourceCanvasRef} style={{ display: "none" }} />
    </div>
  );
}
