"use client";

// "Editor de Itens" -- pedido do Douglas: cadastrar móvel novo direto
// pela tela (upload de imagem), sem precisar organizar pasta local nem
// rodar `npm run sync-assets`, e sem ficar salvo só no computador dele
// -- guardado no Supabase (Storage + tabela room_items, ver
// supabase/migrations/0002_room_items.sql). Só aparece pro DONO da
// sala (ver isOwner/roomRole em GameRoom.tsx, mesmo gate do painel de
// membros).
//
// Upload vai DIRETO do navegador pro Storage (usa o token da própria
// pessoa -- a policy do bucket confere "é owner?" no banco, ver a
// migration) -- só os METADADOS (nome/categoria/URLs já prontas) vão
// pro nosso servidor (POST /api/items), que confere de novo antes de
// gravar.
import { useEffect, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { CUSTOM_ITEM_TARGET_WIDTH } from "@/game/furniture";

type CategoryId = "poltrona" | "divisoria" | "sofa" | "mesa" | "planta" | "computador";

// múltiplo de folga acima do tamanho que o item aparece no jogo (ver
// CUSTOM_ITEM_TARGET_WIDTH em game/furniture.ts) -- pedido do Douglas:
// gera no ChatGPT, monta no Canva, redimensiona pro tamanho final e só
// depois sobe aqui. Isso custava um tanto de qualidade nesse
// redimensionamento manual (e ida-e-volta pra eu ajudar a acertar o
// tamanho), e além disso ele notou que de LONGE (zoom afastado) o móvel
// borra mesmo de perto tendo qualidade -- isso é o efeito clássico de
// encolher demais uma textura no WebGL sem ela ter uma versão
// intermediária: quanto maior a diferença entre o tamanho do arquivo e o
// tamanho exibido, mais a GPU "erra a média" dos pixels ao amostrar pra
// baixo, e borra. Por isso a imagem AGORA é redimensionada aqui no
// navegador (resizeImageForUpload, logo abaixo) pra um teto de ~3x o
// tamanho final -- folga o suficiente pra ficar nítido em qualquer
// zoom (a mesma técnica de "arte em alta, exibida menor" que sites/apps
// bons usam pra tela Retina), sem sobrar tanta diferença que borre. A
// pessoa não precisa mais encolher NADA à mão -- sobe do jeito que
// gerou/montou, em qualquer resolução, e esse teto só corta o excesso.
const UPLOAD_SUPERSAMPLE = 3;

const CATEGORIES: { id: CategoryId; label: string }[] = [
  { id: "poltrona", label: "Poltrona" },
  { id: "divisoria", label: "Divisória" },
  { id: "sofa", label: "Sofá" },
  { id: "mesa", label: "Mesa" },
  { id: "planta", label: "Planta" },
  { id: "computador", label: "Computador" },
];

// "down/left/right/up" = mesma convenção de direção do resto do jogo
// (ver game/grid.ts) -- rótulo em português só pro formulário.
const DIRECTION_FIELDS: { key: "down" | "left" | "right" | "up"; label: string; required: boolean }[] = [
  { key: "down", label: "Frente", required: true },
  { key: "left", label: "Lado esquerdo", required: false },
  { key: "right", label: "Lado direito", required: false },
  { key: "up", label: "Costas", required: false },
];

type CustomItemRow = {
  id: string;
  label: string;
  category: CategoryId;
  art: Partial<Record<"down" | "left" | "right" | "up", string>>;
};

/**
 * Encolhe (só encolhe, nunca aumenta) a imagem pra no máximo maxWidth
 * de largura ANTES de subir pro Storage -- ver UPLOAD_SUPERSAMPLE acima
 * pro porquê. Usa createImageBitmap + canvas (2D, com suavização "high")
 * em vez de mandar o arquivo cru: mais barato que mandar o arquivo
 * gigante e o navegador aguenta tranquilo (é só um redimensionamento,
 * roda na hora, sem travar a tela). Se alguma etapa falhar (formato
 * exótico, navegador antigo) devolve o arquivo ORIGINAL sem esse corte
 * -- upload continua funcionando, só sem o benefício do teto de tamanho.
 */
async function resizeImageForUpload(file: File, maxWidth: number): Promise<File> {
  if (typeof createImageBitmap !== "function") return file;
  try {
    const bitmap = await createImageBitmap(file);
    if (bitmap.width <= maxWidth) {
      bitmap.close?.();
      return file;
    }
    const scale = maxWidth / bitmap.width;
    const targetW = Math.max(1, Math.round(bitmap.width * scale));
    const targetH = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close?.();
      return file;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    bitmap.close?.();
    const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.\w+$/, ".png"), { type: "image/png" });
  } catch (e) {
    console.warn("Não deu pra redimensionar a imagem antes de subir, mandando original", e);
    return file;
  }
}

function slugify(text: string): string {
  return (
    text
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "item"
  );
}

