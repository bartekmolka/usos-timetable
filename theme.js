// Moduł motywów: stosuje ustawienia z widoku „Wygląd” (i opcjonalny własny CSS) na każdej
// stronie USOS. Działa od document_start, żeby nie było mignięcia domyślnego wyglądu.
// Ustawienia zapisuje content.js pod kluczem usosThemeSettings.
(function () {
  'use strict';

  const KEY = 'usosThemeSettings';
  const BG_ID = 'usos-theme-bg';

  const PANEL_VARS = {
    primary: '--usos-primary',
    accent: '--usos-accent',
    danger: '--usos-danger',
    panelBg: '--usos-panel-bg',
    text: '--usos-text',
  };

  let sheet = null;
  let mode = null; // 'adopted' | 'style'
  let styleEl = null;

  const isColor = (v) => typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v);
  const isDataImage = (v) => typeof v === 'string' && v.startsWith('data:image/');

  function buildCss(s) {
    const out = [];

    const vars = [];
    for (const [key, cssVar] of Object.entries(PANEL_VARS)) if (isColor(s[key])) vars.push(`${cssVar}:${s[key]}`);
    if (Number.isFinite(s.radius)) vars.push(`--usos-radius:${s.radius}px`);
    if (vars.length) out.push(`#usos-filter-panel{${vars.join(';')}}`);

    const hasBg = isDataImage(s.bgImage) || isColor(s.pageColor);
    if (hasBg) {
      // Tło leży na osobnej warstwie z-index:-1, więc niczego nie zasłania.
      // Elementy strony, które miały własne tło, robimy przezroczyste, żeby je było widać.
      out.push('html,body,usos-layout,#layout-container,main-panel{background:transparent !important}');
      if (isDataImage(s.bgImage)) {
        const a = Math.min(1, Math.max(0, (Number.isFinite(s.contentBacking) ? s.contentBacking : 85) / 100));
        out.push(
          `main#layout-main-content,menu-left{background:rgba(255,255,255,${a}) !important}` +
            (a > 0 ? 'main#layout-main-content{border-radius:6px}' : '')
        );
      }
    }

    if (s.custom) out.push(s.custom);
    return out.join('\n');
  }

  function applyCss(css) {
    if (mode !== 'style') {
      try {
        if (!sheet) {
          sheet = new CSSStyleSheet();
          document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
          mode = 'adopted';
        }
        sheet.replaceSync(css);
        return;
      } catch {
        sheet = null;
        mode = 'style'; // np. Firefox albo restrykcyjny CSP
      }
    }
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'usos-theme-style';
      (document.head || document.documentElement).appendChild(styleEl);
    }
    styleEl.textContent = css;
  }

  function applyBackground(s) {
    let el = document.getElementById(BG_ID);
    const image = isDataImage(s.bgImage) ? s.bgImage : null;
    const color = isColor(s.pageColor) ? s.pageColor : null;
    if (!image && !color) { el?.remove(); return; }

    if (!el) {
      el = document.createElement('div');
      el.id = BG_ID;
      document.documentElement.appendChild(el);
    }
    const dim = Math.min(80, Math.max(0, Number(s.bgDim) || 0)) / 100;
    const fit = s.bgFit || 'cover';
    const st = el.style;
    st.cssText = 'position:fixed;inset:0;z-index:-1;pointer-events:none;';
    st.backgroundColor = color || 'transparent';
    if (image) {
      st.backgroundImage = `url("${image}")`;
      st.backgroundPosition = 'center';
      st.backgroundRepeat = fit === 'tile' ? 'repeat' : 'no-repeat';
      st.backgroundSize = fit === 'tile' ? 'auto' : fit === 'stretch' ? '100% 100%' : fit;
    }
    if (dim) st.boxShadow = `inset 0 0 0 100vmax rgba(0,0,0,${dim})`;
  }

  function apply(res) {
    const s = res[KEY] || {};
    if (s.enabled === false) {
      applyCss('');
      document.getElementById(BG_ID)?.remove();
      return;
    }
    applyCss(buildCss(s));
    applyBackground(s);
  }

  const load = () => chrome.storage.local.get([KEY], apply);

  load();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && KEY in changes) load();
  });
})();
