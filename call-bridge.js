window.addEventListener('message', e => {
  if (e.source !== window || !e.data || !e.data.__tabKeeperCall) return;
  try { chrome.runtime.sendMessage({ type: 'call', active: !!e.data.active }); } catch (_) {}
});
