/* ============================================================
   Roles Flow — palette + chart-token reader
   Companion to theme.css. Include after it:
     <script src="theme.js"></script>

   Why this exists: the sankey / timeline / ridgeline are built as
   SVG strings, and SVG presentation attributes (fill=, stroke=)
   do NOT inherit CSS custom properties. So the builders read the
   resolved token values from here instead of hard-coding hex.
   ============================================================ */
(function (global) {
  'use strict';

  var PALETTES = ['paper', 'ink', 'pop', 'tide'];
  var STORE_KEY = 'rolesFlow.theme';

  var TOKENS = [
    'paper', 'panel', 'rule', 'ink', 'muted', 'faint', 'accent', 'accent-fg',
    'chip-bg', 'chip-bd', 'bar', 'bar-on', 'thumb',
    'up', 'down', 'flat', 'grid', 'axis', 'dot-fill',
    'pair-a', 'pair-b'
  ];

  var FUNCTIONS = ['engineering', 'product', 'design', 'research',
                   'sales', 'marketing', 'operations', 'other'];

  function readVar(name) {
    return getComputedStyle(document.documentElement)
      .getPropertyValue('--' + name).trim();
  }

  /* Resolved token bundle. Call once per render; cheap, but do not
     call it inside a per-node loop. */
  function theme() {
    var t = {};
    TOKENS.forEach(function (k) {
      t[k.replace(/-(\w)/g, function (m, c) { return c.toUpperCase(); })] = readVar(k);
    });
    t.fn = {};
    FUNCTIONS.forEach(function (fn) { t.fn[fn] = readVar('fn-' + fn); });
    return t;
  }

  function current() {
    return document.documentElement.getAttribute('data-theme') || 'pop';
  }

  function set(name) {
    if (PALETTES.indexOf(name) < 0) return;
    document.documentElement.setAttribute('data-theme', name);
    try { localStorage.setItem(STORE_KEY, name); } catch (e) {}
    global.dispatchEvent(new CustomEvent('themechange', { detail: { theme: name } }));
  }

  function restore() {
    var saved = null;
    try { saved = localStorage.getItem(STORE_KEY); } catch (e) {}
    document.documentElement.setAttribute('data-theme', saved || 'pop');
  }

  /* Build a <div class="seg"> of palette buttons; wire it to re-render. */
  function mountSwitcher(el, onChange) {
    if (!el) return;
    var labels = { paper: 'Paper', ink: 'Ink', pop: 'Pop', tide: 'Tide' };
    el.className = 'seg';
    el.innerHTML = PALETTES.map(function (p) {
      return '<button type="button" data-theme-set="' + p + '"' +
        (p === current() ? ' class="on"' : '') + '>' + labels[p] + '</button>';
    }).join('');
    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-theme-set]');
      if (!b) return;
      set(b.getAttribute('data-theme-set'));
      el.querySelectorAll('button').forEach(function (x) {
        x.classList.toggle('on', x.getAttribute('data-theme-set') === current());
      });
      if (onChange) onChange(current());
    });
  }

  restore();

  global.RolesFlowTheme = {
    palettes: PALETTES,
    functions: FUNCTIONS,
    theme: theme,
    current: current,
    set: set,
    mountSwitcher: mountSwitcher
  };
})(window);
