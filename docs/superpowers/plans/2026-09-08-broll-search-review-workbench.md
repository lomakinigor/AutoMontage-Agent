# B-roll Search Review Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Deliver official Pexels image/video search, human selection, secure local import and explicit preview-before-approval in Review.

**Architecture:** Extend the existing local Review server and command/revision workflow. Isolate provider transport, candidate sessions and OCR/provenance; retain immutable normalized media and approved-only final render.

**Tech Stack:** Node.js 20+ CommonJS, vanilla Review JavaScript, ffmpeg/ffprobe, optional local Tesseract, Node test runner, Playwright, existing Remotion.

**Spec:** `docs/superpowers/specs/2026-09-08-broll-search-review-workbench-design.md`

## Global Constraints

- No push, deploy, release/tag or paid API. No scraper, cookies or reverse API.
- No separate LLM API; current agent writes queryOriginal/queryEnglish from transcript.
- Search/select/import/Save never approve or invoke final render.
- Read-only Review has no new mutation/search/proxy capability.
- Final brollMedia uses local canonical src plus SHA-256 only.
- Preserve existing manual import and metadata v1/v2 behavior; new discovery metadata v3 is additive.
- Browser gets only opaque IDs and allowlisted display fields; API secret/download URLs/paths/hashes remain on server.
- User explicitly authorizes independent agents in parallel, with exclusive file ownership and serialized commits.
- Code changes receive targeted regression tests and accompanying documentation; full suite at integration finish.

## Audit and ownership

Base is origin/main `0e8c5b3`, 12 commits ahead of local main. The copied research documents retain their original bytes. Initial suite: 843 tests, 832 pass, 3 fail, 8 skip; system FFmpeg cannot start because x265 dynamic library is missing. A repaired full FFmpeg installation is selected via PATH for real-media tests; importer failures will be reproduced separately.

Tasks 1 and 2 are sequential before integration. Task 3 can run in its own new directory after design acceptance; task 4 follows task 1; task 5 consumes 2–4; task 6 consumes 5. Task 7 owns preview/approval modules after task 2. No two agents edit a shared file concurrently. Root owns documentation until final documentation task.

### Task 1: Real image/video importer regression

**Files:** Modify `scripts/review/media-import.js`, `tests/helpers/media-fixtures.js`, `tests/review-media-import.test.js`, and only if required `scripts/media-probe.js`; document `TESTING.md` and `CHANGELOG.md` through root integration.

**Interfaces:** Preserve `importReviewMedia({request,signal,projectDir,outputFps,headers,controller,fileSystem,runMediaProcessImpl,statfsImpl,randomId,platform})` and `makeMediaFixtures(directory)`. Add fixture key `webm`; no committed media binaries.

- [x] Generate true JPEG and VP8/Opus WebM fixtures in temporary directories; write named subtests `real JPEG survives quarantine upload.bin` and `real WebM normalizes master and preview`.

```js
const files = makeMediaFixtures(directory);
const jpeg = await importFixture(files.jpeg, 'image/jpeg');
assert.equal(jpeg.metadata.mediaKind, 'image');
const video = await importFixture(files.webm, 'video/webm');
assert.equal(video.metadata.mediaKind, 'video');
assert.match(video.metadata.canonicalSha256, /^[a-f0-9]{64}$/);
```

- [x] Run `node --test tests/review-media-import.test.js` with working FFmpeg and record actual pre-fix failure. Do not confuse environment startup failure with code failure.
- [x] Audit JPEG detection and proxy scale/filter behavior on supported full FFmpeg. Both were already correct on 7.1.5 and 9.0.1; retain production code. The regression confirms declared extension cannot override probed bytes. Preserve owned quarantine names/recovery identities.
- [x] Run importer, media-probe, media-process, imported-assets and ownership tests. Check renamed video JPEG, overrun and quota failures stay closed.
- [x] Commit `test: cover real JPEG and WebM import`; report red/green counts and exact FFmpeg build. Completed as `7c9f234`: 77 importer tests and 196 focused tests pass; no production fix warranted because full FFmpeg 7.1.5/9.0.1 both pass. Historical reduced renderer FFmpeg lacks ingest filters.

