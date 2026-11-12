(() => {
  const md = navigator.mediaDevices;
  if (!md || md.__tkPatched) return;
  md.__tkPatched = true;
  const tracks = new Set();
  let last = false;

  const report = () => {
    for (const t of tracks) if (t.readyState !== 'live') tracks.delete(t);
    const active = tracks.size > 0;
    if (active !== last || active) {
      last = active;
      window.postMessage({ __tabKeeperCall: true, active }, '*');
    }
  };

  const wrap = name => {
    const orig = md[name];
    if (typeof orig !== 'function') return;
    md[name] = async function (...args) {
      const stream = await orig.apply(this, args);
      for (const t of stream.getTracks()) {
        tracks.add(t);
        t.addEventListener('ended', report);
      }
      report();
      return stream;
    };
  };
  wrap('getUserMedia');
  wrap('getDisplayMedia');

  const stop = MediaStreamTrack.prototype.stop;
  MediaStreamTrack.prototype.stop = function () {
    stop.call(this);
    setTimeout(report, 0);
  };
  setInterval(report, 5000);
})();
