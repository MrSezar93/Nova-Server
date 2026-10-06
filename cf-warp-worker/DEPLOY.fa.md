# راهنمای نصب گام‌به‌گام — Nova WARP Worker

دو مسیر دارید؛ هرکدام را که راحت‌تر است انتخاب کنید:

- **مسیر A — داشبورد Cloudflare (بدون نصب هیچ ابزاری)**: فقط یک فایل کد را پیست می‌کنید.
- **مسیر B — Wrangler (خط فرمان)**: برای آپدیت‌های بعدی و اجرای محلی بهتر است.

---

## پیش‌نیاز مشترک

- حساب کلادفلر (پلن رایگان کافی است).
- یک فضای **KV** به نام `WARP_KV` (داده‌ی پنل در آن ذخیره می‌شود).
- فلگ سازگاری **`nodejs_compat`** (برای مسیر پشتیبان ثبت‌نام روی TLS خام).

---

## مسیر A — داشبورد Cloudflare

### گام ۱: ساخت فایل تک‌قسمتی

روی یک سیستم با Node.js 18+:

```bash
cd cf-warp-worker
npm install
npm run build:single      # → dist/worker.min.js
```

محتوای `dist/worker.min.js` را کپی کنید (Ctrl+A / Ctrl+C در ادیتور).

> اگر Node ندارید: از همان فایل ساخته‌شده در مخزن (`dist/worker.min.js`) استفاده کنید یا از یک دوست/comit بگیرید.

### گام ۲: ساخت Worker

1. داشبورد کلادفلر → **Workers & Pages** → **Create** → **Start with Hello World!** (یا `Create Worker`).
2. یک نام بدهید (مثلا `nova-warp`) → **Deploy**.
3. روی **Edit code** بزنید، محتوای ادیتور را پاک کنید و `worker.min.js` را پیست کنید → **Deploy**.
4. آدرس `https://nova-warp.<account>.workers.dev` را باز کنید (فعلاً صفحه‌ی خطای «KV وصل نیست» یا صفحه‌ی ورود می‌بینید — ادامه دهید).

### گام ۳: ساخت و اتصال KV

1. **Storage & Databases** → **KV** → **Create instance** → نام: `WARP_KV` → Create.
2. برگردید به Worker → **Settings** → **Bindings** → **Add** → **KV namespace**:
   - Variable name: `WARP_KV`
   - KV namespace: `WARP_KV`
3. **Deploy** کنید (تغییر Binding نیاز به انتشار دوباره دارد).

### گام ۴: رمز و متغیرها

در Worker → **Settings** → **Variables and Secrets**:

| نام | نوع | مقدار |
| --- | --- | --- |
| `PANEL_PASSWORD` | **Secret** | رمز پنل (حداقل ۸ کاراکتر) |
| `SESSION_SECRET` | **Secret** | رشته‌ی تصادفی ۳۲+ کاراکتری |
| `PANEL_TITLE` | Text | `Nova WARP` |
| `PANEL_LANG` | Text | `fa` |

سپس **Deploy**.

### گام ۵: بررسی سازگاری ران‌تایم

**Settings** → **Runtime** (یا **Compatibility**):

- `Compatibility date`: `2025-08-01` یا جدیدتر
- `Compatibility flags`: `nodejs_compat` را اضافه کنید

اگر این فلگ نباشد، ثبت‌نام از مسیر `fetch` انجام می‌شود و در صورت ۴۲۹/۴۰۳، مسیر پشتیبان در دسترس نخواهد بود (خطای `blocked`).

### گام ۶: آزمایش

```
https://nova-warp.<account>.workers.dev/healthz
```

خروجی باید چیزی شبیه این باشد:

```json
{"ok":true,"worker":"nova-warp","kv":true,"demo":false,"time":"..."}
```

- `kv: true` یعنی KV درست وصل است. اگر `false` بود، گام ۳ را دوباره بررسی کنید.
- آدرس اصلی را باز کنید → ورود با رمز گام ۴ → **کانفیگ جدید**.

---

## مسیر B — Wrangler (خط فرمان)

```bash
# ۱) نصب و ورود
cd cf-warp-worker
npm install
npx wrangler login              # مرورگر باز می‌شود

# ۲) ساخت KV و کپی‌کردن شناسه
npx wrangler kv namespace create WARP_KV
#  ⛅️  Creating namespace with title "WARP_KV"
#  ✨ Success! ... id = "ab12cd34ef56..."   ← این شناسه را کپی کنید

# ۳) شناسه را در wrangler.toml بگذارید
#    [[kv_namespaces]]
#    binding = "WARP_KV"
#    id = "ab12cd34ef56..."

# ۴) رمزها
npx wrangler secret put PANEL_PASSWORD
npx wrangler secret put SESSION_SECRET

# ۵) انتشار
npm run deploy

# (اختیاری) دیدن لاگ زنده
npm run tail
```

برای اجرای محلی (KV محلی، بدون تأثیر روی محیط واقعی):

```bash
npm run dev        # http://localhost:8787
```

### اسکریپت خودکار (id را جایگزین کنید)

```bash
ID=$(npx wrangler kv namespace create WARP_KV --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
sed -i "s/REPLACE_WITH_YOUR_KV_NAMESPACE_ID/$ID/" wrangler.toml
npm run deploy
```

---

## بعد از نصب: چه کاری انجام دهیم؟

1. وارد پنل شوید.
2. **+ کانفیگ جدید**: نام دستگاه (مثلا `phone`)، قالب `WireGuard (.conf)`، تعداد ۱ → بسازید.
3. **نمایش کانفیگ** → دکمه‌ی کپی، یا **QR** را با اپ WireGuard اسکن کنید (اندروید/iOS: Import from QR code).
4. **کپی لینک اشتراک** → می‌توانید برای دوستان بفرستید (لینک شامل کلید واقعی است — مثل رمز با آن رفتار کنید).
5. در تب **تنظیمات**: DNS، MTU، Keepalive، حالت endpoint و سیاست هویت را تنظیم کنید.
6. برای مصرف کمتر: `identityPolicy = shared`؛ برای پایداری بیشتر: `pool` (پیش‌فرض).

---

## به‌روزرسانی نسخه

- **داشبورد**: دوباره `npm run build:single` بگیرید، کد را در ادیتور جای‌گذاری و Deploy کنید.
- **Wrangler**: `git pull && npm install && npm run deploy`.

---

## حذف کامل

1. Worker → **Settings** → **Delete**.
2. **Storage & Databases** → **KV** → فضای `WARP_KV` → Delete.
3. (اختیاری) Secretهای ذخیره‌شده با حذف Worker پاک می‌شوند.

> ⚠️ پیش از حذف، اگر هویتی را با API کلادفلر ساخته‌اید و می‌خواهید از حساب حذف شود: در پنل هویت را حذف کنید (پنل `DELETE /{apiVersion}/reg/{id}` را صدا می‌زند) یا در `wrangler tail` لاگ آن را ببینید.

---

## چک‌لیست سریع

- [ ] KV ساخته و به‌عنوان `WARP_KV` وصل شد
- [ ] `PANEL_PASSWORD` (و `SESSION_SECRET`) تنظیم شد
- [ ] `compatibility_flags = ["nodejs_compat"]`
- [ ] `/healthz` مقدار `"kv": true` می‌دهد
- [ ] ورود به پنل با رمز انجام شد
- [ ] یک کانفیگ ساخته و با اپ WireGuard وصل شد
- [ ] اگر ثبت‌نام ۴۲۹ داد: از «ورود هویت» (`wgcf`) استفاده شد
