import type { ViewportPreset } from "@/lib/viewport";

export type RunRequest = {
  url: string;
  figma: {
    devModeUrlOrFileKey: string;
    nodeId?: string;
    personalAccessToken?: string;
  };
  viewportPreset: ViewportPreset;
  thresholdPx: number;
};

export type RunSuccess = {
  ok: true;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  screenshot: { mimeType: string; base64: string };
  summary: { total: number; pass: number; warn: number; fail: number; missing: number };
  results: Array<{
    className: string;
    selector: string;
    severity: "pass" | "warn" | "fail";
    diffs: Array<{
      key: string;
      figma?: string | number | null;
      web?: string | number | null;
      delta?: number | null;
    }>;
    bbox?: { x: number; y: number; width: number; height: number } | null;
    elementFound: boolean;
  }>;
  meta: {
    url: string;
    figma: { fileKey: string; nodeId: string };
    thresholdPx: number;
    tokens?: { total: number; used: number; truncated: boolean; max: number };
    timingsMs?: Record<string, number>;
  };
};

export type RunFailure = { ok: false; stage?: string; error: string };
export type RunResponse = RunSuccess | RunFailure;

export type JobState =
  | {
      id: string;
      status: "queued" | "running";
      createdAt: number;
      updatedAt: number;
      request: Omit<RunRequest, "figma"> & { figma: Omit<RunRequest["figma"], "personalAccessToken"> };
      logs: string[];
    }
  | {
      id: string;
      status: "succeeded";
      createdAt: number;
      updatedAt: number;
      request: Omit<RunRequest, "figma"> & { figma: Omit<RunRequest["figma"], "personalAccessToken"> };
      logs: string[];
      response: RunSuccess;
    }
  | {
      id: string;
      status: "failed";
      createdAt: number;
      updatedAt: number;
      request: Omit<RunRequest, "figma"> & { figma: Omit<RunRequest["figma"], "personalAccessToken"> };
      logs: string[];
      response: RunFailure;
    };

const jobs = new Map<string, JobState>();

export function createJobId() {
  return `${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;
}

export function redactRequest(req: RunRequest): JobState["request"] {
  return {
    url: req.url,
    viewportPreset: req.viewportPreset,
    thresholdPx: req.thresholdPx,
    figma: {
      devModeUrlOrFileKey: req.figma.devModeUrlOrFileKey,
      nodeId: req.figma.nodeId,
    },
  };
}

export function putJob(job: JobState) {
  jobs.set(job.id, job);
}

export function getJob(id: string) {
  return jobs.get(id) ?? null;
}

export function appendLog(id: string, line: string) {
  const j = jobs.get(id);
  if (!j) return;
  const next: JobState = { ...j, updatedAt: Date.now(), logs: [...j.logs, line].slice(-500) } as JobState;
  jobs.set(id, next);
}

export function setJobRunning(id: string) {
  const j = jobs.get(id);
  if (!j) return;
  if (j.status !== "queued") return;
  jobs.set(id, { ...j, status: "running", updatedAt: Date.now() });
}

export function setJobResult(id: string, res: RunResponse) {
  const j = jobs.get(id);
  if (!j) return;
  const base = {
    id: j.id,
    createdAt: j.createdAt,
    request: j.request,
    logs: j.logs,
    updatedAt: Date.now(),
  };
  if (res.ok) {
    jobs.set(id, { ...base, status: "succeeded", response: res });
  } else {
    jobs.set(id, { ...base, status: "failed", response: res });
  }
}

