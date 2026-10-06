/** Server-rendered HTML pages (login, setup, panel shell, public profile, errors). */

import { STYLES } from "./theme";
import { CLIENT_SCRIPT } from "./client-script";
import { dictionary, normalizeLang, type Lang } from "./i18n";
import type { ClientRecord, Identity, PanelSettings } from "../types";
import { CONFIG_FORMATS, FORMAT_LABELS, type ConfigFormat } from "../lib/wg";

export interface PageMeta {
  title: string;
  lang: Lang;
  panelTitle: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028|\u2029/g, "");
}

function documentShell(meta: PageMeta, body: string, script = ""): string {
  const dir = meta.lang === "en" ? "ltr" : "rtl";
  return (
    `<!doctype html><html lang="${meta.lang}" dir="${dir}"><head>` +
    `<meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">` +
    `<meta name="robots" content="noindex,nofollow">` +
    `<meta name="color-scheme" content="dark light">` +
    `<title>${escapeHtml(meta.title)}</title>` +
    `<style>${STYLES}</style>` +
    `</head><body>${body}${script}</body></html>`
  );
}

function brandHeader(meta: PageMeta): string {
  const dict = dictionary(meta.lang);
  return (
    `<div class="row between">` +
    `<div class="brand"><div class="logo">N</div><div>` +
    `<div style="font-weight:800">${escapeHtml(meta.panelTitle)}</div>` +
    `<div class="muted tiny">${escapeHtml(dict.tagline)}</div>` +
    `</div></div></div>`
  );
}

export function renderLoginPage(options: {
  panelTitle: string;
  lang: Lang;
  error?: string;
  needsSetup?: boolean;
}): string {
  const lang = normalizeLang(options.lang);
  const dict = dictionary(lang);
  const body =
    `<div class="center"><div style="width:min(430px,100%)" class="stack">` +
    `<div class="card stack">` +
    `<div class="brand"><div class="logo">N</div><div>` +
    `<h1 style="margin:0">${escapeHtml(options.panelTitle)}</h1>` +
    `<div class="muted tiny">${escapeHtml(dict.tagline)}</div></div></div>` +
    (options.error ? `<div class="banner err">${escapeHtml(options.error)}</div>` : "") +
    `<form method="post" action="/login" class="stack">` +
    `<div><label>${escapeHtml(dict.password)}</label>` +
    `<input type="password" name="password" autocomplete="current-password" required autofocus></div>` +
    `<button class="primary" type="submit">${escapeHtml(dict.signIn)}</button>` +
    `</form>` +
    (options.needsSetup
      ? `<p class="small-hint">${escapeHtml(dict.setupHint)} <a href="/setup">${escapeHtml(dict.setupButton)}</a></p>`
      : "") +
    `</div>` +
    `<footer>Nova WARP Worker · ${escapeHtml(dict.tagline)}</footer>` +
    `</div></div>`;
  return documentShell({ title: `${options.panelTitle} — ${dict.login}`, lang, panelTitle: options.panelTitle }, body);
}

export function renderSetupPage(options: { panelTitle: string; lang: Lang; error?: string }): string {
  const lang = normalizeLang(options.lang);
  const dict = dictionary(lang);
  const body =
    `<div class="center"><div style="width:min(460px,100%)" class="stack">` +
    `<div class="card stack">` +
    `<h1>${escapeHtml(dict.setupTitle)}</h1>` +
    `<p class="muted">${escapeHtml(dict.setupHint)}</p>` +
    (options.error ? `<div class="banner err">${escapeHtml(options.error)}</div>` : "") +
    `<form method="post" action="/setup" class="stack">` +
    `<div><label>${escapeHtml(dict.password)}</label>` +
    `<input type="password" name="password" minlength="8" autocomplete="new-password" required autofocus></div>` +
    `<div><label>${escapeHtml(dict.passwordRepeat)}</label>` +
    `<input type="password" name="confirm" minlength="8" autocomplete="new-password" required></div>` +
    `<button class="primary" type="submit">${escapeHtml(dict.setupButton)}</button>` +
    `</form>` +
    `</div></div></div>`;
  return documentShell({ title: `${options.panelTitle} — ${dict.setupTitle}`, lang, panelTitle: options.panelTitle }, body);
}

export function renderPanelPage(options: {
  panelTitle: string;
  lang: Lang;
  persistent: boolean;
  demo: boolean;
}): string {
  const lang = normalizeLang(options.lang);
  const dict = dictionary(lang);
  const tabs: Array<[string, string]> = [
    ["dashboard", dict.navDashboard],
    ["clients", dict.navClients],
    ["identities", dict.navIdentities],
    ["settings", dict.navSettings],
    ["help", dict.navHelp],
  ];
  const nav = tabs
    .map(
      ([key, label]) =>
        `<button data-tab="${key}" class="${key === "dashboard" ? "active" : ""}">${escapeHtml(label)}</button>`,
    )
    .join("");
  const body =
    `<div class="wrap">` +
    brandHeader({ title: options.panelTitle, lang, panelTitle: options.panelTitle }) +
    `<div class="nav" id="nav">${nav}<div style="flex:1"></div>` +
    `<button id="new-config" class="primary small">${escapeHtml(dict.newConfig)}</button>` +
    `<button id="logout" class="ghost small">${escapeHtml(dict.signOut)}</button>` +
    `</div>` +
    `<div id="kv-warning" class="banner warn" style="display:none">${escapeHtml(dict.kvMissing)}</div>` +
    (options.demo ? `<div class="banner warn" style="margin-top:10px">DEMO_MODE</div>` : "") +
    `<div id="view" class="stack" style="margin-top:16px"></div>` +
    `<footer>${escapeHtml(dict.tagline)}</footer>` +
    `</div>` +
    `<div class="modal" id="modal"><div class="card" id="modal-body"></div></div>` +
    `<div class="toast" id="toasts"></div>`;
  const script =
    `<script>window.__NOVA__=${jsonForScript({ t: dict, lang, demo: options.demo })};</script>` +
    `<script>${CLIENT_SCRIPT}</script>`;
  return documentShell({ title: options.panelTitle, lang, panelTitle: options.panelTitle }, body, script);
}

