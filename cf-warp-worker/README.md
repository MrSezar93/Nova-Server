# Nova WARP Worker — WireGuard + AmneziaWG + VLESS proxy on Cloudflare

A single Cloudflare Worker that provides three services behind one hostname, with a Persian-first management panel, share links, QR codes and a JSON API:

| Service | Protocol | Data path |
| --- | --- | --- |
| **WireGuard / WARP profiles** | WireGuard (UDP) | `device → WARP edge → internet` |
| **AmneziaWG profiles** | AmneziaWG (UDP, DPI-resistant) | same path, plus junk packets and fake protocol openings (QUIC/STUN/DTLS/DNS) |
| **Built-in VLESS proxy** | VLESS over TLS + WebSocket | `client → Cloudflare TLS edge → Worker → connect()` to the TCP destination |

> **Architecture note.** A Worker cannot terminate WireGuard itself: Cloudflare Workers have no UDP sockets and WireGuard is UDP-only. So for WireGuard/AmneziaWG the Worker is the **control plane** (identity registration, config rendering, panel, share links) while the tunnel terminates on Cloudflare's **WARP edge**. The **VLESS proxy** is the opposite: it really runs on the Worker — the client opens a TLS+WebSocket tunnel to the Worker and the Worker dials the TCP destination with `connect()`, i.e. a real TCP/TLS proxy on Cloudflare with no VPS.

Persian documentation: **[README.fa.md](./README.fa.md)** · Step-by-step deployment: **[DEPLOY.fa.md](./DEPLOY.fa.md)**

## Features

- WARP device registration against the Android API (`v0a5641`, `CF-Client-Version: a-6.38.9-5641`), with a raw-`node:tls` fallback that mimics the Android TLS fingerprint when Cloudflare answers 403/429.
- Import existing credentials instead of registering: `wgcf` `.conf`, `wgcf-account.toml`, WARP client JSON, or a bare private key.
- Per-device identities (`pool` policy, recommended) or one shared identity — plus key rotation, enable/disable, and share-link revocation.
- Output formats: `wg`, `amneziawg`, `singbox`, `clash`, `xray`, `json` — with `reserved` (client_id) bytes where the protocol needs them.
- AmneziaWG: junk packets (`Jc/Jmin/Jmax`) + fake first packets (`I1..I4`, QUIC/STUN/DTLS/DNS) with a **WARP-safe** mode that stays compatible with Cloudflare's stock peer; Clash/sing-box get an `amnezia-wg-option` block.
- VLESS proxy served by the Worker itself (`/ws/<uuid>`): per-device UUIDs, rotation, `vless://` / Clash / sing-box / Xray links, QR codes, enable/disable — works with v2rayNG, NekoBox, Hiddify, Streisand, Clash.Meta, Shadowrocket. TCP only (no UDP; QUIC falls back to TCP) and `connect()` cannot reach Cloudflare IP ranges or port 25.
- Self-contained QR generator (all 40 versions × 4 ECC levels, SVG output, verified against the `qrcode` reference implementation) and a base64 subscription endpoint.
- Persian/English RTL panel: dashboard, clients, identities, settings, logs, API key — no CDN, no external fonts, zero runtime dependencies.
- Security: PBKDF2-SHA256 password in KV (or `PANEL_PASSWORD` secret), HMAC-signed session cookie with epoch-based logout revocation, same-origin checks, CSP, login throttling, per-hour registration quota.

## Quick start

```bash
npm install
npx wrangler kv namespace create WARP_KV     # put the id into wrangler.toml
npx wrangler secret put PANEL_PASSWORD
npx wrangler secret put SESSION_SECRET
npm run deploy
```

Dashboard-only deployment (no tooling): `npm run build:single` and paste `dist/worker.min.js` into a Worker, then bind a KV namespace named `WARP_KV` and set `PANEL_PASSWORD` + `nodejs_compat`.

## Deploy targets

Both targets run the same code:

```bash
# Cloudflare Worker  →  https://nova-warp.<account>.workers.dev
npm run deploy

# Cloudflare Pages   →  https://nova-warp.pages.dev (WebSockets + VLESS proxy included)
npx wrangler pages project create nova-warp     # once
npm run deploy:pages
npm run preview:pages                           # run the Pages bundle on the real workerd runtime, :8789
```

