import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

process.stdin.setEncoding("utf8");

let buf = "";
process.stdin.on("data", (d) => (buf += d));
process.stdin.on("end", async () => {
  try {
    const payload = JSON.parse(buf || "{}");
    const jobId = String(payload.jobId || "");
    const req = payload.request;
    if (!jobId || !req) throw new Error("Invalid runner payload");

    const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
    const log = (msg, extra) => send({ type: "log", jobId, msg, extra: extra ?? null, ts: Date.now() });

    const t0 = Date.now();

    const { fileKey, nodeId } = parseFigma(req.figma.devModeUrlOrFileKey, req.figma.nodeId);
    if (!nodeId) throw new Error("Figma Node ID가 필요합니다.");

    const token = req.figma.personalAccessToken || process.env.FIGMA_TOKEN;
    if (!token) throw new Error("Figma Personal Access Token이 없습니다.");

    log("figma token check start");
    await figmaMe(token);
    log("figma token check ok");

    log("figma extract start", { fileKey, nodeId });
    const nodeDoc = await figmaNodes(token, fileKey, nodeId);
    const tokens = extractTokens(nodeDoc, 250);
    log("figma extract ok", { tokens: tokens.length });

    log("playwright launch start", { executablePath: chromium.executablePath() });
    const browser = await launchBrowser(log);
    log("playwright launch ok");

    try {
      const viewport = presetViewport(req.viewportPreset);
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: viewport.deviceScaleFactor,
        userAgent: UA,
      });
      const page = await context.newPage();
      page.setDefaultTimeout(60_000);

      log("page goto start", { url: req.url });
      const res = await page.goto(req.url, { waitUntil: "networkidle", timeout: 60_000 });
      if (!res) throw new Error("URL 접속 실패");
      if (!res.ok()) throw new Error(`URL 접속 실패: HTTP ${res.status()}`);
      log("page goto ok", { status: res.status() });

      log("web extract start", { classNames: tokens.length });
      const webData = await page.evaluate((names) => {
        const pick = (cs, k) => String(cs[k] ?? "");
        const out = {};
        for (const name of names) {
          const sel = "." + (globalThis.CSS && "escape" in globalThis.CSS ? CSS.escape(name) : name);
          const el = document.querySelector(sel);
          if (!el) {
            out[name] = { found: false };
            continue;
          }
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          out[name] = {
            found: true,
            bbox: { x: r.x, y: r.y, width: r.width, height: r.height },
            classList: Array.from(el.classList),
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
              backgroundColor: pick(cs, "backgroundColor"),
              borderRadius: pick(cs, "borderRadius"),
              opacity: pick(cs, "opacity"),
              transitionDuration: pick(cs, "transitionDuration"),
              transitionTimingFunction: pick(cs, "transitionTimingFunction"),
            },
          };
        }
        return out;
      }, tokens.map((t) => t.className));
      log("web extract ok");

      const results = tokens.map((t) => {
        const entry = webData[t.className];
        if (!entry || entry.found === false) {
          return { className: t.className, selector: "." + t.className, severity: "fail", diffs: [{ key: "element", figma: "expected", web: "not found", delta: null }], bbox: null, elementFound: false };
        }
        return { className: t.className, selector: "." + t.className, severity: "pass", diffs: [], bbox: entry.bbox, elementFound: true };
      });

      log("screenshot start");
      const screenshotBuf = await page.screenshot({ fullPage: false, type: "png" });
      log("screenshot ok", { bytes: screenshotBuf.byteLength });

      const summary = summarize(results);
      send({
        type: "result",
        jobId,
        ok: true,
        response: {
          ok: true,
          viewport,
          screenshot: { mimeType: "image/png", base64: screenshotBuf.toString("base64") },
          summary,
          results,
          meta: {
            url: req.url,
            figma: { fileKey, nodeId },
            thresholdPx: req.thresholdPx,
            timingsMs: { total: Date.now() - t0 },
          },
        },
      });
    } finally {
      await browser.close().catch(() => {});
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stdout.write(JSON.stringify({ type: "result", ok: false, response: { ok: false, stage: "runner", error: msg } }) + "\n");
  }
});

