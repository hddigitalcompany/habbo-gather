"use client";

// "Gerador de cor" pra MÓVEL -- pedido do Douglas: "adiciona a edicao de
// cores nos mobis tambe, quero testar" (mesmo pedido que já tinha feito
// pro avatar, ver ColorZoneTool.tsx -- essa aqui é a versão adaptada pra
// item de móvel custom do Editor de Itens). MESMO algoritmo (colorize
// por zona escolhida por AMOSTRA DE COR pintada, ver game/colorTint.ts),
// só que adaptado pro formato de móvel: em vez de 1 folha só (spritesheet
// 8x2 fixo do avatar), um móvel tem até 4 FOTOS SEPARADAS, uma por
// direção (down/left/right/up -- só "down" é obrigatória, ver
// FurnitureModelColorOption em game/furniture.ts), cada uma no seu
// próprio tamanho nativo (a arte de móvel custom sobe na resolução
// original, sem grade fixa -- ver CustomItemRow/DIRECTION_FIELDS em
// ItemEditor.tsx).
//
// Pinta as zonas em cima da foto de FRENTE (down) só -- applyZoneTint
// classifica por COR de amostra, não por posição/tamanho, então dá pra
// aplicar o MESMO conjunto de zonas em cada foto de direção
// separadamente na hora de salvar (ver handleSave), mesmo elas tendo
// tamanhos/proporções diferentes uma da outra.
//
// Fluxo idêntico ao do avatar: pinta, escolhe cor alvo por zona, gera
// prévia (só da frente), salva -- sobe uma foto NOVA recolorida pra cada
// direção que o item já tem, e isso tudo vira uma entrada em `colors` do
// registro original (mesmo formato de FurnitureModelColorOption) via
// PATCH /api/items/[id].
import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { applyZoneTint, luminance, OUTLINE_LUMINANCE_CUTOFF, type RGB, type ZoneDef } from "@/game/colorTint";
import type { FurnitureModelColorOption } from "@/game/furniture";

type DirectionKey = "down" | "left" | "right" | "up";
const DIRECTIONS: DirectionKey[] = ["down", "left", "right", "up"];
const DIRECTION_LABELS: Record<DirectionKey, string> = {
  down: "Frente esquerda",
  left: "Costas esquerda",
  right: "Frente direita",
  up: "Costas direita",
};

// alvo de largura EXIBIDA (px na tela) pro quadro de pintura -- diferente
// do avatar (FRAME_W/H fixo, sempre 200x260), a arte de móvel custom vem
// em QUALQUER resolução nativa, então a escala de exibição é calculada
// em cima do tamanho real da foto de frente (ver onload abaixo), não uma
// constante fixa.
const PAINT_DISPLAY_TARGET = 340;
const PAINT_SCALE_MIN = 0.4;
const PAINT_SCALE_MAX = 5;
// raio do pincel, em % da menor dimensão da imagem -- mesma ideia do
// BRUSH_RADIUS fixo (4px) do avatar, só que proporcional: a arte de
// móvel custom varia demais de tamanho pra um raio fixo em px fazer
// sentido nos dois extremos (peça pequena tipo planta x peça grande tipo
// sofá).
const BRUSH_RADIUS_RATIO = 0.02;
const BRUSH_RADIUS_MIN = 3;
const BRUSH_RADIUS_MAX = 14;
const MIN_SAMPLE_SEPARATION = 14;
const MAX_SAMPLES_PER_ZONE = 80;

const ZONE_BRUSH_COLORS = ["#ff4d6d", "#3fa9f5", "#ffd23f", "#6bcf63"];
const DEFAULT_TARGET_HEXES = ["#2f6fe0", "#1a1a1a", "#c94f4f", "#2f8f5b"];

