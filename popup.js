const DEFAULTS = {
  enabled: true,
  keepActive: 3,
  protectPinned: true,
  protectAudible: true,
  graceMs: 8000,
  protectCalls: true,
  audibleHoldMin: 10,
  checkMinutes: 1
};

const $ = id => document.getElementById(id);
const clamp = (v, lo, hi, dflt) => Math.min(hi, Math.max(lo, parseInt(v, 10) || dflt));

let statusTimer = null;

function fill(c) {
  $('enabled').checked = c.enabled;
  $('keepActive').value = c.keepActive;
  $('protectPinned').checked = c.protectPinned;
  $('protectAudible').checked = c.protectAudible;
  $('protectCalls').checked = c.protectCalls;
  $('audibleHoldMin').value = c.audibleHoldMin;
  $('graceSec').value = Math.round((c.graceMs || 0) / 1000);
  $('checkMinutes').value = c.checkMinutes;
}

async function load() {
  const c = await chrome.storage.sync.get(DEFAULTS);
  fill({ ...DEFAULTS, ...c });
  refreshStatus();
}

async function save() {
  const keep = clamp($('keepActive').value, 1, 20, 3);
  const graceSec = clamp($('graceSec').value, 0, 600, 8);
  const checkMinutes = clamp($('checkMinutes').value, 1, 60, 1);
  const audibleHoldMin = clamp($('audibleHoldMin').value, 0, 120, 10);
  $('audibleHoldMin').value = audibleHoldMin;
  $('keepActive').value = keep;
  $('graceSec').value = graceSec;
  $('checkMinutes').value = checkMinutes;

  await chrome.storage.sync.set({
    enabled: $('enabled').checked,
    keepActive: keep,
    protectPinned: $('protectPinned').checked,
    protectAudible: $('protectAudible').checked,
    protectCalls: $('protectCalls').checked,
    audibleHoldMin,
    graceMs: graceSec * 1000,
    checkMinutes
  });
  chrome.runtime.sendMessage('enforce');
  refreshStatus();
}

async function reset() {
  await chrome.storage.sync.set(DEFAULTS);
  fill(DEFAULTS);
  chrome.runtime.sendMessage('enforce');
  refreshStatus();
}

function refreshStatus() {
  chrome.runtime.sendMessage('status', s => {
    if (chrome.runtime.lastError || !s) { $('status').textContent = ''; return; }
    $('status').textContent =
      `Tabs: ${s.total} · discarded: ${s.discarded}` +
      (s.audible ? ` · audible: ${s.audible}` : '') +
      (s.calls ? ` · in call: ${s.calls}` : '');
  });
}

['enabled', 'protectPinned', 'protectAudible', 'protectCalls'].forEach(id => $(id).addEventListener('change', save));
['keepActive', 'graceSec', 'checkMinutes', 'audibleHoldMin'].forEach(id => $(id).addEventListener('change', save));

$('discardNow').addEventListener('click', () => {
  chrome.runtime.sendMessage('discardNow', () => setTimeout(refreshStatus, 400));
});
$('reset').addEventListener('click', reset);

statusTimer = setInterval(refreshStatus, 2000);
window.addEventListener('unload', () => clearInterval(statusTimer));

load();
