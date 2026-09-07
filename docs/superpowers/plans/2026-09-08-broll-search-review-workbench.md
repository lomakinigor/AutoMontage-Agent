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

- [ ] Generate true JPEG and VP8/Opus WebM fixtures in temporary directories; write named subtests `real JPEG survives quarantine upload.bin` and `real WebM normalizes master and preview`.

```js
const files = makeMediaFixtures(directory);
const jpeg = await importFixture(files.jpeg, 'image/jpeg');
assert.equal(jpeg.metadata.mediaKind, 'image');
const video = await importFixture(files.webm, 'video/webm');
assert.equal(video.metadata.mediaKind, 'video');
assert.match(video.metadata.canonicalSha256, /^[a-f0-9]{64}$/);
```

- [ ] Run `node --test tests/review-media-import.test.js` with working FFmpeg and record actual pre-fix failure. Do not confuse environment startup failure with code failure.
- [ ] Correct JPEG detection at the exact probe boundary (use declared validated extension only to disambiguate a verified still codec, never trust extension instead of bytes). Correct compatible proxy scale/filter expressions. Preserve owned quarantine names/recovery identities.
- [ ] Run importer, media-probe, media-process, imported-assets and ownership tests. Check renamed video JPEG, overrun and quota failures stay closed.
- [ ] Commit `fix: harden real media import`; report red/green counts and exact FFmpeg build.

### Task 2: Draft visual intent and command model

**Files:** Modify `schema/lesson-brief.schema.json`, `scripts/gen-brief.js`, `scripts/lesson/brief.js`, `scripts/project/workspace.js`, `scripts/review/commands.js`, `scripts/review/diff.js`; tests `tests/lesson-brief.test.js`, `tests/gen-brief.test.js`, `tests/review-commands.test.js`, `tests/broll-intent.test.js`; create `examples/broll-intent.scene.json`.

**Interfaces:** Scene `brollIntent={goal,sourceText,queryOriginal,queryEnglish,semanticDescription?}`: required strings 1–500 chars, query strings 1–200, no controls. Draft can contain intent alone or intent plus media; approved cannot contain intent. Top-level `brollReviewPolicy:'preview-required'` marks new discovery drafts and survives approval. `set-broll-query` command exact shape `{type,sceneIndex,queryOriginal,queryEnglish}` updates queries while retaining goal/sourceText. `replace-broll` keeps intent for subsequent search. Existing commands and local brollSrc remain supported.

- [ ] Add failing schema/normalizer tests and command/diff tests.

```js
const draft = makeBrief({status:'draft', scenes:[pendingScene]});
assert.equal(validateLessonBrief(draft).ok, true);
assert.equal(validateLessonBrief({...draft,status:'approved'}).ok, false);
assert.equal(buildDraftPreviewProps({brief:draft}).scenes[0].scene,'broll');
assert.equal(normalizeSceneWithNoFile(pendingScene).scene,'broll');
```

- [ ] Run named tests; expected failures are missing property and fallback split.
- [ ] Implement bounded schema and draft guards. Normalizer preserves supplied intent; if B-roll requested without file, derive goal/sourceText from existing scene speech fields and an explicitly supplied query, rather than invent remote content. Update generation prompt to instruct current agent about English query.
- [ ] Approval explicitly rejects unresolved intent before publication; approved copy strips resolved intent and validates `requireApproved:true`. Save preserves policy marker. Do not yet enforce full preview until task 7.
- [ ] Extend diff allowlist with `broll-query`; commands remain exact-shape and protected source/theme/output unchanged. Add tests unknown fields, control chars, non-broll scene, selected intent preservation and denied approved pending.
- [ ] Run `node --test tests/broll-intent.test.js tests/lesson-brief.test.js tests/gen-brief.test.js tests/review-commands.test.js tests/review-draft-save.test.js`; commit `feat: add draft broll search intent`.

### Task 3: Official provider, pinned transport and candidate allowlist

**Files:** Create `scripts/broll/remote.js`, `scripts/broll/pexels.js`, `scripts/broll/candidates.js`, `scripts/broll/config.js`; tests `tests/broll-remote.test.js`, `tests/broll-pexels.test.js`, `tests/broll-candidates.test.js`, `tests/broll-config.test.js`; create `scripts/broll/live-acceptance.js`.

