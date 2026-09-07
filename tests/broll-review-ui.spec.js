const { test, expect } = require('playwright/test');
const { mockBrollReview } = require('./helpers/broll-review-project');
const { createPexelsProvider } = require('../scripts/broll/pexels');
const { createCandidateStore } = require('../scripts/broll/candidates');
let fixture;
test.afterEach(async () => { if (fixture) await fixture.close(); fixture = null; });
async function open(page, options) { fixture = await mockBrollReview(options); await page.goto(fixture.url); await expect(page.locator('[data-review-ready]')).toBeVisible(); }
test('default Pexels normalization yields a playable local candidate before selection', async ({ page }) => {
  const provider = createPexelsProvider({ apiKey: 'fixture-api-secret', request: async () => ({
    bytes: Buffer.from(JSON.stringify({ videos: [{
      id: 91, width: 1920, height: 1080, duration: 4,
      url: 'https://www.pexels.com/video/forest-91/',
      user: { name: 'Fixture Author', url: 'https://www.pexels.com/@fixture' },
      image: 'https://images.pexels.com/photos/91/tiny.jpg',
      video_files: [
        { id: 911, width: 1920, height: 1080, file_type: 'video/mp4', link: 'https://videos.pexels.com/video-files/91/full.mp4' },
        { id: 912, width: 640, height: 360, file_type: 'video/mp4', link: 'https://videos.pexels.com/video-files/91/small.mp4' },
      ],
    }] })),
  }) });
  const query = { queryOriginal: 'лес', queryEnglish: 'forest walk', mediaKind: 'video' };
  const found = await provider.search(query);
  const shelf = createCandidateStore().replace({ sceneIndex: 0, query, candidates: found.candidates });
  await open(page);
  fixture.cards.splice(0, fixture.cards.length, ...shelf.candidates);
  await page.getByRole('button', { name: 'Подобрать B-roll', exact: true }).click();
  const video = page.locator('[data-broll-candidate] video');
  await expect(video).toHaveCount(1);
  await expect(video).toHaveAttribute('src', /\/media\/broll-candidate\/[a-f0-9]+\/preview\?token=/);
  await video.evaluate(element => element.play());
  await expect.poll(() => video.evaluate(element => element.currentTime)).toBeGreaterThan(0);
  expect(found.candidates[0].width).toBe(1920);
  expect(fixture.calls.filter(call => call.pathname === '/api/broll/select')).toHaveLength(0);
});
test('pending intent searches bounded safe cards, rejects and pages; selects only opaque clicked ID', async ({ page }) => {
  await open(page);
  await expect(page.getByText('Мы идём по лесу', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Подобрать B-roll', exact: true }).click();
  await expect(page.locator('[data-broll-candidate]')).toHaveCount(12);
  await expect(page.locator('[data-broll-candidate] img[src="x"]')).toHaveCount(0);
  await expect(page.getByText('<img src=x onerror=alert(1)>', { exact: true })).toBeVisible();
  await expect(page.locator('[data-broll-candidate] a').first()).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(page.locator('[data-broll-candidate] video').first()).toHaveAttribute('src', /\/media\/broll-candidate\/candidate_.*\/preview\?token=test-token/);
  await page.getByRole('button', { name: 'Не подходит', exact: true }).first().click();
  await expect(page.locator('[data-broll-candidate]')).toHaveCount(11);
  await page.getByRole('button', { name: 'Ещё варианты', exact: true }).click();
  await expect(page.locator('[data-broll-candidate]')).toHaveCount(12);
  await page.getByRole('button', { name: 'Выбрать', exact: true }).nth(2).click();
  await expect(page.locator('[data-broll-select]')).toHaveValue('asset-1');
  const selection = fixture.calls.find(c => c.pathname === '/api/broll/select').data;
  expect(selection.candidateId).toBe(fixture.cards[2].id);
  expect(Object.keys(selection).sort()).toEqual(['baseHash', 'baseRevision', 'candidateId', 'manifestHash', 'sceneIndex', 'searchId'].sort());
});
test('photo tab and filters, loading, missing key and read-only', async ({ page }) => {
  await open(page); fixture.settings.delay = 150;
  await page.getByRole('tab', { name: 'Фото', exact: true }).click();
  await page.getByLabel('Ориентация', { exact: true }).selectOption('portrait');
  await page.getByLabel('Минимальная ширина', { exact: true }).fill('800');
  await page.getByLabel('Минимальная высота', { exact: true }).fill('1200');
  await page.getByRole('button', { name: 'Подобрать B-roll', exact: true }).click();
  await expect(page.getByText('Ищем варианты…', { exact: true })).toBeVisible();
  await expect(page.locator('[data-broll-candidate]')).toHaveCount(12);
  expect(fixture.calls[0].data).toMatchObject({ mediaKind: 'image', orientation: 'portrait', minWidth: 800, minHeight: 1200 });
  fixture.settings.missingKey = true;
  await page.getByRole('button', { name: 'Подобрать B-roll', exact: true }).click();
  await expect(page.getByText(/PEXELS_API_KEY.*локальн.*\.env/)).toBeVisible();
  await fixture.close(); fixture = null;
  await open(page, { editable: false });
  await expect(page.getByRole('button', { name: 'Подобрать B-roll', exact: true })).toHaveCount(0);
});
test('query and text acknowledgement participate in undo redo save; failed selection retains media', async ({ page }) => {
  await open(page);
  await page.getByLabel('Запрос на английском', { exact: true }).fill('green forest');
  await page.getByLabel('Запрос на английском', { exact: true }).press('Tab');
  await expect(page.locator('[data-edit-status]')).toHaveText('Изменений: 1');
  expect(fixture.calls[0].data.commands[0]).toEqual({ type: 'set-broll-query', sceneIndex: 0, queryOriginal: 'лес', queryEnglish: 'green forest' });
  await page.getByRole('button', { name: 'Отменить', exact: true }).click();
  await expect(page.getByLabel('Запрос на английском', { exact: true })).toHaveValue('forest walk');
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(page.getByLabel('Запрос на английском', { exact: true })).toHaveValue('green forest');
  await page.getByRole('button', { name: 'Подобрать B-roll', exact: true }).click();
  await page.getByRole('button', { name: 'Выбрать', exact: true }).first().click();
  await page.getByLabel('Разрешить встроенный текст', { exact: true }).check();
  await expect(page.locator('[data-edit-status]')).toHaveText('Изменений: 3');
  await page.getByRole('button', { name: 'Отменить', exact: true }).click();
  await expect(page.getByLabel('Разрешить встроенный текст', { exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(page.getByLabel('Разрешить встроенный текст', { exact: true })).toBeChecked();
  fixture.settings.failSelect = true;
  await page.getByRole('button', { name: 'Выбрать', exact: true }).nth(1).click();
  await expect(page.getByText(/Не удалось выбрать/)).toBeVisible();
  await expect(page.locator('[data-broll-select]')).toHaveValue('asset-1');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.locator('[data-edit-status]')).toHaveText('Изменений нет');
});
test('mobile keyboard search has no page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await open(page);
  await page.getByRole('button', { name: 'Подобрать B-roll', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-broll-candidate]')).toHaveCount(12);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
test('search busy conflict preserves query and redo; source playhead survives discovery and only local media loads', async ({ page }) => {
  await open(page);
  const remote = [];
  page.on('request', request => { if (new URL(request.url()).origin !== new URL(fixture.url).origin) remote.push(request.url()); });
  await page.getByLabel('Запрос на английском', { exact: true }).fill('new forest');
  await page.getByLabel('Запрос на английском', { exact: true }).press('Tab');
  await expect(page.locator('[data-edit-status]')).toHaveText('Изменений: 1');
  await page.getByRole('button', { name: 'Отменить', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Повторить', exact: true })).toBeEnabled();
  await page.locator('[data-source-video]').evaluate(video => { video.currentTime = 1; });
  await expect.poll(() => page.locator('[data-source-video]').evaluate(video => video.currentTime)).toBeCloseTo(1, 1);
  fixture.settings.conflict = true;
  await page.getByRole('button', { name: 'Подобрать B-roll', exact: true }).click();
  await expect(page.locator('[data-transient-busy]')).toBeVisible();
  fixture.settings.conflict = false;
  await page.getByRole('button', { name: 'Повторить проверку', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Повторить', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(page.getByLabel('Запрос на английском', { exact: true })).toHaveValue('new forest');
  await page.getByRole('button', { name: 'Подобрать B-roll', exact: true }).click();
  await expect(page.locator('[data-broll-candidate]')).toHaveCount(12);
  await page.locator('[data-broll-candidate] video').first().evaluate(video => video.play());
  await expect.poll(() => page.locator('[data-broll-candidate] video').first().evaluate(video => video.currentTime)).toBeGreaterThan(0);
  expect(await page.locator('[data-source-video]').evaluate(video => video.currentTime)).toBeCloseTo(1, 1);
  expect(remote).toEqual([]);
});
test('hostile attribution URLs are inert while legitimate Pexels links remain usable', async ({ page }) => {
  await open(page);
  fixture.cards[0].author.url = 'javascript:alert(1)';
  fixture.cards[0].license.url = 'https://user:secret@www.pexels.com/license';
  fixture.cards[0].sourcePage = 'https://127.0.0.1/private';
  await page.getByRole('button', { name: 'Подобрать B-roll', exact: true }).click();
  await expect(page.locator('[data-broll-candidate]').first().locator('a')).toHaveCount(0);
  await expect(page.locator('[data-broll-candidate]').nth(1).locator('a')).toHaveCount(3);
});
test('undo and redo query changes invalidate an existing shelf and require a fresh search', async ({ page }) => {
  await open(page);
  await page.getByLabel('Запрос на английском', { exact: true }).fill('new query');
  await page.getByLabel('Запрос на английском', { exact: true }).press('Tab');
  await expect(page.locator('[data-edit-status]')).toHaveText('Изменений: 1');
  await page.getByRole('button', { name: 'Подобрать B-roll', exact: true }).click();
  await expect(page.locator('[data-broll-candidate]')).toHaveCount(12);
  await page.getByRole('button', { name: 'Отменить', exact: true }).click();
  await expect(page.getByLabel('Запрос на английском', { exact: true })).toHaveValue('forest walk');
  await expect(page.locator('[data-broll-candidate]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ещё варианты', exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Подобрать B-roll', exact: true }).click();
  await expect(page.locator('[data-broll-candidate]')).toHaveCount(12);
  expect(fixture.calls.filter(c => c.pathname === '/api/broll/search').at(-1).data.queryEnglish).toBe('forest walk');
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(page.getByLabel('Запрос на английском', { exact: true })).toHaveValue('new query');
  await expect(page.locator('[data-broll-candidate]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ещё варианты', exact: true })).toBeHidden();
  expect(fixture.calls.filter(c => c.pathname === '/api/broll/select')).toHaveLength(0);
});
test('selection and acknowledgement retain shelf but Save invalidates candidates from the previous base', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Подобрать B-roll', exact: true }).click();
  await expect(page.locator('[data-broll-candidate]')).toHaveCount(12);
  await page.getByRole('button', { name: 'Выбрать', exact: true }).first().click();
  await expect(page.locator('[data-broll-select]')).toHaveValue('asset-1');
  await expect(page.locator('[data-broll-candidate]')).toHaveCount(12);
  await page.getByLabel('Разрешить встроенный текст', { exact: true }).check();
  await expect(page.locator('[data-edit-status]')).toHaveText('Изменений: 2');
  await expect(page.locator('[data-broll-candidate]')).toHaveCount(12);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.locator('[data-edit-status]')).toHaveText('Изменений нет');
  await expect(page.locator('[data-broll-candidate]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ещё варианты', exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Подобрать B-roll', exact: true }).click();
  await expect(page.locator('[data-broll-candidate]')).toHaveCount(12);
  expect(fixture.calls.filter(c => c.pathname === '/api/broll/search').at(-1).data.baseRevision).toBe(2);
});
