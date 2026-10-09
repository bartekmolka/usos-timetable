(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Stałe
  // ---------------------------------------------------------------------------
  const KEYS = {
    selections: 'usosGroupFilterSelections',
    collapsed: 'usosGroupFilterCollapsed',
    lectureVis: 'usosLectureVisibility',
    global: 'usosGlobalSelections',
    geometry: 'usosGroupFilterGeometry',
    theme: 'usosThemeSettings',
    scale: 'usosPanelFontScale',
  };
  const HIDE_CLASS = 'usos-filter-hidden';
  const LECTURE = 'W';
  const NONE = '__none__';
  const SCALE_MIN = 0.8;
  const SCALE_MAX = 1.8;
  const SCALE_STEP = 0.1;

  // Kategorie przycisków globalnych: klucz, etykieta, typy zajęć, które obejmują
  const GLOBAL_CATEGORIES = [
    { key: 'CWL', label: 'CWL', types: ['CWL'] },
    { key: 'CWA_CWP', label: 'CWA/CWP', types: ['CWA', 'CWP'] },
    { key: 'W', label: 'W', types: ['W'] },
  ];
  const TYPE_ORDER = { CWL: 0, CWA: 1, CWP: 1, W: 3 };

  // ---------------------------------------------------------------------------
  // Stan
  // ---------------------------------------------------------------------------
  const state = {
    selections: {},                              // { courseId: { type: group | NONE } }
    collapsed: false,
    lectureVis: { global: true, courses: {} },   // tryb W bez grup
    global: { CWL: null, CWA_CWP: null, W: null },
    geometry: {},                                // { left, top, width, height }
    theme: {},                                   // ustawienia wyglądu (patrz THEME_FIELDS)
    fontScale: 1,
    themeOpen: false,
    entries: [],                                 // { courseId, courseName, type, group, setVisible(bool) }
    afterApply: null,                            // wywoływane po każdym przefiltrowaniu (tryb gif)
    courseMap: new Map(),
    globalInfo: {},
    useWGroups: false,
    anyLecture: false,
    status: '',                                  // komunikat zamiast listy (ładowanie / błąd)
    note: '',                                    // dopisek pod listą
  };
  let debounceTimer = null;
  let themeTimer = null;
  let scanning = false;

  function save() {
    chrome.storage.local.set({
      [KEYS.selections]: state.selections,
      [KEYS.collapsed]: state.collapsed,
      [KEYS.lectureVis]: state.lectureVis,
      [KEYS.global]: state.global,
      [KEYS.geometry]: state.geometry,
      [KEYS.scale]: state.fontScale,
    });
  }

  function saveTheme() {
    clearTimeout(themeTimer);
    themeTimer = setTimeout(() => chrome.storage.local.set({ [KEYS.theme]: state.theme }), 120);
  }

  const getSel = (courseId, type) => state.selections[courseId]?.[type];

  function setSel(courseId, type, group) {
    if (!group) {
      const course = state.selections[courseId];
      if (!course) return;
      delete course[type];
      if (Object.keys(course).length === 0) delete state.selections[courseId];
    } else {
      (state.selections[courseId] ||= {})[type] = group;
    }
  }

  // ---------------------------------------------------------------------------
  // Źródło danych: wspólne helpery
  // ---------------------------------------------------------------------------
  function parseInfo(text) {
    if (!text) return null;
    const clean = text.replace(/ /g, ' ').trim();
    const withGroup = clean.match(/^([A-Z]+)\s*,\s*gr\.\s*(\d+)/i);
    if (withGroup) return { type: withGroup[1].toUpperCase(), group: withGroup[2] };
    const typeOnly = clean.match(/^([A-Z]+)/i);
    if (typeOnly) return { type: typeOnly[1].toUpperCase(), group: null };
    return null;
  }

  // ---------------------------------------------------------------------------
  // Źródło A: plan "HTML (nowy)" – elementy <timetable-entry>
  // ---------------------------------------------------------------------------
  function collectNewUiEntries() {
    const result = [];
    for (const node of document.querySelectorAll('timetable-entry')) {
      const courseName = node.getAttribute('name') || 'Nieznany przedmiot';
      const courseId = node.getAttribute('name-id') || courseName;
      const parsed = parseInfo(node.querySelector('[slot="info"]')?.textContent);
      if (!parsed) continue;
      if (parsed.group === null && parsed.type !== LECTURE) continue;
      result.push({
        courseId,
        courseName,
        type: parsed.type,
        group: parsed.group,
        setVisible(visible) {
          node.classList.toggle(HIDE_CLASS, !visible);
          if (visible) node.style.removeProperty('display');
          else node.style.setProperty('display', 'none', 'important');
        },
      });
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Źródło B: plan "obrazek" (gif)
  //   Obrazek to bitmapa + <map name="plan_image_map"> z <area> (bez nazw!).
  //   Nazwy przedmiotów i typy zajęć bierzemy z wersji "HTML (nowy)" tego samego
  //   planu (po zaj_cyk_id). Plan jest składany od nowa: bloki wycinamy z oryginału
  //   i układamy ponownie, więc kolumny dni dopasowują się do pozostałych zajęć.
  // ---------------------------------------------------------------------------
  const isGifMode = () => !!document.querySelector('map[name="plan_image_map"]');

  function parseArea(area) {
    try {
      const url = new URL(area.getAttribute('href'), location.href);
      const zid = url.searchParams.get('zaj_cyk_id');
      const group = url.searchParams.get('gr_nr');
      const c = area.getAttribute('coords').split(',').map(Number);
      if (!zid || !group || c.length < 4 || c.some(Number.isNaN)) return null;
      return { zid, group, x1: c[0], y1: c[1], x2: c[2], y2: c[3], el: area };
    } catch {
      return null;
    }
  }

  // zaj_cyk_id -> { courseId, courseName, type }
  function extractMeta(root, quiet) {
    const meta = {};
    let sample = null;
    for (const node of root.querySelectorAll('timetable-entry')) {
      sample ||= node;
      const id = node.outerHTML.match(/zaj_cyk_id=(\d+)/)?.[1];
      const parsed = parseInfo(node.querySelector('[slot="info"]')?.textContent);
      if (!id || !parsed || meta[id]) continue;
      const name = node.getAttribute('name') || 'Nieznany przedmiot';
      meta[id] = { courseId: node.getAttribute('name-id') || name, courseName: name, type: parsed.type };
    }
    if (!quiet && sample && !Object.keys(meta).length) {
      console.warn('[USOS filtr] <timetable-entry> bez zaj_cyk_id w HTML (nowy). Przykład:', sample.outerHTML.slice(0, 1500));
    }
    return meta;
  }

  // Zapasowy sposób: ukryta, zasandboxowana ramka (blokuje przekierowanie top.location)
  function readMetaFromHiddenFrame(url, timeoutMs = 12000) {
    return new Promise((resolve) => {
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      frame.style.cssText =
        'position:fixed;left:-10000px;top:0;width:1280px;height:800px;border:0;visibility:hidden;';
      const started = Date.now();
      const finish = (meta) => { clearInterval(timer); frame.remove(); resolve(meta); };
      const timer = setInterval(() => {
        let meta = {};
        try { meta = extractMeta(frame.contentDocument, true); } catch { /* jeszcze się ładuje */ }
        if (Object.keys(meta).length) finish(meta);
        else if (Date.now() - started > timeoutMs) finish({});
      }, 300);
      frame.src = url;
      document.body.appendChild(frame);
    });
  }

  function cacheKey() {
    const p = new URL(location.href).searchParams;
    return 'usosGifMeta:' + ['grupa_kod', 'cdyd_kod'].map((k) => p.get(k)).join('|');
  }
  function readCache() {
    try { return JSON.parse(sessionStorage.getItem(cacheKey())); } catch { return null; }
  }
  function writeCache(meta) {
    try { sessionStorage.setItem(cacheKey(), JSON.stringify(meta)); } catch { /* ignoruj */ }
  }

  async function loadGifMeta(neededIds) {
    const cached = readCache();
    if (cached && [...neededIds].every((id) => cached[id])) return cached;

    const url = new URL(location.href);
    url.searchParams.set('plan_format', 'new-ui');

    let meta = {};
    try {
      const res = await fetch(url.href, { credentials: 'same-origin' });
      meta = extractMeta(new DOMParser().parseFromString(await res.text(), 'text/html'));
    } catch (err) {
      console.warn('[USOS filtr] fetch HTML (nowy) nie powiódł się:', err);
    }
    if (!Object.keys(meta).length) meta = await readMetaFromHiddenFrame(url.href);
    if (Object.keys(meta).length) writeCache(meta);
    return meta;
  }

  const imageReady = (img) =>
    img.complete && img.naturalWidth
      ? Promise.resolve()
      : new Promise((resolve) => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
          setTimeout(resolve, 10000);
        });

  // Pasek 1 px x wysokość: dla każdego wiersza pikseli najczęstszy kolor spośród pikseli,
  // których nie zajmuje żaden blok. To odtwarza tło planu (paski godzinowe).
  // rects: [{x1,x2,y1,y2}] w pikselach obrazka. Zwraca { strip: canvas, rows: [[r,g,b]...] }.
  function buildBackdropStrip(data, nw, nh, rects) {
    const covered = new Uint8Array(nw * nh);
    let minX = nw;
    let maxX = 0;
    for (const r of rects) {
      const x1 = Math.max(0, r.x1);
      const x2 = Math.min(nw - 1, r.x2);
      minX = Math.min(minX, x1);
      maxX = Math.max(maxX, x2);
      for (let y = Math.max(0, r.y1); y <= Math.min(nh - 1, r.y2); y++) {
        covered.fill(1, y * nw + x1, y * nw + x2 + 1);
      }
    }
    const strip = document.createElement('canvas');
    strip.width = 1;
    strip.height = nh;
    const sctx = strip.getContext('2d');
    const rows = new Array(nh);
    let rgb = [255, 255, 255];
    for (let y = 0; y < nh; y++) {
      const counts = new Map();
      let best = null;
      let bestN = 0;
      for (let x = minX; x <= maxX; x++) {
        const i = y * nw + x;
        if (covered[i]) continue;
        const p = i * 4;
        const key = (data[p] << 16) | (data[p + 1] << 8) | data[p + 2];
        const n = (counts.get(key) || 0) + 1;
        counts.set(key, n);
        if (n > bestN) { bestN = n; best = key; }
      }
      if (best !== null) rgb = [best >> 16, (best >> 8) & 255, best & 255];
      rows[y] = rgb;
      sctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
      sctx.fillRect(0, y, 1, 1);
    }
    return { strip, rows };
  }

  // Układ pasów (lane) dla zajęć jednego dnia: zajęcia nakładające się w czasie tworzą
  // klaster, a każdy klaster dzieli szerokość dnia na tyle pasów, ile ma jednoczesnych zajęć.
  function assignLanes(list) {
    const items = [...list].sort((p, q) => p.y1 - q.y1 || p.x1 - q.x1);
    const result = new Map();
    let cluster = [];
    let clusterEnd = -Infinity;
    let max = 0;
    const flush = () => {
      if (!cluster.length) return;
      const laneEnds = [];
      for (const b of cluster) {
        let i = laneEnds.findIndex((end) => end < b.y1);
        if (i < 0) { i = laneEnds.length; laneEnds.push(b.y2); } else laneEnds[i] = b.y2;
        result.set(b, { lane: i, n: 0 });
      }
      for (const b of cluster) result.get(b).n = laneEnds.length;
      max = Math.max(max, laneEnds.length);
      cluster = [];
    };
    for (const b of items) {
      if (cluster.length && b.y1 > clusterEnd) flush();
      clusterEnd = Math.max(cluster.length ? clusterEnd : -Infinity, b.y2);
      cluster.push(b);
    }
    flush();
    return { result, max };
  }

  const median = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };

  /**
   * Składa plan od nowa z wyciętych fragmentów oryginalnego obrazka.
   * - kolumny dni mają szerokość dopasowaną do liczby jednoczesnych zajęć,
   * - bloki wypełniają całą szerokość swojego pasa,
   * - współrzędne <area> są przeliczane, więc kliknięcia nadal działają.
   * Rzuca wyjątek, gdy nie da się odczytać pikseli (wtedy używamy zasłon).
   */
  function createGifLayout(img, areas) {
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    if (!nw || !nh || !img.clientWidth || !areas.length) return null;
    const k = nw / img.clientWidth; // współrzędne <area> są w pikselach wyświetlanych

    const src = document.createElement('canvas');
    src.width = nw;
    src.height = nh;
    const sctx = src.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(img, 0, 0);
    const { data } = sctx.getImageData(0, 0, nw, nh); // wyjątek, jeśli canvas "zabrudzony"

    const blocks = areas.map((a) => ({
      a,
      visible: true,
      origCoords: a.el.getAttribute('coords'),
      x1: Math.round(a.x1 * k),
      x2: Math.round(a.x2 * k),
      y1: Math.round(a.y1 * k),
      y2: Math.round(a.y2 * k),
    }));
    for (const b of blocks) b.w = b.x2 - b.x1 + 1;

    // Dni = grupy bloków sąsiadujących w poziomie; przerwy (>3 px) to stałe odcinki obrazka
    const days = [];
    for (const b of [...blocks].sort((p, q) => p.x1 - q.x1)) {
      const d = days[days.length - 1];
      if (d && b.x1 <= d.x2 + 3 * k) {
        d.blocks.push(b);
        d.x2 = Math.max(d.x2, b.x2);
      } else {
        days.push({ x1: b.x1, x2: b.x2, blocks: [b] });
      }
    }
    const parts = [];
    let cursor = 0;
    for (const d of days) {
      if (d.x1 > cursor) parts.push({ fixed: true, x1: cursor, x2: d.x1 - 1 });
      parts.push({ day: d });
      cursor = d.x2 + 1;
    }
    if (cursor < nw) parts.push({ fixed: true, x1: cursor, x2: nw - 1 });

    const headerH = Math.min(...blocks.map((b) => b.y1));
    const { strip, rows } = buildBackdropStrip(data, nw, nh, blocks);

    // Minimalna szerokość dnia: tak, by zmieścił się napis z nagłówka (np. "Poniedziałek")
    for (const d of days) {
      const cx = (d.x1 + d.x2) / 2;
      let half = 0;
      for (let y = 0; y < headerH; y++) {
        const [r, g, bl] = rows[y];
        for (let x = d.x1; x <= d.x2; x++) {
          const p = (y * nw + x) * 4;
          if (Math.abs(data[p] - r) + Math.abs(data[p + 1] - g) + Math.abs(data[p + 2] - bl) > 60) {
            half = Math.max(half, Math.abs(x - cx));
          }
        }
      }
      d.minW = Math.ceil(half * 2 + 16);
    }
    // Szerokość jednego "pasa" w oryginale (dzień = liczba pasów x szerokość pasa)
    const cell = median(days.map((d) => (d.x2 - d.x1 + 1) / Math.max(1, assignLanes(d.blocks).max)));

    const gridBox = Array.from(img.parentElement.parentElement?.children || []).find(
      (el) => el.tagName === 'DIV' && el !== img.parentElement && el.id !== 'plan_progress' && el.style.width
    );
    const origSrc = img.src;
    let token = 0;
    let lastUrl = null;
    let lastSig = '1'.repeat(blocks.length);

    function render() {
      const sig = blocks.map((b) => (b.visible ? '1' : '0')).join('');
      if (sig === lastSig) return;
      lastSig = sig;
      const my = ++token;

      if (!sig.includes('0')) { // wszystko widoczne -> oryginał
        img.src = origSrc;
        img.style.removeProperty('width');
        img.style.removeProperty('height');
        gridBox?.style.setProperty('width', nw / k + 'px');
        for (const b of blocks) b.a.el.setAttribute('coords', b.origCoords);
        return;
      }

      // 1. szerokości
      let total = 0;
      const plan = parts.map((part) => {
        if (part.fixed) {
          const w = part.x2 - part.x1 + 1;
          const item = { part, nx: total, w };
          total += w;
          return item;
        }
        const d = part.day;
        const vis = d.blocks.filter((b) => b.visible);
        const lanes = assignLanes(vis);
        let need = Math.max(lanes.max * cell, d.minW);
        for (const b of vis) need = Math.max(need, b.w * lanes.result.get(b).n);
        const w = Math.min(Math.ceil(need), d.x2 - d.x1 + 1);
        const item = { part, d, vis, lanes, nx: total, w };
        total += w;
        return item;
      });

      // 2. rysowanie
      const out = document.createElement('canvas');
      out.width = total;
      out.height = nh;
      const ctx = out.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      const coords = new Map();
      for (const it of plan) {
        if (it.part.fixed) {
          ctx.drawImage(src, it.part.x1, 0, it.w, nh, it.nx, 0, it.w, nh);
          continue;
        }
        const { d, vis, lanes, nx, w } = it;
        ctx.drawImage(strip, 0, 0, 1, nh, nx, 0, w, nh); // tło (paski)
        const ow = d.x2 - d.x1 + 1;
        const hw = Math.min(ow, w); // nagłówek dnia: wyśrodkowany fragment oryginału
        ctx.drawImage(src, Math.round((d.x1 + d.x2) / 2 - hw / 2), 0, hw, headerH,
          nx + Math.round((w - hw) / 2), 0, hw, headerH);

        for (const b of vis) {
          const { lane, n } = lanes.result.get(b);
          const x = nx + Math.round((lane * w) / n);
          const bw = nx + Math.round(((lane + 1) * w) / n) - x;
          const bh = b.y2 - b.y1 + 1;
          if (bw <= b.w) {
            ctx.drawImage(src, b.x1, b.y1, bw, bh, x, b.y1, bw, bh);
          } else {
            // rozciągamy cienki pionowy wycinek (tło + górna/dolna ramka), potem nakładamy treść
            ctx.drawImage(src, b.x1 + Math.min(2, b.w - 1), b.y1, 1, bh, x, b.y1, bw, bh);
            ctx.drawImage(src, b.x1, b.y1, b.w - 2, bh, x, b.y1, b.w - 2, bh);
            ctx.drawImage(src, b.x2 - 1, b.y1, 2, bh, x + bw - 2, b.y1, 2, bh);
          }
          coords.set(b, [x, b.y1, x + bw - 1, b.y2].map((v) => Math.round(v / k)).join(','));
        }
      }

      const apply = (url) => {
        if (my !== token) { if (url.startsWith('blob:')) URL.revokeObjectURL(url); return; }
        const old = lastUrl;
        lastUrl = url.startsWith('blob:') ? url : null;
        img.src = url;
        img.style.width = total / k + 'px';
        img.style.height = nh / k + 'px';
        gridBox?.style.setProperty('width', total / k + 'px');
        for (const b of blocks) b.a.el.setAttribute('coords', coords.get(b) || '0,0,0,0');
        if (old) setTimeout(() => URL.revokeObjectURL(old), 3000);
      };
      if (out.toBlob) {
        out.toBlob((blob) => (blob ? apply(URL.createObjectURL(blob)) : apply(out.toDataURL('image/png'))), 'image/png');
      } else {
        apply(out.toDataURL('image/png'));
      }
    }

    return { blocks, render };
  }

  // Awaryjnie (gdy nie da się złożyć planu): zasłony odtwarzające tło na ukrytych blokach
  function buildMaskBackdrop(img, areas) {
    try {
      const nw = img.naturalWidth;
      const nh = img.naturalHeight;
      if (!nw || !nh || !img.clientWidth) return null;
      const k = nw / img.clientWidth;
      const canvas = document.createElement('canvas');
      canvas.width = nw;
      canvas.height = nh;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, nw, nh);
      const rects = areas.map((a) => ({
        x1: Math.floor(a.x1 * k), x2: Math.ceil(a.x2 * k), y1: Math.floor(a.y1 * k), y2: Math.ceil(a.y2 * k),
      }));
      const { strip } = buildBackdropStrip(data, nw, nh, rects);
      return { url: strip.toDataURL('image/png'), height: img.clientHeight };
    } catch (err) {
      console.warn('[USOS filtr] nie udało się odtworzyć tła planu:', err);
      return null;
    }
  }

  async function collectGifEntries() {
    const img = document.querySelector('img[usemap="#plan_image_map"]');
    const areas = Array.from(document.querySelectorAll('map[name="plan_image_map"] area'))
      .map(parseArea)
      .filter(Boolean);
    if (!img || !areas.length) {
      return { entries: [], status: 'Nie znaleziono bloków zajęć na obrazku planu.' };
    }

    const meta = await loadGifMeta(new Set(areas.map((a) => a.zid)));
    if (!Object.keys(meta).length) {
      return {
        entries: [],
        status:
          'Nie udało się odczytać nazw przedmiotów z wersji „HTML (nowy)” tego planu. ' +
          'Szczegóły w konsoli (F12). Możesz też przełączyć plan na „HTML (nowy)” – tam filtr działa bezpośrednio.',
      };
    }

    await imageReady(img);

    let layout = null;
    try {
      layout = createGifLayout(img, areas);
    } catch (err) {
      console.warn('[USOS filtr] nie udało się odczytać obrazka planu, używam zasłon:', err);
    }

    const entries = [];
    let unmapped = 0;

    if (layout) {
      layout.blocks.forEach((block, i) => {
        const m = meta[areas[i].zid];
        if (!m) { unmapped++; return; }
        entries.push({
          courseId: m.courseId,
          courseName: m.courseName,
          type: m.type,
          group: areas[i].group,
          setVisible(visible) { block.visible = visible; },
        });
      });
    } else {
      const host = img.parentElement; // pozycjonowany kontener obrazka, ten sam punkt (0,0)
      const backdrop = buildMaskBackdrop(img, areas);
      if (backdrop) {
        host.style.setProperty('--usos-backdrop', `url("${backdrop.url}")`);
        host.style.setProperty('--usos-backdrop-h', backdrop.height + 'px');
      }
      for (const a of areas) {
        const m = meta[a.zid];
        if (!m) { unmapped++; continue; }
        const mask = document.createElement('div');
        mask.className = 'usos-gif-mask';
        mask.style.left = a.x1 + 'px';
        mask.style.top = a.y1 + 'px';
        mask.style.width = a.x2 - a.x1 + 1 + 'px';
        mask.style.height = a.y2 - a.y1 + 1 + 'px';
        if (backdrop) mask.style.backgroundPosition = `0 -${a.y1}px`;
        host.appendChild(mask);
        entries.push({
          courseId: m.courseId,
          courseName: m.courseName,
          type: m.type,
          group: a.group,
          setVisible(visible) { mask.style.display = visible ? 'none' : 'block'; },
        });
      }
    }
    const note = unmapped ? `Nie rozpoznano ${unmapped} bloków (zostały widoczne).` : '';
    return { entries, note, afterApply: layout ? layout.render : null };
  }

  // ---------------------------------------------------------------------------
  // Model
  // ---------------------------------------------------------------------------
  function buildCourseMap(entries) {
    const map = new Map();
    for (const e of entries) {
      if (!map.has(e.courseId)) {
        map.set(e.courseId, { name: e.courseName, types: new Map(), hasLecture: false });
      }
      const course = map.get(e.courseId);
      if (e.type === LECTURE) course.hasLecture = true;
      if (!e.group) continue;
      if (!course.types.has(e.type)) course.types.set(e.type, new Set());
      course.types.get(e.type).add(e.group);
    }
    return map;
  }

  // Dla każdej kategorii globalnej: jakie grupy istnieją i w których kursach
  function buildGlobalInfo(courseMap) {
    const info = {};
    for (const cat of GLOBAL_CATEGORIES) info[cat.key] = { groups: new Set(), courses: new Set() };
    for (const [courseId, course] of courseMap) {
      for (const cat of GLOBAL_CATEGORIES) {
        for (const type of cat.types) {
          const groups = course.types.get(type);
          if (!groups) continue;
          groups.forEach((g) => info[cat.key].groups.add(g));
          info[cat.key].courses.add(courseId);
        }
      }
    }
    return info;
  }

  // Wykłady mają "prawdziwe" grupy, jeśli jest ich więcej niż jedna
  // albo jedyna grupa jest inna niż "1" (wtedy "gr. 1" to tylko artefakt USOS-a).
  const detectWGroups = (wGroups) => wGroups.size > 1 || (wGroups.size === 1 && !wGroups.has('1'));

  // ---------------------------------------------------------------------------
  // Filtrowanie
  // ---------------------------------------------------------------------------
  function isGroupVisible(e) {
    const sel = getSel(e.courseId, e.type);
    return sel !== NONE && (!sel || sel === e.group);
  }

  function isVisible(e) {
    if (e.type !== LECTURE) return isGroupVisible(e);
    if (state.useWGroups) return e.group === null || isGroupVisible(e);
    return state.lectureVis.global && state.lectureVis.courses[e.courseId] !== false;
  }

  function applyFilter() {
    state.entries.forEach((e) => e.setVisible(isVisible(e)));
    state.afterApply?.();
  }

  // ---------------------------------------------------------------------------
  // Stan globalnych przycisków (wyliczany z wyborów per przedmiot)
  // ---------------------------------------------------------------------------
  function computeGlobalValue(cat) {
    const { courses } = state.globalInfo[cat.key];

    if (cat.key === 'W') {
      if (!state.useWGroups) return state.lectureVis.global ? null : NONE;
      if (!courses.size) return null;
      const active = [...courses].map((id) => getSel(id, 'W')).filter((s) => s !== NONE);
      if (!active.length) return NONE;
      const first = active[0];
      return first && active.every((s) => s === first) ? first : null;
    }

    const values = [];
    for (const id of courses) {
      const course = state.courseMap.get(id);
      for (const type of cat.types) if (course.types.has(type)) values.push(getSel(id, type));
    }
    const first = values[0];
    return first && first !== NONE && values.every((v) => v === first) ? first : null;
  }

  function setGlobal(cat, group) {
    if (cat.key === 'W' && !state.useWGroups) {
      state.lectureVis.global = group !== NONE;
    } else {
      for (const id of state.globalInfo[cat.key].courses) {
        const course = state.courseMap.get(id);
        for (const type of cat.types) if (course.types.has(type)) setSel(id, type, group || '');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Pomocniki UI
  // ---------------------------------------------------------------------------
  function h(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function button(className, text, data) {
    const b = h('button', className, text);
    b.type = 'button';
    Object.assign(b.dataset, data);
    return b;
  }

  // Siatka o równych kolumnach; elementy mają rozpiętość (span) w kolumnach.
  // Liczbę kolumn dobiera layoutGrid (zależnie od szerokości okna i rozmiaru czcionki).
  function buildGrid(items) {
    const grid = h('div', 'usos-chip-grid');
    grid.dataset.units = items.reduce((s, i) => s + i.span, 0);
    grid.dataset.maxSpan = Math.max(...items.map((i) => i.span));
    for (const { node, span } of items) {
      if (span > 1) node.style.gridColumn = `span ${span}`;
      grid.appendChild(node);
    }
    return grid;
  }

  function layoutGrid(grid) {
    const w = grid.clientWidth;
    if (!w) return;
    const cs = getComputedStyle(grid);
    const fs = parseFloat(cs.fontSize) || 13;
    const gap = parseFloat(cs.columnGap) || 5;
    const minCell = fs * 2.6;
    const units = +grid.dataset.units;
    const maxSpan = +grid.dataset.maxSpan;
    const maxCols = Math.max(maxSpan, Math.floor((w + gap) / (minCell + gap)));
    const rows = Math.ceil(units / maxCols);
    // jeden rząd -> stała szerokość chipów; więcej rzędów -> wyrównane rzędy (np. 6 + 5, nie 4 + 4 + 3)
    const cols = rows === 1 ? maxCols : Math.max(Math.ceil(units / rows), maxSpan);
    grid.style.setProperty('--cols', cols);
  }

  const layoutAllGrids = (panel) => panel.querySelectorAll('.usos-chip-grid').forEach(layoutGrid);

  function buildRow(rowClass, labelClass, labelText, items) {
    const row = h('div', rowClass);
    row.append(h('span', labelClass, labelText), buildGrid(items));
    return row;
  }

  // Chipy grup + "Ukryj" (szerszy)
  function groupItems({ groups, withHide, base, hideClass, data }) {
    const items = groups.map((g) => ({ node: button(base, g, { ...data, group: g }), span: 1 }));
    if (withHide) {
      items.push({ node: button(`${base} ${hideClass}`, 'Ukryj', { ...data, group: NONE }), span: 2 });
    }
    return items;
  }

  const sortedGroups = (set) => Array.from(set).sort((a, b) => Number(a) - Number(b));

  // ---------------------------------------------------------------------------
  // Okno: pozycja, przeciąganie, rozmiar, czcionka
  // ---------------------------------------------------------------------------
  function clampToViewport(panel) {
    if (!panel || !panel.style.left) return;
    const r = panel.getBoundingClientRect();
    panel.style.left = Math.min(Math.max(0, r.left), Math.max(0, innerWidth - 80)) + 'px';
    panel.style.top = Math.min(Math.max(0, r.top), Math.max(0, innerHeight - 40)) + 'px';
  }

  function applyGeometry(panel) {
    const g = state.geometry;
    if (g.width) panel.style.width = g.width + 'px';
    if (g.height) panel.style.height = g.height + 'px';
    if (g.left != null) {
      panel.style.left = g.left + 'px';
      panel.style.top = g.top + 'px';
      panel.style.right = 'auto';
    }
    clampToViewport(panel);
  }

  function applyScale(panel) {
    panel.style.setProperty('--usos-scale', state.fontScale);
    const label = panel.querySelector('#usos-fs-label');
    if (label) label.textContent = Math.round(state.fontScale * 100) + '%';
    layoutAllGrids(panel);
  }

  function changeScale(panel, delta) {
    const next = Math.round((state.fontScale + delta) * 10) / 10;
    state.fontScale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, next));
    applyScale(panel);
    save();
  }

  function setupDrag(panel) {
    const header = panel.querySelector('#usos-filter-header');
    header.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      const r = panel.getBoundingClientRect();
      const dx = e.clientX - r.left;
      const dy = e.clientY - r.top;
      header.setPointerCapture(e.pointerId);

      const move = (ev) => {
        panel.style.right = 'auto';
        panel.style.left = Math.min(Math.max(0, ev.clientX - dx), innerWidth - 80) + 'px';
        panel.style.top = Math.min(Math.max(0, ev.clientY - dy), innerHeight - 40) + 'px';
      };
      const up = () => {
        header.removeEventListener('pointermove', move);
        header.removeEventListener('pointerup', up);
        header.removeEventListener('pointercancel', up);
        const b = panel.getBoundingClientRect();
        state.geometry.left = Math.round(b.left);
        state.geometry.top = Math.round(b.top);
        save();
      };
      header.addEventListener('pointermove', move);
      header.addEventListener('pointerup', up);
      header.addEventListener('pointercancel', up);
      move(e);
    });
  }

  function setupResize(panel) {
    let first = true;
    let timer;
    new ResizeObserver(() => {
      layoutAllGrids(panel);
      if (first) { first = false; return; }
      if (state.collapsed) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        // natywny resize wpisuje rozmiar inline – zapisujemy tylko to, co user sam ustawił
        if (panel.style.width) state.geometry.width = parseFloat(panel.style.width);
        if (panel.style.height) state.geometry.height = parseFloat(panel.style.height);
        save();
      }, 250);
    }).observe(panel);
  }

  // ---------------------------------------------------------------------------
  // Widok "Wygląd" (ustawienia motywu – bez pisania CSS)
  // ---------------------------------------------------------------------------
  const PANEL_COLOR_KEYS = ['primary', 'accent', 'danger', 'panelBg', 'text'];
  const PRESETS = [
    ['Domyślny', {}],
    ['Ciemny', { primary: '#0f172a', accent: '#38bdf8', danger: '#f87171', panelBg: '#1e293b', text: '#e2e8f0' }],
    ['Fiolet', { primary: '#3b1d57', accent: '#8e5bd1', danger: '#e63946', panelBg: '#fbf8ff', text: '#2a1a3d' }],
    ['Las', { primary: '#14532d', accent: '#16a34a', danger: '#dc2626', panelBg: '#f7fdf9', text: '#14281c' }],
    ['Róż', { primary: '#831843', accent: '#db2777', danger: '#b91c1c', panelBg: '#fff7fb', text: '#3b0d22' }],
  ];
  const THEME_FIELDS = [
    { group: 'Okienko filtra' },
    { key: 'primary', label: 'Kolor główny', type: 'color', def: '#1d3557' },
    { key: 'accent', label: 'Kolor akcentu', type: 'color', def: '#457b9d' },
    { key: 'danger', label: 'Kolor „Ukryj”', type: 'color', def: '#e63946' },
    { key: 'panelBg', label: 'Tło okna', type: 'color', def: '#ffffff' },
    { key: 'text', label: 'Kolor tekstu', type: 'color', def: '#222222' },
    { key: 'radius', label: 'Zaokrąglenie rogów', type: 'range', min: 0, max: 24, def: 12, unit: 'px' },
    { group: 'Strona USOS' },
    { key: 'pageColor', label: 'Kolor tła strony', type: 'color', def: '#eeeeee' },
    { key: 'bgImage', label: 'Obraz tła', type: 'image' },
    { key: 'bgFit', label: 'Dopasowanie obrazu', type: 'select', def: 'cover',
      options: [['cover', 'Wypełnij ekran'], ['contain', 'Zmieść w całości'], ['tile', 'Kafelki'], ['stretch', 'Rozciągnij']] },
    { key: 'bgDim', label: 'Przyciemnienie tła', type: 'range', min: 0, max: 80, def: 0, unit: '%' },
    { key: 'contentBacking', label: 'Biały podkład pod treścią', type: 'range', min: 0, max: 100, def: 85, unit: '%' },
  ];

  // Zmniejsza obraz (żeby mieścił się w pamięci rozszerzenia) i zwraca data URL
  function imageFileToDataUrl(file, maxSide = 2200) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = () => {
        const raw = reader.result;
        const im = new Image();
        im.onerror = () => (raw.length < 3e6 ? resolve(raw) : reject(new Error('za duży obraz')));
        im.onload = () => {
          const k = Math.min(1, maxSide / Math.max(im.naturalWidth, im.naturalHeight));
          const c = document.createElement('canvas');
          c.width = Math.round(im.naturalWidth * k);
          c.height = Math.round(im.naturalHeight * k);
          c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/jpeg', 0.85));
        };
        im.src = raw;
      };
      reader.readAsDataURL(file);
    });
  }

  function buildThemeView(view) {
    const scroll = view.scrollTop;
    view.textContent = '';
    const t = state.theme;
    const rerender = () => { saveTheme(); buildThemeView(view); };

    const top = h('div', 'usos-tv-top');
    const back = button('usos-tv-back', '← Wróć do filtrów');
    back.addEventListener('click', () => toggleTheme(false));
    const enabled = h('label', 'usos-tv-switch');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = t.enabled !== false;
    cb.addEventListener('change', () => { t.enabled = cb.checked; saveTheme(); });
    enabled.append(cb, document.createTextNode(' Motyw włączony'));
    top.append(back, enabled);
    view.append(top);

    // gotowe motywy
    view.append(h('div', 'usos-tv-group', 'Gotowe motywy okienka'));
    const presets = h('div', 'usos-tv-presets');
    for (const [name, vals] of PRESETS) {
      const b = button('usos-tv-preset', name);
      b.style.setProperty('--sw', vals.primary || '#1d3557');
      b.style.setProperty('--sw2', vals.accent || '#457b9d');
      b.addEventListener('click', () => {
        for (const k of PANEL_COLOR_KEYS) delete t[k];
        Object.assign(t, vals);
        rerender();
      });
      presets.append(b);
    }
    view.append(presets);

    // pola
    for (const f of THEME_FIELDS) {
      if (f.group) { view.append(h('div', 'usos-tv-group', f.group)); continue; }
      const row = h('div', 'usos-tv-row');
      row.append(h('span', 'usos-tv-label', f.label));
      const ctl = h('div', 'usos-tv-ctl');
      const value = t[f.key];

      if (f.type === 'color') {
        const input = document.createElement('input');
        input.type = 'color';
        input.value = value || f.def;
        input.addEventListener('input', () => { t[f.key] = input.value; saveTheme(); });
        ctl.append(input);
        if (value) {
          const reset = button('usos-tv-mini', '↺');
          reset.title = 'Przywróć domyślny';
          reset.addEventListener('click', () => { delete t[f.key]; rerender(); });
          ctl.append(reset);
        }
      } else if (f.type === 'range') {
        const input = document.createElement('input');
        input.type = 'range';
        input.min = f.min;
        input.max = f.max;
        input.value = value ?? f.def;
        const out = h('span', 'usos-tv-val', `${input.value}${f.unit}`);
        input.addEventListener('input', () => {
          t[f.key] = Number(input.value);
          out.textContent = `${input.value}${f.unit}`;
          saveTheme();
        });
        ctl.append(input, out);
      } else if (f.type === 'select') {
        const sel = document.createElement('select');
        for (const [v, label] of f.options) sel.append(new Option(label, v));
        sel.value = value || f.def;
        sel.addEventListener('change', () => { t[f.key] = sel.value; saveTheme(); });
        ctl.append(sel);
      } else if (f.type === 'image') {
        const file = document.createElement('input');
        file.type = 'file';
        file.accept = 'image/*';
        file.hidden = true;
        const pick = button('usos-tv-btn', value ? 'Zmień obraz…' : 'Wybierz obraz…');
        pick.addEventListener('click', () => file.click());
        file.addEventListener('change', async () => {
          if (!file.files[0]) return;
          try {
            t[f.key] = await imageFileToDataUrl(file.files[0]);
            rerender();
          } catch {
            pick.textContent = 'Nie udało się wczytać';
          }
        });
        ctl.append(pick, file);
        if (value) {
          const thumb = document.createElement('img');
          thumb.className = 'usos-tv-thumb';
          thumb.src = value;
          const del = button('usos-tv-mini', '✕');
          del.title = 'Usuń obraz';
          del.addEventListener('click', () => { delete t[f.key]; rerender(); });
          ctl.append(thumb, del);
        }
      }
      row.append(ctl);
      view.append(row);
    }

    // zaawansowane: własny CSS
    const adv = document.createElement('details');
    adv.className = 'usos-tv-adv';
    adv.open = !!t.custom;
    adv.append(h('summary', null, 'Zaawansowane: własny CSS'));
    adv.append(h('div', 'usos-tv-hint',
      'Dla osób znających CSS. Działa na całym USOS-ie i okienku (#usos-filter-panel). ' +
      'Obraz z ustawień jest dostępny jako var(--usos-bg-image).'));
    const ta = document.createElement('textarea');
    ta.className = 'usos-tv-css';
    ta.spellcheck = false;
    ta.placeholder = '/* np. */\n#usos-filter-panel .usos-chip.active { background: orange; }';
    ta.value = t.custom || '';
    ta.addEventListener('input', () => { t.custom = ta.value; saveTheme(); });
    adv.append(ta);
    view.append(adv);

    const resetAll = button('usos-tv-reset', 'Przywróć wszystko do domyślnych');
    resetAll.addEventListener('click', () => {
      if (!confirm('Przywrócić domyślny wygląd (usunie kolory, obraz tła i własny CSS)?')) return;
      state.theme = {};
      rerender();
    });
    view.append(resetAll);

    view.scrollTop = scroll;
  }

  function toggleTheme(open) {
    state.themeOpen = open;
    document.getElementById('usos-filter-panel')?.classList.toggle('usos-show-theme', open);
  }

  // ---------------------------------------------------------------------------
  // Panel
  // ---------------------------------------------------------------------------
  function buildGlobalSection(container) {
    const rows = [];
    for (const cat of GLOBAL_CATEGORIES) {
      const isW = cat.key === 'W';
      if (isW && !state.anyLecture) continue;
      const groups = isW && !state.useWGroups ? [] : sortedGroups(state.globalInfo[cat.key].groups);
      if (!groups.length && !isW) continue;

      const items = groupItems({
        groups,
        withHide: isW,
        base: 'usos-global-btn',
        hideClass: 'usos-global-btn-hide',
        data: { action: 'global', cat: cat.key },
      });
      rows.push(buildRow('usos-global-row', 'usos-global-label', cat.label, items));
    }

    if (!rows.length) {
      container.style.display = 'none';
      return;
    }
    container.append(h('div', 'usos-global-title', 'Globalnie'), ...rows);
  }

  function buildCourseCard(courseId, course) {
    const rows = [];

    const types = Array.from(course.types.entries()).sort(([a], [b]) => {
      const diff = (TYPE_ORDER[a] ?? 2) - (TYPE_ORDER[b] ?? 2);
      return diff || a.localeCompare(b);
    });

    for (const [type, groupSet] of types) {
      if (type === LECTURE && !state.useWGroups) continue;
      const items = groupItems({
        groups: sortedGroups(groupSet),
        withHide: true,
        base: 'usos-chip',
        hideClass: 'usos-chip-hide',
        data: { action: 'course', courseId, type },
      });
      rows.push(buildRow('usos-course-type-row', 'usos-course-type-label', type, items));
    }

    if (course.hasLecture && !state.useWGroups) {
      const data = { action: 'lecture', courseId };
      rows.push(
        buildRow('usos-course-type-row', 'usos-course-type-label', 'W', [
          { node: button('usos-chip', 'Pokaż', { ...data, group: 'show' }), span: 2 },
          { node: button('usos-chip usos-chip-hide', 'Ukryj', { ...data, group: 'hide' }), span: 2 },
        ])
      );
    }

    if (!rows.length) return null;

    const card = h('div', 'usos-filter-course');
    card.dataset.courseId = courseId;
    card.append(h('div', 'usos-filter-course-name', course.name), ...rows);
    return card;
  }

  function isButtonActive(btn) {
    const { action, group, cat, courseId, type } = btn.dataset;
    switch (action) {
      case 'global': return state.global[cat] === group;
      case 'course': return getSel(courseId, type) === group;
      case 'lecture': return (state.lectureVis.courses[courseId] === false) === (group === 'hide');
      default: return false;
    }
  }

  function syncButtons() {
    const panel = document.getElementById('usos-filter-panel');
    if (!panel) return;
    panel.querySelectorAll('button[data-action]').forEach((b) => {
      b.classList.toggle('active', isButtonActive(b));
    });
  }

  // Jedno miejsce odświeżania po każdej zmianie
  function refresh() {
    applyFilter();
    for (const cat of GLOBAL_CATEGORIES) state.global[cat.key] = computeGlobalValue(cat);
    save();
    syncButtons();
  }

  function handleClick(e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const { action, group, cat, courseId, type } = btn.dataset;
    const wasActive = btn.classList.contains('active');

    if (action === 'global') {
      setGlobal(GLOBAL_CATEGORIES.find((c) => c.key === cat), wasActive ? null : group);
    } else if (action === 'course') {
      setSel(courseId, type, wasActive ? '' : group);
    } else if (action === 'lecture') {
      state.lectureVis.courses[courseId] = group === 'show';
    }
    refresh();
  }

  function resetAll() {
    state.selections = {};
    state.lectureVis = { global: true, courses: {} };
    state.global = { CWL: null, CWA_CWP: null, W: null };
    buildPanel();
  }

  function buildPanel() {
    const prevScroll = document.querySelector('#usos-filter-body')?.scrollTop || 0;
    document.getElementById('usos-filter-panel')?.remove();

    const panel = h('div');
    panel.id = 'usos-filter-panel';
    panel.classList.toggle('usos-filter-collapsed', state.collapsed);
    panel.classList.toggle('usos-show-theme', state.themeOpen);
    panel.innerHTML =
      '<div id="usos-filter-header"><span>Filtr grup</span><div id="usos-filter-hbtns">' +
      '<button class="usos-hbtn" id="usos-fs-down" type="button" title="Mniejsza czcionka">A−</button>' +
      '<span id="usos-fs-label" title="Rozmiar czcionki okna"></span>' +
      '<button class="usos-hbtn" id="usos-fs-up" type="button" title="Większa czcionka">A+</button>' +
      '<button class="usos-hbtn" id="usos-theme-btn" type="button" title="Kolory, tło strony i wygląd okna">Wygląd</button>' +
      '<button class="usos-hbtn" id="usos-filter-toggle" type="button" title="Zwiń / rozwiń"></button>' +
      '</div></div>' +
      '<div id="usos-filter-body"><div id="usos-global-filters"></div><div id="usos-courses-list"></div></div>' +
      '<div id="usos-theme-view"></div>' +
      '<div id="usos-filter-footer"><button id="usos-filter-reset" type="button">Wyczyść wszystko</button></div>';
    document.body.appendChild(panel);
    applyGeometry(panel);

    const toggle = panel.querySelector('#usos-filter-toggle');
    toggle.textContent = state.collapsed ? '+' : '–';

    const globalEl = panel.querySelector('#usos-global-filters');
    const list = panel.querySelector('#usos-courses-list');

    if (state.status) {
      globalEl.style.display = 'none';
      list.appendChild(h('div', 'usos-filter-empty', state.status));
    } else {
      buildGlobalSection(globalEl);
      const courses = Array.from(state.courseMap.entries()).sort((a, b) =>
        a[1].name.localeCompare(b[1].name, 'pl')
      );
      for (const [courseId, course] of courses) {
        const card = buildCourseCard(courseId, course);
        if (card) list.appendChild(card);
      }
      if (!list.children.length) list.appendChild(h('div', 'usos-filter-empty', 'Nie znaleziono grup.'));
      if (state.note) list.appendChild(h('div', 'usos-filter-empty', state.note));
    }

    buildThemeView(panel.querySelector('#usos-theme-view'));

    panel.addEventListener('click', handleClick);
    toggle.addEventListener('click', () => {
      state.collapsed = !state.collapsed;
      panel.classList.toggle('usos-filter-collapsed', state.collapsed);
      toggle.textContent = state.collapsed ? '+' : '–';
      save();
    });
    panel.querySelector('#usos-fs-down').addEventListener('click', () => changeScale(panel, -SCALE_STEP));
    panel.querySelector('#usos-fs-up').addEventListener('click', () => changeScale(panel, SCALE_STEP));
    panel.querySelector('#usos-theme-btn').addEventListener('click', () => {
      if (state.collapsed) { state.collapsed = false; panel.classList.remove('usos-filter-collapsed'); toggle.textContent = '–'; }
      toggleTheme(!state.themeOpen);
    });
    panel.querySelector('#usos-filter-reset').addEventListener('click', resetAll);

    setupDrag(panel);
    setupResize(panel);
    applyScale(panel);
    panel.querySelector('#usos-filter-body').scrollTop = prevScroll;
    refresh();
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------
  function applyData({ entries, status = '', note = '', afterApply = null }) {
    state.entries = entries;
    state.afterApply = afterApply;
    state.status = status;
    state.note = note;
    state.courseMap = buildCourseMap(entries);
    state.globalInfo = buildGlobalInfo(state.courseMap);
    state.useWGroups = detectWGroups(state.globalInfo.W.groups);
    state.anyLecture = [...state.courseMap.values()].some((c) => c.hasLecture);
    buildPanel();
  }

  async function scanAndRender() {
    if (scanning) return;
    scanning = true;
    try {
      if (isGifMode()) {
        applyData({ entries: [], status: 'Wczytuję dane grup…' });
        applyData(await collectGifEntries());
      } else {
        const entries = collectNewUiEntries();
        if (entries.length) applyData({ entries });
      }
    } finally {
      scanning = false;
    }
  }

  function setupObserver() {
    const container = document.querySelector('.timetable-wrapper') || document.querySelector('usos-timetable');
    if (!container) return;
    new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(scanAndRender, 300);
    }).observe(container, { childList: true, subtree: true });
  }

  function init() {
    chrome.storage.local.get(Object.values(KEYS), async (res) => {
      state.selections = res[KEYS.selections] || {};
      state.collapsed = !!res[KEYS.collapsed];
      state.geometry = res[KEYS.geometry] || {};
      state.theme = res[KEYS.theme] || {};
      state.fontScale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, Number(res[KEYS.scale]) || 1));

      const lv = res[KEYS.lectureVis];
      if (lv) state.lectureVis = { global: lv.global !== false, courses: lv.courses || {} };

      const g = res[KEYS.global] || {};
      for (const cat of GLOBAL_CATEGORIES) state.global[cat.key] = g[cat.key] || null;

      window.addEventListener('resize', () =>
        clampToViewport(document.getElementById('usos-filter-panel'))
      );

      await scanAndRender();
      // w trybie gif nic się dynamicznie nie zmienia – obserwator tylko dla HTML (nowy)
      if (!isGifMode()) setupObserver();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
