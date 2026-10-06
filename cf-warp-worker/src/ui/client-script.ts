/**
 * Panel single-page application (vanilla JS, no build step, no CDN).
 *
 * NOTE: this file is embedded into an HTML <script> tag as-is. Keep it free of
 * template literals and of any interpolation marker so the string stays intact.
 */

export const CLIENT_SCRIPT = String.raw`
(function () {
  'use strict';

  var boot = window.__NOVA__ || { t: {}, lang: 'fa', demo: false };
  var T = boot.t || {};
  var state = { settings: {}, identities: [], clients: [], proxies: [], logs: [], stats: {}, persistent: true, proxy: {} };
  var activeTab = 'dashboard';

  function t(key) { return T[key] || key; }

  function h(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === null || value === undefined || value === false) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key.indexOf('on') === 0 && typeof value === 'function') node.addEventListener(key.slice(2), value);
        else if (key === 'dataset') Object.keys(value).forEach(function (k) { node.dataset[k] = value[k]; });
        else node.setAttribute(key, value === true ? '' : value);
      });
    }
    (children || []).forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function toast(message, kind) {
    var holder = document.getElementById('toasts');
    if (!holder) return;
    var node = h('div', { text: message });
    if (kind) node.style.borderColor = kind === 'error' ? 'var(--err)' : (kind === 'success' ? 'var(--ok)' : 'var(--line)');
    holder.appendChild(node);
    setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 4200);
  }

  function api(path, options) {
    var opts = options || {};
    var init = { method: opts.method || 'GET', headers: {}, credentials: 'same-origin' };
    if (opts.body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return fetch('/api/v1' + path, init).then(function (response) {
      return response.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (err) { data = null; }
        if (!response.ok) {
          if (response.status === 401) { location.href = '/login'; throw new Error('unauthorized'); }
          var message = (data && (data.message || data.error)) || ('HTTP ' + response.status);
          throw new Error(message);
        }
        return data;
      });
    });
  }

  function copy(text, label) {
    var done = function () { toast(label || t('copied'), 'success'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(); });
    } else { fallback(); }
    function fallback() {
      var area = h('textarea', { style: 'position:fixed;opacity:0' });
      area.value = text;
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); done(); } catch (err) { toast(t('error'), 'error'); }
      document.body.removeChild(area);
    }
  }

  function download(name, content) {
    var blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = h('a', { href: url, download: name });
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  function formatDate(ms) {
    if (!ms) return t('never');
    try { return new Date(ms).toLocaleString(boot.lang === 'en' ? 'en-GB' : 'fa-IR'); } catch (err) { return String(ms); }
  }

  function formatBytes(value) {
    if (!value || value < 0) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var index = 0;
    var size = value;
    while (size >= 1024 && index < units.length - 1) { size = size / 1024; index++; }
    return size.toFixed(size >= 10 || index === 0 ? 0 : 1) + ' ' + units[index];
  }

  /* ------------------------------- modal ---------------------------------- */

  var modal = document.getElementById('modal');
  var modalBody = document.getElementById('modal-body');

  function openModal(title, content, footer) {
    clear(modalBody);
    modalBody.appendChild(h('div', { class: 'between' }, [
      h('h2', { text: title }),
      h('button', { class: 'ghost small', text: t('close'), onclick: closeModal })
    ]));
    modalBody.appendChild(content);
    if (footer) modalBody.appendChild(footer);
    modal.classList.add('open');
  }

  function closeModal() { modal.classList.remove('open'); }

  document.addEventListener('keydown', function (event) { if (event.key === 'Escape') closeModal(); });
  if (modal) modal.addEventListener('click', function (event) { if (event.target === modal) closeModal(); });

  /* ------------------------------- actions -------------------------------- */

  function loadState() {
    return api('/state').then(function (data) {
      state = data;
      state.settings = data.settings || {};
      state.identities = data.identities || [];
      state.clients = data.clients || [];
      state.proxies = data.proxies || [];
      state.proxy = data.proxy || {};
      state.logs = data.logs || [];
      state.stats = data.stats || {};
      state.persistent = data.persistent !== false;
      document.getElementById('kv-warning').style.display = state.persistent ? 'none' : 'block';
      render();
    }).catch(function (err) {
      toast(err.message, 'error');
    });
  }

  function proxyById(id) {
    for (var i = 0; i < state.proxies.length; i++) {
      if (state.proxies[i].id === id) return state.proxies[i];
    }
    return null;
  }

  function proxySubscriptionUrl(proxy) {
    return location.origin + '/sub/' + proxy.shareToken;
  }

  function identityById(id) {
    for (var i = 0; i < state.identities.length; i++) {
      if (state.identities[i].id === id) return state.identities[i];
    }
    return null;
  }

  function showConfig(clientId) {
    var client = null;
    for (var i = 0; i < state.clients.length; i++) { if (state.clients[i].id === clientId) client = state.clients[i]; }
    if (!client) return;
    var selected = client.format || state.settings.defaultFormat || 'wg';
    var content = h('div', { class: 'stack' });
    content.appendChild(h('div', { class: 'row' }, [
      h('span', { class: 'pill', text: client.name }),
      h('span', { class: 'pill muted', text: (identityById(client.identityId) || {}).name || '-' }),
      h('span', { class: 'pill muted', text: (identityById(client.identityId) || {}).addressV4 || '-' })
    ]));

    var formats = ['wg', 'amneziawg', 'singbox', 'clash', 'xray', 'json'];
    var tabsRow = h('div', { class: 'row' });
    var pre = h('pre', { text: t('loading') });
    var qrBox = h('div', { class: 'qr' });
    var qrWrap = h('div', { class: 'stack tiny muted' }, [qrBox, h('span', { text: t('scanHint') })]);
    var current = '';

    function load(format) {
      selected = format;
      pre.textContent = t('loading');
      api('/clients/' + client.id + '/config?format=' + format).then(function (data) {
        current = data.content;
        pre.textContent = data.content;
        clear(qrBox);
        qrBox.appendChild(h('img', { src: '/qr/' + client.shareToken + '.svg?format=' + format, alt: t('qrCode'), style: 'width:min(300px,70vw)' }));
      }).catch(function (err) {
        pre.textContent = err.message;
        qrWrap.style.display = 'none';
      });
    }

    formats.forEach(function (format) {
      tabsRow.appendChild(h('button', {
        class: 'small' + (format === selected ? ' primary' : ''),
        text: format,
        onclick: function (event) {
          Array.prototype.forEach.call(tabsRow.children, function (child) { child.className = 'small'; });
          event.currentTarget.className = 'small primary';
          load(format);
        }
      }));
    });

    content.appendChild(tabsRow);
    content.appendChild(h('div', { class: 'split' }, [
      h('div', { class: 'stack' }, [
        pre,
        h('div', { class: 'row' }, [
          h('button', { class: 'small primary', text: t('copy'), onclick: function () { copy(current); } }),
          h('button', { class: 'small', text: t('download'), onclick: function () { download(client.name + '.' + (selected === 'clash' ? 'yaml' : ((selected === 'wg' || selected === 'amneziawg') ? 'conf' : 'json')), current); } }),
          h('button', { class: 'small ghost', text: t('copyLink'), onclick: function () { copy(location.origin + '/c/' + client.shareToken, t('copied')); } })
        ])
      ]),
      qrWrap
    ]));
    openModal(client.name, content);
    load(selected);
  }

  function showProxyModal(proxy) {
    var linkInput = h('textarea', { readonly: true, style: 'min-height:70px' });
    linkInput.value = proxy.url || '';
    var link = proxy.url || '';
    var content = h('div', { class: 'stack' }, [
      h('div', { class: 'row' }, [
        h('span', { class: 'pill', text: proxy.name }),
        h('span', { class: 'pill ok', text: 'VLESS + WS + TLS' }),
        h('span', { class: 'pill muted', text: proxy.host + ':' + proxy.port })
      ]),
      h('div', {}, [h('label', { text: t('proxyLink') }), linkInput]),
      h('p', { class: 'small-hint', text: t('proxyApps') }),
      h('div', { class: 'row' }, [
        h('button', { class: 'small primary', text: t('copy'), onclick: function () { copy(link); } }),
        h('button', { class: 'small', text: t('download'), onclick: function () { download(proxy.name + '.txt', link); } }),
        h('a', { href: '/c/' + proxy.shareToken, target: '_blank', rel: 'noreferrer', style: 'text-decoration:none' }, [
          h('button', { class: 'small ghost', text: t('showLink') })
        ])
      ]),
      h('div', { class: 'split' }, [
        h('div', { class: 'stack' }, [
          h('div', { class: 'muted tiny', text: t('proxySubHint') }),
          h('div', { class: 'mono tiny', style: 'word-break:break-all', text: proxySubscriptionUrl(proxy) }),
          h('div', { class: 'row' }, [
            h('button', { class: 'small ghost', text: t('copy'), onclick: function () { copy(proxySubscriptionUrl(proxy)); } }),
            h('button', { class: 'small ghost', text: 'QR', onclick: function () { window.open('/qr/' + proxy.shareToken + '.svg', '_blank'); } })
          ]),
          h('div', { class: 'muted tiny', text: t('proxyUuid') + ': ' + (proxy.uuid || '') })
        ]),
        h('div', { class: 'qr' }, [h('img', { src: '/qr/' + proxy.shareToken + '.svg', alt: t('qrCode'), style: 'width:min(260px,60vw)' })])
      ]),
      h('div', { class: 'row' }, [
        h('button', { class: 'ghost', text: t('cancel'), onclick: closeModal })
      ])
    ]);
    openModal(proxy.name, content);
  }

  function createProxyForm() {
    var nameInput = h('input', { placeholder: 'proxy-1' });
    var countInput = h('input', { type: 'number', min: '1', max: '25', value: '1' });
    var form = h('div', { class: 'stack' }, [
      h('div', { class: 'grid' }, [
        h('div', {}, [h('label', { text: t('clientName') }), nameInput]),
        h('div', {}, [h('label', { text: t('proxyCount') }), countInput])
      ]),
      h('p', { class: 'small-hint', text: t('serviceHint') }),
      h('div', { class: 'row' }, [
        h('button', {
          class: 'primary',
          text: t('newProxy'),
          onclick: function (event) {
            var button = event.currentTarget;
            button.disabled = true;
            api('/proxies', { method: 'POST', body: { name: nameInput.value, count: Number(countInput.value) || 1 } })
              .then(function (result) {
                closeModal();
                toast(t('success') + ' · ' + result.proxies.length, 'success');
                return loadState();
              })
              .catch(function (err) { toast(err.message, 'error'); })
              .then(function () { button.disabled = false; });
          }
        }),
        h('button', { class: 'ghost', text: t('cancel'), onclick: closeModal })
      ])
    ]);
    openModal(t('newProxy'), form);
  }

  function createClientForm() {
    var nameInput = h('input', { placeholder: state.settings.namePrefix + '-1' });
    var countInput = h('input', { type: 'number', min: '1', max: '25', value: '1' });
    var formatSelect = h('select');
    ['wg', 'amneziawg', 'singbox', 'clash', 'xray', 'json'].forEach(function (format) {
      formatSelect.appendChild(h('option', { value: format, text: format, selected: format === (state.settings.defaultFormat || 'wg') }));
    });
    var identitySelect = h('select');
    identitySelect.appendChild(h('option', { value: '', text: t('autoIdentity') }));
    state.identities.forEach(function (identity) {
      identitySelect.appendChild(h('option', { value: identity.id, text: identity.name + (identity.addressV4 ? ' — ' + identity.addressV4 : '') }));
    });

    var awgSelect = h('select');
    var awgDefaults = state.settings.awg || {};
    [['off', t('awgOff')], ['warp-safe', t('awgWarpSafe')], ['custom', t('awgCustom')]].forEach(function (pair) {
      var selected = pair[0] === 'off' ? !awgDefaults.enabled : (awgDefaults.enabled && ((awgDefaults.mode === 'custom') === (pair[0] === 'custom')));
      awgSelect.appendChild(h('option', { value: pair[0], text: pair[1], selected: selected }));
    });
    var warn = h('p', { class: 'small-hint', text: t('awgHint') });

    var form = h('div', { class: 'stack' }, [
      h('div', { class: 'grid' }, [
        h('div', {}, [h('label', { text: t('clientName') }), nameInput]),
        h('div', {}, [h('label', { text: t('howMany') }), countInput])
      ]),
      h('div', { class: 'grid' }, [
        h('div', {}, [h('label', { text: t('format') }), formatSelect]),
        h('div', {}, [h('label', { text: t('identity') }), identitySelect])
      ]),
      h('div', {}, [h('label', { text: t('awgTitle') }), awgSelect, warn]),
      h('p', { class: 'small-hint', text: t('bulkHint') }),
      h('div', { class: 'row' }, [
        h('button', {
          class: 'primary',
          text: t('newConfig'),
          onclick: function (event) {
            var button = event.currentTarget;
            button.disabled = true;
            var awgChoice = awgSelect.value;
            var awgPayload = awgChoice === 'off'
              ? { enabled: false }
              : Object.assign({}, awgDefaults, {
                  enabled: true,
                  mode: awgChoice === 'custom' ? 'custom' : 'warp-safe',
                  cps: 'quic'
                });
            api('/clients', {
              method: 'POST',
              body: {
                name: nameInput.value,
                count: Number(countInput.value) || 1,
                format: formatSelect.value,
                identityId: identitySelect.value || undefined,
                awg: awgPayload
              }
            }).then(function (result) {
              closeModal();
              toast(t('success') + ' · ' + result.clients.length, 'success');
              return loadState();
            }).catch(function (err) {
              toast(err.message, 'error');
            }).then(function () { button.disabled = false; });
          }
        }),
        h('button', { class: 'ghost', text: t('cancel'), onclick: closeModal })
      ])
    ]);
    openModal(t('newConfig'), form);
  }

  function importForm() {
    var nameInput = h('input', { placeholder: t('optional') });
    var textarea = h('textarea', { placeholder: t('importPlaceholder') });
    var form = h('div', { class: 'stack' }, [
      h('p', { class: 'small-hint', text: t('importHint') }),
      h('div', {}, [h('label', { text: t('identityName') }), nameInput]),
      textarea,
      h('div', { class: 'row' }, [
        h('button', {
          class: 'primary',
          text: t('importIdentity'),
          onclick: function (event) {
            var button = event.currentTarget;
            button.disabled = true;
            api('/identities/import', { method: 'POST', body: { content: textarea.value, name: nameInput.value } })
              .then(function () { closeModal(); toast(t('success'), 'success'); return loadState(); })
              .catch(function (err) { toast(err.message, 'error'); })
              .then(function () { button.disabled = false; });
          }
        }),
        h('button', { class: 'ghost', text: t('cancel'), onclick: closeModal })
      ])
    ]);
    openModal(t('importIdentity'), form);
  }

  function licenseForm(identity) {
    var input = h('input', { placeholder: 'XXXXXXXX-XXXXXXXX-XXXXXXXX' });
    var form = h('div', { class: 'stack' }, [
      h('p', { class: 'small-hint', text: t('licenseHint') }),
      input,
      h('div', { class: 'row' }, [
        h('button', {
          class: 'primary',
          text: t('save'),
          onclick: function (event) {
            var button = event.currentTarget;
            button.disabled = true;
            api('/identities/' + identity.id + '/license', { method: 'POST', body: { license: input.value } })
              .then(function () { closeModal(); toast(t('success'), 'success'); return loadState(); })
              .catch(function (err) { toast(err.message, 'error'); })
              .then(function () { button.disabled = false; });
          }
        }),
        h('button', { class: 'ghost', text: t('cancel'), onclick: closeModal })
      ])
    ]);
    openModal(t('bindLicense') + ' · ' + identity.name, form);
  }

  function renameForm(identity) {
    var input = h('input', { value: identity.name });
    var form = h('div', { class: 'stack' }, [
      h('div', {}, [h('label', { text: t('identityName') }), input]),
      h('div', { class: 'row' }, [
        h('button', {
          class: 'primary',
          text: t('save'),
          onclick: function () {
            api('/identities/' + identity.id, { method: 'PATCH', body: { name: input.value } })
              .then(function () { closeModal(); return loadState(); })
              .catch(function (err) { toast(err.message, 'error'); });
          }
        }),
        h('button', { class: 'ghost', text: t('cancel'), onclick: closeModal })
      ])
    ]);
    openModal(t('rename'), form);
  }

  /* -------------------------------- views --------------------------------- */

  function statCard(label, value) {
    return h('div', { class: 'card' }, [
      h('div', { class: 'muted tiny', text: label }),
      h('div', { style: 'font-size:26px;font-weight:800', text: String(value) })
    ]);
  }

  function viewDashboard() {
    var wrap = h('div', { class: 'stack' });
    wrap.appendChild(h('div', { class: 'grid' }, [
      statCard(t('statClients'), state.stats.clients || 0),
      statCard(t('statIdentities'), state.stats.identities || 0),
      statCard(t('statProxies'), state.stats.proxies || 0),
      statCard(t('statPlus'), state.stats.plus || 0),
      statCard(t('statViews'), state.stats.views || 0)
    ]));

    var quick = h('div', { class: 'card' }, [
      h('div', { class: 'between' }, [
        h('div', {}, [h('h2', { text: t('navDashboard') }), h('p', { class: 'muted', text: t('tagline') })]),
        h('div', { class: 'row' }, [
          h('button', { class: 'primary', text: t('newConfig'), onclick: createClientForm }),
          h('button', { text: t('newProxy'), onclick: createProxyForm }),
          h('button', { class: 'ghost', text: t('newIdentity'), onclick: registerIdentity }),
          h('button', { class: 'ghost', text: t('importIdentity'), onclick: importForm })
        ])
      ])
    ]);
    wrap.appendChild(quick);

    if (!state.identities.length) {
      wrap.appendChild(h('div', { class: 'banner warn', text: t('noIdentities') }));
    }

    var logsCard = h('div', { class: 'card' }, [
      h('div', { class: 'between' }, [
        h('h2', { text: t('logs') }),
        h('button', { class: 'small ghost', text: t('clearLogs'), onclick: function () {
          if (!confirm(t('confirmClearLogs'))) return;
          api('/logs', { method: 'DELETE' }).then(loadState);
        } })
      ])
    ]);
    var logs = h('div', { class: 'logs' });
    if (!state.logs.length) logs.appendChild(h('p', { class: 'muted', text: t('loading') }));
    state.logs.forEach(function (entry) {
      logs.appendChild(h('div', { class: 'log ' + entry.level }, [
        h('span', { class: 'dot' }),
        h('div', {}, [
          h('div', { text: entry.message }),
          h('div', { class: 'muted tiny', text: (entry.details ? entry.details + ' · ' : '') + formatDate(entry.at) })
        ])
      ]));
    });
    logsCard.appendChild(logs);
    wrap.appendChild(logsCard);
    return wrap;
  }

  function viewClients() {
    var wrap = h('div', { class: 'stack' });
    wrap.appendChild(h('div', { class: 'between' }, [
      h('h2', { text: t('navClients') }),
      h('div', { class: 'row' }, [
        h('button', { class: 'primary', text: t('newConfig'), onclick: createClientForm }),
        h('button', { class: 'ghost', text: t('refresh'), onclick: loadState })
      ])
    ]));

    if (!state.clients.length) {
      wrap.appendChild(h('div', { class: 'banner', text: t('noClients') }));
      return wrap;
    }

    var table = h('table', { class: 'table' });
    table.appendChild(h('thead', {}, [h('tr', {}, [
      h('th', { text: t('clientName') }),
      h('th', { class: 'hide-sm', text: t('identity') }),
      h('th', { class: 'hide-sm', text: t('address') }),
      h('th', { class: 'hide-sm', text: t('format') }),
      h('th', { text: t('actions') })
    ])]));
    var body = h('tbody');
    state.clients.forEach(function (client) {
      var identity = identityById(client.identityId);
      body.appendChild(h('tr', {}, [
        h('td', {}, [
          h('div', { class: 'row' }, [
            h('div', { style: 'font-weight:600', text: client.name }),
            h('span', { class: 'pill ' + (client.enabled === false ? 'muted' : 'ok'),
              text: client.enabled === false ? t('disabled') : t('enabled') })
          ]),
          h('div', { class: 'muted tiny', text: formatDate(client.createdAt) })
        ]),
        h('td', { class: 'hide-sm' }, [
          h('span', { class: 'pill muted', text: identity ? identity.name : '—' })
        ]),
        h('td', { class: 'hide-sm mono tiny', text: identity && identity.addressV4 ? identity.addressV4 : '—' }),
        h('td', { class: 'hide-sm' }, [
          h('span', { text: client.format }),
          client.awg ? h('span', { class: 'pill ok', style: 'margin-inline-start:6px', text: 'AWG' }) : null
        ]),
        h('td', {}, [h('div', { class: 'row' }, [
          h('button', { class: 'small', text: t('show'), onclick: function () { showConfig(client.id); } }),
          h('button', { class: 'small ghost', text: t('shareLink'), onclick: function () { copy(location.origin + '/c/' + client.shareToken, t('copied')); } }),
          h('button', { class: 'small ghost', text: t('rotate'), onclick: function () {
            if (!confirm(t('confirmRotate'))) return;
            api('/clients/' + client.id + '/rotate', { method: 'POST' })
              .then(function () { toast(t('success'), 'success'); return loadState(); })
              .catch(function (err) { toast(err.message, 'error'); });
          } }),
          h('button', { class: 'small ghost', text: client.enabled === false ? t('enable') : t('disable'), onclick: function () {
            var next = client.enabled === false;
            if (!next && !confirm(t('confirmDisable'))) return;
            api('/clients/' + client.id, { method: 'PATCH', body: { enabled: next } })
              .then(function () { toast(t('success'), 'success'); return loadState(); })
              .catch(function (err) { toast(err.message, 'error'); });
          } }),
          h('button', { class: 'small danger', text: t('remove'), onclick: function () {
            if (!confirm(t('confirmDelete'))) return;
            api('/clients/' + client.id, { method: 'DELETE' }).then(loadState).catch(function (err) { toast(err.message, 'error'); });
          } })
        ])])
      ]));
    });
    table.appendChild(body);
    wrap.appendChild(h('div', { class: 'card' }, [table]));
    return wrap;
  }

  function viewProxies() {
    var wrap = h('div', { class: 'stack' });
    var info = state.proxy || {};
    wrap.appendChild(h('div', { class: 'between' }, [
      h('div', {}, [
        h('h2', { text: t('navProxy') }),
        h('p', { class: 'muted tiny', text: 'VLESS + WebSocket + TLS · ' + (info.host || '') + (info.path || '') })
      ]),
      h('div', { class: 'row' }, [
        h('button', { class: 'primary', text: t('newProxy'), onclick: createProxyForm }),
        h('button', { class: 'ghost', text: t('refresh'), onclick: loadState })
      ])
    ]));
    wrap.appendChild(h('div', { class: 'banner', text: t('serviceHint') }));

    if (!state.proxies.length) {
      wrap.appendChild(h('div', { class: 'banner', text: t('noClients') }));
      return wrap;
    }

    var table = h('table', { class: 'table' });
    table.appendChild(h('thead', {}, [h('tr', {}, [
      h('th', { text: t('clientName') }),
      h('th', { class: 'hide-sm', text: t('proxyUuid') }),
      h('th', { class: 'hide-sm', text: 'Host' }),
      h('th', { text: t('actions') })
    ])]));
    var body = h('tbody');
    state.proxies.forEach(function (proxy) {
      body.appendChild(h('tr', {}, [
        h('td', {}, [
          h('div', { class: 'row' }, [
            h('div', { style: 'font-weight:600', text: proxy.name }),
            h('span', { class: 'pill ' + (proxy.enabled === false ? 'muted' : 'ok'),
              text: proxy.enabled === false ? t('disabled') : t('enabled') })
          ]),
          h('div', { class: 'muted tiny', text: proxy.url ? proxy.url.split('@')[0].replace('vless://', 'vless://') : '' })
        ]),
        h('td', { class: 'hide-sm mono tiny', text: proxy.uuid || '—' }),
        h('td', { class: 'hide-sm mono tiny', text: (proxy.host || '') + ':' + (proxy.port || 443) }),
        h('td', {}, [h('div', { class: 'row' }, [
          h('button', { class: 'small', text: t('showLink'), onclick: function () { showProxyModal(proxy); } }),
          h('button', { class: 'small ghost', text: t('copy'), onclick: function () { copy(proxy.url || ''); } }),
          h('button', { class: 'small ghost', text: t('rotate'), onclick: function () {
            if (!confirm(t('confirmRotate'))) return;
            api('/proxies/' + proxy.id + '/rotate', { method: 'POST' })
              .then(function () { toast(t('success'), 'success'); return loadState(); })
              .catch(function (err) { toast(err.message, 'error'); });
          } }),
          h('button', { class: 'small ghost', text: proxy.enabled === false ? t('enable') : t('disable'), onclick: function () {
            var next = proxy.enabled === false;
            if (!next && !confirm(t('confirmDisable'))) return;
            api('/clients/' + proxy.id, { method: 'PATCH', body: { enabled: next } })
              .then(function () { toast(t('success'), 'success'); return loadState(); })
              .catch(function (err) { toast(err.message, 'error'); });
          } }),
          h('button', { class: 'small danger', text: t('remove'), onclick: function () {
            if (!confirm(t('confirmDelete'))) return;
            api('/clients/' + proxy.id, { method: 'DELETE' }).then(loadState).catch(function (err) { toast(err.message, 'error'); });
          } })
        ])])
      ]));
    });
    table.appendChild(body);
    wrap.appendChild(h('div', { class: 'card' }, [table]));
    return wrap;
  }

  function viewIdentities() {
    var wrap = h('div', { class: 'stack' });
    wrap.appendChild(h('div', { class: 'between' }, [
      h('h2', { text: t('navIdentities') }),
      h('div', { class: 'row' }, [
        h('button', { class: 'primary', text: t('registerIdentity'), onclick: registerIdentity }),
        h('button', { text: t('importIdentity'), onclick: importForm })
      ])
    ]));

    if (!state.identities.length) {
      wrap.appendChild(h('div', { class: 'banner', text: t('noIdentities') }));
      return wrap;
    }

    state.identities.forEach(function (identity) {
      var account = identity.account || {};
      var card = h('div', { class: 'card' });
      card.appendChild(h('div', { class: 'between' }, [
        h('div', { class: 'stack', style: 'gap:4px' }, [
          h('div', { class: 'row' }, [
            h('h3', { text: identity.name }),
            h('span', { class: 'pill ' + (identity.source === 'demo' ? '' : (identity.linked ? 'ok' : 'muted')),
              text: identity.source === 'demo' ? t('demoIdentity') : (identity.linked ? t('linked') : t('notLinked')) }),
            account.warpPlus ? h('span', { class: 'pill ok', text: 'WARP+' }) : null
          ]),
          h('div', { class: 'muted tiny', text: t('lastSync') + ': ' + formatDate(identity.lastSyncAt) + (identity.deviceId ? ' · ' + identity.deviceId : '') })
        ]),
        h('div', { class: 'row' }, [
          h('button', { class: 'small', text: t('sync'), onclick: function () {
            api('/identities/' + identity.id + '/sync', { method: 'POST' })
              .then(function () { toast(t('success'), 'success'); return loadState(); })
              .catch(function (err) { toast(err.message, 'error'); });
          } }),
          h('button', { class: 'small ghost', text: t('licenseKey'), onclick: function () { licenseForm(identity); } }),
          h('button', { class: 'small ghost', text: t('rename'), onclick: function () { renameForm(identity); } }),
          h('button', { class: 'small danger', text: t('remove'), onclick: function () {
            if (!confirm(t('confirmDelete'))) return;
            api('/identities/' + identity.id, { method: 'DELETE' }).then(loadState).catch(function (err) { toast(err.message, 'error'); });
          } })
        ])
      ]));

      var info = h('div', { class: 'kv', style: 'margin-top:12px' });
      var entries = [
        [t('address'), (identity.addressV4 || '—') + (identity.addressV6 ? ' , ' + identity.addressV6 : '')],
        ['Endpoint', (identity.endpoint || 'engage.cloudflareclient.com')],
        ['client_id', identity.clientId || '—'],
        [t('usage'), account.quota ? (formatBytes(account.premiumData || account.usage || 0) + ' / ' + formatBytes(account.quota)) : t('unlimited')],
        [t('createdAt'), formatDate(identity.createdAt)]
      ];
      entries.forEach(function (pair) {
        info.appendChild(h('span', { text: pair[0] }));
        info.appendChild(h('span', { class: 'mono', text: String(pair[1]) }));
      });
      card.appendChild(info);
      if (identity.lastError) card.appendChild(h('div', { class: 'banner warn', style: 'margin-top:10px', text: identity.lastError }));
      wrap.appendChild(card);
    });
    return wrap;
  }

  function viewSettings() {
    var settings = state.settings || {};
    var titleInput = h('input', { value: settings.title || '' });
    var langSelect = h('select');
    [['fa', 'فارسی'], ['en', 'English']].forEach(function (pair) {
      langSelect.appendChild(h('option', { value: pair[0], text: pair[1], selected: settings.lang === pair[0] }));
    });
    var dnsInput = h('input', { value: (settings.dns || []).join(', ') });
    var mtuInput = h('input', { type: 'number', min: '576', max: '1500', value: String(settings.mtu || 1280) });
    var keepaliveInput = h('input', { type: 'number', min: '0', max: '65535', value: String(settings.keepalive || 0) });

    var allowedSelect = h('select');
    [['all', t('allowedIpsAll')], ['exclude-lan', t('allowedIpsLan')], ['custom', t('allowedIpsCustom')]].forEach(function (pair) {
      allowedSelect.appendChild(h('option', { value: pair[0], text: pair[1], selected: settings.allowedIpsMode === pair[0] }));
    });
    var allowedInput = h('input', { value: (settings.allowedIps || []).join(', '), placeholder: '0.0.0.0/0, ::/0' });

    var endpointSelect = h('select');
    [['auto', t('endpointAuto')], ['random', t('endpointRandom')], ['custom', t('endpointCustom')]].forEach(function (pair) {
      endpointSelect.appendChild(h('option', { value: pair[0], text: pair[1], selected: settings.endpointMode === pair[0] }));
    });
    var endpointHost = h('input', { value: settings.endpointHost || '', placeholder: 'engage.cloudflareclient.com' });
    var endpointPort = h('input', { type: 'number', min: '1', max: '65535', value: String(settings.endpointPort || 2408) });

    var ipv6Select = h('select');
    [['true', 'IPv4 + IPv6'], ['false', 'IPv4 only']].forEach(function (pair) {
      ipv6Select.appendChild(h('option', { value: pair[0], text: pair[1], selected: String(settings.includeIPv6 !== false) === pair[0] }));
    });

    var formatSelect = h('select');
    ['wg', 'singbox', 'clash', 'xray', 'json'].forEach(function (format) {
      formatSelect.appendChild(h('option', { value: format, text: format, selected: settings.defaultFormat === format }));
    });

    var policySelect = h('select');
    [['pool', t('policyPool')], ['shared', t('policyShared')]].forEach(function (pair) {
      policySelect.appendChild(h('option', { value: pair[0], text: pair[1], selected: settings.identityPolicy === pair[0] }));
    });

    var awg = settings.awg || {};
    var awgToggle = h('select');
    [['false', t('awgOff')], ['true', t('awgEnabled')]].forEach(function (pair) {
      awgToggle.appendChild(h('option', { value: pair[0], text: pair[1], selected: String(Boolean(awg.enabled)) === pair[0] }));
    });
    var awgMode = h('select');
    [['warp-safe', t('awgWarpSafe')], ['custom', t('awgCustom')]].forEach(function (pair) {
      awgMode.appendChild(h('option', { value: pair[0], text: pair[1], selected: (awg.mode || 'warp-safe') === pair[0] }));
    });
    var awgCps = h('select');
    ['quic', 'stun', 'dtls', 'dns', 'random', 'none'].forEach(function (kind) {
      awgCps.appendChild(h('option', { value: kind, text: kind, selected: (awg.cps || 'quic') === kind }));
    });
    var awgJc = h('input', { type: 'number', min: '0', max: '12', value: String(awg.jc || 4) });
    var awgJmin = h('input', { type: 'number', min: '0', max: '120', value: String(awg.jmin || 40) });
    var awgJmax = h('input', { type: 'number', min: '0', max: '200', value: String(awg.jmax || 70) });

    var proxyPath = h('input', { value: settings.proxyPath || '/ws', placeholder: '/ws' });
    var proxyPort = h('input', { type: 'number', min: '1', max: '65535', value: String(settings.proxyPort || 443) });
    var proxyDomain = h('input', { value: settings.proxyDomain || '', placeholder: 'warp.example.com' });
    var proxyPadding = h('select');
    [['false', 'خاموش'], ['true', 'روشن']].forEach(function (pair) {
      proxyPadding.appendChild(h('option', { value: pair[0], text: pair[1], selected: String(Boolean(settings.proxyPadding)) === pair[0] }));
    });

    var prefixInput = h('input', { value: settings.namePrefix || 'nova' });
    var limitInput = h('input', { type: 'number', min: '1', max: '60', value: String(settings.registrationLimitPerHour || 6) });
    var apiKeyInput = h('input', { value: state.apiKey || '', readonly: true, class: 'mono' });

    var form = h('div', { class: 'card stack' }, [
      h('h2', { text: t('settings') }),
      h('div', { class: 'grid' }, [
        h('div', {}, [h('label', { text: t('panelTitle') }), titleInput]),
        h('div', {}, [h('label', { text: t('language') }), langSelect])
      ]),
      h('div', { class: 'grid' }, [
        h('div', {}, [h('label', { text: t('dns') }), dnsInput]),
        h('div', {}, [h('label', { text: t('mtu') }), mtuInput]),
        h('div', {}, [h('label', { text: t('keepalive') }), keepaliveInput])
      ]),
      h('div', {}, [h('label', { text: t('allowedIpsMode') }), allowedSelect]),
      h('div', {}, [h('label', { text: t('allowedIpsList') }), allowedInput]),
      h('div', { class: 'grid' }, [
        h('div', {}, [h('label', { text: t('endpointMode') }), endpointSelect]),
        h('div', {}, [h('label', { text: t('endpointHost') }), endpointHost]),
        h('div', {}, [h('label', { text: t('endpointPort') }), endpointPort])
      ]),
      h('div', { class: 'grid' }, [
        h('div', {}, [h('label', { text: t('includeIPv6') }), ipv6Select]),
        h('div', {}, [h('label', { text: t('defaultFormat') }), formatSelect]),
        h('div', {}, [h('label', { text: t('identityPolicy') }), policySelect])
      ]),
      h('div', { class: 'grid' }, [
        h('div', {}, [h('label', { text: t('namePrefix') }), prefixInput]),
        h('div', {}, [h('label', { text: t('registrationLimit') }), limitInput])
      ]),
      h('h3', { text: t('awgTitle') }),
      h('div', { class: 'grid' }, [
        h('div', {}, [h('label', { text: t('enabled') }), awgToggle]),
        h('div', {}, [h('label', { text: t('awgPreset') }), awgMode]),
        h('div', {}, [h('label', { text: t('awgCps') }), awgCps])
      ]),
      h('div', { class: 'grid' }, [
        h('div', {}, [h('label', { text: 'Jc' }), awgJc]),
        h('div', {}, [h('label', { text: 'Jmin' }), awgJmin]),
        h('div', {}, [h('label', { text: 'Jmax' }), awgJmax]),
        h('div', {}, [h('label', { text: ' ' }), h('button', {
          class: 'small ghost',
          text: t('awgReshuffle'),
          onclick: function (event) {
            api('/settings', { method: 'PUT', body: { awgRandomize: true } })
              .then(function () { toast(t('success'), 'success'); return loadState(); })
              .catch(function (err) { toast(err.message, 'error'); });
            void event;
          }
        })])
      ]),
      h('p', { class: 'small-hint', text: t('awgHint') }),
      h('h3', { text: t('proxySettings') }),
      h('div', { class: 'grid' }, [
        h('div', {}, [h('label', { text: t('proxyPathLabel') }), proxyPath]),
        h('div', {}, [h('label', { text: t('proxyPortLabel') }), proxyPort]),
        h('div', {}, [h('label', { text: t('proxyDomainLabel') }), proxyDomain]),
        h('div', {}, [h('label', { text: t('proxyPaddingLabel') }), proxyPadding])
      ]),
      h('p', { class: 'small-hint', text: t('proxyPathHint') }),
      h('div', { class: 'row' }, [
        h('button', {
          class: 'primary',
          text: t('save'),
          onclick: function (event) {
            var button = event.currentTarget;
            button.disabled = true;
            api('/settings', {
              method: 'PUT',
              body: {
                title: titleInput.value,
                lang: langSelect.value,
                dns: dnsInput.value,
                mtu: Number(mtuInput.value),
                keepalive: Number(keepaliveInput.value),
                allowedIpsMode: allowedSelect.value,
                allowedIps: allowedInput.value,
                endpointMode: endpointSelect.value,
                endpointHost: endpointHost.value,
                endpointPort: Number(endpointPort.value),
                includeIPv6: ipv6Select.value === 'true',
                defaultFormat: formatSelect.value,
                identityPolicy: policySelect.value,
                namePrefix: prefixInput.value,
                registrationLimitPerHour: Number(limitInput.value),
                awg: {
                  enabled: awgToggle.value === 'true',
                  mode: awgMode.value,
                  cps: awgCps.value,
                  jc: Number(awgJc.value),
                  jmin: Number(awgJmin.value),
                  jmax: Number(awgJmax.value),
                  s1: (awg.s1 || 0), s2: (awg.s2 || 0), s3: (awg.s3 || 0), s4: (awg.s4 || 0),
                  h1: (awg.h1 || 1), h2: (awg.h2 || 2), h3: (awg.h3 || 3), h4: (awg.h4 || 4),
                  i1: awg.i1, i2: awg.i2, i3: awg.i3, i4: awg.i4, i5: awg.i5
                },
                proxyPath: proxyPath.value,
                proxyPort: Number(proxyPort.value),
                proxyDomain: proxyDomain.value,
                proxyPadding: proxyPadding.value === 'true' 
              }
            }).then(function () {
              toast(t('success'), 'success');
              boot.lang = langSelect.value;
              return loadState();
            }).catch(function (err) { toast(err.message, 'error'); })
              .then(function () { button.disabled = false; });
          }
        }),
        h('button', {
          class: 'ghost',
          text: t('signOut'),
          onclick: function () { api('/logout', { method: 'POST' }).then(function () { location.href = '/login'; }); }
        })
      ])
    ]);

    var apiCard = h('div', { class: 'card stack' }, [
      h('h2', { text: t('apiKey') }),
      h('p', { class: 'small-hint', text: 'GET /api/v1/state — Authorization: Bearer <key>' }),
      h('div', { class: 'row' }, [
        h('div', { class: 'grow' }, [apiKeyInput]),
        h('button', { class: 'small', text: t('copy'), onclick: function () { copy(apiKeyInput.value); } }),
        h('button', { class: 'small ghost', text: t('regenerateApiKey'), onclick: function () {
          api('/api-key', { method: 'POST' }).then(function (result) { apiKeyInput.value = result.apiKey; toast(t('success'), 'success'); });
        } })
      ])
    ]);

    return h('div', { class: 'stack' }, [form, apiCard]);
  }

  function viewHelp() {
    var body = h('div', { class: 'card' });
    String(t('helpBody')).split('\n\n').forEach(function (paragraph) {
      body.appendChild(h('p', { class: 'muted', style: 'white-space:pre-wrap', text: paragraph }));
    });
    var links = h('div', { class: 'card stack' }, [
      h('h2', { text: t('sourceFaq') }),
      h('p', {}, [h('a', { href: 'https://cloudflare.com/cdn-cgi/trace', target: '_blank', rel: 'noreferrer', text: 'cloudflare.com/cdn-cgi/trace' })]),
      h('p', {}, [h('a', { href: 'https://github.com/ViRb3/wgcf', target: '_blank', rel: 'noreferrer', text: 'wgcf (پروژه‌ی مرجع)' })]),
      h('p', {}, [h('a', { href: 'https://www.cloudflare.com/application/terms/', target: '_blank', rel: 'noreferrer', text: 'Cloudflare Terms of Service' })])
    ]);
    return h('div', { class: 'stack' }, [body, links]);
  }

  function render() {
    var host = document.getElementById('view');
    clear(host);
    var views = { dashboard: viewDashboard, clients: viewClients, proxy: viewProxies, identities: viewIdentities, settings: viewSettings, help: viewHelp };
    host.appendChild((views[activeTab] || viewDashboard)());
    Array.prototype.forEach.call(document.querySelectorAll('.nav button'), function (button) {
      button.className = button.dataset.tab === activeTab ? 'active' : '';
    });
    var subtitle = document.getElementById('subtitle');
    if (subtitle) subtitle.textContent = t('tagline');
  }

  function registerIdentity() {
    var name = prompt(t('identityName'), '');
    if (name === null) return;
    toast(t('loading'));
    api('/identities', { method: 'POST', body: { name: name } })
      .then(function () { toast(t('success'), 'success'); return loadState(); })
      .catch(function (err) { toast(err.message, 'error'); });
  }

  /* --------------------------------- init --------------------------------- */

  Array.prototype.forEach.call(document.querySelectorAll('.nav button'), function (button) {
    button.addEventListener('click', function () {
      activeTab = button.dataset.tab;
      if (location.hash !== '#' + activeTab) location.hash = activeTab;
      render();
    });
  });

  window.addEventListener('hashchange', function () {
    var tab = (location.hash || '').replace('#', '');
    if (tab && tab !== activeTab) { activeTab = tab; render(); }
  });

  var logoutButton = document.getElementById('logout');
  if (logoutButton) logoutButton.addEventListener('click', function () {
    api('/logout', { method: 'POST' }).then(function () { location.href = '/login'; });
  });

  var newProxyButton = document.getElementById('new-proxy');
  if (newProxyButton) newProxyButton.addEventListener('click', createProxyForm);

  var newConfigButton = document.getElementById('new-config');
  if (newConfigButton) newConfigButton.addEventListener('click', createClientForm);

  var initial = (location.hash || '').replace('#', '');
  if (initial && ['dashboard', 'clients', 'identities', 'settings', 'help'].indexOf(initial) >= 0) activeTab = initial;

  loadState();
  setInterval(function () { if (!document.hidden && activeTab === 'dashboard') loadState(); }, 60000);
})();
`;
