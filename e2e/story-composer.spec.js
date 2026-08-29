import { test, expect } from '@playwright/test';

// Çoklu metin katmanı + döndürme özelliği — kullanıcı raporunun ("storye
// metin eklediğimizde sadece 1 tane ekliyor, 2.sine tıklayınca öncekini
// düzenliyor") doğrudan e2e karşılığı, artı GIF/mention/hashtag katmanları
// ve limitin 10'a çıkması.

async function openStoryModal(page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.locator('#add-story-btn').click();
  await expect(page.locator('#story-modal')).toBeVisible();
}

test.describe('Story composer — multi-text layers', () => {
  test('clicking "Yazı" twice creates two independent text layers', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await openStoryModal(page);

    await page.locator('#story-add-text-btn').click();
    await page.locator('#story-caption-input').fill('birinci metin');
    await page.locator('#story-add-text-btn').click();
    await page.locator('#story-caption-input').fill('ikinci metin');

    const layers = page.locator('.story-layer-text');
    await expect(layers).toHaveCount(2);

    const raw = await page.locator('#story-overlay-elements-input').inputValue();
    const parsed = JSON.parse(raw);
    const textEls = parsed.filter((e) => e.type === 'text');
    expect(textEls).toHaveLength(2);
    expect(textEls.map((e) => e.text).sort()).toEqual(['birinci metin', 'ikinci metin'].sort());

    expect(errors).toHaveLength(0);
  });

  test('tapping an existing text layer edits it instead of creating a new one', async ({ page }) => {
    await openStoryModal(page);

    await page.locator('#story-add-text-btn').click();
    await page.locator('#story-caption-input').fill('orijinal metin');
    // Yeni bir katman BAŞLATMADAN (Yazı butonuna TEKRAR basmadan) canvas'taki
    // katmana dokunmak sadece onu düzenlemeli.
    await page.locator('.story-layer-text').first().click({ position: { x: 5, y: 5 } });
    await page.locator('#story-caption-input').fill('güncellenmiş metin');

    await expect(page.locator('.story-layer-text')).toHaveCount(1);
    const raw = await page.locator('#story-overlay-elements-input').inputValue();
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].text).toBe('güncellenmiş metin');
  });

  test('clearing the text removes the layer', async ({ page }) => {
    await openStoryModal(page);
    await page.locator('#story-add-text-btn').click();
    await page.locator('#story-caption-input').fill('silinecek');
    await expect(page.locator('.story-layer-text')).toHaveCount(1);
    await page.locator('#story-caption-input').fill('');
    await expect(page.locator('.story-layer-text')).toHaveCount(0);
  });

  test('hashtag layer can be added via the panel', async ({ page }) => {
    await openStoryModal(page);
    await page.locator('#story-hashtag-toggle-btn').click();
    await page.locator('#story-hashtag-input').fill('tatil');
    await page.locator('#story-hashtag-add-btn').click();

    await expect(page.locator('.story-layer-hashtag')).toHaveCount(1);
    const raw = await page.locator('#story-overlay-elements-input').inputValue();
    const parsed = JSON.parse(raw);
    expect(parsed).toContainEqual(expect.objectContaining({ type: 'hashtag', tag: 'tatil' }));
  });

  test('overlay layers cap at 10', async ({ page }) => {
    await openStoryModal(page);
    for (let i = 0; i < 12; i++) {
      await page.locator('#story-hashtag-toggle-btn').click();
      await page.locator('#story-hashtag-input').fill('tag' + i);
      await page.locator('#story-hashtag-add-btn').click();
    }
    const raw = await page.locator('#story-overlay-elements-input').inputValue();
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveLength(10);
  });

  test('desktop wheel fallback changes scale and rotation of the active layer', async ({ page }) => {
    await openStoryModal(page);
    await page.locator('#story-add-text-btn').click();
    await page.locator('#story-caption-input').fill('boyut testi');

    const layer = page.locator('.story-layer-text').first();
    const box = await layer.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -100); // scale up
    await page.mouse.wheel(0, -100);

    let raw = await page.locator('#story-overlay-elements-input').inputValue();
    let parsed = JSON.parse(raw);
    expect(parsed[0].scale).toBeGreaterThan(1);

    await page.keyboard.down('Shift');
    await page.mouse.wheel(0, 100); // rotate
    await page.keyboard.up('Shift');

    raw = await page.locator('#story-overlay-elements-input').inputValue();
    parsed = JSON.parse(raw);
    expect(parsed[0].rotation).not.toBe(0);
  });

  test('GIF panel opens, searches, and adds an image layer without console errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await openStoryModal(page);
    await page.locator('#story-gif-toggle-btn').click();
    await expect(page.locator('#story-gif-panel')).toBeVisible();
    await page.waitForResponse((r) => r.url().includes('/gif/search'));
    const firstGif = page.locator('#story-gif-results img').first();
    await expect(firstGif).toBeVisible({ timeout: 5000 });
    await firstGif.click();

    await expect(page.locator('.story-layer-image')).toHaveCount(1);
    expect(errors).toHaveLength(0);
  });

  test('sticker panel opens without console errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await openStoryModal(page);
    await page.locator('#story-sticker-toggle-btn').click();
    await expect(page.locator('#story-sticker-panel')).toBeVisible();
    await page.waitForResponse((r) => r.url().includes('/stickers/mine'));
    expect(errors).toHaveLength(0);
  });

  test('mention panel searches without console errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await openStoryModal(page);
    await page.locator('#story-mention-toggle-btn').click();
    await expect(page.locator('#story-mention-panel')).toBeVisible();
    await page.locator('#story-mention-search-input').fill('a');
    await page.waitForResponse((r) => r.url().includes('/social/mentions/search'));
    expect(errors).toHaveLength(0);
  });

  test('submitting a text-only story round-trips through the viewer without duplication', async ({ page }) => {
    await openStoryModal(page);
    await page.locator('#story-add-text-btn').click();
    await page.locator('#story-caption-input').fill('e2e görüntüleyici testi ' + Date.now());
    const uniqueText = await page.locator('#story-caption-input').inputValue();

    await Promise.all([
      page.waitForNavigation(),
      page.locator('.story-modal-body button[type="submit"]').click(),
    ]);

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.locator('.story-avatar-btn[data-user-id]').first().click();
    await expect(page.locator('#story-viewer-modal')).toBeVisible();

    // Bu test hesabında önceki test'lerden kalan BAŞKA aktif hikayeler
    // olabilir (en eskiden en yeniye sıralı gösteriliyor, bkz.
    // app/stories.py::user_stories `.order("created_at")`) — bizimki HER
    // ZAMAN sonuncusu, "Sonraki" görünür olduğu sürece ilerle.
    const nextBtn = page.locator('#story-next-btn');
    for (let i = 0; i < 50 && !(await nextBtn.isHidden()); i++) {
      await nextBtn.click();
    }

    // Metin TEK bir yerde görünmeli — .story-overlay-layer olarak (yeni
    // katman render'ı) VE eski #story-viewer-caption AYNI ANDA GÖRÜNÜR
    // olmamalı (çift render kuralı).
    const overlayText = page.locator('.story-overlay-layer.story-layer-text-content', { hasText: uniqueText });
    await expect(overlayText).toBeVisible();
    await expect(page.locator('#story-viewer-caption')).toBeHidden();
  });
});
