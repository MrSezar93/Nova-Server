# Nova WARP Worker — پنل و سرور کانفیگ WireGuard روی Cloudflare

سرویس‌ورکر کلادفلر (Cloudflare Worker) که هویت‌های **WARP** کلادفلر را می‌سازد/مدیریت می‌کند و برای هر دستگاه یک **کانفیگ WireGuard** آماده‌ی استفاده می‌دهد؛ همراه با یک **پنل مدیریت فارسی** (داشبورد، کانفیگ‌ها، هویت‌ها، لینک اشتراک، QR و API).

> 🧭 **معماری در یک نگاه:** ترافیک شما از شبکه‌ی کلادفلر (لبه‌ی WARP) عبور می‌کند و از دید سایت‌ها آی‌پی کلادفلر دیده می‌شود؛ Worker نقش **کنترل‌پلین** را دارد: ثبت‌نام/مدیریت هویت، ساخت کانفیگ، پنل و لینک اشتراک.
> Worker نمی‌تواند خودش ترمینال WireGuard باشد، چون Cloudflare Workers سوکت **UDP** در اختیار کد نمی‌گذارد؛ ترمینالِ تونل، سرورهای WARP کلادفلر هستند (`162.159.192.0/24`، `188.114.96.0/24`، …) که از هر جای دنیا قابل دسترسی‌اند. مسیر داده: **دستگاه شما ← (WireGuard/UDP) ← لبه‌ی WARP کلادفلر ← اینترنت**.

---

## فهرست

