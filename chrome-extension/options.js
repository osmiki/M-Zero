const originInput = document.getElementById("origin");
const saveBtn = document.getElementById("save");
const savedEl = document.getElementById("saved");

const DEFAULT_ORIGIN = "https://design-qa-agent.vercel.app";
const LEGACY_DEFAULT_ORIGINS = [
  "https://m-zero-production.up.railway.app",
  "http://127.0.0.1:3023",
  "http://127.0.0.1:3024",
  "http://127.0.0.1:3025",
  "http://127.0.0.1:3026",
  "http://127.0.0.1:3027",
  "http://127.0.0.1:3028",
];

async function load() {
  const { appOrigin } = await chrome.storage.sync.get({ appOrigin: DEFAULT_ORIGIN });
  const norm = normalizeOrigin(String(appOrigin).trim()) ?? DEFAULT_ORIGIN;
  if (LEGACY_DEFAULT_ORIGINS.includes(norm)) {
    await chrome.storage.sync.set({ appOrigin: DEFAULT_ORIGIN });
    originInput.value = DEFAULT_ORIGIN;
    return;
  }
  if (norm !== appOrigin) {
    await chrome.storage.sync.set({ appOrigin: norm });
  }
  originInput.value = norm;
}

function normalizeOrigin(s) {
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

saveBtn.addEventListener("click", async () => {
  savedEl.textContent = "";
  const norm = normalizeOrigin(originInput.value.trim());
  if (!norm) {
    savedEl.textContent = "Invalid URL";
    return;
  }
  await chrome.storage.sync.set({ appOrigin: norm });
  savedEl.textContent = "Saved";
});

load();

