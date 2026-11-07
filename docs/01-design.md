# ۰۱ — طراحی فنی

## هدف

یک DEX مستقل روی TON که:

1. استخرهای وزن‌دار **Osmosis classic** داشته باشد (نه constant-product ساده).
2. در هر استخر، یکی از دو دارایی **همیشه KUKI** باشد.
3. نقدینگی، کارمزد و سهام LP را بدون اوراکل و بدون ریسک‌های قابل‌اجتناب مدیریت کند.
4. ربات بتواند قیمت را بین این استخرها و STON.fi هم‌گام کند.

## غیرهدف‌ها (در v0.1)

- استخر چنددارایی (۳ یا ۴ دارایی) — به‌خاطر واریز اتمی، به router/vault نیاز دارد.
- LP به‌صورت jetton قابل‌انتقال — فعلاً ledger داخلی است.
- واریز یک‌طرفه (zap) — در v1.
- حاکمیت DAO / timelock — فعلاً مالک کارخانه.
- پروتکل فی — فعلاً کل کارمزد به LP می‌رسد.

---

## ۱. مدل استخر

هر استخر: `(KUKI, TOKEN)` با وزن‌های صحیح `wKuki, wToken` (۱ تا ۱۶) و کارمزد `feeBps` (حداکثر ۱۰۰۰ = ۱۰٪).

وزن‌ها «جزء» هستند، نه درصد: `(4,1)` یعنی ۸۰/۲۰ و `(1,1)` یعنی ۵۰/۵۰. مجموع وزن‌ها اهمیتی ندارد؛ فقط نسبت‌شان در فرمول می‌آید.

### فرمول swap

```
out = B_out · (1 − (B_in / (B_in + in·(1−fee))) ^ (w_in / w_out))
```

این همان invariant وزن‌دار است:

```
Π x_i^{w_i} = const
```

برای `w_in = w_out` به constant-product کلاسیک تبدیل می‌شود و در قرارداد یک مسیر سریع و **دقیق** دارد:

```
out = B_out · inEff / (B_in + inEff)
```

برای وزن‌های نابرابر، توان کسری لازم است (مثلاً ۸۰/۲۰ در جهت token→KUKI یعنی توان ۱/۴). TVM عدد اعشاری ندارد، پس:

```
t^(p/q) = exp( (p/q) · ln t )
```

با fixed-point ۱e۱۸. پیاده‌سازی در `contracts/KukiDex.tact` و `bot/src/math/fixed.ts` **خط‌به‌خط یکی است** و تست‌ها خروجی قرارداد را با مرجع TS تا چند wei مقایسه می‌کنند.

جزئیات `ln`:
- نرمال‌سازی `m = x·2^k ∈ [1,2)`
- `ln(m) = 2·atanh((m−1)/(m+1))` با ۱۲ جمله
- `ln(x) = ln(m) − k·ln2`

جزئیات `exp`:
- `y = n·ln2 + r`، `r ∈ [0, ln2)`
- سری تیلور متناوب تا ۲۰ جمله
- `exp(y) = 2^n · exp(r)` (برای y منفی، شیفت راست)

خطای نسبی اندازه‌گیری‌شده: `< 1e-12` برای round-trip و `~1e-9` برای توان کسری. رزروها بر حسب واحد jetton (۹ اعشار) هستند، پس این خطا در عمل صفر است.

### ۱.۱ استخر KUKI/TON با TON بومی

جفت اصلی KUKI در STON.fi، `KUKI/TON` است و TON بومی jetton نیست. برای اینکه ربات بتواند مستقیماً با همان جفت اربیتراژ کند، استخر یک حالت `tonSide` دارد:

- `token = ZERO` و فقط کیف‌پول jetton مربوط به KUKI bind می‌شود (`ready` با یک bind کامل می‌شود).
- `reserveToken` همان رزرو TON بر حسب nanoTON است.
- ورود TON با پیام `SwapTonIntent` است: کاربر `amountIn` را اعلام می‌کند و `amountIn + 0.05 TON` می‌فرستد؛ ۰٫۰۵ برای گس/استوریج در استخر می‌ماند.
- خروج TON با `send` بومی انجام می‌شود و `WithdrawTon` ادمین نمی‌تواند به رزرو TON دست بزند (شرط `myBalance() > reserveToken + amount`).
- نقدینگی TON با پیام `LiquidityTonPart` و همان الگوی `(owner, nonce)` جفت می‌شود؛ مبلغ = `value − 0.05`.

