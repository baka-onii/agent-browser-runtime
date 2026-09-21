// Evasion init scripts: make the JS surface read like an ordinary human-driven Chrome.
// Injected via Page.addScriptToEvaluateOnNewDocument on every page session, so they run
// before page scripts AND propagate to iframes. Bounded goal: normal-sites hygiene only —
// no attempt to defeat hardened endpoints (Cloudflare/DataDome), no CAPTCHA handling.
// NOTE: primary webdriver defense is the launch flag
// --disable-blink-features=AutomationControlled (transport.ts); this script is second-line.
export const EVASION_JS = `(() => {
  try {
    // --- navigator.webdriver: the launch flag (--disable-blink-features=AutomationControlled)
    // already yields the NATIVE getter returning false — do not touch that perfect state.
    // Only patch when automation is actually exposed (e.g. attached foreign Chrome),
    // since a redefined getter (descriptor present, non-native toString) is itself a tell.
    try {
      if (navigator.webdriver === true) {
        Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => undefined });
      }
    } catch {}
    // --- navigator.plugins / mimeTypes: ONLY patch when empty (bot-shaped).
    // New headless already ships the real native PluginArray — replacing it with a
    // JS fabrication fails 'instanceof PluginArray' (a known tell). Same rule below:
    // never overwrite a healthy native value with a proxy.
    try {
      if (navigator.plugins.length === 0) {
        const plugins = [
          { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: 'Portable Document Format' },
          { name: 'Chromium PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: 'Portable Document Format' },
          { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        ];
        Object.defineProperty(Navigator.prototype, 'plugins', { get: () => plugins });
        Object.defineProperty(Navigator.prototype, 'mimeTypes', { get: () => [
          { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
        ]});
      }
    } catch {}
    // --- languages / vendor / hardwareConcurrency: only fill bot-shaped gaps ---
    try { if (!navigator.languages || navigator.languages.length === 0) Object.defineProperty(Navigator.prototype, 'languages', { get: () => ['en-US', 'en'] }); } catch {}
    try { if (!navigator.vendor || navigator.vendor === '') Object.defineProperty(Navigator.prototype, 'vendor', { get: () => 'Google Inc.' }); } catch {}
    try { if (!navigator.hardwareConcurrency) Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => 8 }); } catch {}
    try { if (!navigator.deviceMemory) Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => 8 }); } catch {}
    // --- window.chrome surface (app/csi/loadTimes/runtime) ---
    try {
      if (!window.chrome) (window).chrome = {};
      const c = window.chrome;
      if (!c.app) c.app = { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } };
      if (!c.csi) c.csi = function(){};
      if (!c.loadTimes) c.loadTimes = function(){};
      if (!c.runtime) c.runtime = { OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' }, OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' }, PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' }, PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' }, PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' }, RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' } };
    } catch {}
    // --- permissions.query: keep notifications consistent with real Chrome ---
    try {
      const orig = Permissions.prototype.query;
      Permissions.prototype.query = function (p) {
        if (p && p.name === 'notifications') {
          const denied = Notification.permission === 'denied';
          return Promise.resolve({ state: denied ? 'denied' : 'prompt', onchange: null });
        }
        return orig.call(this, p);
      };
    } catch {}
    // --- outer dimensions (headless reports 0) ---
    try {
      if (window.outerWidth === 0) Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth });
      if (window.outerHeight === 0) Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 80 });
    } catch {}
    // --- media codecs: report Chrome-real support ---
    try {
      const origIsType = MediaSource.isTypeSupported;
      MediaSource.isTypeSupported = function (t) {
        if (/mp4|avc|webm|vp9|opus|vorbis/i.test(String(t))) return true;
        return origIsType.call(this, t);
      };
      const m = HTMLMediaElement.prototype;
      const origCanPlay = m.canPlayType;
      m.canPlayType = function (t) {
        if (/mp4/i.test(String(t))) return 'probably';
        if (/webm/i.test(String(t))) return 'maybe';
        return origCanPlay.call(this, t);
      };
    } catch {}
    // --- webgl: hide SwiftShader software renderer tell ---
    try {
      const getParam = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function (p) {
        if (p === 37445) return 'Google Inc. (Intel)';
        if (p === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)';
        return getParam.call(this, p);
      };
      if (window.WebGL2RenderingContext) {
        const getParam2 = WebGL2RenderingContext.prototype.getParameter;
        WebGL2RenderingContext.prototype.getParameter = function (p) {
          if (p === 37445) return 'Google Inc. (Intel)';
          if (p === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)';
          return getParam2.call(this, p);
        };
      }
    } catch {}
    try { window.__abrEvasion = 1; } catch {}
  } catch {}
})();`;