1. [ویژگی‌ها](#ویژگیها)
2. [نصب سریع (Wrangler)](#نصب-سریع-wrangler)
3. [نصب بدون نصب ابزار (داشبورد Cloudflare)](#نصب-داشبورد-cloudflare)
4. [تنظیمات و متغیرها](#تنظیمات-و-متغیرها)
5. [اولین اجرا و کار با پنل](#اولین-اجرا-و-کار-با-پنل)
6. [قالب‌های خروجی](#قالبهای-خروجی)
7. [HTTP API](#http-api)
8. [ورود هویت دستی (وقتی ثبت‌نام 429/403 می‌شود)](#ورود-هویت-دستی)
9. [پیش‌نمایش محلی و تست](#پیشنمایش-محلی-و-تست)
10. [امنیت](#امنیت)
11. [عیب‌یابی](#عیبیابی)
12. [سؤالات متداول](#سؤالات-متداول)
13. [ساختار پروژه](#ساختار-پروژه)

---

## ویژگی‌ها

| بخش | توضیح |
| --- | --- |
| ثبت‌نام WARP | ساخت هویت جدید با API اندرویدی کلادفلر (`POST /{apiVersion}/reg`)، هدرهای `1.1.1.1/6.38.9-5641 (Android 16.0.0)` و `CF-Client-Version: a-6.38.9-5641` |
| مسیر پشتیبان TLS | اگر کلادفلر درخواست `fetch` را با ۴۲۹/۴۰۳ رد کند، همان درخواست روی سوکت خام TLS با اثر انگشت اندروید (`node:tls` + `nodejs_compat`) تکرار می‌شود |
| ورود هویت دستی | ورود کانفیگ `.conf`، فایل `wgcf-account.toml`، خروجی JSON کلاینت WARP یا کلید خصوصی خام — بدون هیچ تماسی با API کلادفلر |
| کانفیگ چندنفره | هر کانفیگ می‌تواند هویت اختصاصی خودش را داشته باشد (`pool`) یا همه روی یک هویت مشترک باشند (`shared`) |
| قالب‌های خروجی | WireGuard `.conf`، sing-box، Clash.Meta، Xray/v2ray، JSON خام |
| QR Code | تولید QR به‌صورت SVG بدون هیچ کتابخانه‌ی بیرونی (پیاده‌سازی کامل ۴۰ نسخه + ۴ سطح ECC) — برای اسکن با اپ WireGuard |
| لینک اشتراک | `/c/<token>` (صفحه‌ی عمومی)، `/c/<token>/raw?format=` (دانلود)، `/qr/<token>.svg`، `/sub/<token>` (base64) |
| پنل فارسی | RTL، دارک/لایت، SPA سبک بدون CDN و بدون فونت بیرونی، مدیریت هویت/کانفیگ/تنظیمات/لاگ‌ها |
| کنترل دسترسی | رمز پنل (PBKDF2-SHA256 در KV یا `PANEL_PASSWORD`)، کوکی امضاشده‌ی ۷ روزه با قابلیت باطل‌کردن، کلید API، محدودیت تلاش ورود، بررسی Same-Origin |
| محدودیت ثبت‌نام | سهمیه‌ی قابل تنظیم (پیش‌فرض ۶ هویت در ساعت) برای جلوگیری از مسدودشدن توسط کلادفلر |
| WARP+ | ثبت لایسنس (`PUT .../account`) و نمایش مصرف/سهمیه |
| بدون وابستگی اجرایی | خروجی صفر وابستگی (بدون npm در ران‌تایم)، نوع‌بندی کامل TypeScript، خروجی تک‌فایل برای پیست در داشبورد |

---

## نصب سریع (Wrangler)

پیش‌نیاز: Node.js 18+ و یک حساب کلادفلر.

```bash
cd cf-warp-worker
npm install

# ۱) ساخت فضای KV و کپی‌کردن شناسه‌ی خروجی
npx wrangler kv namespace create WARP_KV
#    →  [[kv_namespaces]] binding = "WARP_KV"  id = "xxxxxxxxxxxx"

# ۲) گذاشتن شناسه در wrangler.toml
#    (یا برای پیش‌فرض: مقدار REPLACE_WITH_YOUR_KV_NAMESPACE_ID را عوض کنید)

# ۳) رمز پنل را به‌صورت Secret بگذارید (توصیه‌شده)
npx wrangler secret put PANEL_PASSWORD
npx wrangler secret put SESSION_SECRET      # یک رشته‌ی تصادفی ۳۲+ کاراکتری

# ۴) دیپلوی
npm run deploy
```

خروجی، آدرسی مثل `https://nova-warp.<نام-حساب>.workers.dev` است. همان را در مرورگر باز کنید.

> اگر می‌خواهید همه‌چیز با یک دستور انجام شود:
> `npx wrangler kv namespace create WARP_KV && npm run deploy`
> (شناسه‌ی KV را دستی در `wrangler.toml` جای‌گذاری کنید.)

### اسکریپت‌های npm

| دستور | کار |
| --- | --- |
| `npm run dev` | اجرای محلی با `wrangler dev` (KV محلی) |
| `npm run deploy` | انتشار روی Cloudflare |
| `npm run typecheck` | بررسی تایپ‌ها (`tsc --noEmit`) |
| `npm run build` | باندل خوانا → `dist/worker.js` |
| `npm run build:single` | خروجی تک‌فایل و مینیفای‌شده → `dist/worker.min.js` |
| `npm test` | اجرای ۵۵ تست (crypto، QR، API، پنل، مسیرهای اشتراک) |
| `npm run preview` | پیش‌نمایش محلی پنل بدون Cloudflare (پورت ۸۰۸۰، رمز `nova-preview`) |
| `npm run tail` | مشاهده‌ی زنده‌ی لاگ Worker |

---

## نصب (داشبورد Cloudflare)

بدون نصب هیچ ابزاری — مناسب وقتی نمی‌خواهید Node نصب کنید. جزئیات تصویری‌تر در [`DEPLOY.fa.md`](./DEPLOY.fa.md).

1. `npm run build:single` را روی یک سیستم با Node اجرا کنید و محتوای `dist/worker.min.js` را کپی کنید.
   (یا فایل را از مخزن بردارید.)
2. در داشبورد کلادفلر: **Workers & Pages → Create → Worker** بسازید و کد را با محتوای `worker.min.js` جایگزین و **Deploy** کنید.
3. **Storage & Databases → KV → Create namespace** با نام `WARP_KV` بسازید.
4. در Worker: **Settings → Bindings → Add → KV namespace**؛ نام متغیر: `WARP_KV`، و هم‌نام فضای ساخته‌شده را انتخاب کنید.
5. در **Settings → Variables and Secrets** این‌ها را بگذارید (حداقل اولی):
   - `PANEL_PASSWORD` → نوع **Secret** (رمز پنل)
   - `SESSION_SECRET` → نوع **Secret** (رشته‌ی تصادفی)
   - `PANEL_TITLE` → مثلا `Nova WARP` (نوع Text)
   - `PANEL_LANG` → `fa` یا `en`
6. در **Settings → Runtime** مطمئن شوید سازگاری روی `nodejs_compat` است (برای مسیر پشتیبان TLS لازم است) و تاریخ سازگاری ≥ `2025-08-01`.
7. آدرس Worker را باز کنید → صفحه‌ی ورود/راه‌اندازی.

> ⚠️ اگر KV را وصل نکنید، Worker با حافظه‌ی موقت کار می‌کند (`persistent: false` در `/healthz`) و **با هر ری‌استارت داده‌ها پاک می‌شود**. برای استفاده‌ی واقعی KV لازم است.

---

## تنظیمات و متغیرها

### متغیرهای محیطی (Secret/Variable)

| نام | پیش‌فرض | توضیح |
| --- | --- | --- |
| `PANEL_PASSWORD` | — | رمز پنل. اگر تنظیم شود، اولویت دارد بر رمز ذخیره‌شده در KV و صفحه‌ی `/setup` غیرفعال می‌شود. |
| `SESSION_SECRET` | مشتق از رکورد احراز هویت | کلید امضای کوکی نشست. تغییر آن همه‌ی نشست‌ها را باطل می‌کند. |
| `API_KEY` | تولید در پنل | کلید ثابت API (اختیاری). |
| `PANEL_TITLE` | `Nova WARP` | عنوان پنل. |
| `PANEL_LANG` | `fa` | زبان پیش‌فرض پنل (`fa`/`en`). |
| `API_VERSION` | `v0a5641` | نسخه‌ی API اندرویدی کلادفلر. |
| `TEAM_TOKEN` | — | توکن Zero Trust؛ به بدنه‌ی ثبت‌نام اضافه می‌شود (`team_token`). |
| `MAX_REGISTRATIONS_PER_HOUR` | ۶ | سقف ساخت هویت جدید در ساعت. |
| `PASSWORD_ITERATIONS` | `10000` | تعداد دور PBKDF2 برای رمز ذخیره‌شده در KV. |
| `DEMO_MODE` | `0` | `1` = ساخت هویت جعلی برای تست رابط کاربری (هیچ تماسی با کلادفلر نمی‌شود). |
| `DISABLE_RAW_TLS` | `0` | `1` = غیرفعال‌کردن مسیر پشتیبان TLS. |
| `WARP_API_BASE` / `WARP_API_HEADERS` | — | فقط برای تست/دیباگ (تغییر میزبان API و افزودن هدر JSON). |
| `ALLOW_FRAMING` | `0` | `1` = حذف `X-Frame-Options` و `frame-ancestors` (فقط برای پیش‌نمایش/Embed داخلی؛ در محیط واقعی خاموش بگذارید). |

### تنظیمات پنل (ذخیره در KV، از تب «تنظیمات»)

| کلید | مقادیر | توضیح |
| --- | --- | --- |
| `dns` | لیست | DNS کانفیگ‌ها (پیش‌فرض `1.1.1.1`, `1.0.0.1`, DNSهای IPv6 کلادفلر). |
| `mtu` | ۵۷۶–۱۵۰۰ | پیش‌فرض `1280` (مقدار توصیه‌شده‌ی WARP). |
| `keepalive` | ۰–۶۵۵۳۵ | `PersistentKeepalive`؛ پیش‌فرض `25`، مقدار `0` یعنی حذف شود. |
| `allowedIpsMode` | `all` \| `exclude-lan` \| `custom` | `exclude-lan` با محاسبه‌ی مکمل CIDRها، ترافیک شبکه‌ی محلی را بیرون از تونل نگه می‌دارد. |
| `allowedIps` | لیست | فقط وقتی `custom` انتخاب شود. |
| `endpointMode` | `auto` \| `random` \| `custom` | `auto` = `engage.cloudflareclient.com:2408`؛ `random` = انتخاب تصادفی از استخر Anycast کلادفلر؛ `custom` = میزبان/پورت دلخواه (دامنه‌ی شخصی باید DNS-only باشد). |
| `includeIPv6` | bool | افزودن آدرس/DNS نسخه‌ی ۶ به کانفیگ. |
| `defaultFormat` | `wg` \| `singbox` \| `clash` \| `xray` \| `json` | قالب پیش‌فرض کانفیگ‌های جدید. |
| `identityPolicy` | `pool` \| `shared` | `pool` = هر کانفیگ هویت اختصاصی (توصیه‌شده)؛ `shared` = یک هویت برای همه. |
| `namePrefix` | متن | پیشوند نام خودکار هویت‌ها (مثل `nova-a1b`). |
| `registrationLimitPerHour` | ۱–۶۰ | سهمیه‌ی ساخت هویت. |

---

## اولین اجرا و کار با پنل

1. **راه‌اندازی**: اگر `PANEL_PASSWORD` را تنظیم نکرده باشید، آدرس `/` شما را به `/setup` می‌فرستد؛ یک رمز (حداقل ۸ کاراکتر) بسازید. اگر `PANEL_PASSWORD` تنظیم شده باشد، مستقیم صفحه‌ی ورود می‌آید.
2. **داشبورد**: تعداد کانفیگ‌ها/هویت‌ها، هویت‌های WARP+، بازدید لینک‌ها و لاگ رویدادها.
3. **کانفیگ جدید** (`+ کانفیگ جدید`): نام، قالب خروجی، تعداد (۱ تا ۲۵ کانفیگ در یک حرکت) و در صورت نیاز هویت مشخص.
   - در حالت `pool` هر کانفیگ یک هویت تازه می‌گیرد (توصیه می‌شود، چون WARP با هویت مشترک، مسیر برگشت را بین دستگاه‌ها جابه‌جا می‌کند).
4. **هویت جدید**: ثبت‌نام واقعی روی کلادفلر — یا **ورود هویت** برای پیست کانفیگ/TOML/JSON/کلید.
5. هر کانفیگ: دکمه‌های **نمایش کانفیگ**، **کپی لینک اشتراک**، **بازتولید کلید** (`rotate` — کانفیگ قبلی از کار می‌افتد)، **غیرفعال/فعال** (لینک اشتراک را بدون حذف، از دسترس خارج می‌کند) و **حذف**.
6. **تنظیمات**: مقادیر بالا + ساخت/بازتولید **کلید API**.

مسیرهای عمومی (بدون ورود، با توکن تصادفی):

```
https://<worker>/c/<token>                 # صفحه‌ی کانفیگ + QR + راهنما
https://<worker>/c/<token>/raw?format=wg   # دانلود فایل (conf/yaml/json)
https://<worker>/qr/<token>.svg            # تصویر QR (SVG)
https://<worker>/sub/<token>              # خروجی base64 برای کلاینت‌های اشتراکی
```

اگر کانفیگی را «غیرفعال» کنید، همه‌ی این مسیرها `403` می‌دهند تا دوباره فعالش کنید.

---

## قالب‌های خروجی

| قالب | مناسب برای | نکته |
| --- | --- | --- |
| `wg` | اپ رسمی WireGuard (اندروید/iOS/دسکتاپ)، `wg-quick` | فایل `.conf` استاندارد؛ قابل اسکن با QR |
| `singbox` | sing-box (اندروید/iOS/دسکتاپ) | `outbounds` با `reserved` |
| `clash` | Clash.Meta / Mihomo | بخش `proxies` با `type: wireguard` |
| `xray` | Xray / v2ray | `protocol: wireguard` + `reserved` |
| `json` | اسکریپت‌ها/اشتراک | JSON خام شامل کلید، آدرس، endpoint، MTU، DNS، AllowedIPs |

نمونه‌ی خروجی `wg`:

```ini
# Nova WARP — Cloudflare WireGuard profile
# client: phone • identity: nova-a1b
[Interface]
PrivateKey = <کلید خصوصی ۳۲ بایتی base64>
Address = 172.16.0.2/32, 2606:4700:110:8a2f::1/128
DNS = 1.1.1.1, 1.0.0.1, 2606:4700:4700::1111, 2606:4700:4700::1001
MTU = 1280

[Peer]
PublicKey = bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = engage.cloudflareclient.com:2408
PersistentKeepalive = 25
```

> ستون `reserved` (سه بایت اول `client_id`) که Cloudflare برای هر دستگاه برمی‌گرداند، در قالب‌های sing-box/Clash/Xray/JSON نوشته می‌شود؛ برای فایل `.conf` نیازی نیست (خود پروتکل WireGuard هویت را از کلید می‌فهمد).

---

## HTTP API

همه‌ی مسیرهای `/api/v1/*` با **کوکی نشست** یا هدر `Authorization: Bearer <API_KEY>` کار می‌کنند. برای درخواست‌های تغییردهنده، هدر `Origin` باید با میزبان یکی باشد.

```bash
BASE=https://nova-warp.example.workers.dev
KEY=nw_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

curl -s $BASE/healthz
curl -s -H "Authorization: Bearer $KEY" $BASE/api/v1/state

# ساخت هویت واقعی روی کلادفلر
curl -s -X POST -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
     -d '{"name":"tehran-1"}' $BASE/api/v1/identities

# ورود هویت دستی از فایل wgcf
curl -s -X POST -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
     -d "$(python3 -c 'import json;print(json.dumps({"name":"imported","content":open("wgcf-profile.conf").read()}))')" \
     $BASE/api/v1/identities/import

# ساخت ۳ کانفیگ با هویت‌های اختصاصی
curl -s -X POST -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
     -d '{"name":"family","count":3,"format":"wg"}' $BASE/api/v1/clients

# گرفتن کانفیگ یک کلاینت
curl -s -H "Authorization: Bearer $KEY" "$BASE/api/v1/clients/<id>/config?format=singbox"

# ثبت لایسنس WARP+
curl -s -X POST -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
     -d '{"license":"XXXXXXXX-XXXXXXXX-XXXXXXXX"}' $BASE/api/v1/identities/<id>/license
```

| متد و مسیر | کار |
| --- | --- |
| `GET /healthz` | سلامت سرویس (`ok`, `kv`, `demo`, زمان). |
| `GET /api/v1/state` | وضعیت کامل پنل: تنظیمات، هویت‌ها، کانفیگ‌ها، لاگ‌ها، آمار. |
| `PUT /api/v1/settings` | به‌روزرسانی تنظیمات (هر کلید جدول تنظیمات). |
| `POST /api/v1/api-key` | ساخت/بازتولید کلید API. |
| `POST /api/v1/logout` | خروج؛ همه‌ی کوکی‌های صادرشده باطل می‌شوند. |
| `GET/POST /api/v1/identities` | فهرست/ساخت هویت (`name`, `teamToken`, `model`). |
| `POST /api/v1/identities/import` | ورود هویت (`content`, `name`). |
| `PATCH /api/v1/identities/:id` | تغییر نام. |
| `POST /api/v1/identities/:id/sync` | به‌روزرسانی آدرس/کلید Peer/مصرف از کلادفلر. |
| `POST /api/v1/identities/:id/license` | ثبت لایسنس WARP+. |
| `DELETE /api/v1/identities/:id` | حذف هویت (اگر به کانفیگی وصل نباشد). |
| `GET/POST /api/v1/clients` | فهرست/ساخت کانفیگ (`name`, `count`, `format`, `identityId`, `options`). |
| `GET /api/v1/clients/:id/config?format=` | محتوای کانفیگ (`{format, content}`). |
| `PATCH /api/v1/clients/:id` | تغییر نام/قالب/هویت/`enabled`/`note`/`options`. |
| `POST /api/v1/clients/:id/rotate` | بازتولید کلید و هویت کانفیگ. |
| `DELETE /api/v1/clients/:id` | حذف کانفیگ. |
| `DELETE /api/v1/logs` | پاک‌کردن لاگ‌ها. |

خطاها به شکل `{"error":"<کد>","message":"<پیام فارسی>","detail":"..."}` برمی‌گردند.

---

## ورود هویت دستی

اگر کلادفلر ثبت‌نام Worker را محدود کند (خطای ۴۲۹ یا ۴۰۳ — به‌خاطر اثر انگشت TLS/محدودیت نرخ)، نیازی به صبر کردن نیست: یک هویت موجود را وارد کنید. چند راه ساده:

**۱) با `wgcf` (روی کامپیوتر خودتان):**

```bash
wgcf register          # ساخت wgcf-account.toml
wgcf generate          # ساخت wgcf-profile.conf
```

سپس در پنل → «ورود هویت» → محتوای `wgcf-profile.conf` (یا خود `wgcf-account.toml`) را پیست کنید. `device_id`/`access_token` از TOML خوانده می‌شوند، پس بعداً دکمه‌ی «همگام‌سازی» و «لایسنس WARP+» هم کار می‌کند.

**۲) با کانفیگ اپ ۱.۱.۱.۱**: از اپ، پروفایل WireGuard را اکسپورت کنید (یا کلید خصوصی + آدرس + کلید Peer را دارید) و در همان کادر پیست کنید. اگر فایل شامل `reserved` باشد، به‌صورت خودکار به `client_id` تبدیل می‌شود.

**۳) فقط کلید خصوصی**: یک رشته‌ی base64 ۳۲ بایتی (۴۴ کاراکتری) کافی است؛ بقیه‌ی مقادیر با پیش‌فرض‌های WARP پر می‌شوند (`172.16.0.2`, کلید Peer استاندارد WARP, `engage.cloudflareclient.com:2408`).

> در حالت ورود دستی، «همگام‌سازی» و «لایسنس» فقط وقتی کار می‌کنند که `device_id` و `access_token` هم وارد شده باشند (مثل خروجی TOML/JSON). در بقیه‌ی موارد، کانفیگ ساخته‌شده کاملاً کار می‌کند ولی مصرف/سهمیه نمایش داده نمی‌شود.

---

## پیش‌نمایش محلی و تست

```bash
npm install
npm run preview        # http://localhost:8080  — رمز: nova-preview
```

پیش‌نمایش با `DEMO_MODE=1` اجرا می‌شود: یک هویت آزمایشی و دو کانفیگ نمونه ساخته می‌شود تا پنل، QR، صفحه‌ی اشتراک و API را بدون تماس با کلادفلر ببینید. (کانفیگ‌های DEMO واقعی نیستند.)

```bash
npm test               # ۵۵ تست بدون شبکه
npm run typecheck      # بررسی تایپ‌ها
npm run build:single   # خروجی تک‌فایل برای داشبورد
```

پوشش تست‌ها: رمزنگاری X25519 و کلید عمومی، محاسبه‌ی `reserved`، رندر همه‌ی قالب‌ها، حذف شبکه‌ی محلی (`exclude-lan`)، ماتریس QR در مقایسه با پیاده‌سازی مرجع (همه‌ی نسخه‌ها و سطوح)، پارسر HTTP خام، ورود هویت‌ها از conf/TOML/JSON/کلید، احراز هویت و throttle، ذخیره‌سازی KV و یک سوئیت end-to-end روی خود Worker (ثبت‌نام با API جعلی، ساخت کانفیگ، لینک اشتراک، چرخش کلید، سهمیه، CSRF).

---

## امنیت

- **رمز پنل**: اگر `PANEL_PASSWORD` را Secret بگذارید، مقایسه با HMAC زمان‌ثابت انجام می‌شود و هیچ هش رمزی در KV ذخیره نمی‌شود. در غیر این‌صورت، `PBKDF2-SHA256` با ۱۰٬۰۰۰ دور (قابل تغییر با `PASSWORD_ITERATIONS`) در KV ذخیره می‌شود.
- **نشست‌ها**: کوکی `nova_warp_session` امضاشده با HMAC-SHA256، `HttpOnly` + `Secure` + `SameSite=Lax`، عمر ۷ روز. `POST /api/v1/logout` یک «دور نشست» را در KV بالا می‌برد، پس کوکی‌های قبلی (حتی اگر دزدیده شده باشند) بی‌اعتبار می‌شوند.
- **ضد CSRF**: هر درخواست تغییردهنده باید `Origin`/`Sec-Fetch-Site` هم‌مبدأ داشته باشد.
- **هدرهای امنیتی**: `CSP` سخت، `nosniff`، `no-referrer`، `X-Frame-Options: DENY` (مگر `ALLOW_FRAMING=1`)، `no-store` روی پاسخ‌ها.
- **محدودیت ورود**: ۸ تلاش ناموفق در ۱۰ دقیقه برای هر IP (با هش IP ذخیره می‌شود، خود IP ذخیره نمی‌شود).
- **لینک اشتراک = کلید**: هر کسی توکن `/c/<token>` را داشته باشد کانفیگ را می‌بیند. توکن‌ها تصادفی ۱۸ کاراکتری‌اند؛ در صورت لو رفتن، «بازتولید کلید» یا «غیرفعال» کنید.
- **کلید خصوصی WireGuard** در پاسخ هیچ API مدیریتی برنمی‌گردد؛ فقط از مسیر کانفیگ/لینک اشتراک خارج می‌شود.

---

## عیب‌یابی

| نشانه | علت احتمالی | راه‌حل |
| --- | --- | --- |
| `429 rate_limited` هنگام ساخت هویت | کلادفلر ثبت‌نام را برای این Worker محدود کرده (اثر انگشت TLS/نرخ) | چند دقیقه صبر کنید، سهمیه را کم کنید (`MAX_REGISTRATIONS_PER_HOUR=2`)، یا از **ورود هویت دستی** استفاده کنید. مسیر پشتیبان TLS به‌طور خودکار امتحان می‌شود. |
| `blocked` / ۵۰۳ با متن blocked | درخواست خروجی Worker مسدود شده | `WARP_API_BASE`/`WARP_API_HEADERS` را بررسی کنید؛ ورود هویت دستی امن‌ترین راه است. |
| پنل می‌گوید `persistent: false` | KV وصل نیست | Binding به نام `WARP_KV` بسازید و دوباره Deploy کنید. |
| داده‌ها پس از چند دقیقه قدیمی به‌نظر می‌رسند | KV نهایتاً یکنواخت است (eventually consistent) | هر آی‌دیوایدویچالت خودش نوشته‌های خودش را فوراً می‌بیند؛ برای چند نفر هم‌زمان، ویرایش‌ها را پشت‌سرهم انجام دهید. |
| `node:tls` خطا می‌دهد | فلگ `nodejs_compat` نیست | `compatibility_flags = ["nodejs_compat"]` را در `wrangler.toml` بگذارید یا `DISABLE_RAW_TLS=1` کنید. |
| کانفیگ وصل نمی‌شود | پورت UDP بسته است | پورت دیگر امتحان کنید (`endpointMode=custom` و مثلا `2408`→`500`)، یا `endpointMode=random`. |
| QR ساخته نمی‌شود | کانفیگ بزرگ‌تر از ظرفیت ۴۰ نسخه‌ی QR | فایل را دانلود کنید یا `includeIPv6` و DNS را کم کنید. |
| «این لینک معتبر نیست» | کانفیگ حذف یا غیرفعال شده | در پنل، وضعیت کانفیگ را ببینید. |
| `too many attempts` هنگام ورود | throttle ورود | ۱۰ دقیقه صبر کنید یا IP دیگری امتحان کنید. |

---

## سؤالات متداول

**آیا ترافیک من واقعاً از کلادفلر عبور می‌کند؟**
بله. دستگاه شما با پروتکل WireGuard به لبه‌ی WARP (شبکه‌ی کلادفلر) تونل می‌زند و خروجی ترافیک از آنجا است. Worker فقط کانفیگ/هویت را تحویل می‌دهد.

**چرا Worker خودش تونل WireGuard را بالا نمی‌آورد؟**
چون Workers اجازه‌ی سوکت UDP نمی‌دهد و WireGuard روی UDP کار می‌کند. تنها راه اجرای واقعی WireGuard در Cloudflare، استفاده از سرورهای WARP آن است — همان کاری که این پروژه انجام می‌دهد.

**تفاوت این با یک Worker پروکسی (VLESS/WS و …) چیست؟**
آنجا ترافیک با TCP/TLS از خود Worker عبور می‌کند (محدودیت‌های خودش را دارد). اینجا یک تونل WireGuard کامل دارید: بدون CPU Worker مصرف نمی‌شود، سرعت بالاتر و پشتیبانی از UDP؛ فقط کانفیگ از Worker گرفته می‌شود.

**هر دستگاه هویت جدا بگیرد یا مشترک؟**
جدا (`pool`). با هویت مشترک، کلادفلر ممکن است مسیر برگشت را بین دستگاه‌ها جابه‌جا کند و هر دو ناپایدار شوند.

**چند کانفیگ می‌توانم بسازم؟**
محدودیت سخت‌گیرانه‌ای وجود ندارد؛ اما داده‌ها در یک سند KV نگه‌داری می‌شوند (سقف ۲۵ مگابایت و یک نوشتن در ثانیه برای هر کلید). برای صدها کانفیگ کافی است؛ برای هزاران، به D1/DO مهاجرت کنید.

**می‌توانم از `warp-plus`/`AmneziaWG` هم استفاده کنم؟**
کانفیگ `.conf` استاندارد WireGuard است و در AmneziaWG هم (با خاموش‌کردن ویژگی‌های obfuscation) کار می‌کند. `warp-plus`/`usque` پروتکل‌های متفاوتی دارند و کانفیگ WireGuard برایشان کاربردی ندارد.

**آیا باید از دامنه‌ی شخصی استفاده کنم؟**
اختیاری است. در `wrangler.toml` بخش `[[routes]]` را باز کنید. برای endpoint دلخواه (فیلد `custom`)، دامنه باید در حالت DNS-only باشد (پروکسی نارنجی خاموش).

---

## ساختار پروژه

```
cf-warp-worker/
├─ src/
│  ├─ index.ts              روتر Worker و API  (/, /login, /setup, /api/v1/*, /c/:token, /qr/:token, /sub/:token, /healthz)
│  ├─ types.ts              تایپ‌ها + DEFAULT_SETTINGS
│  ├─ lib/
│  │  ├─ wg.ts              کلید X25519، reserved، انتخاب endpoint، رندر ۵ قالب کانفیگ
│  │  ├─ warp.ts            کلاینت API کلادفلر (ثبت‌نام/گرفتن/لایسنس/…) + مسیر پشتیبان TLS
│  │  ├─ rawhttp.ts         درخواست HTTP روی سوکت خام TLS و پارسر chunked/content-length
│  │  ├─ importer.ts        تشخیص و ورود conf / TOML / JSON / کلید خام
│  │  ├─ service.ts         منطق دامنه: ساخت هویت، ورود، همگام‌سازی، ساخت کانفیگ
│  │  ├─ store.ts           ذخیره‌سازی JSON در KV + کش کوتاه‌مدت در ایزوله
│  │  ├─ auth.ts            PBKDF2، کوکی امضاشده، کلید API، throttle ورود
│  │  ├─ http.ts            روتر، پاسخ‌ها، هدرهای امنیتی، کوکی
│  │  ├─ qr.ts              تولیدکننده‌ی کامل QR (۴۰ نسخه × ۴ سطح ECC) به SVG
│  │  └─ b64.ts             base64/base64url/hex، HMAC، SHA-256، مقایسه‌ی زمان‌ثابت
│  └─ ui/                   پنل فارسی: i18n، تم، اسکریپت SPA و قالب صفحه‌ها
├─ scripts/                 build (esbuild) / test / preview محلی
├─ tests/                   ۵۵ تست (node:test) شامل سوئیت end-to-end
├─ wrangler.toml
├─ README.fa.md             همین فایل
├─ DEPLOY.fa.md             راهنمای گام‌به‌گام نصب
└─ README.md               نسخه‌ی انگلیسی خلاصه
```

---

ساخته‌شده برای پروژه‌ی **Nova Server** — لایسنس مطابق مخزن اصلی.