این حالت با ۶ تست جداگانه روی TVM پوشش داده شده: واریز، swap دو طرفه، refund، برداشت و انتقال مالکیت.

### قیمت لحظه‌ای

```
price(token in KUKI) = (B_kuki · w_token) / (B_token · w_kuki)
```

`getSpotPrice()` همین را با ۱e۱۸ برمی‌گرداند.

---

## ۲. کارمزد

- `feeBps` در init و فقط توسط `admin` قابل تغییر است (سقف ۱۰٪).
- کارمزد در استخر می‌ماند: رزرو ورودی با کل مبلغ افزایش می‌یابد، رزرو خروجی با خروجی کم می‌شود. یعنی کارمزد به‌صورت خودکار به LP تعلق می‌گیرد.
- پروتکل فی در v0.1 وجود ندارد. اگر بعداً اضافه شود، باید در همان لحظهٔ swap جدا و به خزانه منتقل شود، نه اینکه در رزرو بماند.

---

## ۳. سهام LP

v0.1 از ledger داخلی استفاده می‌کند (نه jetton) تا سطح حمله کمتر و کد کمتر باشد.

### واریز باید متناسب باشد

واریز فقط وقتی پذیرفته می‌شود که نسبت دو دارایی با نسبت فعلی استخر در محدودهٔ ۰٫۵٪ (`DEPOSIT_TOLERANCE_BPS`) باشد. دلیل:

- بدون اوراکل و بدون محاسبهٔ invariant کسری، سهام را می‌توان دقیق و ارزان mint کرد.
- از حملهٔ «donation / price manipulation» برای mint ارزان سهام جلوگیری می‌کند.
- برای ۵۰/۵۰ دقیقاً رفتار Uniswap V2 است.

فرمول:

- اولین واریز: `shares = min(kukiAmt·1e18/wKuki, tokenAmt·1e18/wToken)` (تابع همگن درجهٔ ۱).
- واریزهای بعدی: `shares = totalShares · min(amt_i·1e18/B_i) / 1e18`.
- برداشت: `amount_i = B_i · shares / totalShares`.

### قفل بوت‌استرپ

در اولین واریز، ۰٫۱٪ سهام به آدرس خود استخر mint می‌شود. این سهام هرگز قابل برداشت نیست (استخر نمی‌تواند پیام بفرستد)، پس `totalShares` هرگز صفر نمی‌شود و حملهٔ «تخلیهٔ کامل و بازنشانی قیمت» ممکن نیست.

---

## ۴. نقدینگی در دنیای async

TON actor-based است؛ نمی‌توان دو jetton را در یک تراکنش اتمی به استخر داد. راه‌حل v0.1:

```
کاربر:
  1) transfer KUKI  → کیف‌پول استخر → notification → باز شدن session (owner, nonce)
  2) transfer TOKEN → کیف‌پول استخر → notification → تکمیل و mint
  3) اگر لگ دوم نیامد: CancelLiquidity (خود کاربر) یا ExpireLiquidity (هر کسی بعد از deadline)
```

- هر کاربر فقط یک session باز دارد؛ nonce برای جلوگیری از قاطی‌شدن sessionهاست.
- اگر لگ دوم با nonce متفاوت برسد، **refund** می‌شود و وارد session نمی‌شود.
- اگر در `finalize` slippage یا نسبت رد شود، هر دو لگ refund می‌شوند.
- **هیچ‌جا بعد از دریافت jetton، `throw` نمی‌کنیم.** throw در handler به معنی گم‌شدن jetton در کیف‌پول استخر بدون ثبت حسابداری است؛ به‌جایش refund می‌فرستیم.

این الگو در تست‌ها پوشش داده شده: واریز موفق، refund slippage، و refund لگ ناهماهنگ.

---

## ۵. Bind کردن کیف‌پول‌های jetton

استخر باید بداند notification از کدام کیف‌پول jetton آمده تا دارایی را تشخیص دهد. آدرس کیف‌پول jetton برابر است با:

```
hash(code_jetton_wallet, data{owner: pool, master: jetton})
```

و آدرس استخر به init data خودش وابسته است؛ پس آدرس کیف‌پول‌ها **قبل از** ساخت استخر قابل محاسبه نیست (circular dependency). راه‌حل:

