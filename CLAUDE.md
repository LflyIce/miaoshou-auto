# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local automation tool (Chinese UI/logs: "妙手ERP商品必填属性自动填写助手") that drives the 妙手 ERP product-edit page with Playwright to auto-fill required (red-star) product attributes. It also rewrites JP/EN SEO titles, cleans descriptions, trims SKU specs, exports product data, and batch-saves — all per product. Ships as both a CLI (`src/*.js`) and an Electron desktop app that wraps the same core. A second, independent automation target lives in `src/temu/` (Temu 商家后台 login + 申报价格核对); it shares only `src/utils.js` with the 妙手 pipeline.

All code comments, log prefixes (`[扫描]`, `[保存]`, `[下一商品]`…), config keys, and docs are in Chinese — preserve that style when editing.

## Commands

```bash
npm install                       # deps (set ELECTRON_MIRROR for China mirror if slow)
npx playwright install chromium   # only needed if not using local Edge (default uses msedge)

npm run login                     # node src/login.js — manual login, saves storage/miaoshou_state.json
npm run fill                      # node src/main.js — the batch fill loop
npm run app                       # electron . — desktop GUI
npm run dist                      # electron-builder → Windows NSIS installer in dist/
.\scripts\build.ps1               # preferred packaging wrapper: sets China mirrors (ELECTRON_MIRROR,
                                  #   ELECTRON_BUILDER_BINARIES_MIRROR), disables code signing, sorts output
                                  #   into dist/installer + dist/portable — bare `npm run dist` can stall on binary downloads
node src/temu/login_temu.js       # Temu login → storage/temu_state.json (independent of the 妙手 session)
node src/temu/price_check.js      # Temu 申报价格 list automation (see "Temu side-tooling" below)
```

**No test framework, no linter.** Tests are plain Node scripts using `node:assert` + hand-written fakes. Run all:

