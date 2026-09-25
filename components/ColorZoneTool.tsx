"use client";

// "Gerador de cor" -- pedido do Douglas: "cria essa ferramenta por
// seleção" (depois de recusar máscara fixa por coordenada, que "limita
// mt", E redesenhar cada peça em cada quadro à mão, "nao tem ia que me
// da isso sem errar"). Ver conversa no chat + game/colorTint.ts pro
// algoritmo (colorize com deslocamento de luminância, zona escolhida
// por AMOSTRA DE COR pintada, não por coordenada fixa).
//
// Fluxo: abre em cima de um item JÁ cadastrado (cabelo/acessório/traje
// OU tom de pele -- ver prop apiBase abaixo, pedido do Douglas
// "adicionar cores pra avatar tambem" / "edicao encima do ja subido" --
// usado dentro do AvatarCreatorPanel em ItemEditor.tsx) -- pinta zonas
// em cima do quadro de FRENTE/PARADO (quadro 0 da folha 8x2), escolhe o
// hex alvo de cada zona, gera uma prévia, e ao salvar sobe uma folha
// NOVA (recolorida inteira, todos os 15 quadros) pro Storage, virando
// uma entrada em `colors` do registro original (mesmo formato de
// ColorOption em game/customization.ts) via PATCH /api/<apiBase>/[id].
import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
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

