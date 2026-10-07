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
  };
  const HIDE_CLASS = 'usos-filter-hidden';
  const LECTURE = 'W';
  const NONE = '__none__';
  const MIN_CELL = 32; // min. szerokość chipa w px
  const GAP = 5;

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
    entries: [],                                 // { courseId, courseName, type, group, setVisible(bool) }
    courseMap: new Map(),
    globalInfo: {},
    useWGroups: false,
    anyLecture: false,
    status: '',                                  // komunikat zamiast listy (ładowanie / błąd)
    note: '',                                    // dopisek pod listą
  };
  let debounceTimer = null;
  let scanning = false;

  function save() {
    chrome.storage.local.set({
      [KEYS.selections]: state.selections,
      [KEYS.collapsed]: state.collapsed,
      [KEYS.lectureVis]: state.lectureVis,
      [KEYS.global]: state.global,
      [KEYS.geometry]: state.geometry,
    });
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
    const clean = text.replace(/\u00A0/g, ' ').trim();
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
  //   planu (po zaj_cyk_id), a ukrywanie robimy nakładkami na obrazek.
  // ---------------------------------------------------------------------------
  const isGifMode = () => !!document.querySelector('map[name="plan_image_map"]');

  function parseArea(area) {
    try {
      const url = new URL(area.getAttribute('href'), location.href);
      const zid = url.searchParams.get('zaj_cyk_id');
      const group = url.searchParams.get('gr_nr');
      const c = area.getAttribute('coords').split(',').map(Number);
      if (!zid || !group || c.length < 4 || c.some(Number.isNaN)) return null;
      return { zid, group, x1: c[0], y1: c[1], x2: c[2], y2: c[3] };
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

    const host = img.parentElement; // pozycjonowany kontener obrazka, ten sam punkt (0,0)
    const entries = [];
    let unmapped = 0;
    for (const a of areas) {
      const m = meta[a.zid];
      if (!m) { unmapped++; continue; }
      const mask = document.createElement('div');
      mask.className = 'usos-gif-mask';
      mask.style.left = a.x1 + 'px';
      mask.style.top = a.y1 + 'px';
      mask.style.width = a.x2 - a.x1 + 1 + 'px';
      mask.style.height = a.y2 - a.y1 + 1 + 'px';
      host.appendChild(mask);
      entries.push({
        courseId: m.courseId,
        courseName: m.courseName,
        type: m.type,
        group: a.group,
        setVisible(visible) { mask.style.display = visible ? 'none' : 'block'; },
      });
    }
    const note = unmapped ? `Nie rozpoznano ${unmapped} bloków (zostały widoczne).` : '';
    return { entries, note };
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

  const applyFilter = () => state.entries.forEach((e) => e.setVisible(isVisible(e)));

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
  // Liczbę kolumn dobiera layoutGrid (zależnie od szerokości okna).
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
    const units = +grid.dataset.units;
    const maxSpan = +grid.dataset.maxSpan;
    const maxCols = Math.max(maxSpan, Math.floor((w + GAP) / (MIN_CELL + GAP)));
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
  // Okno: pozycja, przeciąganie, rozmiar
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
    panel.innerHTML =
      '<div id="usos-filter-header"><span>Filtr grup</span><button id="usos-filter-toggle" type="button"></button></div>' +
      '<div id="usos-filter-body"><div id="usos-global-filters"></div><div id="usos-courses-list"></div></div>' +
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

    panel.addEventListener('click', handleClick);
    toggle.addEventListener('click', () => {
      state.collapsed = !state.collapsed;
      panel.classList.toggle('usos-filter-collapsed', state.collapsed);
      toggle.textContent = state.collapsed ? '+' : '–';
      save();
    });
    panel.querySelector('#usos-filter-reset').addEventListener('click', resetAll);

    setupDrag(panel);
    setupResize(panel);
    layoutAllGrids(panel);
    panel.querySelector('#usos-filter-body').scrollTop = prevScroll;
    refresh();
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------
  function applyData({ entries, status = '', note = '' }) {
    state.entries = entries;
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