```powershell
Get-ChildItem test -Filter *.test.js | ForEach-Object {
  Write-Host "RUN $($_.Name)"; node $_.FullName
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

Run a single test: `node test/save_feedback.test.js`.

Syntax check (the "lint" substitute — run after touching Electron files):

```powershell
node -c electron\main.js; node -c electron\preload.js; node -c electron\renderer\app.js; node -c src\utils.js
```

## Architecture

Layered, with a clean core/UI split:

```
Electron renderer (renderer/app.js)  ←→  window.miaoshouApp (contextBridge IPC)
Electron main (electron/main.js)     ←→  child_process.fork(src/login.js | src/main.js) + stdin('\n')
automation core (src/*.js)           ←→  Playwright → local Edge → 妙手 ERP page
                                     ←→  Zhipu GLM via Anthropic Messages API
```

**The core never knows Electron exists.** The desktop app launches `src/main.js` as a forked child process and bridges its terminal `waitForEnter()` prompt into a UI "继续/Continue" button by writing `'\n'` to the child's stdin (`electron/main.js` → `task:continue`). When editing the interactive flow, both sides must stay in sync.

**Two roots, not one.** `src/utils.js` resolves all paths through `DATA_ROOT`, which is either `PROJECT_ROOT` (CLI / dev) or the value of `MIAOSHOU_DATA_ROOT` env var (set by Electron for the packaged app's `userData` dir). `electron/main.js` `prepareRuntime()` copies default `config/` and the knowledge base into the runtime root on first launch, and `syncBundledDefaults()` force-overwrites developer-only config keys (`startUrl`, `browser`, `thresholds`, `modules`, `knowledgeBase`, `preSave`, `update`, plus `ai.baseURL`/`ai.maxTokens`/`ai.providers`) from the bundled defaults on every start — so user-edited values in those keys do **not** survive an app upgrade by design. Only `ai.model`, `ai.sendImages`, `productEditUrl`, `headless`, `behavior.saveAfterFill`, `behavior.waitForManualPage`, `batch.maxProducts` are UI-writable/preserved.

**Two different logins — don't confuse them.** `npm run login` persists the **Playwright** session for 妙手 ERP to `storage/miaoshou_state.json` (never committed). Separately, the **Electron desktop UI** has its own gate: `config/auth.json` (gitignored, defaults `admin`/`admin`, read by `loadAuth` and checked by the `auth:login` IPC handler). Guests can still enter the app in a limited mode.

## The per-product pipeline (`src/main.js` → `processCurrentProduct`)

Five logged phases per product, run in a loop (`maxProducts`, 0 = unlimited):

1. Read title/images (`page_reader.js`); SKU data and product link are read **before** switching to the 类别&属性 module, because the SKU table may disappear after navigation.
2. Rewrite JP/EN titles via AI (`ai_analyzer.rewriteProductTitles`, two-step: expand keywords → 150–175 char punctuation-free JP title) and fill them (`title_filler.js`); clean description; edit SKU specs. The title AI request is fired **immediately** (`startTitleGeneration` returns a promise) and runs in parallel with the description/SKU DOM work; it is awaited later, so title latency doesn't serialize the pipeline.
3. `navigateToModule('类别&属性')` then `scanRequiredAttributes()` (`attribute_scanner.js`) — finds the section via a DOM scoring algorithm, collects required rows, detects control type, and **actually opens each dropdown** to read real page options. Each row is tagged `data-ms-attr-row=<id>` for later targeting.
4. `buildKnowledgeDecisions()` reuses stable historical values from the category knowledge base (skipping AI); remaining fields go to `analyzeAttributes()` in one batched AI call.
5. A **field work queue** (`while (queue.length)`): every field goes through `processAttributeField()` (shared with the save-repair path) → `decideFinalValue()` → `chooseBestOption()` (the matcher) → `fillAttribute()` (`filler.js`, with read-back verification **plus live-option rematch**: after opening a dropdown, if the decision value isn't among the live options, `matchLocally()` re-matches it against what's actually rendered — logged as `[活选项]`). Success is recorded back into the knowledge base. After each successful fill, `discoverNewRequiredAttributes()` (`attribute_scanner.js`) re-collects the pane's required-and-empty rows, diffs names against already-handled ones, and enqueues genuinely new **cascaded** fields (bounded `MAX_CASCADE_ROUNDS = 3`) with fresh knowledge/AI/secondChoice decisions — cascades are handled in-flow, not via after-the-fact rescue. The probe also runs once before the loop when the initial queue is empty (everything pre-filled) — otherwise late-rendered required rows would wait for a failed save to surface. `textureSafeDecision()` short-circuits 纹理 fields before the AI is even consulted: prefer the page option that spawns no child required attribute (无里料 for 里料纹理, 绒面/PU for 面料纹理; method `texture_no_child`, confidence 1). Empty `input` fields get `neutralInputValue()` text (`neutral_text_fallback`, 0.35).

Cascaded attributes are caught **inside** the [5/5] queue loop (see `discoverNewRequiredAttributes` above). Before the loop, `scanUntilComplete()` still guards scan completeness — it diffs the pane's required-row names against what was scanned (required-only; optional rows never count as missed, or it would loop forever), rescans up to 3×, and on persistent misses prints a per-row 漏扫诊断 (`diagnoseScanZeroRows` in `attribute_scanner.js` is the deeper variant). After the loop: export to Excel, and if `saveAfterFill=true`, `saveCurrentProductWithRetry()` clicks 保存修改. Note the retry budget is **hardcoded `maxAttempts = 6`** with a "same error 3× in a row → skip product" circuit breaker — the `batch.saveRetryLimit` config key is **dead config** nothing reads. Before the first save attempt, `prefillOutsideRequiredFields()` fills deterministic required fields that live **outside** the 类别&属性 pane (configured in `config.preSave.outsideFields`, e.g. 制造地点→中国大陆 — the scanner and cascade discovery can't see them, so without prefill every product burns a failed save to discover them). It locates each field via `locateFieldAcrossModules()`, skips rows that already have a value (`isFixRowEmpty`), and fills through `fixFieldByErrorName(..., tag='presave')` — logs show `picker_presave`/`presave_*` methods. On save failure the repair is field-directed: `extractRequiredFieldNames()` parses the toast (【字段名】 brackets, or `xx必填/不能为空/未填写/有误` suffixes), `locateFieldAcrossModules()` finds the row **anywhere in the page** — switching modules when needed, since e.g. 制造地点 lives in 产品信息, not 类别&属性 — and `fixFieldByErrorName()` fills it directly (click-style cascaders/readonly pickers go through `fillPickerByClick`, which auto-continues into second-level panels and verifies by row read-back). Failing that, `fixAttributesForRetry()` re-runs only the attribute flow (full scan + `processAttributeField` loop over still-missing required fields — no title/description/SKU/export), then saves again. Between products, `goToNextProduct()` tries three strategies (goods-list click, configured/`下一个商品` text buttons, left product list) and `decideNextProductTransition()` (`src/batch_flow.js`, pure + unit-tested) **stops the batch** when the page didn't actually switch — the tool must never edit the same product twice.

## The matcher is the heart of the project (`src/option_matcher.js` → `chooseBestOption`)

AI-inferred values are mapped to **real page options** through a strict priority chain. `method` is logged for every field:

`exact` (1.0) → `normalized` (0.98) → `synonym` (0.94, bidirectional via `config/synonyms.json`) → `contains` (0.90) → `included_by` (0.88) → `fuzzy` (Levenshtein·0.55 + Jaccard·0.45, ≥ `thresholds.autoSelectScore` 0.85) → `ai_second_choice` (a second AI call constrained to page options, ≥ `thresholds.aiSecondChoiceScore` 0.7) → `fallback` (field-level 0.72, then global 0.65) → `neutral_fallback` (0.45) → `manual_required` (0, leave for human).

**Non-negotiable invariants** (do not weaken these):
- Every `select`/`multi_select` final value **must** come from the page's real options — with one exception: when the scan read no options at all, `fallback_unverified` (0.35) takes the field-level fallback value and types it into the dropdown; the filler's search path only clicks it if it actually appears among live options. The AI can never invent a value — it only proposes, the matcher constrains.
- If nothing matches, the field is marked `manual_required` and logged to `data/failed_items.xlsx`. Never force-fill.
- **Sensitive-field guard is currently absent** (known divergence from the original design): `chooseFallback` no longer special-cases 材质/材料/认证/证书/品牌/产地 — the `sensitiveAttributes` key in `fallback_rules.json` is dead config nothing reads. Field-level rules exist for 材质/材料/品牌, but 认证/证书/产地 fall through to the *global* fallback today. If strict behavior is wanted, restore the check in `chooseFallback` (and update `option_matcher.material-fallback.test.js`, which asserts the lenient behavior).

When tuning accuracy: add to `config/synonyms.json` (bidirectional) or `config/fallback_rules.json` (field-level). Lowering `autoSelectScore` matches more aggressively but risks wrong matches.

## AI integration uses the Anthropic Messages format — not OpenAI

All AI calls use the **Anthropic Messages format** — never OpenAI. The unified client lives in `src/anthropic_client.js` (`AnthropicClient`), which all compatible providers (智谱 GLM, LongCat, etc.) share. `ai_analyzer.js` builds a client via `createAIClient()` (reads `config.ai.providers[model]` for `baseURL`/`apiKeyEnv`), then calls `complete` / `completeWithFallback` / `completeJSON`. Wire format: POST `${baseURL}/v1/messages` with header `anthropic-version: 2023-06-01`, top-level `system` field, `temperature: 0.1`, parses `json.content[].text` blocks. Image-bearing requests auto-retry text-only on failure; vision caps at 3 images. System prompts live in `config/prompt_templates.json` (`attributeAnalysisSystem`, `secondChoiceSystem`); title-rewrite prompts are hardcoded defaults in `ai_analyzer.js`. `extractJSON` strips ```json fences and extracts the outermost `{...}`. Treat the docs' OpenAI/`paas/v4`/`GLM-5V-Turbo` references as stale.

The API key is **not** in `config.json` — that file only stores the env-var *name* (`ai.apiKeyEnv`, default `ZAI_API_KEY`). The key itself lives in `.env`, loaded via `dotenv` at the top of `src/main.js`. The Electron app persists it back to `.env` through the `app:save-settings` IPC handler (`env.ZAI_API_KEY = ...`); `prepareRuntime()` seeds an empty `.env` on first launch.

## Knowledge base (`src/category_knowledge.js`)

`storage/category_attribute_knowledge.json` (committed, grows with use) caches per-category attribute history. On a known category, fields with reliable historical values are reused directly via `buildKnowledgeDecisions` — but the reused value is **re-matched against current page options**, never trusted blindly. Confidence caps at `min(0.96, 0.78 + min(count,6)·0.03)`. `maxSamplesPerAttribute`/`maxTitlesPerCategory` bound growth.

## Temu side-tooling (`src/temu/`)

`login_temu.js` / `price_check.js` automate the Temu 商家后台 申报价格 flow. Fully separate from the 妙手 pipeline: own login state (`storage/temu_state.json`, configured via `config.temu.loginUrl` / `config.temu.priceCheckUrl`), no shared loop or AI calls — only `src/utils.js` is reused. `price_check.js` specifics worth knowing before touching it:

- The price list is a **virtual-scrolling** table — only visible rows are rendered, so it processes while scrolling and dedupes by SKC 编号.
- Temu uses CSS-module classnames with hash suffixes (`TB_checkCell_5-120-1`), which cannot be prefix-matched — **locate exclusively via `data-testid`**.
- Clicking 查看并确认申报价格 opens a right drawer (`bgb-pc-show-drawer-body`) holding one SKC's SKU rows; the SKC-level 操作 dropdown (default 申请调整更新申报价格) is where 放弃调整申报价格 lives. Decisions use the group's first SKU 原价/调整后价; range prices take the lower bound.

## Adding things — the extension points

- **New control type**: (1) detect in `attribute_scanner.js` `detectControlType`, (2) add a `fillAttribute` branch in `filler.js` with read-back verification, (3) add a final-decision branch in `main.js` `decideFinalValue`, (4) add a knowledge-reuse branch in `main.js` `decideFromKnowledge`.
- **New AI capability**: add a function in `ai_analyzer.js` using `createAIClient()` then `client.completeWithFallback(...)` + `extractJSON`; put prompts in `prompt_templates.json`. For a new provider, add an entry in `config.json` `ai.providers` with `label` + `baseURL` + `apiKeyEnv` (no `apiType` needed — everything is Anthropic-format now).
- **New UI config option**: add the control in `renderer/index.html`, wire it in `renderer/app.js` (`els`/`init`/`saveSettings`), and deep-merge it in `electron/main.js` `app:save-settings`. Keys not added to the save handler won't persist.
- **Broken page selectors** (妙手 DOM changed): extend `modules.attributes.aliases` in config, or the selector lists / scoring in `attribute_scanner.js`. All dropdown primitives — `OPTION_SELECTORS` (jx/el/ant option-node selectors), `openSelect`/`closeDropdown`/`closeDropdownByOutsideClick`/`clickOption`/`clickFirstVisibleOption`/`typeSearchValue`/`verifyRowContains`/`collectVisibleOptions`, and the event-wait `waitForDropdownVisible` — live in **`src/ui.js`**, the single source of truth shared by `attribute_scanner.js`, `filler.js`, and `sku_filler.js`. The 妙手 page mixes `jx-*` (its own), `el-*`, and `ant-*` components, so selector lists carry all three prefixes — keep that. Beware two `jx` quirks: multi-select **rolls back uncommitted picks on Escape** (`ui.closeDropdownByOutsideClick` closes by clicking the pane label and re-picks missing values), and the 更多属性 expand button is a toggle (`is-collapse` state must be checked before clicking, or you re-collapse it).

## Output artifacts (gitignored)

`data/logs.xlsx` (full per-field log), `data/failed_items.xlsx` (+ screenshot + error), `data/screenshots/*.png`, `data/product_export_YYYYMMDD.xlsx` (采购成本 = 申报价 / 4, hardcoded in `product_export.js`). `logger.js` falls back to a timestamped filename if the xlsx is open in Excel. `storage/miaoshou_state.json` holds the Playwright login state and is never committed.
