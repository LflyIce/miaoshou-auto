# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local automation tool (Chinese UI/logs: "妙手ERP商品必填属性自动填写助手") that drives the 妙手 ERP product-edit page with Playwright to auto-fill required (red-star) product attributes. It also rewrites JP/EN SEO titles, cleans descriptions, trims SKU specs, exports product data, and batch-saves — all per product. Ships as both a CLI (`src/*.js`) and an Electron desktop app that wraps the same core.

All code comments, log prefixes (`[扫描]`, `[保存]`, `[下一商品]`…), config keys, and docs are in Chinese — preserve that style when editing.

## Commands

```bash
npm install                       # deps (set ELECTRON_MIRROR for China mirror if slow)
npx playwright install chromium   # only needed if not using local Edge (default uses msedge)

npm run login                     # node src/login.js — manual login, saves storage/miaoshou_state.json
npm run fill                      # node src/main.js — the batch fill loop
npm run app                       # electron . — desktop GUI
npm run dist                      # electron-builder → Windows NSIS installer in dist/
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

**Two roots, not one.** `src/utils.js` resolves all paths through `DATA_ROOT`, which is either `PROJECT_ROOT` (CLI / dev) or the value of `MIAOSHOU_DATA_ROOT` env var (set by Electron for the packaged app's `userData` dir). `electron/main.js` `prepareRuntime()` copies default `config/` and the knowledge base into the runtime root on first launch, and `syncBundledDefaults()` force-overwrites developer-only config keys (`startUrl`, `browser`, `thresholds`, `modules`, `knowledgeBase`, plus `ai.baseURL`/`ai.maxTokens`) from the bundled defaults on every start — so user-edited values in those keys do **not** survive an app upgrade by design. Only `ai.model`, `ai.sendImages`, `productEditUrl`, `headless`, `behavior.saveAfterFill`, `behavior.waitForManualPage`, `batch.maxProducts` are UI-writable/preserved.

**Two different logins — don't confuse them.** `npm run login` persists the **Playwright** session for 妙手 ERP to `storage/miaoshou_state.json` (never committed). Separately, the **Electron desktop UI** has its own gate: `config/auth.json` (gitignored, defaults `admin`/`admin`, read by `loadAuth` and checked by the `auth:login` IPC handler). Guests can still enter the app in a limited mode.

## The per-product pipeline (`src/main.js` → `processCurrentProduct`)

Five logged phases per product, run in a loop (`maxProducts`, 0 = unlimited):

1. Read title/images (`page_reader.js`); SKU data and product link are read **before** switching to the 类别&属性 module, because the SKU table may disappear after navigation.
2. Rewrite JP/EN titles via AI (`ai_analyzer.rewriteProductTitles`, two-step: expand keywords → 150–175 char punctuation-free JP title) and fill them (`title_filler.js`); clean description; edit SKU specs.
3. `navigateToModule('类别&属性')` then `scanRequiredAttributes()` (`attribute_scanner.js`) — finds the section via a DOM scoring algorithm, collects required rows, detects control type, and **actually opens each dropdown** to read real page options. Each row is tagged `data-ms-attr-row=<id>` for later targeting.
4. `buildKnowledgeDecisions()` reuses stable historical values from the category knowledge base (skipping AI); remaining fields go to `analyzeAttributes()` in one batched AI call.
5. Per field: `decideFinalValue()` → `chooseBestOption()` (the matcher) → `fillAttribute()` (`filler.js`, with read-back verification). Success is recorded back into the knowledge base.

After the loop body: a second `scanRequiredAttributes()` catches **cascaded** attributes that only appear after a prior selection. Then export to Excel, and if `saveAfterFill=true`, `saveCurrentProductWithRetry()` clicks 保存修改; on failure it reads the toast/error, calls `analyzeSaveError()`, re-scans with the error fields, and retries once (`saveRetryLimit`).

## The matcher is the heart of the project (`src/option_matcher.js` → `chooseBestOption`)

AI-inferred values are mapped to **real page options** through a strict priority chain. `method` is logged for every field:

`exact` (1.0) → `normalized` (0.98) → `synonym` (0.94, bidirectional via `config/synonyms.json`) → `contains` (0.90) → `included_by` (0.88) → `fuzzy` (Levenshtein·0.55 + Jaccard·0.45, ≥ `thresholds.autoSelectScore` 0.85) → `ai_second_choice` (a second AI call constrained to page options, ≥ `thresholds.aiSecondChoiceScore` 0.7) → `fallback` (field-level 0.72, then global 0.65) → `neutral_fallback` (0.45) → `manual_required` (0, leave for human).

**Non-negotiable invariants** (do not weaken these):
- Every `select`/`multi_select` final value **must** come from the page's real options. The AI can never invent a value — it only proposes, the matcher constrains.
- If nothing matches, the field is marked `manual_required` and logged to `data/failed_items.xlsx`. Never force-fill.
- **Sensitive fields** (材质/材料/认证/证书/品牌/产地) never use the *global* fallback — only a matching field-level rule in `config/fallback_rules.json` will fill them. `chooseFallback` enforces this.

When tuning accuracy: add to `config/synonyms.json` (bidirectional) or `config/fallback_rules.json` (field-level). Lowering `autoSelectScore` matches more aggressively but risks wrong matches.

## AI integration uses the Anthropic Messages format — not OpenAI

All AI calls use the **Anthropic Messages format** — never OpenAI. The unified client lives in `src/anthropic_client.js` (`AnthropicClient`), which all compatible providers (智谱 GLM, LongCat, etc.) share. `ai_analyzer.js` builds a client via `createAIClient()` (reads `config.ai.providers[model]` for `baseURL`/`apiKeyEnv`), then calls `complete` / `completeWithFallback` / `completeJSON`. Wire format: POST `${baseURL}/v1/messages` with header `anthropic-version: 2023-06-01`, top-level `system` field, `temperature: 0.1`, parses `json.content[].text` blocks. Image-bearing requests auto-retry text-only on failure; vision caps at 3 images. System prompts live in `config/prompt_templates.json` (`attributeAnalysisSystem`, `secondChoiceSystem`); title-rewrite prompts are hardcoded defaults in `ai_analyzer.js`. `extractJSON` strips ```json fences and extracts the outermost `{...}`. Treat the docs' OpenAI/`paas/v4`/`GLM-5V-Turbo` references as stale.

