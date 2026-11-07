# KUKI DEX + ربات اربیتراژ

یک DEX مستقل روی TON با استخرهای وزن‌دار به سبک **Osmosis classic**؛ همهٔ استخرها با **KUKI** جفت می‌شوند و ربات، قیمت را بین **STON.fi** و **KUKI DEX** هم‌گام می‌کند.

> این پروژه به‌صورت جدا و مستقل از مینی‌اپ KUKI Tap ساخته شده و در پوشهٔ `kuki-dex/` زندگی می‌کند. کد قراردادها **audit نشده** است؛ قبل از پول واقعی، تست‌نت و بازبینی امنیتی لازم است.

---

## چه چیزی ساخته شده

| بخش | وضعیت |
|---|---|
| قرارداد استخر وزن‌دار (Tact) با فرمول Osmosis/Balancer | ✅ کامپایل و ۱۲ تست روی TVM |
| نرخ ثابت ۱۸ اعشاری با `ln/exp` برای توان کسری (مثل ۸۰/۲۰) | ✅ تست‌شده تا خطای ~1e-12 |
| کارخانهٔ استخر + ثبت و ساخت آدرس قطعی | ✅ |
| جفت‌شدن اجباری KUKI در هر استخر | ✅ |
| **استخر KUKI/TON با TON بومی** (بدون jetton واسط) | ✅ ۶ تست روی TVM |
| **انتقال مالکیت** (`SetAdmin` + `ChangeOwner`) برای دیپلوی واسط | ✅ تست‌شده |
| نقدینگی دو مرحله‌ای (به‌خاطر مدل async تون) + refund و cancel | ✅ تست‌شده |
| سهام LP داخلی + قفل ۰٫۱٪ در بوت‌استرپ | ✅ تست‌شده |
| ربات: خواندن رزروها، محاسبهٔ اندازهٔ بهینه، سود خالص بعد از گس | ✅ ۱۵ تست ریاضی |
| **گارد سود ProtoRev-style**: quote از خود قرارداد، بررسی دوباره قبل از لگ ۲، circuit breaker | ✅ ۶ تست |
| دموی کامل deploy + نقدینگی + اجرای اربیتراژ روی زنجیرهٔ محلی | ✅ `pnpm demo` |
| اجرای لگ KUKI (jetton transfer + forward payload) | ✅ ساخته و تست پیام |
| اجرای لگ STON.fi با SDK رسمی | ⚠️ کد نوشته شده، روی مین‌نت تست نشده |
| حالت dry-run پیش‌فرض + اجرای واقعی با `EXECUTE=1` | ✅ |

---

## معماری

```
        کاربر / ربات
             │  jetton transfer + forward payload
             ▼
   ┌──────────────────┐        ┌──────────────────┐
   │  WeightedPool    │◄──────►│  jetton wallet   │  (KUKI / token)
   │  KUKI + token    │        │  مخصوص استخر     │
   │  wKuki, wToken   │        └──────────────────┘
   │  fee, reserves   │
   │  LP share ledger │        ┌──────────────────┐
   └────────┬─────────┘        │  PoolFactory     │
            │ initOf           │  owner + KUKI    │
            └──────────────────│  ثبت استخرها     │
                               └──────────────────┘
```

هر استخر دقیقاً دو دارایی دارد: **KUKI** و یک jetton دیگر. این تصمیم آگاهانه است: «همهٔ استخرها با KUKI جفت می‌شوند» یعنی KUKI دارایی پایه است و استخر چنددارایی (مثل Osmosis با ۸ دارایی) در نسخهٔ بعد اضافه می‌شود؛ چون واریز اتمی چنددارایی روی TON به یک router/vault جدا نیاز دارد.

---

## شروع سریع

```bash
cd kuki-dex
pnpm install --ignore-workspace
pnpm build          # Tact + TypeScript
pnpm test           # قراردادها روی emulator + ریاضی ربات + پارس STON.fi
```

خروجی تست‌ها:

```
✔ creates a pool, binds wallets and mints LP shares on a 50/50 deposit
✔ swaps KUKI -> token with the exact curve output
✔ refunds instead of throwing when slippage is not met
✔ prices an 80/20 pool like Osmosis classic (exp/ln path)
✔ withdraws pro-rata and keeps the locked bootstrap shares
✔ refunds a stray liquidity leg that does not match the open session
```

### دموی کامل روی زنجیرهٔ محلی (بدون پول واقعی)

```bash
pnpm build
node dist/scripts/demo.js
```

این اسکریپت واقعاً factory و دو استخر را deploy می‌کند، نقدینگی می‌ریزد، یک فرصت کم‌سود را رد می‌کند و یک فرصت سودده را با دو تراکنش واقعی اجرا می‌کند.

### دیپلوی (اول تست‌نت)