On Pages the KV namespace (`WARP_KV`), `PANEL_PASSWORD` and the `nodejs_compat`
compatibility flag are configured in the project dashboard (Settings → Bindings /
Variables / Functions). See [DEPLOY.fa.md](./DEPLOY.fa.md) (path C) for the walkthrough.

## Development

```bash
npm run preview        # local panel preview, http://localhost:8080 (password: nova-preview) — DEMO_MODE, no Cloudflare calls
npm test               # 89 tests, fully offline (crypto, AWG, VLESS proxy, QR vs reference, HTTP parser, importers, auth, KV, end-to-end worker suite)
npm run typecheck
npm run build:single   # single-file bundle for the dashboard editor
```

## Routes

| Route | Purpose |
| --- | --- |
| `GET /` , `/login`, `/setup` | Panel (session cookie) |
| `GET /healthz` | Health probe (`kv` shows whether the KV binding is present) |
| `/api/v1/state`, `/api/v1/settings`, `/api/v1/api-key`, `/api/v1/logout`, `/api/v1/logs` | Panel API (cookie or `Authorization: Bearer <API_KEY>`) |
| `/api/v1/identities` (+ `/import`, `/:id`, `/:id/sync`, `/:id/license`) | WARP identity management |
| `/api/v1/clients` (+ `/:id`, `/:id/config?format=`, `/:id/rotate`) | WireGuard / AmneziaWG profile management |
| `/api/v1/proxies` (+ `/:id/links?format=`, `/:id/rotate`) | VLESS proxy management (`PATCH`/`DELETE` via `/api/v1/clients/:id`) |
| `GET /ws/<uuid>` (upgrade) | VLESS-over-WebSocket data plane served by the Worker |
| `GET /c/:token` , `/c/:token/raw?format=` , `/qr/:token.svg` , `/sub/:token` | Public share link, download, QR, base64 subscription |

## Environment variables

`PANEL_PASSWORD`, `SESSION_SECRET`, `API_KEY`, `PANEL_TITLE`, `PANEL_LANG`, `API_VERSION`, `TEAM_TOKEN`, `MAX_REGISTRATIONS_PER_HOUR`, `PASSWORD_ITERATIONS`, `DEMO_MODE`, `DISABLE_RAW_TLS`, `WARP_API_BASE`, `WARP_API_HEADERS`, `ALLOW_FRAMING`, `PROXY_DEBUG`, `PANEL_DEBUG` — see [README.fa.md](./README.fa.md#تنظیمات-و-متغیرها) for defaults and details.

## Troubleshooting highlights

- **"Worker threw a JavaScript exception"** — the runtime used to hide the cause. The Worker now catches it and answers with an *internal error* page carrying an 8-digit error id; set `PANEL_DEBUG=1` to print the message and stack on that page, and watch `npm run tail` for the same id. The two usual culprits on a fresh deploy are a missing `nodejs_compat` compatibility flag and a missing `WARP_KV` binding.

- **429 / `rate_limited` while registering** — Cloudflare throttles new registrations per client. Wait, lower `MAX_REGISTRATIONS_PER_HOUR`, or use **Import identity** (a `wgcf` profile works forever and never touches the API).
- **`persistent: false` in the panel** — the KV binding is missing; data would be lost on restart.
- **`node:tls` errors** — add the `nodejs_compat` compatibility flag, or set `DISABLE_RAW_TLS=1`.
- **Profile does not connect** — try another endpoint/port (`endpointMode = random` or `custom`), and make sure local UDP isn't blocked.
- **AmneziaWG profile rejected by a client** — the stock WireGuard app ignores `Jc/Jmin/Jmax/I1..`; use AmneziaVPN, FLClash, Hiddify or `awg`, keep `mode = warp-safe` for Cloudflare's servers, or grab the plain `wg` format.
- **VLESS proxy fails** — re-copy the link from the Proxy tab (check `proxyPath`/`proxyPort`; custom domains need `proxyDomain`), remember UDP traffic does not pass through, and set `PROXY_DEBUG=1` to see session errors in `wrangler tail`.

Licensed like the parent repository.
