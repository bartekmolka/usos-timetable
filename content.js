(function () {
  'use strict';

  const SELECTIONS_KEY = 'usosGroupFilterSelections';
  const COLLAPSED_KEY = 'usosGroupFilterCollapsed';
  const HIDE_CLASS = 'usos-filter-hidden';
  const LECTURE_TYPE = 'W';

  let selections = {};
  let collapsed = false;
  let currentEntries = [];
  let debounceTimer = null;

  function parseInfo(text) {
    if (!text) return null;
    const clean = text.replace(/\u00A0/g, ' ').trim();
    const match = clean.match(/^([^\s,]+)\s*,\s*gr\.\s*(\d+)/i);
    if (!match) return null;
    return { type: match[1].toUpperCase(), group: match[2] };
  }

  function collectEntries() {
    const nodes = Array.from(document.querySelectorAll('timetable-entry'));
    const data = [];
    for (const el of nodes) {
      const courseName = el.getAttribute('name') || 'Nieznany przedmiot';
      const courseId = el.getAttribute('name-id') || courseName;
      const infoEl = el.querySelector('[slot="info"]');
      const parsed = parseInfo(infoEl ? infoEl.textContent : '');
      if (!parsed) continue;
      data.push({ el, courseId, courseName, type: parsed.type, group: parsed.group });
    }
    return data;
  }

  function buildCourseMap(entries) {
    const map = new Map();
    for (const e of entries) {
      if (!map.has(e.courseId)) {
        map.set(e.courseId, { name: e.courseName, types: new Map() });
      }
      if (e.type === LECTURE_TYPE) continue;
      const course = map.get(e.courseId);
      if (!course.types.has(e.type)) course.types.set(e.type, new Set());
      course.types.get(e.type).add(e.group);
    }
    return map;
  }

  function hide(el) {
    el.classList.add(HIDE_CLASS);
    el.style.setProperty('display', 'none', 'important');
  }
  function show(el) {
    el.classList.remove(HIDE_CLASS);
    el.style.removeProperty('display');
  }

  function applyFilter() {
    for (const e of currentEntries) {
      if (e.type === LECTURE_TYPE) {
        show(e.el);
        continue;
      }
      const courseSel = selections[e.courseId];
      const chosen = courseSel ? courseSel[e.type] : undefined;
      if (!chosen || chosen === e.group) {
        show(e.el);
      } else {
        hide(e.el);
      }
    }
  }

  function setSelection(courseId, type, group) {
    if (!selections[courseId]) selections[courseId] = {};
    if (!group) {
      delete selections[courseId][type];
      if (Object.keys(selections[courseId]).length === 0) delete selections[courseId];
    } else {
      selections[courseId][type] = group;
    }
    chrome.storage.local.set({ [SELECTIONS_KEY]: selections });
  }

  function buildPanel(courseMap) {
    const existing = document.getElementById('usos-filter-panel');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = 'usos-filter-panel';
    if (collapsed) panel.classList.add('usos-filter-collapsed');

    panel.innerHTML =
      '<div id="usos-filter-header">' +
        '<span>Filtr grup zajęciowych</span>' +
        '<button id="usos-filter-toggle" title="Zwiń/rozwiń">' + (collapsed ? '+' : '\u2013') + '</button>' +
      '</div>' +
      '<div id="usos-filter-body"></div>' +
      '<div id="usos-filter-footer">' +
        '<button id="usos-filter-reset">Wyczyść filtry (pokaż wszystko)</button>' +
      '</div>';

    document.body.appendChild(panel);

    const body = panel.querySelector('#usos-filter-body');
    const sortedCourses = Array.from(courseMap.entries()).sort((a, b) =>
      a[1].name.localeCompare(b[1].name, 'pl')
    );

    let anyFilterable = false;

    for (const [courseId, course] of sortedCourses) {
      if (course.types.size === 0) continue;
      anyFilterable = true;

      const row = document.createElement('div');
      row.className = 'usos-filter-course';

      const title = document.createElement('div');
      title.className = 'usos-filter-course-name';
      title.textContent = course.name;
      row.appendChild(title);

      const sortedTypes = Array.from(course.types.entries()).sort((a, b) => a[0].localeCompare(b[0]));

      for (const [type, groupsSet] of sortedTypes) {
        const groups = Array.from(groupsSet).sort((a, b) => Number(a) - Number(b));

        const line = document.createElement('div');
        line.className = 'usos-filter-type-line';

        const label = document.createElement('span');
        label.className = 'usos-filter-type-label';
        label.textContent = type;
        line.appendChild(label);

        const select = document.createElement('select');
        select.dataset.courseId = courseId;
        select.dataset.type = type;

        const optAll = document.createElement('option');
        optAll.value = '';
        optAll.textContent = 'Wszystkie';
        select.appendChild(optAll);

        for (const g of groups) {
          const opt = document.createElement('option');
          opt.value = g;
          opt.textContent = 'Gr. ' + g;
          select.appendChild(opt);
        }

        const current = (selections[courseId] && selections[courseId][type]) || '';
        select.value = current;

        select.addEventListener('change', () => {
          setSelection(courseId, type, select.value);
          applyFilter();
        });

        line.appendChild(select);
        row.appendChild(line);
      }

      body.appendChild(row);
    }

    if (!anyFilterable) {
      const info = document.createElement('div');
      info.className = 'usos-filter-empty';
      info.textContent = 'Nie znaleziono grup do filtrowania (same wykłady).';
      body.appendChild(info);
    }

    panel.querySelector('#usos-filter-toggle').addEventListener('click', () => {
      collapsed = !collapsed;
      panel.classList.toggle('usos-filter-collapsed', collapsed);
      panel.querySelector('#usos-filter-toggle').textContent = collapsed ? '+' : '\u2013';
      chrome.storage.local.set({ [COLLAPSED_KEY]: collapsed });
    });

    panel.querySelector('#usos-filter-reset').addEventListener('click', () => {
      selections = {};
      chrome.storage.local.set({ [SELECTIONS_KEY]: selections });
      body.querySelectorAll('select').forEach((s) => (s.value = ''));
      applyFilter();
    });
  }

  function scanAndRender() {
    currentEntries = collectEntries();
    if (currentEntries.length === 0) return;
    const courseMap = buildCourseMap(currentEntries);
    buildPanel(courseMap);
    applyFilter();
  }

  function setupObserver() {
    const container = document.querySelector('.timetable-wrapper') || document.querySelector('usos-timetable');
    if (!container) return;
    const observer = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(scanAndRender, 300);
    });
    observer.observe(container, { childList: true, subtree: true });
  }

  function init() {
    chrome.storage.local.get([SELECTIONS_KEY, COLLAPSED_KEY], (res) => {
      selections = (res && res[SELECTIONS_KEY]) || {};
      collapsed = !!(res && res[COLLAPSED_KEY]);
      scanAndRender();
      setupObserver();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
