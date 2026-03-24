import { NextResponse } from "next/server";
import { z } from "zod";
import { spawn } from "node:child_process";
import path from "node:path";
import { createJobId, putJob, redactRequest, setJobResult, setJobRunning, appendLog, type RunRequest } from "@/lib/jobs";

export const runtime = "nodejs";

const BodySchema = z.object({
  url: z.string().url(),
  figma: z.object({
    devModeUrlOrFileKey: z.string().min(1),
    nodeId: z.string().optional(),
    personalAccessToken: z.string().optional(),
  }),
  viewportPreset: z.enum(["mobile", "tablet", "pc"]).default("pc"),
  thresholdPx: z.number().min(0).max(50).default(2),
});

export async function POST(req: Request) {
  try {
    const body = BodySchema.parse(await req.json());
    const jobId = createJobId();
    const safeReq = redactRequest(body as RunRequest);

    putJob({
      id: jobId,
      status: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      request: safeReq,
      logs: [],
    });

    // Run in a child process to prevent Chromium launch hangs from blocking this server process.
    queueMicrotask(() => {
      setJobRunning(jobId);
      const runnerPath = path.resolve(process.cwd(), "qa-runner.mjs");
      const child = spawn(process.execPath, [runnerPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });

      const append = (line: string) => {
        console.log(line);
        appendLog(jobId, line);
      };

      let stdoutBuf = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d) => {
        stdoutBuf += d;
        let idx;
        while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
          const line = stdoutBuf.slice(0, idx).trim();
          stdoutBuf = stdoutBuf.slice(idx + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === "log") {
              const rendered = `[job:${jobId}] ${msg.msg}${msg.extra ? " " + JSON.stringify(msg.extra) : ""}`;
              append(rendered);
            } else if (msg.type === "result") {
              setJobResult(jobId, msg.response);
            }
          } catch {
            append(`[job:${jobId}] ${line}`);
          }
        }
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d) => {
        append(`[job:${jobId}] [stderr] ${String(d).trim()}`);
      });

      child.on("exit", (code, signal) => {
        if (code === 0) return;
        // If we haven't set a result yet, mark failed.
        setJobResult(jobId, {
          ok: false,
          stage: "runner_exit",
          error: `runner exited code=${code} signal=${signal ?? ""}`,
        });
      });

      // Hard kill if child hangs.
      const killTimer = setTimeout(() => {
        append(`[job:${jobId}] runner timeout -> killing process`);
        child.kill("SIGKILL");
        setJobResult(jobId, { ok: false, stage: "runner_timeout", error: "runner가 시간 내 종료되지 않아 중단되었습니다." });
      }, 120_000);
      child.on("exit", () => clearTimeout(killTimer));

      child.stdin.write(JSON.stringify({ jobId, request: body }) + "\n");
      child.stdin.end();
    });

    return NextResponse.json({ ok: true, jobId });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Unknown error" },
      { status: 400 }
    );
  }
}

