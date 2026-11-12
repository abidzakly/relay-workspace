// Runs before React to avoid a light/dark flash. Reads the persisted Zustand store (key: core-ui).
(function () {
  try {
    // Same hours as skyPhase in lib/daypart.ts. Set first, so it survives a failure reading the store.
    var h = new Date().getHours();
    document.documentElement.dataset.daypart =
      h >= 5 && h < 8 ? 'dawn' : h >= 8 && h < 17 ? 'day' : h >= 17 && h < 19 ? 'dusk' : 'night';
    var raw = localStorage.getItem('core-ui');
    var theme = raw ? (JSON.parse(raw).state || {}).theme : null;
    // Same rule as resolveDark in store/ui.ts: anything but an explicit choice follows the OS.
    var dark =
      theme === 'dark' || (theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
  } catch {
    /* ignore */
  }
})();
