import { expect, test } from '@playwright/test';
import { installTauriMock } from './tauriMock';

// 長いヘッダー(テーブル名+日本語note)の省略表示(2026-07-15):
// 箱幅はカラム内容のみで決まり(estimateTableNodeSize はヘッダー幅を見ない)、
// 収まらないヘッダーは「…」で省略される(全文は title ツールチップ)。
const PATH = '/mock/header-ellipsis.dbml';
const SRC = `Table VERY_LONG_TABLE_NAME_THAT_SHOULD_NOT_WIDEN_THE_BOX_1234567890 [note: 'とても長い日本語のテーブル名の説明がここに入り省略されるはず'] {
  id int [pk]
  name varchar
}

Table SHORT {
  id int [pk]
  name varchar
}
`;

test('長いヘッダーでも箱幅はカラム内容のみで決まり、ヘッダーは…で省略される', async ({ page }) => {
  await installTauriMock(page, { files: { [PATH]: SRC }, dialogPath: PATH });
  await page.goto('/');
  await page.locator('button[aria-label="DBMLファイルを開く"]').click();

  const longNode = page.locator('.react-flow__node', { hasText: 'VERY_LONG_TABLE_NAME' }).first();
  const shortNode = page.locator('.react-flow__node', { hasText: 'SHORT' }).first();
  await longNode.waitFor({ timeout: 30_000 });
  await page.getByRole('slider').press('Home'); // LOD 無効化(カラム行を描かせる)

  // カラム構成が同一なので、ヘッダーの長短に関わらず箱幅は一致するはず。
  const longBox = await longNode.boundingBox();
  const shortBox = await shortNode.boundingBox();
  expect(longBox).not.toBeNull();
  expect(shortBox).not.toBeNull();
  expect(Math.abs(longBox!.width - shortBox!.width)).toBeLessThanOrEqual(1);

  // ヘッダーのテーブル名は溢れており(scrollWidth > clientWidth)、ellipsis で省略されている。
  const nameEl = longNode.locator('.table-drag-handle h6').first();
  const metrics = await nameEl.evaluate((el) => ({
    overflowing: el.scrollWidth > el.clientWidth,
    textOverflow: getComputedStyle(el).textOverflow,
    title: el.getAttribute('title'),
  }));
  expect(metrics.overflowing).toBe(true);
  expect(metrics.textOverflow).toBe('ellipsis');
  // ツールチップで全文が見える。
  expect(metrics.title).toBe('VERY_LONG_TABLE_NAME_THAT_SHOULD_NOT_WIDEN_THE_BOX_1234567890');

  await longNode.screenshot({ path: 'e2e/__screenshots__/header-ellipsis.png' });
});
