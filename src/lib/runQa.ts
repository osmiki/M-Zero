import { chromium } from "playwright";
import { compareTokenToComputed, type CompareConfig } from "@/lib/compare";
import {
  assertPersonalAccessToken,
  extractFigmaTokensFromNode,
  normalizeNodeId,
  parseFigmaDevModeUrl,
} from "@/lib/figma";
import { getViewport, type ViewportPreset } from "@/lib/viewport";
import type { RunRequest, RunResponse, RunSuccess } from "@/lib/jobs";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export async function runQa(
  jobId: string,
  req: RunRequest,
  log: (line: string, extra?: Record<string, unknown>) => void
): Promise<RunResponse> {
  const t0 = performance.now();
  const hardTimeout = <T,>(p: Promise<T>, ms: number, label: string) => withTimeout(p, ms, label);

  const figmaParsed = parseFigmaDevModeUrl(req.figma.devModeUrlOrFileKey);
  const fileKey = figmaParsed.fileKey ?? req.figma.devModeUrlOrFileKey.trim();
  const nodeId = normalizeNodeId(req.figma.nodeId ?? figmaParsed.nodeId ?? "");
  if (!nodeId) return { ok: false, stage: "input", error: "Figma Node ID가 필요합니다." };

  const token = req.figma.personalAccessToken ?? process.env.FIGMA_TOKEN;
  if (!token) return { ok: false, stage: "input", error: "Figma Personal Access Token이 없습니다." };

  const viewport = getViewport(req.viewportPreset as ViewportPreset);

  try {
    log("figma token check start");
    await hardTimeout(assertPersonalAccessToken(token), 15_000, "figma_token_check_timeout");
    log("figma token check ok");
  } catch (e) {
    return { ok: false, stage: "figma_token_check", error: e instanceof Error ? e.message : String(e) };
  }
  const tAfterToken = performance.now();

  let tokens: Awaited<ReturnType<typeof extractFigmaTokensFromNode>>["tokens"];
  try {
    log("figma extract start", { fileKey, nodeId });
    ({ tokens } = await hardTimeout(
      extractFigmaTokensFromNode({
        personalAccessToken: token,
        fileKey,
        nodeId,
        maxTokens: 300,
      }),
      35_000,
      "figma_extract_timeout"
    ));
    log("figma extract ok", { tokens: tokens.length });
  } catch (e) {
    return { ok: false, stage: "figma_extract", error: e instanceof Error ? e.message : String(e) };
  }
  const tAfterFigma = performance.now();

  const tokenCount = tokens.length;
  const MAX_TOKENS = 250;
  const truncated = tokenCount > MAX_TOKENS;
  if (truncated) tokens = tokens.slice(0, MAX_TOKENS);

  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    log("playwright launch start", { executablePath: chromium.executablePath() });
    browser = await hardTimeout(
      chromium.launch({
        headless: true,
        timeout: 60_000,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      }),
      65_000,
      "playwright_launch_timeout"
    );
    log("playwright launch ok");
  } catch (e) {
    return { ok: false, stage: "playwright_launch", error: e instanceof Error ? e.message : String(e) };
  }

  try {
    log("browser context create start", { viewport });
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.deviceScaleFactor,
      userAgent: UA,
    });
    log("browser context create ok");

    log("page new start");
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    log("page new ok");

    try {
      log("page goto start", { url: req.url });
      const res = await hardTimeout(
        page.goto(req.url, { waitUntil: "networkidle", timeout: 60_000 }),
        70_000,
        "web_goto_timeout"
      );
      if (!res) throw new Error("URL 접속 실패");
      if (!res.ok()) throw new Error(`URL 접속 실패: HTTP ${res.status()}`);
      log("page goto ok", { status: res.status() });
    } catch (e) {
      return { ok: false, stage: "web_goto", error: e instanceof Error ? e.message : String(e) };
    }
    const tAfterGoto = performance.now();

    const compareConfig: CompareConfig = { thresholdPx: req.thresholdPx };

    const classNames = tokens.map((t) => t.className);
    log("web extract start", { classNames: classNames.length });
    const webData = await hardTimeout(
      page.evaluate((names) => {
      const pick = (cs: CSSStyleDeclaration, k: keyof CSSStyleDeclaration) => String(cs[k] ?? "");
      const out: Record<
        string,
        | { found: false }
        | {
            found: true;
            bbox: { x: number; y: number; width: number; height: number };
            classList: string[];
            computed: Record<string, string>;
          }
      > = {};
      for (const name of names) {
        const sel = "." + (globalThis.CSS && "escape" in globalThis.CSS ? (CSS as any).escape(name) : name);
        const el = document.querySelector(sel);
        if (!el) {
          out[name] = { found: false };
          continue;
        }
        const r = (el as Element).getBoundingClientRect();
        const cs = getComputedStyle(el as Element);

        // Figma TEXT 노드가 컨테이너 엘리먼트에 매핑된 경우를 위해
        // TreeWalker로 가장 첫 번째 텍스트 자식 노드의 부모 element 색상을 fallback으로 추출
        let _textChildColor = "";
        try {
          const tw = document.createTreeWalker(
            el as Element,
            NodeFilter.SHOW_TEXT,
            { acceptNode: (n) => (n.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) }
          );
          const tn = tw.nextNode();
          if (tn && (tn as Text).parentElement && (tn as Text).parentElement !== el) {
            _textChildColor = getComputedStyle((tn as Text).parentElement!).color;
          }
        } catch {}

        out[name] = {
          found: true,
          bbox: { x: r.x, y: r.y, width: r.width, height: r.height },
          classList: Array.from((el as Element).classList),
          computed: {
            width: pick(cs, "width"),
            height: pick(cs, "height"),
            paddingTop: pick(cs, "paddingTop"),
            paddingRight: pick(cs, "paddingRight"),
            paddingBottom: pick(cs, "paddingBottom"),
            paddingLeft: pick(cs, "paddingLeft"),
            marginTop: pick(cs, "marginTop"),
            marginRight: pick(cs, "marginRight"),
            marginBottom: pick(cs, "marginBottom"),
            marginLeft: pick(cs, "marginLeft"),
            gap: pick(cs, "gap"),
            fontSize: pick(cs, "fontSize"),
            fontWeight: pick(cs, "fontWeight"),
            lineHeight: pick(cs, "lineHeight"),
            letterSpacing: pick(cs, "letterSpacing"),
            color: pick(cs, "color"),
            _textChildColor,
            backgroundColor: pick(cs, "backgroundColor"),
            borderRadius: pick(cs, "borderRadius"),
            borderTopWidth: pick(cs, "borderTopWidth"),
            borderRightWidth: pick(cs, "borderRightWidth"),
            borderBottomWidth: pick(cs, "borderBottomWidth"),
            borderLeftWidth: pick(cs, "borderLeftWidth"),
            borderTopColor: pick(cs, "borderTopColor"),
            borderRightColor: pick(cs, "borderRightColor"),
            borderBottomColor: pick(cs, "borderBottomColor"),
            borderLeftColor: pick(cs, "borderLeftColor"),
            borderTopStyle: pick(cs, "borderTopStyle"),
            outlineWidth: pick(cs, "outlineWidth"),
            outlineColor: pick(cs, "outlineColor"),
            outlineStyle: pick(cs, "outlineStyle"),
            opacity: pick(cs, "opacity"),
            boxShadow: pick(cs, "boxShadow"),
            transitionDuration: pick(cs, "transitionDuration"),
            transitionTimingFunction: pick(cs, "transitionTimingFunction"),
          },
        };
      }
      return out;
      }, classNames),
      25_000,
      "web_extract_timeout"
    );
    log("web extract ok");

    const results: RunSuccess["results"] = [];
    for (const t of tokens) {
      const className = t.className;
      const selector = `.${cssEscape(className)}`;
      const entry = (webData as any)[className] as any;
      if (!entry || entry.found === false) {
        const out = compareTokenToComputed(t, null, compareConfig);
        results.push({ className, selector, severity: "fail", diffs: out.diffs, bbox: null, elementFound: false });
        continue;
      }
      const computed = { classList: entry.classList as string[], computed: entry.computed as Record<string, string> };
      const out = compareTokenToComputed(t, computed, compareConfig);
      results.push({
        className,
        selector,
        severity: out.severity,
        diffs: out.diffs,
        bbox: entry.bbox ?? null,
        elementFound: true,
      });
    }
    const tAfterCompare = performance.now();

    log("screenshot start");
    const screenshotBuf = await hardTimeout(
      page.screenshot({ fullPage: false, type: "png" }),
      25_000,
      "screenshot_timeout"
    );
    log("screenshot ok", { bytes: screenshotBuf.byteLength });
    const tAfterShot = performance.now();

    const summary = summarize(results);
    const res: RunSuccess = {
      ok: true,
      viewport,
      screenshot: { mimeType: "image/png", base64: screenshotBuf.toString("base64") },
      summary,
      results,
      meta: {
        url: req.url,
        figma: { fileKey, nodeId },
        thresholdPx: req.thresholdPx,
        tokens: { total: tokenCount, used: tokens.length, truncated, max: MAX_TOKENS },
        timingsMs: {
          tokenCheck: Math.round(tAfterToken - t0),
          figmaExtract: Math.round(tAfterFigma - tAfterToken),
          webGoto: Math.round(tAfterGoto - tAfterFigma),
          compare: Math.round(tAfterCompare - tAfterGoto),
          screenshot: Math.round(tAfterShot - tAfterCompare),
          total: Math.round(tAfterShot - t0),
        },
      },
    };
    log("done", { summary: res.summary });
    return res;
  } catch (e) {
    return { ok: false, stage: "runtime", error: e instanceof Error ? e.message : String(e) };
  } finally {
    await browser?.close().catch(() => {});
  }
}

function summarize(results: RunSuccess["results"]) {
  let pass = 0;
  let warn = 0;
  let fail = 0;
  let missing = 0;
  for (const r of results) {
    if (!r.elementFound) missing++;
    if (r.severity === "pass") pass++;
    else if (r.severity === "warn") warn++;
    else fail++;
  }
  return { total: results.length, pass, warn, fail, missing };
}

function cssEscape(s: string) {
  return s.replace(/[^a-zA-Z0-9_-]/g, (m) => `\\${m}`);
}

async function withTimeout<T>(p: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let id: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, rej) => {
    id = setTimeout(() => rej(new Error(label)), timeoutMs);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (id) clearTimeout(id);
  }
}