// paleta de quadradinhos pra escolher a cor alvo -- pedido do Douglas
// depois do hex manual ("muito dificil acertar nesse rgb"): "quero
// todas elas em quadradinho, faca na largura toda da janela e deixe
// um scrol pra rolar dentro das cores, mostres 3 linhas de cor / ao
// inves do rgb". Substitui de vez o <input type="color"> nativo (a
// roda de cor do sistema) -- clica no quadradinho e pronto, o campo de
// hex continua do lado pra digitar um valor exato se precisar.
const PALETTE_SWATCHES: string[] = [
  "#000000", "#1a1a1a", "#333333", "#4d4d4d", "#666666", "#808080", "#999999", "#b3b3b3", "#cccccc", "#e6e6e6", "#f5f5f5", "#ffffff",
  "#7f0000", "#a30000", "#c62828", "#e53935", "#ef5350", "#ff8a80", "#ff5252", "#d32f2f", "#b71c1c", "#8e0000",
  "#7f3f00", "#a35c00", "#e65100", "#f57c00", "#fb8c00", "#ffa726", "#ffb74d", "#ffcc80", "#ff9800", "#e67e22",
  // pedido do Douglas: "libera aqui mais amarelo, uns mais acizentado"
  // -- 6 tons novos no fim da faixa de amarelo, dessaturados/puxando
  // pro cáqui (mostarda acinzentada), além dos amarelos vivos que já
  // tinham.
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

  // pedido do Douglas: "bota mais cores" -- mais faixas pra cobrir o que
  // as 12 linhas de cima ainda deixavam faltando (tom de pele mais
  // variado pra pele/cabelo, ciano/índigo entre o azul e o roxo,
  // vivo/neon pra acessório, pastel bem claro, oliva/caqui entre
  // amarelo e verde, e vinho/jóia bem escuro).
  "#ffe0bd", "#ffcd94", "#f1c27d", "#e0ac69", "#c68642", "#a0522d", "#8d5524", "#6f4423", "#5c3317", "#4a2c17", "#3b1f0f", "#ae7242",
  "#006064", "#00838f", "#0097a7", "#00acc1", "#00bcd4", "#26c6da", "#4dd0e1", "#80deea",
  "#1a237e", "#283593", "#303f9f", "#3949ab", "#3f51b5", "#5c6bc0", "#7986cb", "#9fa8da",
  "#827717", "#9e9d24", "#afb42b", "#c0ca33", "#cddc39", "#d4e157", "#dce775", "#e6ee9c",
  "#ff006e", "#fb5607", "#ffbe0b", "#8338ec", "#3a86ff", "#06ffa5", "#00f5d4", "#ff4365", "#39ff14", "#ff10f0",
  "#ffd1dc", "#ffe4e1", "#e0bbff", "#c7ceea", "#b5ead7", "#c9f7f5", "#fff5ba", "#ffdac1", "#e2f0cb", "#d4a5a5", "#a2d2ff", "#bde0fe",
  "#4a0e0e", "#5c1a1a", "#800000", "#2c003e", "#3d0066", "#0f3d3e", "#013220", "#1a0f0f",
];

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
  // "avatar-items" (cabelo/acessório/traje, de sempre) ou "avatar-skins"
  // (tom de pele -- pedido do Douglas: "adicionar cores pra avatar
  // tambem") -- decide tanto o endpoint do PATCH (/api/<apiBase>/[id])
  // quanto a pastinha dentro do bucket "room-items" onde a folha
  // recolorida é salva (mesma convenção de path por tipo que
  // avatar_skins/avatar_items já usam, ver 0005_avatar_skins.sql).
  // Default "avatar-items" -- não quebra quem já chamava sem essa prop.
  apiBase = "avatar-items",
}: {
  item: AvatarItemForColorTool;
  accessToken: string;
  onClose: () => void;
  onSaved: () => void;
  apiBase?: "avatar-items" | "avatar-skins";
}) {
  // zoom da área de pintura -- pedido do Douglas: "quero dar zoom"
  // (ficava difícil acertar o pincel em detalhe pequeno só no
  // PAINT_SCALE fixo de 2.4x). Multiplica em cima do PAINT_SCALE de
  // sempre -- ver .color-zone-tool-canvas-stack no JSX (só muda o
  // TAMANHO EXIBIDO via style inline; o canvas de baixo continua com a
  // MESMA resolução interna de sempre, ver bg/overlay canvas em
  // color-zone-tool-bg-canvas/overlay-canvas que já são width:100%/
  // height:100% do pai no CSS -- crescem/encolhem sozinhos). Não precisa
  // mexer em pointerToImageXY/paintAt: eles já leem o tamanho de TELA
  // via getBoundingClientRect(), então convertem certo pra qualquer
  // zoom sem trocar nada na conta.
  const [zoom, setZoom] = useState(1);
  const ZOOM_MIN = 0.6;
  const ZOOM_MAX = 4;
  function clampZoom(z: number) {
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  }
  function handleCanvasWheel(e: ReactWheelEvent<HTMLDivElement>) {
    e.preventDefault();
    setZoom((z) => clampZoom(z - e.deltaY * 0.0015));
  }

  const [zones, setZones] = useState<Zone[]>([]);
  // texto DIGITADO no campo de hex de cada zona (ver zone-hex-input no
  // JSX) -- separado de zone.targetHex de propósito: o Douglas reclamou
  // "muito difícil acertar nesse rgb" usando só o seletor nativo
  // <input type="color"> (no Mac abre a roda de cor do sistema, sem
  // campo de hex à mão) -- agora dá pra digitar/colar o hex direto
  // (mesmo formato que ele já usa no chat, tipo "#d1a276"). Guarda o
  // texto BRUTO enquanto digita (pode estar incompleto, tipo "#d1a") e
  // só grava em zone.targetHex quando fechar 6 dígitos válidos -- assim
  // nunca chega hex quebrado no algoritmo (ver commitHexDraft abaixo).
  const [hexDrafts, setHexDrafts] = useState<Record<string, string>>({});
  const [activeZoneKey, setActiveZoneKey] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [previewCounts, setPreviewCounts] = useState<number[] | null>(null);
  const [saveLabel, setSaveLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // id da cor JÁ CADASTRADA sendo apagada agora (ver handleDeleteColor)
  // -- só pra desabilitar o botãozinho de "x" dela enquanto a chamada
  // não volta, sem travar o resto da ferramenta.
  const [deletingColorId, setDeletingColorId] = useState<string | null>(null);

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

  // texto mostrado no campo de hex -- o que o Douglas digitou por
  // último (mesmo incompleto), ou o hex já salvo da zona se ele ainda
  // não mexeu nesse campo.
  function hexDraftFor(zone: Zone): string {
    return hexDrafts[zone.key] ?? zone.targetHex;
  }

  // só GRAVA em zone.targetHex (o que o algoritmo de fato usa) quando o
  // texto fecha um hex de 6 dígitos válido -- aceita com ou sem "#" na
  // frente, maiúsculo ou minúsculo (mesmo jeito que o Douglas colou hex
  // no chat, ex: "#d1a276"). Enquanto não fecha, só guarda o rascunho
  // (hexDrafts) sem tocar targetHex -- não passa lixo pro colorTint.ts.
  function handleHexInput(key: string, raw: string) {
    setHexDrafts((prev) => ({ ...prev, [key]: raw }));
    const cleaned = raw.trim().replace(/^#/, "");
    if (/^[0-9a-fA-F]{6}$/.test(cleaned)) {
      updateZone(key, { targetHex: `#${cleaned.toLowerCase()}` });
    }
  }

  // ao sair do campo (ou trocar de zona), se o que ficou digitado não
  // fechou um hex válido, volta o campo a mostrar o hex de verdade da
  // zona -- sem isso um "#d1a" largado pela metade ficava exibido pra
  // sempre, mesmo a zona continuando com a última cor válida por baixo.
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
      const path = `${apiBase}/colors/${item.id}-${slugify(label)}-${stamp}.png`;
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

      const res = await fetch(`/api/${apiBase}/${item.id}`, {
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

  // apagar uma cor JÁ CADASTRADA -- pedido do Douglas: "Quero apagar as
  // cores ja adicionadas". Mesmo PATCH /api/avatar-items/[id] que
  // handleSave usa pra ADICIONAR uma cor (ele substitui o array
  // `colors` inteiro), só que mandando o array SEM essa entrada. Também
  // tenta apagar o PNG correspondente do Storage (melhor esforço -- se
  // falhar, ignora e segue: o registro em `colors` já foi removido de
  // qualquer forma, só sobraria um arquivo órfão no bucket).
  async function handleDeleteColor(color: ColorOption) {
    const ok = window.confirm(`Apagar a cor "${color.label}" de vez? Não dá pra desfazer.`);
    if (!ok) return;
    setDeletingColorId(color.id);
    setSaveError(null);
    try {
      const nextColors = (item.colors ?? []).filter((c) => c.id !== color.id);
      const res = await fetch(`/api/${apiBase}/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ colors: nextColors }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "erro ao apagar cor");

      const supabase = getSupabaseBrowserClient();
      const marker = "/room-items/";
      const markerIdx = color.file.indexOf(marker);
      if (supabase && markerIdx >= 0) {
        const storagePath = color.file.slice(markerIdx + marker.length);
        supabase.storage
          .from("room-items")
          .remove([storagePath])
          .catch(() => {}); // melhor esforço, não bloqueia a UI
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
        Pinte por cima do desenho marcando cada parte que vai virar uma cor (ex: uma zona pra camisa, outra pra
        calça). Não precisa acertar a borda certinha -- o sistema acha o resto pela cor. Pixel bem escuro (contorno)
        nunca é tocado.
      </p>
      {loadError && <p className="color-zone-tool-error">{loadError}</p>}

      <div className="color-zone-tool-body">
        <div className="color-zone-tool-paint-col">
          {/* zoom -- pedido do Douglas: "quero dar zoom". Scroll do mouse
              em cima do desenho zoom in/out (ver handleCanvasWheel); os
              botões embaixo são o mesmo controle pra quem usa trackpad/
              touch sem scroll vertical fácil. */}
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
              style={{ width: FRAME_W * PAINT_SCALE * zoom, height: FRAME_H * PAINT_SCALE * zoom }}
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
                {/* mostra a cor alvo atual -- a ESCOLHA em si agora é
                    feita na paleta de quadradinhos logo abaixo (ver
                    color-zone-palette), não mais na roda de cor nativa. */}
                <span
                  className="color-zone-target-swatch"
                  style={{ background: zone.targetHex }}
                  title={`Cor alvo dessa zona: ${zone.targetHex}`}
                />
                {/* campo de hex digitado -- ver comentário de hexDrafts
                    acima ("muito difícil acertar nesse rgb" com só a roda
                    de cor nativa). Aceita colar "#d1a276" direto. */}
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

      {/* paleta de quadradinhos -- pedido do Douglas: "quero todas elas
          em quadradinho, faca na largura toda da janela e deixe um
          scrol pra rolar dentro das cores, mostres 3 linhas de cor / ao
          inves do rgb". Fica FORA de color-zone-tool-body de propósito
          (não dentro da coluna estreita de zonas) pra ocupar a largura
          inteira da janela da ferramenta. Clicar num quadradinho seta o
          targetHex da zona ATIVA (a mesma que já fica marcada pra
          pintar no canvas). */}
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

          {/* SEM `{previewCounts && (...)}` em volta do canvas de propósito
              -- bug reportado pelo Douglas: "cliquei em gerar e nada
              aconteceu". O canvas só existia DEPOIS de previewCounts virar
              não-nulo, mas previewCounts só vira não-nulo DEPOIS de
              generatePreview conseguir escrever nesse mesmo canvas (via
              previewCanvasRef.current) -- ou seja, o ref vinha sempre nulo
              no primeiro clique (elemento nem montado ainda) e a função
              retornava sem fazer nada, sempre. Agora o canvas fica sempre
              montado (escondido via CSS até ter prévia), então o ref
              sempre existe quando o botão é clicado. */}
          <div className={previewCounts ? "color-zone-tool-preview" : "color-zone-tool-preview color-zone-tool-preview-empty"}>
            <canvas
              ref={previewCanvasRef}
              className="color-zone-tool-preview-canvas"
              style={{ width: FRAME_W * PAINT_SCALE * 0.6, height: FRAME_H * PAINT_SCALE * 0.6 }}
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
              <p className="color-zone-tool-counts">Clique em "Gerar prévia" pra ver o resultado aqui.</p>
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
                // botão de apagar -- pedido do Douglas: "Quero apagar as
                // cores ja adicionadas" (ver handleDeleteColor acima).
                <div key={c.id} className="color-zone-existing-item">
                  <span className="skin-swatch" style={{ background: c.hex ?? "#8a7ca8" }} title={c.label} />
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

      {/* fora de tela -- só pra manipular pixels, nunca aparece direto. */}
      <canvas ref={sourceCanvasRef} style={{ display: "none" }} />
    </div>
  );
}