**Interfaces:**
- `requestRemote({url,allowedHosts,headers,signal,maxBytes,timeoutMs,expectedMimeTypes,maxRedirects=3,lookup,requestImpl}) -> Promise<{bytes,contentType,url}>`; defaults use production HTTPS and DNS pinning. Test injection is explicit constructor dependency, never environment or browser parameter.
- `createPexelsProvider({apiKey,request=requestRemote}).search(search) -> Promise<{candidates,nextPage}>`; `search` matches spec fields, default page=1 and 12 results. Candidates hold provider/providerAssetId/sourcePage/author/license/queryOriginal/queryEnglish/retrievedAt/rendition/mediaKind/width/height/durationSec/hasAudio/thumbnailUrl/previewUrl/downloadUrl. Use documented official search paths.
- `createCandidateStore({ttlMs,maxEntries,now,randomId}).replace({sceneIndex,query,candidates}) -> {searchId,candidates}`; `.get({candidateId,searchId,sceneIndex})`, `.reject({candidateId,searchId})`, `.clear()`. Browser candidate output is allowlisted and media URLs are local proxy paths.
- `loadBrollConfig({env=process.env,root}) -> {provider,apiKey}` reads optional root `.env` without echo, override or export to browser. Missing key yields typed fixed `BROLL_KEY_MISSING`.

- [ ] Create local HTTP mock contract server via injected transport and unit DNS/request doubles. Write hostile URL, IPv4/IPv6, redirect, timeout, partial/oversized stream, MIME and secret echo cases before code.

```js
await assert.rejects(requestRemote({url:'http://127.0.0.1/a',allowedHosts:['images.pexels.com']}), {code:'BROLL_REMOTE_REJECTED'});
await assert.rejects(provider.search(query), {code:'BROLL_KEY_MISSING'});
assert.equal(otherStore.get({candidateId:card.id,searchId,sceneIndex:0}), null);
assert.equal(JSON.stringify(browserCards).includes(secret), false);
```

- [ ] Run tests, expect missing modules. Implement HTTPS allowlist, public DNS pinning and every-hop validation; cap API 2 MiB, thumbnail 5 MiB, preview 32 MiB, selected image 25 MiB/video 256 MiB. Reject compressed content, false length/truncation, credentialed URLs and response abort. Sanitize public/provider errors using fixed codes, never raw upstream message.
- [ ] Normalize official photo/video fields, require public Pexels source/profile URLs and legal HTTPS rendition host; filter duration/resolution/orientation and preserve provider ranking, dedupe. Thumbnail and bounded preview must not fall back to full video.
- [ ] Add opaque random session-scoped candidate IDs and per-scene generation expiry; server-only CDN URLs. Pagination, rejects, caps and fresh search invalidation tested.
- [ ] Add live command that reports `SKIPPED: PEXELS_API_KEY is not configured` and exit 0 without key; with key perform free photo/video search/proxy and one explicitly chosen fixture acceptance, sanitized output, no automatic approval.
- [ ] Run four test files; commit `feat: add secure pexels broll discovery`.

### Task 4: Immutable provenance and local text evidence

**Files:** Create `scripts/broll/text-scan.js`, `scripts/broll/provenance.js`; modify `scripts/review/imported-assets.js`, `scripts/review/media-import.js`, `scripts/review/assets.js`; tests `tests/broll-text-scan.test.js`, `tests/broll-provenance.test.js`, existing metadata/import tests.

**Interfaces:** `scanEmbeddedText({filePath,mediaKind,durationSec,signal,run=runMediaProcess}) -> {status,text,reasons,engine}`; `hashTextScan(scan) -> sha256`; `validateProvenance(value)` and `browserProvenance(value)` explicit shape. Import gains optional server-only `provenance` and `scanEmbeddedTextImpl`; v3 only for discovery, manual v2 remains unchanged. Metadata v3 is exact v2 keys plus provenance/textScan; image preview hash remains null because same image is preview. Metadata limit increases only to a bounded 32 KiB if evidence requires it.

- [ ] Add red roundtrip tests v1/v2/v3, malformed provenance URLs/control text, unknown fields, v3 audio duration, scan hashes and warnings.

```js
assert.equal(parseImportedAssetMetadata({bytes:v3Bytes,expectedId}).version,3);
assert.equal(hashTextScan(scan),hashTextScan(structuredClone(scan)));
assert.equal((await scanEmbeddedText({filePath:fixture,mediaKind:'image',run:missingTool})).status,'unavailable');
```

- [ ] Implement bounded local Tesseract invocation and three evenly spaced video frame samples, shell-free, max output/time and abort. Stream frames through pipes or owned temporary context; no arbitrary user path output. Any recognized text -> needs-review; failures -> unavailable. No network/language download.
- [ ] Scan normalized canonical bytes before immutable publication. Populate provenance from server candidate only; verify v3 fields and hashes on reread and expose display-safe summaries through both asset descriptor paths.
- [ ] Add real generated text-image and video tests when local Tesseract available; missing-tool negative test always executes. Verify corrupt media still rejected, unsafe text escaped at UI later.
- [ ] Run metadata/import/OCR suites; commit `feat: preserve broll provenance and text scan`.

