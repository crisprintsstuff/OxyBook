// SPDX-License-Identifier: Apache-2.0

/**
 * Client-side island script shipped with `@oxybook/theme-default` (Apache-2.0,
 * ARCHITECTURE §5.2, §6, §10):
 * - Initializes Pagefind UI (`#oxybook-search`) and `/` or `Ctrl+K` / `Cmd+K` shortcut.
 * - Hydrates `<Tabs>` / `<TabItem>` (`.oxybook-tabs`), including `data-tabs-group` sync.
 * - Hydrates `::: code-group` / `<CodeGroup>` (`.oxybook-code-group`) with a tab bar.
 * - Hydrates the mobile sidebar drawer toggle and version switcher `<select>`.
 */
export function buildThemeClientScript(bundlePath: string): string {
  return `(function () {
  var BUNDLE_PATH = ${JSON.stringify(bundlePath)};

  function selectTab(container, value, syncGroup) {
    var buttons = container.querySelectorAll(':scope > .oxybook-tabs-list > .oxybook-tab');
    var panels = container.querySelectorAll(':scope > .oxybook-tab-item, :scope > .oxybook-code-panel');
    var targetValue = value;
    if (!targetValue && buttons.length > 0) {
      targetValue = buttons[0].getAttribute('data-tab-value');
    }
    buttons.forEach(function (btn) {
      var active = btn.getAttribute('data-tab-value') === targetValue;
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
      btn.setAttribute('tabindex', active ? '0' : '-1');
    });
    panels.forEach(function (panel) {
      var active = panel.getAttribute('data-tab-value') === targetValue;
      if (active) {
        panel.removeAttribute('hidden');
      } else {
        panel.setAttribute('hidden', '');
      }
    });
    if (syncGroup) {
      var group = container.getAttribute('data-tabs-group');
      if (group && targetValue) {
        try {
          localStorage.setItem('oxybook-tab:' + group, targetValue);
        } catch (e) {}
        document.querySelectorAll('.oxybook-tabs[data-tabs-group]').forEach(function (other) {
          if (other !== container && other.getAttribute('data-tabs-group') === group) {
            selectTab(other, targetValue, false);
          }
        });
      }
    }
  }

  function initTabs() {
    document.querySelectorAll('.oxybook-tabs').forEach(function (container) {
      var buttons = Array.prototype.slice.call(
        container.querySelectorAll(':scope > .oxybook-tabs-list > .oxybook-tab')
      );
      if (buttons.length === 0) return;
      var initial = buttons[0].getAttribute('data-tab-value');
      var group = container.getAttribute('data-tabs-group');
      if (group) {
        try {
          var saved = localStorage.getItem('oxybook-tab:' + group);
          if (saved && buttons.some(function (b) { return b.getAttribute('data-tab-value') === saved; })) {
            initial = saved;
          }
        } catch (e) {}
      }
      selectTab(container, initial, false);
      buttons.forEach(function (btn, idx) {
        btn.addEventListener('click', function () {
          selectTab(container, btn.getAttribute('data-tab-value'), true);
        });
        btn.addEventListener('keydown', function (ev) {
          if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
          ev.preventDefault();
          var nextIdx = ev.key === 'ArrowRight'
            ? (idx + 1) % buttons.length
            : (idx - 1 + buttons.length) % buttons.length;
          var nextBtn = buttons[nextIdx];
          if (nextBtn) {
            nextBtn.focus();
            selectTab(container, nextBtn.getAttribute('data-tab-value'), true);
          }
        });
      });
    });
  }

  function initCodeGroups() {
    document.querySelectorAll('.oxybook-code-group').forEach(function (group) {
      if (group.querySelector(':scope > .oxybook-tabs-list')) return;
      var pres = Array.prototype.slice.call(group.querySelectorAll(':scope > pre'));
      if (pres.length <= 1) return;
      var tablist = document.createElement('div');
      tablist.className = 'oxybook-tabs-list';
      tablist.setAttribute('role', 'tablist');
      pres.forEach(function (pre, idx) {
        var val = String(idx);
        var label =
          pre.getAttribute('data-title') ||
          pre.getAttribute('data-language') ||
          ('Tab ' + (idx + 1));
        pre.classList.add('oxybook-code-panel');
        pre.setAttribute('data-tab-value', val);
        if (idx > 0) pre.setAttribute('hidden', '');
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'oxybook-tab';
        btn.setAttribute('role', 'tab');
        btn.setAttribute('data-tab-value', val);
        btn.setAttribute('aria-selected', idx === 0 ? 'true' : 'false');
        btn.textContent = label;
        btn.addEventListener('click', function () {
          selectTab(group, val, false);
        });
        tablist.appendChild(btn);
      });
      group.insertBefore(tablist, group.firstChild);
    });
  }

  function initShell() {
    var toggle = document.querySelector('.oxybook-mobile-toggle');
    if (toggle) {
      toggle.addEventListener('click', function () {
        var open = document.body.getAttribute('data-sidebar-open') === 'true';
        document.body.setAttribute('data-sidebar-open', open ? 'false' : 'true');
        toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
      });
    }
    var versionSelect = document.querySelector('.oxybook-version-select');
    if (versionSelect) {
      versionSelect.addEventListener('change', function (ev) {
        var target = ev.target && ev.target.value;
        if (target) window.location.href = target;
      });
    }
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && document.body.getAttribute('data-sidebar-open') === 'true') {
        document.body.setAttribute('data-sidebar-open', 'false');
        if (toggle) toggle.setAttribute('aria-expanded', 'false');
      }
      var tag = ev.target && ev.target.tagName;
      var editing = tag === 'INPUT' || tag === 'TEXTAREA' || (ev.target && ev.target.isContentEditable);
      if (!editing && (ev.key === '/' || ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k'))) {
        var input = document.querySelector('#oxybook-search input');
        if (input) {
          ev.preventDefault();
          input.focus();
        }
      }
    });
  }

  function initSearch() {
    var el = document.getElementById('oxybook-search');
    if (!el) return;
    if (typeof window.PagefindUI === 'function') {
      new window.PagefindUI({
        element: '#oxybook-search',
        bundlePath: BUNDLE_PATH,
        showSubResults: true,
        resetStyles: false
      });
    }
  }

  function boot() {
    initTabs();
    initCodeGroups();
    initShell();
    initSearch();
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();`;
}