// mesma paleta de quadradinhos do ColorZoneTool.tsx (avatar) -- pedido do
// Douglas era geral ("quero todas elas em quadradinho"), não só pro
// avatar, então usa a mesma lista pra manter a MESMA escolha de cor nos
// dois lugares (duplicada de propósito, mesmo motivo de sempre: evita
// import cruzado entre os dois componentes).
const PALETTE_SWATCHES: string[] = [
  "#000000", "#1a1a1a", "#333333", "#4d4d4d", "#666666", "#808080", "#999999", "#b3b3b3", "#cccccc", "#e6e6e6", "#f5f5f5", "#ffffff",
  "#7f0000", "#a30000", "#c62828", "#e53935", "#ef5350", "#ff8a80", "#ff5252", "#d32f2f", "#b71c1c", "#8e0000",
  "#7f3f00", "#a35c00", "#e65100", "#f57c00", "#fb8c00", "#ffa726", "#ffb74d", "#ffcc80", "#ff9800", "#e67e22",
  "#7f6f00", "#a38b00", "#f9a825", "#fbc02d", "#fdd835", "#ffeb3b", "#fff176", "#fff9c4", "#c9a227", "#d4af37",
  "#8f8a5c", "#9c9464", "#bdb76b", "#a9a482", "#c9c299", "#d6cfa1",
  "#0b3d0b", "#1b5e20", "#2e7d32", "#388e3c", "#43a047", "#66bb6a", "#81c784", "#a5d6a7", "#33691e", "#558b2f",
  "#004d40", "#00695c", "#00796b", "#00897b", "#26a69a", "#4db6ac", "#80cbc4", "#b2dfdb",
  "#0d47a1", "#1565c0", "#1976d2", "#1e88e5", "#2196f3", "#42a5f5", "#64b5f6", "#90caf9", "#0b2545", "#274690",
  "#4a148c", "#6a1b9a", "#7b1fa2", "#8e24aa", "#9c27b0", "#ab47bc", "#ba68c8", "#ce93d8",
  "#880e4f", "#ad1457", "#c2185b", "#d81b60", "#e91e63", "#ec407a", "#f06292", "#f8bbd0",
  "#3e2723", "#4e342e", "#5d4037", "#6d4c41", "#795548", "#8d6e63", "#a1887f", "#d7ccc8",
  "#8a5a3c", "#a9714a", "#c48a5c", "#d1a276", "#e0b48a", "#f0c9a0", "#fde6b5", "#ffe0bd",
  "#0d1b2a", "#1b263b", "#415a77", "#6b705c", "#a5a58d", "#b7b7a4",
  "#ffe0bd", "#ffcd94", "#f1c27d", "#e0ac69", "#c68642", "#a0522d", "#8d5524", "#6f4423", "#5c3317", "#4a2c17", "#3b1f0f", "#ae7242",
  "#006064", "#00838f", "#0097a7", "#00acc1", "#00bcd4", "#26c6da", "#4dd0e1", "#80deea",
  "#1a237e", "#283593", "#303f9f", "#3949ab", "#3f51b5", "#5c6bc0", "#7986cb", "#9fa8da",
  "#827717", "#9e9d24", "#afb42b", "#c0ca33", "#cddc39", "#d4e157", "#dce775", "#e6ee9c",
  "#ff006e", "#fb5607", "#ffbe0b", "#8338ec", "#3a86ff", "#06ffa5", "#00f5d4", "#ff4365", "#39ff14", "#ff10f0",
  "#ffd1dc", "#ffe4e1", "#e0bbff", "#c7ceea", "#b5ead7", "#c9f7f5", "#fff5ba", "#ffdac1", "#e2f0cb", "#d4a5a5", "#a2d2ff", "#bde0fe",
  "#4a0e0e", "#5c1a1a", "#800000", "#2c003e", "#3d0066", "#0f3d3e", "#013220", "#1a0f0f",
];

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

/** Carrega uma URL de imagem num canvas novo (crossOrigin: bucket "room-items" é público) e devolve o ImageData na resolução NATIVA. */
function loadImageData(url: string): Promise<{ imageData: ImageData; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Navegador sem suporte a canvas 2D."));
        return;
      }
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0);
      resolve({ imageData: ctx.getImageData(0, 0, canvas.width, canvas.height), width: canvas.width, height: canvas.height });
    };
    img.onerror = () => reject(new Error("Não deu pra carregar essa foto."));
    img.src = url;
  });
}

