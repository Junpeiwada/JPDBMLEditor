import { test, expect } from '@playwright/test';
import { installTauriMock } from './tauriMock';

// ▲▼(並べ替えボタン)の右ガター(Docs/設計-行オーバレイ.md 案2)の確認。
// - フォーカス起点テーブルのみ箱幅が MOVE_GUTTER_WIDTH(44px) 広がり、▲▼ はガター内に出る
//   → note セル(最右列)に重ならず、note のダブルクリック編集を奪わない(P1/P2)。
// - note 右端の列リサイズハンドルとも重ならない(P3)。
// - 編集行を開いている間は ▲▼・リサイズハンドルを出さない(原則5)。
const PATH = '/Users/test/mini.dbml';
const SRC = `Table T {
  "id" int [pk]
  "st" int [note: '区分']
}
`;

test('フォーカスで右ガターが付き、▲▼ が note セル・リサイズハンドルと重ならない', async ({ page }) => {
  await installTauriMock(page, { files: { [PATH]: SRC }, dialogPath: PATH });
  await page.goto('/');
  await page.locator('button[aria-label="DBMLファイルを開く"]').click();

  const node = page.locator('.react-flow__node', { hasText: 'T' }).first();
  await node.waitFor({ timeout: 30_000 });
  await page.getByRole('slider').press('Home');

  const widthBefore = (await node.boundingBox())!.width;
  await node.locator('.table-drag-handle').click(); // フォーカスへ
  const widthAfter = (await node.boundingBox())!.width;
  expect(widthAfter - widthBefore, 'フォーカスで箱幅が +44(ガター分) になる').toBeCloseTo(44, 0);

  // ▲▼ とセル・ハンドルの領域が交差しない(座標での構造確認)。
  const zones = await node.evaluate((root) => {
    const r = root.getBoundingClientRect();
    const rel = (el: Element) => {
      const b = el.getBoundingClientRect();
      return { left: b.x - r.x, right: b.x - r.x + b.width };
    };
    const buttons = root.querySelector('.column-move-buttons')!;
    const notes = Array.from(root.querySelectorAll('[data-cell="note"]')).map(rel);
    const handles = Array.from(root.querySelectorAll('.column-resize-handle')).map(rel);
    return { buttons: rel(buttons), notes, handles };
  });
  for (const noteZone of zones.notes) {
    expect(
      noteZone.right,
      `note セル(右端=${noteZone.right})が ▲▼ (左端=${zones.buttons.left})に達しない`,
    ).toBeLessThanOrEqual(zones.buttons.left);
  }
  for (const h of zones.handles) {
    expect(
      h.right,
      `リサイズハンドル(右端=${h.right})が ▲▼ (左端=${zones.buttons.left})に達しない`,
    ).toBeLessThanOrEqual(zones.buttons.left);
  }

  // フォーカス解除(背景クリック)で箱幅が元に戻る。
  await page.keyboard.press('Escape');
  await expect
    .poll(async () => (await node.boundingBox())!.width, { message: 'フォーカス解除でガターが外れる' })
    .toBeCloseTo(widthBefore, 0);
});

test('未フォーカスから note をダブルクリックすると(▲▼に奪われず)編集が始まる', async ({ page }) => {
  await installTauriMock(page, { files: { [PATH]: SRC }, dialogPath: PATH });
  await page.goto('/');
  await page.locator('button[aria-label="DBMLファイルを開く"]').click();

  const node = page.locator('.react-flow__node', { hasText: 'T' }).first();
  await node.waitFor({ timeout: 30_000 });
  await page.getByRole('slider').press('Home');

  // フォーカスせずいきなり note セルをダブルクリック(1打目でフォーカス遷移が起きるパス)。
  await node.locator('[data-cell="note"]').nth(1).dblclick();
  const noteField = node.getByPlaceholder('note');
  await expect(noteField, 'カラム移動ではなく編集行が開く').toBeVisible();
  await expect(noteField).toHaveValue('区分');

  // 編集行を開いている間は ▲▼・リサイズハンドルが消える(原則5)。
  await expect(node.locator('.column-move-buttons')).toHaveCount(0);
  await expect(node.locator('.column-resize-handle')).toHaveCount(0);

  // 破棄しても行順が変わっていない(移動が誤発火していない)。
  await page.keyboard.press('Escape');
  await expect(noteField).toBeHidden();
  const names = await node.locator('[data-cell="name"]').allTextContents();
  expect(names, 'カラム順が変わっていない').toEqual(['id', 'st']);
});
