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

function dataDir() {
  // DATA_DIR 환경변수 우선 (Railway volume 등 배포 환경)
  // 없으면 프로젝트 루트의 .dqa-web-data 폴더 (로컬 개발)
  return process.env.DATA_DIR ?? `${process.cwd()}/.dqa-web-data`;
}

function filePathFor(id: string) {
  // id is generated internally as web_<...> so this is safe enough.
  return `${dataDir()}/${id}.json`;
}

export function createWebDataId() {
  return `web_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;
}

export function putWebData(data: WebComputedPayload) {
  const id = createWebDataId();
  store.set(id, { id, createdAt: Date.now(), data });
  persistToDisk(id, data);
  return id;
}

export function getWebData(id: string) {
  const mem = store.get(id)?.data ?? null;
  if (mem) return mem;
  const disk = readFromDisk(id);
  if (disk) {
    store.set(id, { id, createdAt: Date.now(), data: disk });
    return disk;
  }
  return null;
}

function persistToDisk(id: string, data: WebComputedPayload) {
  try {
    // Lazy import to keep this module usable in edge-like contexts (we run nodejs).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("fs") as typeof import("fs");
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(filePathFor(id), JSON.stringify(data), "utf8");
  } catch {
    // Best-effort persistence (MVP). In-memory still works within the same process.
  }
}

function readFromDisk(id: string): WebComputedPayload | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("fs") as typeof import("fs");
    const p = filePathFor(id);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw) as WebComputedPayload;
  } catch {
    return null;
  }
}