### Task 2: Draft visual intent and command model

**Files:** Modify `schema/lesson-brief.schema.json`, `scripts/gen-brief.js`, `scripts/lesson/brief.js`, `scripts/project/workspace.js`, `scripts/review/commands.js`, `scripts/review/diff.js`; tests `tests/lesson-brief.test.js`, `tests/gen-brief.test.js`, `tests/review-commands.test.js`, `tests/broll-intent.test.js`; create `examples/broll-intent.scene.json`.

**Interfaces:** Scene `brollIntent={goal,sourceText,queryOriginal,queryEnglish,semanticDescription?}`: required strings 1–500 chars, query strings 1–200, no controls. Draft can contain intent alone or intent plus media; approved cannot contain intent. Top-level `brollReviewPolicy:'preview-required'` marks new discovery drafts and survives approval. `set-broll-query` command exact shape `{type,sceneIndex,queryOriginal,queryEnglish}` updates queries while retaining goal/sourceText. `replace-broll` keeps intent for subsequent search. Existing commands and local brollSrc remain supported.

- [x] Add failing schema/normalizer tests and command/diff tests.

```js
const draft = makeBrief({status:'draft', scenes:[pendingScene]});
assert.equal(validateLessonBrief(draft).ok, true);
assert.equal(validateLessonBrief({...draft,status:'approved'}).ok, false);
assert.equal(buildDraftPreviewProps({brief:draft}).scenes[0].scene,'broll');
assert.equal(normalizeSceneWithNoFile(pendingScene).scene,'broll');
```

- [x] Run named tests; expected failures are missing property and fallback split.
- [x] Implement bounded schema and draft guards. Normalizer preserves supplied intent; if B-roll requested without file, derive goal/sourceText from existing scene speech fields and an explicitly supplied query, rather than invent remote content. Update generation prompt to instruct current agent about English query.
- [x] Approval explicitly rejects unresolved intent before publication; approved copy strips resolved intent and validates `requireApproved:true`. Save preserves policy marker. Do not yet enforce full preview until task 7.
- [x] Extend diff allowlist with `broll-query`; commands remain exact-shape and protected source/theme/output unchanged. Add tests unknown fields, control chars, non-broll scene, selected intent preservation and denied approved pending.
- [x] Run `node --test tests/broll-intent.test.js tests/lesson-brief.test.js tests/gen-brief.test.js tests/review-commands.test.js tests/review-draft-save.test.js`; commit `feat: add draft broll search intent`.

Task 2 evidence: `a256140` plus review corrections `349f232`; 117 targeted tests pass. Reviewer findings corrected: no-file prompt now permits intent, partial intent derives only existing scene text with explicit queries, diff accepts only the two query fields.

### Task 3: Official provider, pinned transport and candidate allowlist

**Files:** Create `scripts/broll/remote.js`, `scripts/broll/pexels.js`, `scripts/broll/candidates.js`, `scripts/broll/config.js`; tests `tests/broll-remote.test.js`, `tests/broll-pexels.test.js`, `tests/broll-candidates.test.js`, `tests/broll-config.test.js`; create `scripts/broll/live-acceptance.js`.

