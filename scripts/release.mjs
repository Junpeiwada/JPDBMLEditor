#!/usr/bin/env node
// リリース補助スクリプト。
//
//   npm run release
//
// 現在バージョンを提示し、patch を +1 した値を既定サジェストする。Enter で確定、
// 手入力で上書き。確定後、以下 3 ファイルのバージョンを揃えてコミットし、main と
// タグ(vX.Y.Z)を push する。タグ push により .github/workflows/release.yml の
// リリースビルドが起動する（成果物は下書き Release に添付され、公開は手動）。
//
//   - package.json                (version)
//   - src-tauri/tauri.conf.json   ("version")
//   - src-tauri/Cargo.toml        (version = "...")
//
// 外部依存なし（Node 標準モジュールのみ）。VSCode タスク・素のターミナル・CI いずれからも動く。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(root, 'package.json');
const confPath = join(root, 'src-tauri', 'tauri.conf.json');
const cargoPath = join(root, 'src-tauri', 'Cargo.toml');

/** X.Y.Z 形式のみ許可（プレリリース・ビルドメタは今回のリリース運用では扱わない）。 */
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

/** git を同期実行し、標準出力を文字列で返す。 */
function git(args, opts = {}) {
  // stdio:'inherit' の場合 execFileSync の戻り値は null（出力は端末へ直行）。
  // その場合は空文字を返す（呼び出し側は戻り値を使わない push 等でのみ inherit を渡す）。
  const out = execFileSync('git', args, { cwd: root, encoding: 'utf8', ...opts });
  return out == null ? '' : out.trim();
}

function readCurrentVersion() {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (typeof pkg.version !== 'string' || !SEMVER.test(pkg.version)) {
    fail(`package.json の version が X.Y.Z 形式ではありません: ${pkg.version}`);
  }
  return pkg.version;
}

/** patch を +1 したサジェスト値。 */
function suggestNext(version) {
  const [, major, minor, patch] = version.match(SEMVER);
  return `${major}.${minor}.${Number(patch) + 1}`;
}

// --- 3 ファイルのバージョン書き換え（フォーマットは極力保持する） ---

