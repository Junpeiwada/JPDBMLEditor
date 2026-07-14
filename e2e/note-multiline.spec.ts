import { test, expect } from '@playwright/test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { installTauriMock } from './tauriMock';

// 複数行note(改行入り)のカラムが、箱から切れずに縦に伸びて全行表示されることの目視確認用。
// ローカルの SampleDBML/(リポジトリ非含有)を走査し、最も行数の多い note を持つカラムの
// テーブルを撮る。サンプルが無い環境ではスキップする。
const DBML_PATH = '/Users/test/sample.dbml';

// SampleDBML/*.dbml から「note 内の \n が最多のカラム」とそのテーブルを探す。
function findMultilineNoteTarget(): { content: string; table: string; column: string } | null {
  if (!existsSync('SampleDBML')) return null;
  let best: { content: string; table: string; column: string; lines: number } | null = null;
  for (const file of readdirSync('SampleDBML').filter((f) => f.endsWith('.dbml'))) {
    const content = readFileSync(`SampleDBML/${file}`, 'utf8');
    const tableRe = /Table\s+(?:"([^"]+)"|(\S+))\s*\{([\s\S]*?)\n\}/g;
    for (let t; (t = tableRe.exec(content)); ) {
      const tableName = t[1] ?? t[2];
      for (const line of t[3].split('\n')) {
        const note = line.match(/note:\s*'((?:[^'\\]|\\.)*)'/);
        if (!note) continue;
        const lines = (note[1].match(/\\n/g) ?? []).length + 1;
        const col = line.match(/^\s*(?:"([^"]+)"|(\S+))\s/);
        if (!col) continue;
        if (!best || lines > best.lines) {
          best = { content, table: tableName, column: col[1] ?? col[2], lines };
        }
      }
    }
  }
  return best && best.lines > 1 ? best : null;
}

const target = findMultilineNoteTarget();

test('capture: 複数行noteの表示', async ({ page }) => {
  test.skip(!target, 'SampleDBML/ に複数行noteを含むサンプルが無いためスキップ');
  const { content, table, column } = target!;
  await installTauriMock(page, { files: { [DBML_PATH]: content }, dialogPath: DBML_PATH });
  await page.goto('/');
  await page.locator('button[aria-label="DBMLファイルを開く"]').click();

  // 複数行noteを持つテーブルが描画されるまで待つ。
  const node = page.locator('.react-flow__node', { hasText: table }).first();
  await node.waitFor({ timeout: 30_000 });

  // 検索で対象テーブルに絞る(複数行noteを持つカラム名で検索)。
  await page.getByPlaceholder(/検索/).fill(column);
  await page.waitForTimeout(800);

  // LOD(縮小時の省略表示)を無効にしてカラム行を必ず描かせる(しきい値スライダーを最小へ)。
  await page.getByRole('slider').press('Home');
  // 対象テーブルにフォーカスし、読める倍率までズームインする。
  await node.click();
  await page.waitForTimeout(500);
  for (let i = 0; i < 5; i++) {
    await page.locator('.react-flow__controls-zoomin').click();
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'e2e/__screenshots__/note-multiline.png' });
  // ノード単体も撮る(複数行noteのセルが読める倍率で確認するため)。
  await node.screenshot({ path: 'e2e/__screenshots__/note-multiline-node.png' });

  // note セルの実描画高さ(全行分)が、行の高さに収まっているか(切れていないか)を検証する。
  const noteCell = node.locator('[data-cell="note"]').first();
  await expect(noteCell).toBeVisible();
  const info = await node.evaluate((el) => {
    const rows = Array.from(el.querySelectorAll('[data-cell="note"]')).map((n) => {
      const row = n.parentElement as HTMLElement;
      const lines = Array.from(n.children) as HTMLElement[];
      const contentH = lines.reduce((a, l) => a + l.getBoundingClientRect().height, 0);
      return { rowH: row.getBoundingClientRect().height, contentH, lines: lines.length };
    });
    const body = el.getBoundingClientRect().height;
    return { rows, body };
  });
  // 各行: note の全行が行の高さに収まる(はみ出し=切れ が無い)
  for (const r of info.rows) {
    expect(r.contentH, `note ${r.lines}行 が行高 ${r.rowH} に収まる`).toBeLessThanOrEqual(r.rowH + 0.5);
  }
  console.log('複数行noteの行:', info.rows.filter((r) => r.lines > 1).length, '/ 最大行数:', Math.max(...info.rows.map((r) => r.lines)));
});