**Interfaces:**
- `requestRemote({url,allowedHosts,headers,signal,maxBytes,timeoutMs,expectedMimeTypes,maxRedirects=3,lookup,requestImpl}) -> Promise<{bytes,contentType,url}>`; defaults use production HTTPS and DNS pinning. Test injection is explicit constructor dependency, never environment or browser parameter.
- `createPexelsProvider({apiKey,request=requestRemote}).search(search) -> Promise<{candidates,nextPage}>`; `search` matches spec fields, default page=1 and 12 results. Candidates hold provider/providerAssetId/sourcePage/author/license/queryOriginal/queryEnglish/retrievedAt/rendition/mediaKind/width/height/durationSec/hasAudio/thumbnailUrl/previewUrl/downloadUrl. Use documented official search paths.
- `createCandidateStore({ttlMs,maxEntries,now,randomId}).replace({sceneIndex,query,candidates}) -> {searchId,candidates}`; `.get({candidateId,searchId,sceneIndex})`, `.reject({candidateId,searchId})`, `.clear()`. Browser candidate output is allowlisted and media URLs are local proxy paths.
- `loadBrollConfig({env=process.env,root}) -> {provider,apiKey}` reads optional root `.env` without echo, override or export to browser. Missing key yields typed fixed `BROLL_KEY_MISSING`.

- [x] Create local HTTP mock contract server via injected transport and unit DNS/request doubles. Write hostile URL, IPv4/IPv6, redirect, timeout, partial/oversized stream, MIME and secret echo cases before code.

```js
await assert.rejects(requestRemote({url:'http://127.0.0.1/a',allowedHosts:['images.pexels.com']}), {code:'BROLL_REMOTE_REJECTED'});
await assert.rejects(provider.search(query), {code:'BROLL_KEY_MISSING'});
assert.equal(otherStore.get({candidateId:card.id,searchId,sceneIndex:0}), null);
assert.equal(JSON.stringify(browserCards).includes(secret), false);
```

- [x] Run tests, expect missing modules. Implement HTTPS allowlist, public DNS pinning and every-hop validation; cap API 2 MiB, thumbnail 5 MiB, preview 32 MiB, selected image 25 MiB/video 256 MiB. Reject compressed content, false length/truncation, credentialed URLs and response abort. Sanitize public/provider errors using fixed codes, never raw upstream message.
- [x] Normalize official photo/video fields, require public Pexels source/profile URLs and legal HTTPS rendition host; filter duration/resolution/orientation and preserve provider ranking, dedupe. Thumbnail and bounded preview must not fall back to full video.
- [x] Add opaque random session-scoped candidate IDs and per-scene generation expiry; server-only CDN URLs. Pagination, rejects, caps and fresh search invalidation tested.
- [x] Add live command that reports `SKIPPED: PEXELS_API_KEY is not configured` and exit 0 without key; with key perform free photo/video search/proxy and one explicitly chosen fixture acceptance, sanitized output, no automatic approval.
- [x] Run four test files; commit `feat: add secure pexels broll discovery`.

Task 3 evidence: `2e422b6`, `604bd6f`, `207e472`; 56 provider/provenance tests pass. Independent spec/quality/security re-review passes after Unicode/UTF-8 contract correction. Live Pexels remains skipped because no key is configured.

### Task 4: Immutable provenance and local text evidence

**Files:** Create `scripts/broll/text-scan.js`, `scripts/broll/provenance.js`; modify `scripts/review/imported-assets.js`, `scripts/review/media-import.js`, `scripts/review/assets.js`, `scripts/review/media-process.js`; tests `tests/review-media-process.test.js`, `tests/broll-text-scan.test.js`, `tests/broll-provenance.test.js`, existing metadata/import tests.

**Interfaces:** `scanEmbeddedText({filePath,mediaKind,durationSec,signal,run=runMediaProcess}) -> {status,text,reasons,engine}`; `hashTextScan(scan) -> sha256`; `validateProvenance(value)` and `browserProvenance(value)` explicit shape. Import gains optional server-only `provenance` and `scanEmbeddedTextImpl`; v3 only for discovery, manual v2 remains unchanged. Metadata v3 is exact v2 keys plus provenance/textScan; image preview hash remains null because same image is preview. Metadata limit increases only to a bounded 32 KiB if evidence requires it.

- [x] Add red roundtrip tests v1/v2/v3, malformed provenance URLs/control text, unknown fields, v3 audio duration, scan hashes and warnings.