function parseFigma(devModeUrlOrKey, nodeIdOverride) {
  const input = String(devModeUrlOrKey || "").trim();
  let fileKey = input;
  let nodeId = nodeIdOverride ? normalizeNodeId(nodeIdOverride) : null;
  if (input.startsWith("http")) {
    const u = new URL(input);
    const parts = u.pathname.split("/").filter(Boolean);
    const keyIdx = parts.indexOf("design") >= 0 ? parts.indexOf("design") + 1 : parts.indexOf("file") + 1;
    if (keyIdx >= 1 && parts[keyIdx]) fileKey = parts[keyIdx];
    const rawNode = u.searchParams.get("node-id") || u.searchParams.get("node_id");
    if (!nodeId && rawNode) nodeId = normalizeNodeId(rawNode);
  }
  return { fileKey, nodeId };
}

function normalizeNodeId(input) {
  const raw = String(input || "").trim();
  const s = raw.replace(/\s+/g, "");
  const m = s.match(/(\d+)\s*[:-]\s*(\d+)/);
  if (m) return `${m[1]}:${m[2]}`;
  const m2 = s.match(/(\d+):(\d+)/);
  if (m2) return `${m2[1]}:${m2[2]}`;
  return raw;
}

async function figmaMe(token) {
  const res = await fetch("https://api.figma.com/v1/me", { headers: { "X-Figma-Token": token }, cache: "no-store" });
  if (res.ok) return;
  const text = await res.text().catch(() => "");
  throw new Error(`Figma /me 실패: HTTP ${res.status} ${text}`);
}

async function figmaNodes(token, fileKey, nodeId) {
  const url = `https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(nodeId)}`;
  const res = await fetch(url, { headers: { "X-Figma-Token": token }, cache: "no-store" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Figma nodes 실패: HTTP ${res.status} ${text}`);
  }
  const json = await res.json();
  const doc = json?.nodes?.[nodeId]?.document;
  if (!doc) throw new Error("Figma node document를 찾지 못했습니다.");
  return doc;
}

function extractTokens(doc, max) {
  const uniq = new Map();
  const stack = [doc];
  while (stack.length) {
    const n = stack.pop();
    const name = typeof n?.name === "string" ? n.name.trim() : "";
    if (name && !uniq.has(name)) {
      uniq.set(name, { className: name });
      if (uniq.size >= max) break;
    }
    const children = Array.isArray(n?.children) ? n.children : [];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return Array.from(uniq.values());
}

function presetViewport(p) {
  if (p === "mobile") return { width: 390, height: 844, deviceScaleFactor: 2 };
  if (p === "tablet") return { width: 768, height: 1024, deviceScaleFactor: 2 };
  return { width: 1440, height: 900, deviceScaleFactor: 2 };
}

async function launchBrowser(log) {
  // Prefer headless-shell binary (not .app bundle) to avoid macOS app-spawn issues in restricted envs.
  const chromiumPath = chromium.executablePath();
  const headlessShellPath = chromiumPath
    .replace("/chromium-1208/", "/chromium_headless_shell-1208/")
    .replace(
      "/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "/chrome-headless-shell-mac-x64/chrome-headless-shell"
    );

  const attempts = [
    { label: "chromium_headless_shell", executablePath: headlessShellPath },
    { label: "chromium_default", executablePath: undefined },
  ];

  let lastErr = null;
  for (const a of attempts) {
    try {
      log("playwright launch attempt", { label: a.label, executablePath: a.executablePath ?? chromiumPath });
      const browser = await chromium.launch({
        headless: true,
        timeout: 60_000,
        ...(a.executablePath ? { executablePath: a.executablePath } : null),
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
      return browser;
    } catch (e) {
      lastErr = e;
      log("playwright launch attempt failed", { label: a.label, message: e instanceof Error ? e.message : String(e) });
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? "launch failed"));
}

function summarize(results) {
  let pass = 0, warn = 0, fail = 0, missing = 0;
  for (const r of results) {
    if (!r.elementFound) missing++;
    if (r.severity === "pass") pass++; else if (r.severity === "warn") warn++; else fail++;
  }
  return { total: results.length, pass, warn, fail, missing };
}

