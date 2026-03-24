import { NextResponse } from "next/server";
import { z } from "zod";
import { assertPersonalAccessToken, normalizeNodeId, parseFigmaDevModeUrl } from "@/lib/figma";

export const runtime = "nodejs";

const BodySchema = z.object({
  figma: z.object({
    devModeUrlOrFileKey: z.string().min(1),
    nodeId: z.string().optional(),
    personalAccessToken: z.string().optional(),
  }),
});

type Attempt = {
  headerStyle: "x_figma_token";
  ok: boolean;
  status: number | null;
  errorCategory:
    | "network_blocked"
    | "invalid_token"
    | "no_permission"
    | "not_found"
    | "unknown_error"
    | null;
  message: string;
  responseSnippet?: string;
};

type DiagnoseResponse =
  | {
      ok: true;
      input: { fileKey: string; nodeId: string | null };
      tokenProvided: boolean;
      checks: {
        me: Attempt[];
        file: Attempt[];
        node?: Attempt[];
      };
      verdict:
        | "token_missing"
        | "network_blocked"
        | "invalid_token"
        | "no_permission"
        | "file_not_found"
        | "node_not_found"
        | "ok";
    }
  | { ok: false; error: string };

export async function POST(req: Request) {
  try {
    const body = BodySchema.parse(await req.json());

    const parsed = parseFigmaDevModeUrl(body.figma.devModeUrlOrFileKey);
    const fileKey = parsed.fileKey ?? body.figma.devModeUrlOrFileKey.trim();
    const nodeIdRaw = body.figma.nodeId ?? parsed.nodeId ?? null;
    const nodeId = nodeIdRaw ? normalizeNodeId(nodeIdRaw) : null;

    const token = body.figma.personalAccessToken ?? process.env.FIGMA_TOKEN ?? "";
    const tokenProvided = Boolean(token);
    if (!tokenProvided) {
      const out: DiagnoseResponse = {
        ok: true,
        input: { fileKey, nodeId },
        tokenProvided,
        checks: { me: [], file: [] },
        verdict: "token_missing",
      };
      return NextResponse.json(out);
    }

    const meUrl = "https://api.figma.com/v1/me";
    const fileUrl = `https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}`;
    const nodeUrl = nodeId
      ? `https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(nodeId)}`
      : null;

    // Validate "Personal Access Token" using X-Figma-Token only.
    let me: Attempt[];
    try {
      await assertPersonalAccessToken(token);
      me = [{ headerStyle: "x_figma_token", ok: true, status: 200, errorCategory: null, message: "OK" }];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const lower = msg.toLowerCase();
      me = [
        {
          headerStyle: "x_figma_token",
          ok: false,
          status: lower.includes("http 401") ? 401 : lower.includes("http 403") ? 403 : null,
          errorCategory:
            lower.includes("invalid token") || lower.includes("personal access token")
              ? "invalid_token"
              : lower.includes("네트워크") || lower.includes("network")
                ? "network_blocked"
                : "unknown_error",
          message: msg,
        },
      ];
    }

    const file = await runAttempts(fileUrl, token);
    const node = nodeUrl ? await runAttempts(nodeUrl, token) : undefined;

    const verdict = pickVerdict({ me, file, node });

    const out: DiagnoseResponse = {
      ok: true,
      input: { fileKey, nodeId },
      tokenProvided,
      checks: { me, file, ...(node ? { node } : {}) },
      verdict,
    };
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

async function runAttempts(url: string, token: string): Promise<Attempt[]> {
  const out: Attempt[] = [];
  try {
    const res = await fetch(url, { headers: { "X-Figma-Token": token }, cache: "no-store" });
    const text = await safeReadText(res);
    const cat = categorize(res.status, text);
    out.push({
      headerStyle: "x_figma_token",
      ok: res.ok,
      status: res.status,
      errorCategory: res.ok ? null : cat,
      message: res.ok ? "OK" : `HTTP ${res.status}`,
      responseSnippet: text ? truncate(text, 260) : undefined,
    });
  } catch (e) {
    out.push({
      headerStyle: "x_figma_token",
      ok: false,
      status: null,
      errorCategory: "network_blocked",
      message: e instanceof Error ? e.message : String(e),
    });
  }
  return out;
}

function categorize(status: number, bodyText: string): Attempt["errorCategory"] {
  const t = bodyText.toLowerCase();
  if (status === 401 || status === 403) {
    if (t.includes("invalid token")) return "invalid_token";
    return "no_permission";
  }
  if (status === 404) return "not_found";
  return "unknown_error";
}

function pickVerdict(checks: { me: Attempt[]; file: Attempt[]; node?: Attempt[] }) {
  const anyNetworkBlocked =
    checks.me.some((a) => a.errorCategory === "network_blocked") ||
    checks.file.some((a) => a.errorCategory === "network_blocked") ||
    (checks.node?.some((a) => a.errorCategory === "network_blocked") ?? false);
  if (anyNetworkBlocked) return "network_blocked";

  const meBest = bestAttempt(checks.me);
  if (!meBest?.ok) {
    if (meBest?.errorCategory === "invalid_token") return "invalid_token";
    if (meBest?.errorCategory === "no_permission") return "no_permission";
    return "invalid_token";
  }

  const fileBest = bestAttempt(checks.file);
  if (!fileBest?.ok) {
    if (fileBest?.status === 404) return "file_not_found";
    if (fileBest?.errorCategory === "no_permission") return "no_permission";
    return "no_permission";
  }

  if (checks.node) {
    const nodeBest = bestAttempt(checks.node);
    if (!nodeBest?.ok) {
      if (nodeBest?.status === 404) return "node_not_found";
      if (nodeBest?.errorCategory === "not_found") return "node_not_found";
      return "node_not_found";
    }
  }

  return "ok";
}

function bestAttempt(attempts: Attempt[]): Attempt | null {
  if (!attempts.length) return null;
  return attempts.find((a) => a.ok) ?? attempts[0];
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function truncate(s: string, max: number) {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