export function renderSharePage(options: {
  panelTitle: string;
  lang: Lang;
  client: ClientRecord;
  identity: Identity | null;
  configs: Array<{ format: ConfigFormat; content: string }>;
  qrSvg?: string | null;
  qrError?: string;
}): string {
  const lang = normalizeLang(options.lang);
  const dict = dictionary(lang);
  const formatTabs = options.configs
    .map(
      (entry) =>
        `<a class="small" style="text-decoration:none" href="?format=${entry.format}#config">` +
        `${escapeHtml(FORMAT_LABELS[entry.format])}</a>`,
    )
    .join(" ");
  const blocks = options.configs
    .map(
      (entry) =>
        `<div class="stack" id="config"><h3>${escapeHtml(FORMAT_LABELS[entry.format])}</h3>` +
        `<pre id="conf-${entry.format}">${escapeHtml(entry.content)}</pre>` +
        `<div class="row">` +
        `<button class="small" data-copy="${entry.format}">${escapeHtml(dict.copy)}</button>` +
        `<button class="small ghost" data-download="${entry.format}">${escapeHtml(dict.download)}</button>` +
        `</div></div>`,
    )
    .join("");
  const payloads = jsonForScript(
    Object.fromEntries(options.configs.map((entry) => [entry.format, entry.content])),
  );
  const script =
    `<script>var CFG=${payloads};` +
    `document.querySelectorAll('[data-copy]').forEach(function(b){b.addEventListener('click',function(){` +
    `navigator.clipboard.writeText(CFG[b.dataset.copy]);b.textContent='${dict.copied}';});});` +
    `document.querySelectorAll('[data-download]').forEach(function(b){b.addEventListener('click',function(){` +
    `var f=b.dataset.download;var ext=f==='wg'?'conf':(f==='clash'?'yaml':'json');` +
    `var blob=new Blob([CFG[f]],{type:'text/plain;charset=utf-8'});var a=document.createElement('a');` +
    `a.href=URL.createObjectURL(blob);a.download='warp-'+f+'.'+ext;document.body.appendChild(a);a.click();});});` +
    `</script>`;
  const body =
    `<div class="wrap">` +
    brandHeader({ title: options.panelTitle, lang, panelTitle: options.panelTitle }) +
    `<div class="split" style="margin-top:18px">` +
    `<div class="stack">` +
    `<div class="card stack">` +
    `<h1>${escapeHtml(dict.publicPage)}</h1>` +
    `<div class="row"><span class="pill">${escapeHtml(options.client.name)}</span>` +
    (options.identity?.addressV4
      ? `<span class="pill muted mono">${escapeHtml(options.identity.addressV4)}</span>`
      : "") +
    `<span class="pill muted">${escapeHtml(dict.format)}</span></div>` +
    `<div class="card" style="box-shadow:none;background:var(--card-2)">${formatTabs}</div>` +
    `</div>` +
    blocks +
    `<div class="banner">${escapeHtml(dict.shareHint)}</div>` +
    `</div>` +
    `<div class="stack">` +
    `<div class="card stack">` +
    `<h3>${escapeHtml(dict.qrCode)}</h3>` +
    (options.qrSvg
      ? `<div class="qr">${options.qrSvg}</div><p class="small-hint">${escapeHtml(dict.scanHint)}</p>`
      : `<p class="small-hint">${escapeHtml(options.qrError ?? dict.error)}</p>`) +
    `</div>` +
    `<div class="card stack">` +
    `<a href="/" style="text-decoration:none"><button style="width:100%">${escapeHtml(dict.backToPanel)}</button></a>` +
    `</div>` +
    `</div>` +
    `</div>` +
    `<footer>${escapeHtml(dict.tagline)}</footer>` +
    `</div>`;
  return documentShell(
    { title: `${options.client.name} — ${options.panelTitle}`, lang, panelTitle: options.panelTitle },
    body,
    script,
  );
}

export function renderMessagePage(options: {
  panelTitle: string;
  lang: Lang;
  heading: string;
  message: string;
  status?: number;
}): string {
  const lang = normalizeLang(options.lang);
  const dict = dictionary(lang);
  const body =
    `<div class="center"><div style="width:min(520px,100%)" class="stack">` +
    `<div class="card stack">` +
    `<h1>${escapeHtml(options.heading)}</h1>` +
    `<p class="muted">${escapeHtml(options.message)}</p>` +
    `<a href="/" style="text-decoration:none"><button class="primary">${escapeHtml(dict.backToPanel)}</button></a>` +
    `</div></div></div>`;
  return documentShell({ title: options.heading, lang, panelTitle: options.panelTitle }, body);
}

export function panelMeta(settings: PanelSettings, lang: Lang): PageMeta {
  return { title: settings.title, lang: normalizeLang(lang), panelTitle: settings.title };
}

export const CONFIG_FORMAT_LIST = CONFIG_FORMATS;
