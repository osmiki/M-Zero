import crypto from "crypto";

export type FigmaSession = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // epoch ms
  userIdString?: string;
};

export type SessionRecord = {
  id: string;
  createdAt: number;
  figma?: FigmaSession;
};

const SESSION_COOKIE = "dqa_session";

type StoreShape = {
  sessions: Map<string, SessionRecord>;
  oauthStates: Map<
    string,
    {
      createdAt: number;
      codeVerifier: string;
      redirectUri: string;
    }
  >;
};

function getStore(): StoreShape {
  const g = globalThis as any;
  if (!g.__DQA_STORE__) {
    g.__DQA_STORE__ = {
      sessions: new Map<string, SessionRecord>(),
      oauthStates: new Map(),
    } satisfies StoreShape;
  }
  return g.__DQA_STORE__ as StoreShape;
}

export function getSessionCookieName() {
  return SESSION_COOKIE;
}

export function newId(prefix: string) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

export function createOAuthState(args: { redirectUri: string; codeVerifier: string }) {
  const store = getStore();
  const state = newId("st");
  store.oauthStates.set(state, { createdAt: Date.now(), ...args });
  return state;
}

export function consumeOAuthState(state: string) {
  const store = getStore();
  const v = store.oauthStates.get(state);
  if (!v) return null;
  store.oauthStates.delete(state);
  // Basic TTL guard (5 minutes)
  if (Date.now() - v.createdAt > 5 * 60_000) return null;
  return v;
}

export function createSession() {
  const store = getStore();
  const id = newId("sess");
  const rec: SessionRecord = { id, createdAt: Date.now() };
  store.sessions.set(id, rec);
  return rec;
}

export function getSession(id: string | null | undefined) {
  if (!id) return null;
  const store = getStore();
  return store.sessions.get(id) ?? null;
}

export function setFigmaSession(sessionId: string, figma: FigmaSession) {
  const store = getStore();
  const rec = store.sessions.get(sessionId) ?? { id: sessionId, createdAt: Date.now() };
  rec.figma = figma;
  store.sessions.set(sessionId, rec);
  return rec;
}

export function deleteSession(id: string) {
  const store = getStore();
  store.sessions.delete(id);
}

export function sha256Base64Url(input: string) {
  const hash = crypto.createHash("sha256").update(input).digest();
  return base64Url(hash);
}

export function base64Url(buf: Buffer) {
  return buf
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

