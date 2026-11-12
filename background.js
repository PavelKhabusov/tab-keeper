// Tab Keeper keeps only the N most recently used tabs alive and discards the rest
// (chrome.tabs.discard: the tab stays in the strip and reloads on click).
// Never discarded: active tabs, the last N by lastAccessed, tabs used within the
// grace period, and optionally pinned, audible and in-call tabs.

const DEFAULTS = {
  enabled: true,
  keepActive: 3,        // how many recent tabs stay alive
  protectPinned: true,  // skip pinned tabs
  protectAudible: true, // skip tabs playing audio
  graceMs: 8000,        // skip tabs used within the last N ms
  protectCalls: true,   // skip tabs with mic/camera/screen share on
  audibleHoldMin: 10,   // keep protecting N minutes after audio stops (pauses in a call)
  checkMinutes: 1       // fallback alarm period
};

async function getCfg() {
  const c = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...c };
}

// internal pages (chrome://, about:, extensions, devtools) can't be discarded
function isDiscardable(tab) {
  if (!tab || tab.discarded) return false;
  const u = tab.url || tab.pendingUrl || '';
  return /^(https?|file|ftp):/i.test(u);
}

// calls: tabId -> frameIds with live mic/camera; lastAudible: tabId -> last audio time
async function getSession() {
  const { calls = {}, lastAudible = {} } = await chrome.storage.session.get(['calls', 'lastAudible']);
  return { calls, lastAudible };
}

async function setCall(tabId, frameId, active) {
  const { calls } = await getSession();
  const frames = new Set(calls[tabId] || []);
  active ? frames.add(frameId) : frames.delete(frameId);
  if (frames.size) calls[tabId] = [...frames]; else delete calls[tabId];
  await chrome.storage.session.set({ calls });
}

async function markAudible(tabs) {
  const { lastAudible } = await getSession();
  const now = Date.now();
  let changed = false;
  for (const t of tabs) if (t.audible) { lastAudible[t.id] = now; changed = true; }
  if (changed) await chrome.storage.session.set({ lastAudible });
  return lastAudible;
}

function isProtectedCall(tab, cfg, sess, now) {
  if (cfg.protectCalls && sess.calls[tab.id]) return true;
  if (cfg.protectAudible && tab.audible) return true;
  const la = sess.lastAudible[tab.id];
  return !!(cfg.protectAudible && la && now - la < cfg.audibleHoldMin * 60000);
}

let timer = null;
function scheduleEnforce(delay = 600) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; enforce(); }, delay);
}

async function enforce() {
  const cfg = await getCfg();
  if (!cfg.enabled) return;

  let tabs;
  try { tabs = await chrome.tabs.query({}); } catch (e) { return; }
  if (!tabs.length) return;

  const now = Date.now();
  const sess = await getSession();
  sess.lastAudible = await markAudible(tabs);

  // most recently used first
  const ranked = tabs.slice().sort(
    (a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0)
  );

  const keepSet = new Set(ranked.slice(0, Math.max(1, cfg.keepActive)).map(t => t.id));

  for (let i = 0; i < ranked.length; i++) {
    const tab = ranked[i];
    if (keepSet.has(tab.id)) continue;
    if (tab.active) continue;
    if (cfg.protectPinned && tab.pinned) continue;
    if (isProtectedCall(tab, cfg, sess, now)) continue;
    if (cfg.graceMs && tab.lastAccessed && (now - tab.lastAccessed) < cfg.graceMs) continue;
    if (!isDiscardable(tab)) continue;

    try { await chrome.tabs.discard(tab.id); } catch (e) {}
  }
}

// one-off "Discard others now" from the popup
async function discardNow() {
  const cfg = await getCfg();
  const tabs = await chrome.tabs.query({});
  const now = Date.now();
  const sess = await getSession();
  sess.lastAudible = await markAudible(tabs);
  const ranked = tabs.slice().sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  const keepSet = new Set(ranked.slice(0, Math.max(1, cfg.keepActive)).map(t => t.id));
  for (const tab of ranked) {
    if (keepSet.has(tab.id) || tab.active) continue;
    if (cfg.protectPinned && tab.pinned) continue;
    if (isProtectedCall(tab, cfg, sess, now)) continue;
    if (!isDiscardable(tab)) continue;
    try { await chrome.tabs.discard(tab.id); } catch (e) {}
  }
}

async function getStatus() {
  const tabs = await chrome.tabs.query({});
  const { calls } = await getSession();
  return {
    calls: tabs.filter(t => calls[t.id]).length,
    total: tabs.length,
    discarded: tabs.filter(t => t.discarded).length,
    audible: tabs.filter(t => t.audible).length
  };
}

// re-evaluate on tab events
chrome.tabs.onActivated.addListener(() => scheduleEnforce());
chrome.tabs.onCreated.addListener(() => scheduleEnforce());
chrome.tabs.onUpdated.addListener((id, info) => {
  if (info.status === 'loading') clearTab(id, true);
  if (info.status === 'complete' || info.audible !== undefined) scheduleEnforce(1200);
});
chrome.windows.onFocusChanged.addListener(() => scheduleEnforce());
chrome.runtime.onStartup.addListener(() => scheduleEnforce(2000));
chrome.runtime.onInstalled.addListener(() => scheduleEnforce(2000));

async function clearTab(tabId, callsOnly) {
  const { calls, lastAudible } = await getSession();
  delete calls[tabId];
  if (!callsOnly) delete lastAudible[tabId];
  await chrome.storage.session.set({ calls, lastAudible });
}
chrome.tabs.onRemoved.addListener(id => clearTab(id, false));

// the service worker may sleep, so an alarm wakes it up
async function setupAlarm() {
  const cfg = await getCfg();
  const mins = Math.min(60, Math.max(1, cfg.checkMinutes || 1));
  chrome.alarms.create('enforce', { periodInMinutes: mins });
}
setupAlarm();
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'enforce') enforce(); });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.checkMinutes) setupAlarm();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'call' && sender.tab) {
    setCall(sender.tab.id, sender.frameId || 0, msg.active);
    return;
  }
  if (msg === 'discardNow') { discardNow().then(() => sendResponse(true)); return true; }
  if (msg === 'enforce') { enforce().then(() => sendResponse(true)); return true; }
  if (msg === 'status') { getStatus().then(sendResponse); return true; }
});