### Task 5: Review search/select integration and acknowledgement commands

**Files:** Create `scripts/review/broll-discovery.js`; modify `scripts/review/server.js`, `scripts/review/model.js`, `scripts/review/commands.js`, `scripts/review/diff.js`, `scripts/project/workspace.js`, `schema/lesson-brief.schema.json`, `scripts/lesson/media-validation.js` if that is the authoritative verifier discovered by audit; tests `tests/broll-discovery.test.js`, `tests/broll-review-security.test.js`, `tests/broll-approval.test.js`.

**Interfaces:** `createBrollDiscovery({provider,store,download,importMedia,controller,...context})` owns session search/select/proxy; fixed routes in spec. Search/Select body carries baseRevision/baseHash/manifestHash; every async completion rechecks current snapshot and candidate generation. Selection returns `{assetId,state}`, UI queues ordinary replace-broll. Reuse import controller/shared project lease; route consumes bounded download bytes as exact-length stream into `importReviewMedia`, no separate filesystem staging.

`allow-broll-text` exact command `{type,sceneIndex,allowEmbeddedText}`; browser scene acknowledgement is boolean only; canonical scene `brollReview={assetSha256,scanSha256,allowEmbeddedText:true}` materialized from authoritative asset records at Save. Hashes never sent to browser. Replacement clears acknowledgement, Undo restores. Diff kind `embedded-text` captures decision without hashes. Imported metadata identity comparisons include provenance and textScan.

- [ ] Write red mock E2E search -> proxy -> select -> import -> validate -> Save assertions. Search/proxy must produce zero full rendition requests; only selected rendition is downloaded.
- [ ] Write security tests token/origin/read-only, spoofed/cross-session/expired ID, scene/query mismatch, upstream errors containing key, concurrent search replacement, Save/approval during import and stale snapshot after download.

```js
assert.equal((await readonly.post('/api/broll/search',body)).status,405);
assert.equal(fullDownloads,0);
assert.equal((await edit.post('/api/broll/select',selection)).status,201);
assert.equal(fullDownloads,1);
assert.equal(readCurrentBrief().status,'draft');
```

- [ ] Implement routes using fixed errors and explicit display fields, no URL accepted in browser request. Proxy authenticated and edit-only; support browser range without unbounded remote transfer, permit local bounded byte slicing.
- [ ] Add acknowledgement canonical/browser mapping and approval verification: unresolved intent, needs-review/unavailable without matching allowance, changed metadata/scan/hash all block before approved files are published.
- [ ] Run new suites plus server-security/draft-save/project-mutation/compatibility tests; commit `feat: integrate broll candidate review workflow`.

### Task 6: Candidate shelf UI and browser E2E

**Files:** Create `review/broll-discovery.js`; modify `review/app.js`, `review/index.html`, `review/styles.css`, `scripts/review/server.js` static allowlist only; create `tests/broll-review-ui.spec.js`; change `package.json` test:review-ui to include both specs; tests fixtures in `tests/helpers/broll-review-project.js`.

**Interfaces:** `createBrollDiscoveryUI({request,getState,queueCommand,refresh,setBusy,reportError})` renders for each broll scene. English/original query fields read scene intent; tabs `Видео`/`Фото`; orientation/minimum duration/minimum width/height controls; actions `Подобрать B-roll`, `Выбрать`, `Не подходит`, `Ещё варианты`. Existing fit/start/used interval/audio controls remain.

- [ ] Write failing Playwright mock-backend tests for pending scenes, tabs/filter request, 6–12 accessible cards, attribution/source/license, proxy video playback, selects only clicked ID, rejection/more, missing-key notice, read-only controls absent.
- [ ] Implement shelf with DOM textContent for all untrusted strings; validated public links use noopener/noreferrer. No CDN URLs in DOM/network; thumbnails and video previews authenticated local proxies. Maintain per-scene selection/busy and surface conflict without silently rebasing.
- [ ] Show recognized OCR text and `Разрешить встроенный текст`; clear assets have no extra approval. Existing selected video remains default mute, fit and start change only command queue.
- [ ] Test malicious provider text markup inert, portrait/mobile layout, keyboard access, failed import retains previous selection, upload manual flow and undo/redo/save.
- [ ] Run `npm run test:review-ui`; commit `feat: add broll search shelf to review`.

### Task 7: Genuine preview gate and explicit approval