```js
assert.equal(parseImportedAssetMetadata({bytes:v3Bytes,expectedId}).version,3);
assert.equal(hashTextScan(scan),hashTextScan(structuredClone(scan)));
assert.equal((await scanEmbeddedText({filePath:fixture,mediaKind:'image',run:missingTool})).status,'unavailable');
```

- [x] Implement bounded local Tesseract invocation and three evenly spaced video frame samples, shell-free, max output/time and abort. Stream frames through pipes or owned temporary context; no arbitrary user path output. Any recognized text -> needs-review; failures -> unavailable. No network/language download.
- [x] Scan normalized canonical bytes before immutable publication. Populate provenance from server candidate only; verify v3 fields and hashes on reread and expose display-safe summaries through both asset descriptor paths.
- [x] Add real generated text-image and video tests when local Tesseract available; missing-tool negative test always executes. Verify corrupt media still rejected, unsafe text escaped at UI later.
- [x] Run metadata/import/OCR suites; commit `feat: preserve broll provenance and text scan`.

Task 4 evidence: `47e48a5`, `40ed476`, `145e322`; 121 focused tests pass, affected cancellation rerun 84/84. Native Tesseract checked a generated image and three real video frames. Independent spec/quality/security re-review passes; hashes stay server-side and aborted OCR cannot publish an asset.

### Task 5: Review search/select integration and acknowledgement commands

**Files:** Create `scripts/review/broll-discovery.js`; modify `scripts/review/server.js`, `scripts/review/model.js`, `scripts/review/commands.js`, `scripts/review/diff.js`, `scripts/project/workspace.js`, `schema/lesson-brief.schema.json`, `scripts/lesson/broll-media-files.js`; tests `tests/broll-discovery.test.js`, `tests/broll-review-security.test.js`, `tests/broll-approval.test.js`.

**Interfaces:** `createBrollDiscovery({provider,store,download,importMedia,controller,...context})` owns session search/select/proxy; fixed routes in spec. Search/Select body carries baseRevision/baseHash/manifestHash; every async completion rechecks current snapshot and candidate generation. Selection returns `{assetId,state}`, UI queues ordinary replace-broll. Reuse import controller/shared project lease; route consumes bounded download bytes as exact-length stream into `importReviewMedia`, no separate filesystem staging.

`allow-broll-text` exact command `{type,sceneIndex,allowEmbeddedText}`; browser scene acknowledgement is boolean only; canonical scene `brollReview={assetSha256,scanSha256,allowEmbeddedText:true}` materialized from authoritative asset records at Save. Hashes never sent to browser. Replacement clears acknowledgement, Undo restores. Diff kind `embedded-text` captures decision without hashes. Imported metadata identity comparisons include provenance and textScan.

- [x] Write red mock E2E search -> proxy -> select -> import -> validate -> Save assertions. Search/proxy must produce zero full rendition requests; only selected rendition is downloaded.
- [x] Write security tests token/origin/read-only, spoofed/cross-session/expired ID, scene/query mismatch, upstream errors containing key, concurrent search replacement, Save/approval during import and stale snapshot after download.

```js
assert.equal((await readonly.post('/api/broll/search',body)).status,405);
assert.equal(fullDownloads,0);
assert.equal((await edit.post('/api/broll/select',selection)).status,201);
assert.equal(fullDownloads,1);
assert.equal(readCurrentBrief().status,'draft');
```

- [x] Implement routes using fixed errors and explicit display fields, no URL accepted in browser request. Proxy authenticated and edit-only; support browser range without unbounded remote transfer, permit local bounded byte slicing.
- [x] Add acknowledgement canonical/browser mapping and approval verification: unresolved intent, needs-review/unavailable without matching allowance, changed metadata/scan/hash all block before approved files are published.
- [x] Run new suites plus server-security/draft-save/project-mutation/compatibility tests; commit `feat: integrate broll candidate review workflow`.