The API key is **not** in `config.json` — that file only stores the env-var *name* (`ai.apiKeyEnv`, default `ZAI_API_KEY`). The key itself lives in `.env`, loaded via `dotenv` at the top of `src/main.js`. The Electron app persists it back to `.env` through the `app:save-settings` IPC handler (`env.ZAI_API_KEY = ...`); `prepareRuntime()` seeds an empty `.env` on first launch.

## Knowledge base (`src/category_knowledge.js`)

`storage/category_attribute_knowledge.json` (committed, grows with use) caches per-category attribute history. On a known category, fields with reliable historical values are reused directly via `buildKnowledgeDecisions` — but the reused value is **re-matched against current page options**, never trusted blindly. Confidence caps at `min(0.96, 0.78 + min(count,6)·0.03)`. `maxSamplesPerAttribute`/`maxTitlesPerCategory` bound growth.

## Adding things — the extension points

- **New control type**: (1) detect in `attribute_scanner.js` `detectControlType`, (2) add a `fillAttribute` branch in `filler.js` with read-back verification, (3) add a final-decision branch in `main.js` `decideFinalValue`, (4) add a knowledge-reuse branch in `main.js` `decideFromKnowledge`.
- **New AI capability**: add a function in `ai_analyzer.js` using `createAIClient()` then `client.completeWithFallback(...)` + `extractJSON`; put prompts in `prompt_templates.json`. For a new provider, add an entry in `config.json` `ai.providers` with `label` + `baseURL` + `apiKeyEnv` (no `apiType` needed — everything is Anthropic-format now).
- **New UI config option**: add the control in `renderer/index.html`, wire it in `renderer/app.js` (`els`/`init`/`saveSettings`), and deep-merge it in `electron/main.js` `app:save-settings`. Keys not added to the save handler won't persist.
- **Broken page selectors** (妙手 DOM changed): extend `modules.attributes.aliases` in config, or the selector lists / scoring in `attribute_scanner.js`. Note `OPTION_SELECTORS` is duplicated across `attribute_scanner.js`, `filler.js`, **and** `sku_filler.js` — update all three.

## Output artifacts (gitignored)

`data/logs.xlsx` (full per-field log), `data/failed_items.xlsx` (+ screenshot + error), `data/screenshots/*.png`, `data/product_export_YYYYMMDD.xlsx` (采购成本 = 申报价 / 4, hardcoded in `product_export.js`). `logger.js` falls back to a timestamped filename if the xlsx is open in Excel. `storage/miaoshou_state.json` holds the Playwright login state and is never committed.