export default function ItemEditor({
  accessToken,
  onClose,
  onItemsChanged,
}: {
  accessToken: string;
  onClose: () => void;
  onItemsChanged: () => void;
}) {
  const [items, setItems] = useState<CustomItemRow[] | null>(null);
  const [label, setLabel] = useState("");
  const [category, setCategory] = useState<CategoryId>("poltrona");
  const [files, setFiles] = useState<Partial<Record<"down" | "left" | "right" | "up", File>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRefs = useRef<Partial<Record<string, HTMLInputElement | null>>>({});

  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  async function loadItems() {
    setError(null);
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data, error: fetchError } = await supabase.from("room_items").select("id, label, category, art");
    if (fetchError) {
      setError(fetchError.message);
      return;
    }
    setItems((data ?? []) as CustomItemRow[]);
  }

  useEffect(() => {
    loadItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!label.trim()) {
      setError("Dá um nome pro item.");
      return;
    }
    if (!files.down) {
      setError("A imagem de frente é obrigatória.");
      return;
    }
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setSubmitting(true);
    try {
      const slug = slugify(label);
      // teto de resolução com folga (ver UPLOAD_SUPERSAMPLE/
      // resizeImageForUpload acima) -- calculado UMA vez por categoria
      // escolhida, as 4 direções usam o mesmo teto (a peça tem
      // proporções parecidas de qualquer ângulo).
      const maxUploadWidth = CUSTOM_ITEM_TARGET_WIDTH[category] * UPLOAD_SUPERSAMPLE;
      const art: Record<string, string> = {};
      for (const field of DIRECTION_FIELDS) {
        const rawFile = files[field.key];
        if (!rawFile) continue;
        const file = await resizeImageForUpload(rawFile, maxUploadWidth);
        const ext = file.name.split(".").pop() || "png";
        const path = `${category}/${slug}-${Date.now()}-${field.key}.${ext}`;
        const { error: uploadError } = await supabase.storage.from("room-items").upload(path, file, {
          upsert: false,
          contentType: file.type || "image/png",
        });
        if (uploadError) throw uploadError;
        const { data: publicUrlData } = supabase.storage.from("room-items").getPublicUrl(path);
        art[field.key] = publicUrlData.publicUrl;
      }

      const res = await fetch("/api/items", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ label: label.trim(), category, art }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "erro ao cadastrar item");

      setLabel("");
      setFiles({});
      for (const key of Object.keys(fileInputRefs.current)) {
        const input = fileInputRefs.current[key];
        if (input) input.value = "";
      }
      await loadItems();
      onItemsChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "erro ao cadastrar item");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/items/${id}`, { method: "DELETE", headers: authHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "erro ao apagar item");
      await loadItems();
      onItemsChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "erro ao apagar item");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="items-panel-backdrop" onClick={onClose}>
      <div className="items-panel" onClick={(e) => e.stopPropagation()}>
        <div className="items-panel-header">
          <h2>Editor de itens</h2>
          <button type="button" className="items-panel-close" onClick={onClose} title="Fechar">
            ✕
          </button>
        </div>

        <form className="items-panel-form" onSubmit={handleSubmit}>
          <input
            className="items-panel-input"
            type="text"
            placeholder="Nome do item"
            value={label}
            maxLength={40}
            onChange={(e) => setLabel(e.target.value)}
          />
          <select className="items-panel-input" value={category} onChange={(e) => setCategory(e.target.value as CategoryId)}>
            {CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>

          <p className="settings-hint">
            Pode subir a imagem na qualidade original (do ChatGPT/Canva, sem redimensionar à mão) -- o jogo encolhe sozinho pro tamanho certo.
          </p>

          <div className="items-panel-uploads">
            {DIRECTION_FIELDS.map((field) => (
              <label key={field.key} className="items-panel-upload-field">
                <span>
                  {field.label}
                  {field.required ? " *" : ""}
                </span>
                <input
                  ref={(el) => {
                    fileInputRefs.current[field.key] = el;
                  }}
                  type="file"
                  accept="image/png,image/webp,image/jpeg"
                  onChange={(e) =>
                    setFiles((prev) => ({ ...prev, [field.key]: e.target.files?.[0] ?? undefined }))
                  }
                />
              </label>
            ))}
          </div>

          {error && <p className="items-panel-error">{error}</p>}

          <button type="submit" className="items-panel-submit" disabled={submitting}>
            {submitting ? "Enviando..." : "Cadastrar item"}
          </button>
        </form>

        <section className="items-panel-section">
          <h3>Itens cadastrados ({items?.length ?? 0})</h3>
          {!items ? (
            <p className="items-panel-loading">Carregando...</p>
          ) : items.length === 0 ? (
            <p className="items-panel-loading">Nenhum item custom ainda.</p>
          ) : (
            <ul className="items-panel-list">
              {items.map((item) => (
                <li key={item.id} className="items-panel-row">
                  {item.art.down && <img className="items-panel-thumb" src={item.art.down} alt={item.label} />}
                  <span className="items-panel-name">
                    {item.label} <span className="items-panel-category">({CATEGORIES.find((c) => c.id === item.category)?.label ?? item.category})</span>
                  </span>
                  <button type="button" disabled={busyId === item.id} onClick={() => handleDelete(item.id)}>
                    Excluir
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