Task 5 evidence: `f1a43f2`; 161 targeted tests pass. Independent spec/quality/security review passes after bounded proxy FIFO, per-candidate cancellation, stale OCR generation abort and changed-scan identity regressions.

### Task 6: Candidate shelf UI and browser E2E

**Files:** Create `review/broll-discovery.js`; modify `review/app.js`, `review/index.html`, `review/styles.css`, `scripts/review/server.js` static allowlist only; create `tests/broll-review-ui.spec.js`; change `package.json` test:review-ui and `playwright.config.js` testMatch to include both specs; tests fixtures in `tests/helpers/broll-review-project.js`.

**Interfaces:** `createBrollDiscoveryUI({request,getState,queueCommand,refresh,setBusy,reportError})` renders for each broll scene. English/original query fields read scene intent; tabs `Видео`/`Фото`; orientation/minimum duration/minimum width/height controls; actions `Подобрать B-roll`, `Выбрать`, `Не подходит`, `Ещё варианты`. Existing fit/start/used interval/audio controls remain.

- [x] Write failing Playwright mock-backend tests for pending scenes, tabs/filter request, 6–12 accessible cards, attribution/source/license, proxy video playback, selects only clicked ID, rejection/more, missing-key notice, read-only controls absent.
- [x] Implement shelf with DOM textContent for all untrusted strings; validated public links use noopener/noreferrer. No CDN URLs in DOM/network; thumbnails and video previews authenticated local proxies. Maintain per-scene selection/busy and surface conflict without silently rebasing.
- [x] Show recognized OCR text and `Разрешить встроенный текст`; clear assets have no extra approval. Existing selected video remains default mute, fit and start change only command queue.
- [x] Test malicious provider text markup inert, portrait/mobile layout, keyboard access, failed import retains previous selection, upload manual flow and undo/redo/save.
- [x] Run `npm run test:review-ui`; commit `feat: add broll search shelf to review`.

Task 6 evidence: `7025b27`, `c50a68f`; 53 full browser tests and 8 focused tests after query/base shelf invalidation pass. Independent re-review passes. Root inspected desktop/mobile fixture screenshots.

### Task 7: Genuine preview gate and explicit approval

**Files:** Modify `scripts/preview.js`, `scripts/project/preview-workspace.js`, `scripts/project/workspace.js`, `scripts/project/approve-brief.js`, `schema/project.schema.json`, `schema/lesson-brief.schema.json`, `scripts/lesson/brief.js`, `scripts/review/server.js`, `scripts/review/model.js`, `review/app.js`, `review/styles.css`; create `scripts/review/preview-jobs.js`, `tests/broll-preview-approval.test.js`, `tests/broll-preview-e2e.test.js`.

**Interfaces:** Published currentPreview adds optional `briefSha256` and `sourceSha256`. New discovery `brollReviewPolicy:'preview-required'` needs matching full preview bytes, brief bytes, source/output and full range before approveBrief. `approveBrief(...,{confirmPreviewViewed:false,expectedPreviewSha256})` requires explicit true for discovery and expected matching hash if supplied. Approved brief `brollApproval={draftSha256,previewSha256,confirmedAt}` records gate receipt; final validator requires it whenever policy marker exists. Approved copies remove brollIntent; legacy approved briefs unaffected.

Final review refinement: verify discovery provenance from opened v3 metadata in `scripts/lesson/broll-media-files.js` instead of trusting only optional intent/policy markers. Approval infers the gate from verified media; `scripts/build.js` rejects approved v3 media without policy/receipt before rendering. Add v3-negative and v2-positive cases in `tests/broll-approval.test.js`. After all slow hashes, recheck every opened preview/source/media/metadata descriptor and path snapshot, including size/mtime/ctime, immediately before transaction publication. Regressions cover an earlier preview changed during a later source hash and reset of receipt after an approved brief is edited. Genuine E2E includes unresolved placeholder preview before selection.