**Files:** Modify `scripts/project/preview-workspace.js`, `scripts/project/workspace.js`, `scripts/project/approve-brief.js`, `schema/project.schema.json` (verify actual manifest schema filename), `schema/lesson-brief.schema.json`, `scripts/lesson/brief.js`, `scripts/review/server.js`, `scripts/review/model.js`, `review/app.js`; create `scripts/review/preview-jobs.js`, `tests/broll-preview-approval.test.js`, `tests/broll-preview-e2e.test.js`.

**Interfaces:** Published currentPreview adds optional `briefSha256`. New discovery `brollReviewPolicy:'preview-required'` needs matching full preview bytes, brief bytes, source/output and full range before approveBrief. `approveBrief(...,{confirmPreviewViewed:false,expectedPreviewSha256})` requires explicit true for discovery and expected matching hash if supplied. Approved brief `brollApproval={draftSha256,previewSha256,confirmedAt}` records gate receipt; final validator requires it whenever policy marker exists. Approved copies remove brollIntent; legacy approved briefs unaffected.

Edit-only `POST /api/broll/preview` accepts base snapshot and `{kind:'full'|'excerpt',sceneIndex}`; starts shell-free child `node scripts/preview.js --project-dir ... --no-open` with fixed validated excerpt times, returns opaque job ID; `GET /api/broll/preview-job` polls bounded status and refreshed state. Actual CLI remains sole renderer. `POST /api/broll/approve` requires current base snapshot, full preview and `confirmPreviewViewed:true`; never final-render. UI offers preview buttons after Save and explicit full-view checkbox/approval. Read-only only plays existing preview. Changed draft makes previous preview visibly stale.

- [ ] Write red tests pending -> reject, excerpt -> reject, stale/full hash replacement -> reject, current full plus explicit confirmation -> approve, no automatic approval, failed job preserves previous preview and process abort on server close.
- [ ] Implement gate under existing project lease with rechecks at publication. Preview job revalidates base before launch/publication; Save/approval races fail conflict with immutable old state preserved.
- [ ] Add real tiny fixture E2E: selected normalized video -> Save -> real excerpt Remotion -> real full Remotion -> explicit approval -> approved-only actual final render -> ffmpeg full decode. Use neutral source and public lesson-neutral theme; no capture-mode stand-in for genuine E2E.
- [ ] Run preview/approval/transaction tests and focused Playwright flow; commit `feat: require full preview before broll approval`.

### Task 8: Benchmark, documentation and release readiness

**Files:** Create `scripts/broll/benchmark-openclip.py`, `docs/research/2026-09-08-broll-reranking-benchmark.md`; modify `README.md`, `ARCHITECTURE.md`, `docs/REVIEW-WORKBENCH.md`, `docs/TEMPLATES.md`, `TESTING.md`, `DECISIONS.md`, `CHANGELOG.md`, `.env.example`, `.github/workflows/ci.yml`, current spec/plan.

**Interfaces:** Benchmark has deterministic corpus manifest/relevance labels, provider-order vs OpenCLIP top-5 metric and dependency/runtime measurements. Optional deps isolated outside normal npm installation. Env fields exactly BROLL_SEARCH_PROVIDER/PEXELS_API_KEY and reserved PIXABAY_API_KEY/OPENVERSE_CLIENT_ID/OPENVERSE_CLIENT_SECRET; no real .env committed. `node scripts/broll/live-acceptance.js` reports precise skip without configured key.

- [ ] Run small reproducible experiment; verify code/weights licenses, record cold/warm timing, weights/dependency bytes and peak RSS; default provider order unless clear benefit demonstrated. Alternative-provider corpus is explicitly exploratory, never Pexels live evidence.
- [ ] Document Russian human walkthrough from obtaining a free Pexels key/local .env to draft, search, preview candidate, selection/settings, OCR acknowledgement, Save, excerpt/full preview, explicit approval and final render. Explain current API limits/credit obligations with official links and no secret values.
- [ ] Configure CI to run new Node tests automatically, both browser specs and real-media dependencies; verify no paid/live provider calls in CI.
- [ ] Independent task compliance/quality and full branch security review. Fix actionable findings with regression tests; rerun affected tests.
- [ ] Run `npm test`, `npm run doctor`, `npm run demo`, `npm run test:review-ui`, available package checks, `npm pack --dry-run`, privacy checks, Gitleaks and precommit hook. Capture exact passed/failed/skipped and reasons; no claimed success from exit code alone.
- [ ] Check diff against base for credentials, personal absolute paths, media and .env. Mark completed steps with evidence, commit documentation logically, leave clean branch/worktree intact, open branch review. Do not push.

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