1. کارخانه استخر را deploy می‌کند.
2. مالک (admin) آدرس کیف‌پول‌های واقعی را off-chain از `get_wallet_address` مستر jetton می‌گیرد.
3. `BindWallet{index, wallet}` را به استخر می‌فرستد.
4. تا وقتی هر دو bind نشده‌اند، `ready = false` و هر swap/liq رد و refund می‌شود.

**این یک نقطهٔ اعتماد است:** ادمین می‌تواند آدرس اشتباه bind کند. اما:

- نمی‌تواند رزروها را بدزدد (رزروها فقط با swap/withdraw جابه‌جا می‌شوند).
- bind فقط یک‌بار برای هر index انجام می‌شود و قابل تغییر نیست.
- در v1 می‌توان آن را با یک «vault» که خودِ استخر deploy می‌کند یا با تأیید هستهٔ jetton جایگزین کرد.

جزئیات تهدید در `04-security-and-risks.md`.

---

## ۶. پیام‌ها

| مبدأ | op | توضیح |
|---|---|---|
| jetton transfer (forward) | `0x4b554b01` | `SwapIntent{assetIn, minOut, receiver, deadline}` |
| jetton transfer (forward) | `0x4b554b02` | `LiquidityPart{nonce, assetIdx, minShares, deadline}` |
| کاربر → استخر | `0x4b554b03` | `CancelLiquidity{nonce}` |
| admin → استخر | `0x4b554b04` | `BindWallet{index, wallet}` |
| admin → استخر | `0x4b554b05` | `SetPaused{paused}` |
| admin → استخر | `0x4b554b06` | `SetFee{feeBps}` |
| کاربر → استخر | `0x4b554b07` | `WithdrawLiquidity{shares, minKuki, minToken}` |
| هر کسی → استخر | `0x4b554b08` | `ExpireLiquidity{owner}` |
| admin → استخر | `0x4b554b0a` | `WithdrawTon{amount, to}` (فقط گس اضافه) |
| استخر → بیرون | `0x4b554b10..12` | رویدادهای Swap / Add / Remove |

### نکتهٔ فنی: forward payload

TEP-74 می‌گوید `forward_payload: Either Cell ^Cell`؛ یعنی یک بیت انتخاب و بعد payload. استخر این بیت را می‌خواند:

- `0` → payload inline
- `1` → `loadRef()`

اگر این را نادیده بگیرید، اولین بیتِ opcode به‌جای selector خوانده می‌شود و همهٔ swapها با «bad payload» refund می‌شوند. این دقیقاً باگ اولیهٔ همین پروژه بود و در تست‌ها پوشش داده شد.

---

## ۷. توابع خواندنی (getters)

```tact
getPoolState()   -> (reserveKuki, reserveToken, wKuki, wToken, feeBps, totalShares, paused, ready)
getShares(owner) -> Int
getSpotPrice()   -> Int  // KUKI per token, 1e18
getQuote(assetIn, amountIn) -> Int  // authoritative swap quote
getAssets()      -> (kuki, token)
getWallets()     -> (walletKuki, walletToken)
getAdmin()       -> Address
```

`getPoolState` برای قیمت‌گذاری و `getQuote` برای ساخت `minOut` استفاده می‌شود. ربات قبل از هر لگ، quote را از خود قرارداد می‌گیرد تا محاسبات محلی هرگز جای وضعیت واقعی زنجیره را نگیرند.

---

## ۸. محدودیت‌های شناخته‌شده (v0.1)

1. فقط دو دارایی؛ استخر ۳/۴ دارایی نیاز به router دارد.
2. LP jetton نیست؛ سهام قابل انتقال یا استفاده در فارم نیست.
3. واریز باید متناسب باشد؛ zap یک‌طرفه ندارد.
4. اگر انتقال خروجی bounce شود (مثلاً گیرندهٔ نامعتبر)، رزروها قبلاً کم شده‌اند و بازیابی خودکار وجود ندارد. برای v1 باید `bounced` handler اضافه شود.
5. ادمین می‌تواند استخر را pause کند؛ timelock ندارد.
6. هیچ اوراکلی وجود ندارد؛ قیمت فقط از رزروها می‌آید (که برای AMM درست است، ولی برای وام/مشتقه کافی نیست).