Edit-only `POST /api/broll/preview` accepts base snapshot and `{kind:'full'|'excerpt',sceneIndex}`; starts shell-free child `node scripts/preview.js --project-dir ... --brief <current-registered-draft> --no-open` with fixed validated excerpt times, returns opaque job ID; `GET /api/broll/preview-job` polls bounded status and refreshed state. Actual CLI remains sole renderer. `POST /api/broll/approve` requires current base snapshot, full preview and `confirmPreviewViewed:true`; never final-render. UI offers preview buttons after Save and explicit full-view checkbox/approval. Read-only only plays existing preview. Changed draft makes previous preview visibly stale.

- [x] Write red tests pending -> reject, excerpt -> reject, stale/full hash replacement -> reject, current full plus explicit confirmation -> approve, no automatic approval, failed job preserves previous preview and process abort on server close.
- [x] Implement gate under existing project lease with rechecks at publication. Hash the exact draft bytes parsed for rendering in `runPreview`, carry that snapshot through plan/publication, reject any later byte change. Preview job revalidates base before launch/publication; Save/approval races fail conflict with immutable old state preserved.
- [x] Add real tiny fixture E2E: selected normalized video -> Save -> real excerpt Remotion -> real full Remotion -> explicit approval -> approved-only actual final render -> ffmpeg full decode. Use neutral source and public lesson-neutral theme; no capture-mode stand-in for genuine E2E.
- [x] Run preview/approval/transaction tests and focused Playwright flow; commit `feat: require full preview before broll approval`.

Task 7 evidence: `e90ee58`; 258 focused tests pass. Genuine pending-placeholder → selection/import → excerpt/full Remotion → played preview → explicit approval → final decode → re-edit invalidation passes. Root full Node run: 1012 total, 1009 pass, 0 fail, 3 deliberately deferred real-render tests. Confirmed v3 marker and late-hash review findings are covered by regressions.

### Task 8: Benchmark, documentation and release readiness

**Files:** Create `scripts/broll/benchmark-openclip.py`, `docs/research/2026-09-08-broll-reranking-benchmark.md`; modify `README.md`, `AGENTS.md`, `ARCHITECTURE.md`, `docs/REVIEW-WORKBENCH.md`, `docs/SCENE-CATALOG.md`, `docs/TEMPLATES.md`, `TESTING.md`, `DECISIONS.md`, `CHANGELOG.md`, `.env.example`, `.npmignore`, `.github/workflows/ci.yml`, current spec/plan.

**Interfaces:** Benchmark has deterministic corpus manifest/relevance labels, provider-order vs OpenCLIP top-5 metric and dependency/runtime measurements. Optional deps isolated outside normal npm installation. Env fields exactly BROLL_SEARCH_PROVIDER/PEXELS_API_KEY and reserved PIXABAY_API_KEY/OPENVERSE_CLIENT_ID/OPENVERSE_CLIENT_SECRET; no real .env committed. `node scripts/broll/live-acceptance.js` reports precise skip without configured key.

**Security audit refinement:** Installed Remotion automatically imports every key from root `.env` into its rendering browser. Fix the central resolved CLI/command boundary in `scripts/env.js`, `scripts/build-commands.js`, `scripts/render-chunks.js` as required, with a trusted comment-only `config/remotion-public.env` and regression `tests/broll-render-env-security.test.js`; do not create a real root `.env`. All preview/final/still/chunk paths must explicitly select the safe env file. Preserve legitimate `REMOTION_*` inputs; provider credentials never enter browser env. Preview job children omit provider credentials as well. This is required by the existing key-isolation spec, not a change to the approved product architecture.

