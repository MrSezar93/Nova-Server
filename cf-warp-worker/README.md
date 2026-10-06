# Nova WARP Worker — WireGuard config server + panel on Cloudflare

A single Cloudflare Worker that registers/manages **Cloudflare WARP** identities and hands out ready-to-use **WireGuard profiles** (plus sing-box / Clash.Meta / Xray / JSON), with a Persian-first management panel, share links, QR codes and a JSON API.

> **Architecture note.** A Worker cannot terminate WireGuard itself: Cloudflare Workers have no UDP sockets and WireGuard is UDP-only. So the Worker is the **control plane** (identity registration, config rendering, panel, share links) while the actual tunnel terminates on Cloudflare's **WARP edge**. Your traffic still leaves through Cloudflare: `device → WireGuard/UDP → WARP edge → internet`.

Persian documentation: **[README.fa.md](./README.fa.md)** · Step-by-step deployment: **[DEPLOY.fa.md](./DEPLOY.fa.md)**

## Features

- WARP device registration against the Android API (`v0a5641`, `CF-Client-Version: a-6.38.9-5641`), with a raw-`node:tls` fallback that mimics the Android TLS fingerprint when Cloudflare answers 403/429.
- Import existing credentials instead of registering: `wgcf` `.conf`, `wgcf-account.toml`, WARP client JSON, or a bare private key.
- Per-device identities (`pool` policy, recommended) or one shared identity — plus key rotation, enable/disable, and share-link revocation.
- Output formats: `wg`, `singbox`, `clash`, `xray`, `json` — with `reserved` (client_id) bytes where the protocol needs them.
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

## Development

```bash
npm run preview        # local panel preview, http://localhost:8080 (password: nova-preview) — DEMO_MODE, no Cloudflare calls
npm test               # 55 tests, fully offline (crypto, QR vs reference, HTTP parser, importers, auth, KV, end-to-end worker suite)
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
| `/api/v1/clients` (+ `/:id`, `/:id/config?format=`, `/:id/rotate`) | WireGuard profile management |
| `GET /c/:token` , `/c/:token/raw?format=` , `/qr/:token.svg` , `/sub/:token` | Public share link, download, QR, base64 subscription |

## Environment variables

`PANEL_PASSWORD`, `SESSION_SECRET`, `API_KEY`, `PANEL_TITLE`, `PANEL_LANG`, `API_VERSION`, `TEAM_TOKEN`, `MAX_REGISTRATIONS_PER_HOUR`, `PASSWORD_ITERATIONS`, `DEMO_MODE`, `DISABLE_RAW_TLS`, `WARP_API_BASE`, `WARP_API_HEADERS`, `ALLOW_FRAMING` — see [README.fa.md](./README.fa.md#تنظیمات-و-متغیرها) for defaults and details.

## Troubleshooting highlights

- **429 / `rate_limited` while registering** — Cloudflare throttles new registrations per client. Wait, lower `MAX_REGISTRATIONS_PER_HOUR`, or use **Import identity** (a `wgcf` profile works forever and never touches the API).
- **`persistent: false` in the panel** — the KV binding is missing; data would be lost on restart.
- **`node:tls` errors** — add the `nodejs_compat` compatibility flag, or set `DISABLE_RAW_TLS=1`.
- **Profile does not connect** — try another endpoint/port (`endpointMode = random` or `custom`), and make sure local UDP isn't blocked.

Licensed like the parent repository.