function imageDataToBlob(imageData: ImageData): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve(null);
  ctx.putImageData(imageData, 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

export interface FurnitureItemForColorTool {
  id: string;
  label: string;
  category: string;
  art: Partial<Record<DirectionKey, string>>;
  colors?: FurnitureModelColorOption[] | null;
}

export default function FurnitureColorZoneTool({
  item,
  accessToken,
  onClose,
  onSaved,
}: {
  item: FurnitureItemForColorTool;
  accessToken: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  const ZOOM_MIN = 0.4;
  const ZOOM_MAX = 4;
  function clampZoom(z: number) {
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  }
  function handleCanvasWheel(e: ReactWheelEvent<HTMLDivElement>) {
    e.preventDefault();
    setZoom((z) => clampZoom(z - e.deltaY * 0.0015));
  }

  const [zones, setZones] = useState<Zone[]>([]);
  const [hexDrafts, setHexDrafts] = useState<Record<string, string>>({});
  const [activeZoneKey, setActiveZoneKey] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [previewCounts, setPreviewCounts] = useState<number[] | null>(null);
  const [saveLabel, setSaveLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deletingColorId, setDeletingColorId] = useState<string | null>(null);

  // tamanho NATIVO da foto de frente (down) -- só sabido depois que ela
  // carrega, ver useEffect abaixo. Tudo (escala de exibição, raio do
  // pincel) depende disso, diferente do avatar (FRAME_W/H sempre fixo).
  const [nativeSize, setNativeSize] = useState<{ w: number; h: number } | null>(null);
  const paintScale = nativeSize ? Math.min(PAINT_SCALE_MAX, Math.max(PAINT_SCALE_MIN, PAINT_DISPLAY_TARGET / Math.max(nativeSize.w, nativeSize.h))) : 1;
  const brushRadius = nativeSize
    ? Math.min(BRUSH_RADIUS_MAX, Math.max(BRUSH_RADIUS_MIN, Math.round(Math.min(nativeSize.w, nativeSize.h) * BRUSH_RADIUS_RATIO)))
    : BRUSH_RADIUS_MIN;

  const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const paintBgCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const isPaintingRef = useRef(false);
  const resultDownDataRef = useRef<ImageData | null>(null);

  const activeZone = zones.find((z) => z.key === activeZoneKey) ?? null;
  const downUrl = item.art.down;

  useEffect(() => {
    let cancelled = false;
    if (!downUrl) {
      setLoadError("Esse item não tem foto de frente cadastrada.");
      return;
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (cancelled) return;
      const canvas = sourceCanvasRef.current;
      if (!canvas) return;
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        setLoadError("Navegador sem suporte a canvas 2D.");
        return;
      }
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      setNativeSize({ w: canvas.width, h: canvas.height });

      const scale = Math.min(PAINT_SCALE_MAX, Math.max(PAINT_SCALE_MIN, PAINT_DISPLAY_TARGET / Math.max(canvas.width, canvas.height)));
      const bg = paintBgCanvasRef.current;
      if (bg) {
        bg.width = canvas.width * scale;
        bg.height = canvas.height * scale;
        const bgCtx = bg.getContext("2d");
        if (bgCtx) {
          bgCtx.imageSmoothingEnabled = false;
          bgCtx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, bg.width, bg.height);
        }
      }
      const overlay = overlayCanvasRef.current;
      if (overlay) {
        overlay.width = canvas.width * scale;
        overlay.height = canvas.height * scale;
      }
      setReady(true);
    };
    img.onerror = () => {
      if (!cancelled) setLoadError("Não deu pra carregar a arte desse item pra pintar em cima.");
    };
    img.src = downUrl;
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downUrl]);

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

  function hexDraftFor(zone: Zone): string {
    return hexDrafts[zone.key] ?? zone.targetHex;
  }

  function handleHexInput(key: string, raw: string) {
    setHexDrafts((prev) => ({ ...prev, [key]: raw }));
    const cleaned = raw.trim().replace(/^#/, "");
    if (/^[0-9a-fA-F]{6}$/.test(cleaned)) {
      updateZone(key, { targetHex: `#${cleaned.toLowerCase()}` });
    }
  }

  function handleHexBlur(zone: Zone) {
    const cleaned = (hexDrafts[zone.key] ?? "").trim().replace(/^#/, "");
    if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) {
      setHexDrafts((prev) => {
        const next = { ...prev };
        delete next[zone.key];
        return next;
      });
    }
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
        ctx.arc(p.x * paintScale, p.y * paintScale, brushRadius * paintScale * 0.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function paintAt(imgX: number, imgY: number) {
    if (!activeZone || !nativeSize) return;
    const source = sourceCanvasRef.current;
    if (!source) return;
    const ctx = source.getContext("2d");
    if (!ctx) return;
    if (imgX < 0 || imgY < 0 || imgX >= nativeSize.w || imgY >= nativeSize.h) return;

    const r0 = Math.max(0, Math.floor(imgX - brushRadius));
    const g0 = Math.max(0, Math.floor(imgY - brushRadius));
    const w = Math.min(nativeSize.w, Math.ceil(imgX + brushRadius)) - r0;
    const h = Math.min(nativeSize.h, Math.ceil(imgY + brushRadius)) - g0;
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
            if (dx * dx + dy * dy > brushRadius * brushRadius) continue;
            const idx = (y * w + x) * 4;
            const a = patch.data[idx + 3];
            if (a < 200) continue;
            const r = patch.data[idx];
            const g = patch.data[idx + 1];
            const b = patch.data[idx + 2];
            if (luminance(r, g, b) < OUTLINE_LUMINANCE_CUTOFF) continue;
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
        octx.arc(imgX * paintScale, imgY * paintScale, brushRadius * paintScale * 0.6, 0, Math.PI * 2);
        octx.fill();
      }
    }
    setPreviewCounts(null);
  }

  function pointerToImageXY(e: ReactPointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = e.currentTarget.width / rect.width;
    const scaleY = e.currentTarget.height / rect.height;
    const x = ((e.clientX - rect.left) * scaleX) / paintScale;
    const y = ((e.clientY - rect.top) * scaleY) / paintScale;
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
    if (!source || !preview || !nativeSize) return;
    const zonesWithSamples = zones.filter((z) => z.samples.length > 0);
    if (zonesWithSamples.length === 0) {
      setSaveError("Pinte pelo menos uma zona antes de gerar a prévia.");
      return;
    }
    setSaveError(null);
    setGenerating(true);
    setTimeout(() => {
      const ctx = source.getContext("2d");
      preview.width = nativeSize.w * paintScale;
      preview.height = nativeSize.h * paintScale;
      const pctx = preview.getContext("2d");
      if (!ctx || !pctx) {
        setGenerating(false);
        return;
      }
      const downData = ctx.getImageData(0, 0, nativeSize.w, nativeSize.h);
      const zoneDefs: ZoneDef[] = zonesWithSamples.map((z) => ({ samples: z.samples, targetHex: z.targetHex }));
      const { zonePixelCounts } = applyZoneTint(downData, zoneDefs);
      const tmp = document.createElement("canvas");
      tmp.width = nativeSize.w;
      tmp.height = nativeSize.h;
      const tctx = tmp.getContext("2d");
      if (tctx) {
        tctx.putImageData(downData, 0, 0);
        pctx.imageSmoothingEnabled = false;
        pctx.clearRect(0, 0, preview.width, preview.height);
        pctx.drawImage(tmp, 0, 0, nativeSize.w, nativeSize.h, 0, 0, preview.width, preview.height);
      }
      resultDownDataRef.current = downData;
      setPreviewCounts(zonePixelCounts);
      setGenerating(false);
    }, 0);
  }

  async function handleSave() {
    const label = saveLabel.trim();
    if (!label) {
      setSaveError("Dá um nome pra essa variante (ex: Azul/Preto).");
      return;
    }
    if (!resultDownDataRef.current) {
      setSaveError("Gera a prévia antes de salvar.");
      return;
    }
    const zonesWithSamples = zones.filter((z) => z.samples.length > 0);
    if (zonesWithSamples.length === 0) {
      setSaveError("Pinte pelo menos uma zona antes de salvar.");
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
      const zoneDefs: ZoneDef[] = zonesWithSamples.map((z) => ({ samples: z.samples, targetHex: z.targetHex }));
      const stamp = Date.now();
      const slug = slugify(label);
      const newArt: Partial<Record<DirectionKey, string>> = {};

      // "down" já foi recolorido pra prévia (resultDownDataRef) -- as
      // OUTRAS direções (se o item tiver) precisam ser carregadas e
      // recoloridas AGORA, cada uma com o MESMO conjunto de zonas (a
      // classificação é por cor de amostra, não por posição -- funciona
      // igual em fotos de tamanhos diferentes, ver comentário no topo do
      // arquivo). Carrega, tinge em cima da MESMA ImageData e sobe, uma
      // direção por vez.
      for (const dir of DIRECTIONS) {
        const srcUrl = item.art[dir];
        if (!srcUrl) continue;
        let data: ImageData;
        if (dir === "down") {
          data = resultDownDataRef.current!;
        } else {
          const loaded = await loadImageData(srcUrl);
          applyZoneTint(loaded.imageData, zoneDefs);
          data = loaded.imageData;
        }
        const blob = await imageDataToBlob(data);
        if (!blob) throw new Error(`erro ao gerar PNG da direção "${dir}"`);
        const path = `${item.category}/colors/${item.id}-${slug}-${stamp}-${dir}.png`;
        const { error: uploadError } = await supabase.storage
          .from("room-items")
          .upload(path, blob, { upsert: false, contentType: "image/png" });
        if (uploadError) throw uploadError;
        const { data: urlData } = supabase.storage.from("room-items").getPublicUrl(path);
        newArt[dir] = urlData.publicUrl;
      }

      if (!newArt.down) throw new Error("erro ao gerar a foto de frente recolorida");

      const newColor: FurnitureModelColorOption = { id: crypto.randomUUID(), label, art: newArt };
      const nextColors = [...(item.colors ?? []), newColor];

      const res = await fetch(`/api/items/${item.id}`, {
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

  async function handleDeleteColor(color: FurnitureModelColorOption) {
    const ok = window.confirm(`Apagar a cor "${color.label}" de vez? Não dá pra desfazer.`);
    if (!ok) return;
    setDeletingColorId(color.id);
    setSaveError(null);
    try {
      const nextColors = (item.colors ?? []).filter((c) => c.id !== color.id);
      const res = await fetch(`/api/items/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ colors: nextColors }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "erro ao apagar cor");

      const supabase = getSupabaseBrowserClient();
      const marker = "/room-items/";
      if (supabase) {
        const paths: string[] = [];
        for (const url of Object.values(color.art)) {
          if (!url) continue;
          const idx = url.indexOf(marker);
          if (idx >= 0) paths.push(url.slice(idx + marker.length));
        }
        if (paths.length > 0) supabase.storage.from("room-items").remove(paths).catch(() => {});
      }
      onSaved();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "erro ao apagar cor");
    } finally {
      setDeletingColorId(null);
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
        Pinte por cima da foto de frente marcando cada parte que vai virar uma cor. Não precisa acertar a borda
        certinha -- o sistema acha o resto pela cor. Ao salvar, a MESMA cor é aplicada nas outras fotos de direção
        desse item também (contorno bem escuro nunca é tocado).
      </p>
      {loadError && <p className="color-zone-tool-error">{loadError}</p>}

      <div className="color-zone-tool-body">
        <div className="color-zone-tool-paint-col">
          <div className="color-zone-tool-zoom-row">
            <button type="button" onClick={() => setZoom((z) => clampZoom(z - 0.25))} title="Menos zoom">
              −
            </button>
            <span className="color-zone-tool-zoom-label">{Math.round(zoom * 100)}%</span>
            <button type="button" onClick={() => setZoom((z) => clampZoom(z + 0.25))} title="Mais zoom">
              +
            </button>
            {zoom !== 1 && (
              <button type="button" onClick={() => setZoom(1)} title="Restaurar zoom">
                Reset
              </button>
            )}
          </div>
          <div className="color-zone-tool-canvas-scroll" onWheel={handleCanvasWheel}>
            <div
              className="color-zone-tool-canvas-stack"
              style={{
                width: (nativeSize?.w ?? 1) * paintScale * zoom,
                height: (nativeSize?.h ?? 1) * paintScale * zoom,
              }}
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
                <span
                  className="color-zone-target-swatch"
                  style={{ background: zone.targetHex }}
                  title={`Cor alvo dessa zona: ${zone.targetHex}`}
                />
                <input
                  type="text"
                  className="color-zone-hex-input"
                  value={hexDraftFor(zone)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => handleHexInput(zone.key, e.target.value)}
                  onBlur={() => handleHexBlur(zone)}
                  placeholder="#d1a276"
                  maxLength={7}
                  title="Cor alvo dessa zona (hex -- pode colar direto)"
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
        </div>
      </div>

      <div className="color-zone-palette-wrap">
        <span className="color-zone-palette-label">
          {activeZone ? `Cor de "${activeZone.label}"` : "Selecione uma zona pra escolher a cor"}
        </span>
        <div className="color-zone-palette">
          {PALETTE_SWATCHES.map((hex) => (
            <button
              key={hex}
              type="button"
              className={
                activeZone && activeZone.targetHex.toLowerCase() === hex.toLowerCase()
                  ? "color-zone-palette-swatch color-zone-palette-swatch-selected"
                  : "color-zone-palette-swatch"
              }
              style={{ background: hex }}
              disabled={!activeZone}
              title={hex}
              onClick={() => {
                if (!activeZone) return;
                updateZone(activeZone.key, { targetHex: hex });
                setHexDrafts((prev) => {
                  const next = { ...prev };
                  delete next[activeZone.key];
                  return next;
                });
              }}
            />
          ))}
        </div>
      </div>

      <div className="color-zone-tool-below">
        <div className="color-zone-tool-actions">
          <button type="button" onClick={generatePreview} disabled={!ready || generating}>
            {generating ? "Gerando..." : "Gerar prévia"}
          </button>
        </div>

        <div className={previewCounts ? "color-zone-tool-preview" : "color-zone-tool-preview color-zone-tool-preview-empty"}>
          <canvas
            ref={previewCanvasRef}
            className="color-zone-tool-preview-canvas"
            style={{ width: (nativeSize?.w ?? 1) * paintScale * 0.6, height: (nativeSize?.h ?? 1) * paintScale * 0.6 }}
          />
          {previewCounts ? (
            <ul className="color-zone-tool-counts">
              {zones
                .filter((z) => z.samples.length > 0)
                .map((z, i) => (
                  <li key={z.key}>
                    {z.label}: {previewCounts[i] ?? 0}px recoloridos
                  </li>
                ))}
            </ul>
          ) : (
            <p className="color-zone-tool-counts">Clique em &quot;Gerar prévia&quot; pra ver o resultado aqui.</p>
          )}
        </div>

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
              <div key={c.id} className="color-zone-existing-item">
                {c.art.down ? (
                  <img className="color-zone-existing-thumb" src={c.art.down} alt={c.label} title={c.label} />
                ) : (
                  <span className="skin-swatch" title={c.label} />
                )}
                <button
                  type="button"
                  className="color-zone-existing-delete"
                  onClick={() => handleDeleteColor(c)}
                  disabled={deletingColorId === c.id}
                  title={`Apagar "${c.label}"`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <canvas ref={sourceCanvasRef} style={{ display: "none" }} />
    </div>
  );
}