function bumpPackageJson(next) {
  const raw = readFileSync(pkgPath, 'utf8');
  // トップレベルの "version" は JSON のほぼ先頭に来る前提で、最初の 1 件のみ置換する
  // （フォーマット保持のためテキスト置換にしている）。置換後は再パースで結果を検証する。
  const updated = raw.replace(/("version"\s*:\s*")[^"]+(")/, `$1${next}$2`);
  if (updated === raw) fail('package.json の version を置換できませんでした');
  if (JSON.parse(updated).version !== next) {
    fail('package.json の version 更新結果が不正です（想定外のキーを書き換えた可能性）');
  }
  writeFileSync(pkgPath, updated);
}

function bumpTauriConf(next) {
  const raw = readFileSync(confPath, 'utf8');
  const updated = raw.replace(/("version"\s*:\s*")[^"]+(")/, `$1${next}$2`);
  if (updated === raw) fail('tauri.conf.json の version を置換できませんでした');
  if (JSON.parse(updated).version !== next) {
    fail('tauri.conf.json の version 更新結果が不正です（想定外のキーを書き換えた可能性）');
  }
  writeFileSync(confPath, updated);
}

function bumpCargoToml(next) {
  const raw = readFileSync(cargoPath, 'utf8');
  // [package] 直下の最初の version 行のみ置換する（依存の version = "..." を巻き込まない）。
  const lines = raw.split('\n');
  let inPackage = false;
  let done = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 配列テーブル [[bin]] 等（先頭が [[）に入ったら package スコープから抜ける。
    if (/^\s*\[\[/.test(line)) {
      inPackage = false;
      continue;
    }
    const section = line.match(/^\s*\[([^\]]+)\]/);
    if (section) {
      inPackage = section[1].trim() === 'package';
      continue;
    }
    if (inPackage && /^\s*version\s*=\s*"/.test(line)) {
      lines[i] = line.replace(/(version\s*=\s*")[^"]+(")/, `$1${next}$2`);
      done = true;
      break;
    }
  }
  if (!done) fail('Cargo.toml の [package] version を置換できませんでした');
  writeFileSync(cargoPath, lines.join('\n'));
}

/** Cargo.lock を新バージョンに追随させる（オフラインで自パッケージのみ更新）。 */
function updateCargoLock() {
  try {
    execFileSync('cargo', ['update', '--offline', '-p', 'jpdbmleditor'], {
      cwd: join(root, 'src-tauri'),
      stdio: 'ignore',
    });
  } catch {
    // cargo 不在やオフライン失敗時は Cargo.lock 更新をスキップ（次回ビルドで解決される）。
    console.warn('  ! Cargo.lock の自動更新をスキップしました（cargo update に失敗）');
  }
}

async function main() {
  // --- 前提チェック ---
  let status;
  try {
    status = git(['status', '--porcelain']);
  } catch {
    fail('git リポジトリではないか、git が使えません');
  }
  if (status) {
    fail(`作業ツリーに未コミットの変更があります。先にコミット/退避してください:\n${status}`);
  }

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const current = readCurrentVersion();
  const suggestion = suggestNext(current);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`\n現在のバージョン: ${current}  (ブランチ: ${branch})`);
  if (branch !== 'main') {
    // リリースは main から行う想定。別ブランチなら明示的に確認する。
    const proceed = (await rl.question(`⚠ ブランチが main ではありません (${branch})。このまま続けますか？ [y/N]: `))
      .trim()
      .toLowerCase();
    if (proceed !== 'y' && proceed !== 'yes') {
      rl.close();
      console.log('中止しました。');
      process.exit(0);
    }
  }
  const answer = (await rl.question(`新しいバージョン [${suggestion}]: `)).trim();
  const next = answer === '' ? suggestion : answer;

  if (!SEMVER.test(next)) {
    rl.close();
    fail(`バージョンは X.Y.Z 形式で指定してください: ${next}`);
  }
  if (next === current) {
    rl.close();
    fail(`現在と同じバージョンです: ${next}`);
  }

  const tag = `v${next}`;
  const existingTags = git(['tag', '--list', tag]);
  if (existingTags) {
    rl.close();
    fail(`タグ ${tag} は既にローカルに存在します`);
  }
  // リモート先行タグも検出する（別マシン/CI で既に打たれている場合、push で初めて弾かれるのを防ぐ）。
  try {
    const remoteTag = git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`]);
    if (remoteTag) {
      rl.close();
      fail(`タグ ${tag} は既にリモート(origin)に存在します`);
    }
  } catch {
    // ネットワーク不通等でリモート確認できない場合はスキップ（push 時に弾かれる）。
  }

  console.log('\n次を実行します:');
  console.log(`  1. バージョン更新 ${current} → ${next}（package.json / tauri.conf.json / Cargo.toml）`);
  console.log(`  2. コミット`);
  console.log(`  3. git push origin ${branch}`);
  console.log(`  4. git tag ${tag} && git push origin ${tag}  ← これでリリースビルドが起動します`);
  const confirm = (await rl.question('\n実行してよいですか？ [y/N]: ')).trim().toLowerCase();
  rl.close();
  if (confirm !== 'y' && confirm !== 'yes') {
    console.log('中止しました。');
    process.exit(0);
  }

  // --- 実行 ---
  // 各段階で失敗したとき、どこまで完了しどう復旧するかを案内する（中間状態で放置しない）。

  // (1) ファイル書き換え + コミット。ここで落ちたらファイルだけ変わった状態なので restore を促す。
  try {
    console.log('\n→ バージョンを更新中…');
    bumpPackageJson(next);
    bumpTauriConf(next);
    bumpCargoToml(next);
    updateCargoLock();

    console.log('→ コミット中…');
    git(['add', 'package.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']);
    git(['commit', '-m', `バージョンを ${next} に上げる`]);
  } catch (e) {
    fail(
      `バージョン更新/コミットに失敗しました: ${e?.message ?? e}\n` +
        `  ファイルが書き換わったまま残っている可能性があります。元に戻すには:\n` +
        `    git restore package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock`,
    );
  }

  // (2) main(現在ブランチ) を push。ここで落ちたら「コミット済み・push 未完・タグ未作成」。
  try {
    console.log(`→ push 中 (origin ${branch})…`);
    git(['push', 'origin', branch], { stdio: 'inherit' });
  } catch (e) {
    fail(
      `origin ${branch} への push に失敗しました: ${e?.message ?? e}\n` +
        `  バージョン更新のコミットはローカルに作成済みです（タグは未作成）。\n` +
        `  原因を解消して再度: git push origin ${branch} してから、手動でタグを打つか再実行してください。`,
    );
  }

  // (3) タグ作成 + push。main push は成功済みなので、タグだけ後追いできるよう案内する。
  console.log(`→ タグ ${tag} を作成して push 中…`);
  try {
    git(['tag', tag]);
  } catch (e) {
    fail(`タグ ${tag} の作成に失敗しました: ${e?.message ?? e}`);
  }
  try {
    git(['push', 'origin', tag], { stdio: 'inherit' });
  } catch (e) {
    fail(
      `タグ ${tag} の push に失敗しました: ${e?.message ?? e}\n` +
        `  コミットと origin ${branch} の push は完了済みです。\n` +
        `  続行する場合:   git push origin ${tag}\n` +
        `  やり直す場合:   git tag -d ${tag}  してから原因を解消し再実行`,
    );
  }

  console.log(`\n✓ ${tag} を push しました。リリースビルドが起動します。`);
  console.log('  進捗: https://github.com/Junpeiwada/JPDBMLEditor/actions');
  console.log('  ビルド完了後、Releases の下書きを確認して Publish してください。');
}

main().catch((e) => fail(e?.message ?? String(e)));
