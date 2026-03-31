const runBtn = document.getElementById("run");
const viewportSel = document.getElementById("viewport");
const statusEl = document.getElementById("status");
const msgEl = document.getElementById("msg");
const errEl = document.getElementById("err");
const optionsLink = document.getElementById("optionsLink");

optionsLink.addEventListener("click", async (e) => {
  e.preventDefault();
  await chrome.runtime.openOptionsPage();
});

function setStatus(s) {
  statusEl.textContent = s;
}

function setMsg(s) {
  msgEl.textContent = s;
}

function setErr(s) {
  errEl.textContent = s;
}

runBtn.addEventListener("click", async () => {
  runBtn.disabled = true;
  setErr("");
  setMsg("");
  setStatus("Extracting…");
  try {
    const viewport = viewportSel.value || undefined;
    const resp = await chrome.runtime.sendMessage({ type: "extract_upload_open", viewport });
    if (!resp?.ok) throw new Error(resp?.error || "Unknown error");
    setStatus("Done");
    setMsg(`webDataId: ${resp.webDataId}`);
    if (resp.fullPageError) setErr(`fullPage fail: ${resp.fullPageError}`);
  } catch (e) {
    setStatus("Failed");
    setErr(e instanceof Error ? e.message : String(e));
  } finally {
    runBtn.disabled = false;
  }
});