- [x] Run small reproducible experiment; verify code/weights licenses, record cold/warm timing, weights/dependency bytes and peak RSS; default provider order unless clear benefit demonstrated. Alternative-provider corpus is explicitly exploratory, never Pexels live evidence.
- [x] Document Russian human walkthrough from obtaining a free Pexels key/local .env to draft, search, preview candidate, selection/settings, OCR acknowledgement, Save, excerpt/full preview, explicit approval and final render. Explain current API limits/credit obligations with official links and no secret values.
- [x] Configure CI to run new Node tests automatically, both browser specs and real-media dependencies; verify no paid/live provider calls in CI.
- [x] Reproduce Remotion dotenv leakage with a synthetic secret in a temporary fixture project, then prove the installed CLI environment loader excludes it with explicit safe env selection. Test all command builders and provider-key stripping in child spawn options; rerun actual preview/final acceptance after the command change.
- [x] Independent task compliance/quality and branch security review (scope and limitation recorded below). Fix actionable findings with regression tests; rerun affected tests.
- [ ] Run `npm test`, `npm run doctor`, `npm run demo`, `npm run test:review-ui`, available package checks, `npm pack --dry-run`, privacy checks, Gitleaks and precommit hook. Capture exact passed/failed/skipped and reasons; no claimed success from exit code alone.
- [ ] Check diff against base for credentials, personal absolute paths, media and .env. Mark completed steps with evidence, commit documentation logically, leave clean branch/worktree intact, open branch review. Do not push.

Task 8 benchmark evidence: `cb418e3`; 16 stdlib-only tests pass after independent duplicate-label validation review. Two offline CPU reruns on 57 local thumbnails reproduce every score and rank exactly; public text artifacts and pinned recovery instructions are committed without images or model weights. Live acceptance v3 wiring: `28926cd`, 19 focused tests pass and independent review passes.

Final rendition review: `0e8d6f0` fixes the default no-filter video query. It selects the largest rendition within local importer limits and retains a distinct smaller preview. Two red tests reproduce the prior minimum-rendition/no-preview problem and unsupported geometry/duration; 16 provider/store/provenance tests and an actual provider-normalizer-to-browser-play test pass. Independent code-quality re-review passes.

## Self-audit before implementation

| Boundary | Producer/consumer | Audit result |
|---|---|---|
| 1 → 4 → 5 | importReviewMedia plus optional provenance | Preserves raw manual import and controller/lease; remote buffer only selected file |
| 2 → 5 → 6 | intent/query command and diff | queryOriginal/queryEnglish match, hashes kept server-side |
| 3 → 5 → 6 | provider candidates/store/display | opaque candidate IDs distinct from imported asset-N IDs |
| 4 → 5 → 7 | textScan + hash-bound brollReview | immutable evidence; user allowance belongs to selection metadata |
| 2 → 7 | brollReviewPolicy persists | resolved intent stripping cannot erase preview requirement |
| 7 → 6 | async real preview job/state | UI integration serialized after core UI ownership is released |
| 1–8 | each task fixtures, exact APIs, failing cases | No unrelated refactor; legacy behavior tested at each integration |

All spec areas have tasks. New approved policy/receipt applies only discovery workflow; legacy approved projects remain valid. Implementation may refine exact helper filenames after code audit; report and synchronize changes to this plan before dependent dispatch.

## Final review scope

Independent spec/code-quality review passes, including the final `e90ee58` receipt/provenance/common-barrier changes. Component-level transport/provider/import/UI security reviews passed. A fresh broader independent security audit confirmed two approval issues, then its turn was stopped by the platform automatic cybersecurity content filter; that blocked probing was not retried. The confirmed v3-marker and late-hash findings were fixed with regressions and reviewed by the main agent; a subsequent independent code-only correctness review passed. Do not describe the interrupted broader audit as a completed independent security sign-off. Root verification covers the implemented security contracts through the full regression suite and ordinary code inspection.

Current local acceptance: full Node 1009 pass/0 fail/3 dedicated-render skips; complete Playwright 56 pass/0 fail/0 skip; the three dedicated real-render E2Es pass separately with 0 skips. Pexels live acceptance remains `SKIPPED: PEXELS_API_KEY is not configured`. No live Pexels search is claimed.
