import { supabase, WEB_DATA_BUCKET } from "./supabase";

export type WebComputedPayload = {
  href: string;
  viewport: { width: number; height: number; devicePixelRatio: number };
  scrollHeight?: number;
  scrollY?: number;
  extractedAt: number;
  screenshotDataUrl?: string | null;
  elements: Record<
    string,
    {
      bbox: { x: number; y: number; width: number; height: number } | null;
      classList: string[];
      computed: Record<string, string>;
      textBbox?: { x: number; y: number; width: number; height: number } | null;
    }
  >;
};

type Stored = { id: string; createdAt: number; data: WebComputedPayload };

const store = new Map<string, Stored>();

const useSupabase = !!supabase;

// ── 로컬 파일 시스템 ──
function dataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (process.env.VERCEL) return "/tmp/.dqa-web-data";
  return `${process.cwd()}/.dqa-web-data`;
}
function filePathFor(id: string) { return `${dataDir()}/${id}.json`; }

function persistToDisk(id: string, data: WebComputedPayload) {
  try {
    const fs = require("fs") as typeof import("fs");
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(filePathFor(id), JSON.stringify(data), "utf8");
  } catch { /* best-effort */ }
}

function readFromDisk(id: string): WebComputedPayload | null {
  try {
    const fs = require("fs") as typeof import("fs");
    const p = filePathFor(id);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8")) as WebComputedPayload;
  } catch { return null; }
}

// ── Supabase Storage ──
async function persistToSupabase(id: string, data: WebComputedPayload) {
  if (!supabase) return;
  try {
    const { screenshotDataUrl, ...cssData } = data;

    const jsonBlob = new Blob([JSON.stringify(cssData)], { type: "application/json" });
    const { error: jsonErr } = await supabase.storage
      .from(WEB_DATA_BUCKET)
      .upload(`${id}/data.json`, jsonBlob, { upsert: true });
    if (jsonErr) console.error("[Supabase] JSON upload error:", jsonErr.message);

    if (screenshotDataUrl) {
      const match = screenshotDataUrl.match(/^data:([^;]+);base64,(.+)$/s);
      if (match) {
        const mimeType = match[1];
        const ext = mimeType.includes("png") ? "png" : "jpg";
        const binary = Buffer.from(match[2], "base64");
        const { error: imgErr } = await supabase.storage
          .from(WEB_DATA_BUCKET)
          .upload(`${id}/screenshot.${ext}`, binary, { contentType: mimeType, upsert: true });
        if (imgErr) console.error("[Supabase] Screenshot upload error:", imgErr.message);
      }
    }
  } catch (e) {
    console.error("[Supabase] persist error:", e);
  }
}

async function readFromSupabase(id: string): Promise<WebComputedPayload | null> {
  if (!supabase) return null;
  try {
    const { data: jsonData, error: jsonErr } = await supabase.storage
      .from(WEB_DATA_BUCKET)
      .download(`${id}/data.json`);
    if (jsonErr || !jsonData) return null;
    const cssData = JSON.parse(await jsonData.text()) as WebComputedPayload;

    for (const ext of ["png", "jpg"]) {
      try {
        const { data: fileData } = await supabase.storage
          .from(WEB_DATA_BUCKET)
          .download(`${id}/screenshot.${ext}`);
        if (fileData && fileData.size > 0) {
          const buf = Buffer.from(await fileData.arrayBuffer());
          const mime = ext === "png" ? "image/png" : "image/jpeg";
          cssData.screenshotDataUrl = `data:${mime};base64,${buf.toString("base64")}`;
          break;
        }
      } catch { /* no screenshot */ }
    }
    return cssData;
  } catch (e) {
    console.error("[Supabase] read error:", e);
    return null;
  }
}

// ── Public API ──
export function createWebDataId() {
  return `web_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;
}

export async function putWebData(data: WebComputedPayload) {
  const id = createWebDataId();
  store.set(id, { id, createdAt: Date.now(), data });
  if (useSupabase) {
    await persistToSupabase(id, data);
  }
  persistToDisk(id, data);
  return id;
}

export async function getWebDataAsync(id: string): Promise<WebComputedPayload | null> {
  const mem = store.get(id)?.data ?? null;
  if (mem) return mem;
  if (useSupabase) {
    const remote = await readFromSupabase(id);
    if (remote) { store.set(id, { id, createdAt: Date.now(), data: remote }); return remote; }
  }
  const disk = readFromDisk(id);
  if (disk) { store.set(id, { id, createdAt: Date.now(), data: disk }); return disk; }
  return null;
}

export function getWebData(id: string) {
  const mem = store.get(id)?.data ?? null;
  if (mem) return mem;
  const disk = readFromDisk(id);
  if (disk) { store.set(id, { id, createdAt: Date.now(), data: disk }); return disk; }
  return null;
}