```bash
cp .env.example .env
# TON_ENDPOINT=https://toncenter.com/api/v2/jsonRPC
# KUKI_WALLET_MNEMONIC=...
# KUKI_JETTON=...  TOKEN_JETTON=...
# WEIGHTS=4,1  FEE_BPS=30  DRY_RUN=1
node --env-file=.env dist/scripts/deploy.js

# استخر KUKI/TON با TON بومی + انتقال مالکیت به ولت ادمین:
# TON_SIDE=1
# ADMIN_ADDRESS=UQ...
node --env-file=.env dist/scripts/deploy.js
```

> برای broadcast واقعی به یک کیف پول با موجودی TON نیاز است. اسکریپت بدون کلید فقط dry-run می‌کند. mnemonic را در `.env` بگذارید، نه در چت.

بعد از دیپلوی، آدرس استخر را در `KUKI_POOL` بگذارید و نقدینگی اولیه بریزید:

```bash
# KUKI_AMOUNT=100  TOKEN_AMOUNT=1000000  EXECUTE=1
node --env-file=.env dist/scripts/seed.js
```

### ربات

```bash
pnpm build
node dist/bot/src/index.js          # فقط پایش، بدون تراکنش
EXECUTE=1 node dist/bot/src/index.js
```

### شبیه‌سازی اقتصاد

```bash
node dist/bot/src/simulate.js                 # با عمق واقعی استخر KUKI/TON
node dist/bot/src/simulate.js depth=5000      # اگر عمق ۵٬۰۰۰ TON بود
```

---

## اعداد واقعی (و چرا مهم‌اند)

استخر فعلی KUKI/TON در STON.fi حدود **۶۰ TON** عمق دارد (TVL ~۱۳۲ دلار در زمان نوشتن). با گس ۰٫۴۵ TON برای دو لگ:

| عمق فرضی استخر | گپ سربه‌سر (break-even) | سود خالص در گپ ۴٪ |
|---|---|---|
| ۶۰ TON (واقعی) | > ۲۰۰۰ bps | منفی |
| ۱٬۰۰۰ TON | ۶۸۳ bps | منفی |
| ۵٬۰۰۰ TON | ۳۳۴ bps | ~۰٫۲۴ TON |
| ۲۰٬۰۰۰ TON | ۱۹۷ bps | ~۲٫۳ TON |

یعنی: **تا وقتی استخر عمق چند هزار TON نداشته باشد، ربات اربیتراژِ سودده نیست.** این مهم‌ترین واقعیت اقتصادی پروژه است و در `docs/02-economics.md` کامل توضیح داده شده.

---

## نقشهٔ فایل‌ها

```
kuki-dex/
  contracts/
    KukiDex.tact          قرارداد استخر + کارخانه (Tact)
    TestJetton.tact       jetton تستی برای تست‌های emulator
  bot/
    src/math/fixed.ts     ln/exp و pow با ۱e۱۸
    src/math/weighted.ts  فرمول استخر وزن‌دار، LP، spot
    src/strategy/arb.ts   جست‌وجوی اندازهٔ بهینه
    src/venues/           آداپتر STON.fi و KUKI
    src/exec/             ساخت پیام، کیف پول، لگ‌ها
    src/bot.ts            حلقهٔ اصلی
    src/simulate.ts       میزکار اقتصاد
  tests/pool.test.ts      تست قرارداد روی TVM
  bot/tests/*.test.ts     تست ریاضی و پارس API
  scripts/deploy.ts       دیپلوی کارخانه + استخر + bind
  docs/                   طراحی، اقتصاد، ربات، امنیت، نقشهٔ راه
```

---

## هشدارها

- قراردادها **audit نشده‌اند**. پول واقعی نگذارید تا بازبینی مستقل انجام شود.
- ادمین (مالک کارخانه) می‌تواند آدرس کیف‌پول‌های jetton استخر را bind کند؛ تا قبل از bind، استخر `ready=false` است و معامله نمی‌کند. این یک نقطهٔ اعتماد است و در `docs/04-security-and-risks.md` توضیح داده شده.
- اربیتراژ روی TON **اتمیک نیست**: دو لگ جدا هستند و بین آن‌ها ریسک قیمت/موجودی وجود دارد.
- «حجم از طریق اربیتراژ» فقط تا اندازهٔ عمق استخر و اندازهٔ گپ واقعی است؛ حجم ساختگی (wash trading) ارزش اقتصادی ایجاد نمی‌کند و می‌تواند مصداق دستکاری بازار باشد.
- توکن و DEX ممکن است در حوزهٔ مقررات اوراق بهادار/پول‌شویی قرار بگیرند؛ این سند مشاورهٔ حقوقی نیست.

---

## مستندات

- [طراحی فنی](docs/01-design.md)
- [اقتصاد و اعداد](docs/02-economics.md)
- [ربات اربیتراژ](docs/03-bot.md)
- [امنیت و ریسک‌ها](docs/04-security-and-risks.md)
- [نقشهٔ راه](docs/05-roadmap.md)
