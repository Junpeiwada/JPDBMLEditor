// .dbml ファイルの読み込み・パース・編集適用(Undo/Redo)・保存をまとめるフック。
// - ファイルを開く(ダイアログ→読み込み→パース)
// - 編集はメモリ上の currentText を更新するだけで、保存(saveFile)するまでディスクへは書かない
//   (Docs/計画-保存UNDO計画.md: 「編集は溜め、保存で書き込む」モデル)
// - テーブル定義編集(カラム追加/編集/削除)はテキストスナップショット履歴で無限 Undo/Redo できる
// - パースエラー時はトースト通知し、直前の表示(モデル)を維持する
// - ファイル監視は廃止した。外部変更は「手動リロード」ボタン(reloadFromDisk)で明示的に取り込む
import { useCallback, useReducer, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { useSnackbar } from 'notistack';
import { parseDbml } from './parse';
import type { DbmlModel } from './model';
import {
  readSidecar,
  writeSidecar,
  SIDECAR_VERSION,
  type TablePosition,
  type TableColumnWidthOverride,
} from '../meta/sidecar';

/**
 * 直近の model 更新が何によって起きたか(Docs/設計-視点移動.md の F1〜F3 + 保存UNDO計画)。
 * - open: ファイルを開いた(初回ロード) → 全体フィットする
 * - reload: 手動リロードボタンによる再読込 → 視点維持
 * - save: 明示保存(ディスクへの書き込み) → 視点維持
 * - edit: 保存前の編集適用(applyEdit)・Undo/Redo によるモデル更新 → 視点維持
 * null は「まだ何も読み込んでいない」初期状態。
 */
export type ModelUpdateKind = 'open' | 'reload' | 'save' | 'edit';

/**
 * 編集履歴 + 現在状態を1つにまとめた reducer 状態。
 *
 * present(現在テキスト)・past/future(Undo/Redo履歴)・model(present のパース結果)・
 * savedText(dirty判定基準) を「1つの状態」として原子的に遷移させる。これにより、
 * 個別 useState + setter クロージャで present を読むと生じる「関数型更新の内側で
 * クロージャキャプチャした古い present を積んでしまう」非対称バグ(レビュー H-1/H-2)を
 * 構造的に排除する。1イベント内で複数遷移(undo→redo 等)を同期的に発行しても、
 * reducer は直前の返り値を次の action に渡すため常に最新 present を基準に積める。
 *
 * parse は副作用を持つため reducer の外(呼び出し側)で行い、パース済みの model を action に載せる
 * (reducer 自身は純関数に保つ)。
 */
interface EditState {
  past: string[];
  present: string;
  future: string[];
  savedText: string;
  model: DbmlModel | null;
}

type EditAction =
  // ファイルを開く/リロード: 履歴を捨て、present=savedText=読み込んだ内容にする。
  | { type: 'load'; text: string; model: DbmlModel }
  // 編集適用: 現在の present を past に積み、present を新テキストへ。future はクリア。
  | { type: 'apply'; text: string; model: DbmlModel }
  // Undo: past の末尾へ戻し、現在の present を future の先頭へ。
  | { type: 'undo'; model: DbmlModel }
  // Redo: future の先頭へ進め、現在の present を past の末尾へ。
  | { type: 'redo'; model: DbmlModel }
  // 明示保存成功: savedText を「実際に書き込んだ内容」に合わせる(履歴は保持)。
  // present ではなく書き込んだ text を渡す: await 中に更に編集が入っても、
  // その新しい編集は未保存(dirty)として正しく残るようにするため。
  | { type: 'markSaved'; text: string };

function editReducer(state: EditState, action: EditAction): EditState {
  switch (action.type) {
    case 'load':
      return { past: [], present: action.text, future: [], savedText: action.text, model: action.model };
    case 'apply':
      return {
        ...state,
        past: [...state.past, state.present],
        present: action.text,
        future: [],
        model: action.model,
      };
    case 'undo': {
      if (state.past.length === 0) return state;
      const previous = state.past[state.past.length - 1];
      return {
        ...state,
        past: state.past.slice(0, -1),
        present: previous,
        future: [state.present, ...state.future],
        model: action.model,
      };
    }
    case 'redo': {
      if (state.future.length === 0) return state;
      const next = state.future[0];
      return {
        ...state,
        past: [...state.past, state.present],
        present: next,
        future: state.future.slice(1),
        model: action.model,
      };
    }
    case 'markSaved':
      return { ...state, savedText: action.text };
    default:
      return state;
  }
}

const initialEditState: EditState = { past: [], present: '', future: [], savedText: '', model: null };

export interface UseDbmlFileResult {
  filePath: string | null;
  model: DbmlModel | null;
  isLoading: boolean;
  /** いま画面が表しているDBML全文(未保存の編集を含む)。Undo/Redo・applyEditで更新される。 */
  currentText: string;
  /** 最後にディスクへ書いた(または開いた)内容。isDirty判定の基準。 */
  savedText: string;
  /** currentText !== savedText。未保存の編集があるかどうか。 */
  isDirty: boolean;
  /**
   * 開いているファイルのサイドカー(.jpdbml.json)に保存済みのテーブル配置座標。
   * ファイルを開いた時点で1回だけ読み込む。無い/壊れている場合は空マップ(自動レイアウトへ)。
   * ユーザーが動かしたテーブルのみ載る(未移動テーブルは ELK レイアウトに委ねる)。
   */
  savedPositions: Record<string, TablePosition>;
  /**
   * 開いているファイルのサイドカーに保存済みの、手動リサイズした列幅
   * (テーブルID→{name?,type?,note?}px)。Excel風リサイズのため名前列も含む全列を絶対pxで持つ。
   * 未指定の列は自動概算に委ねる。
   */
  savedColumnWidths: Record<string, TableColumnWidthOverride>;
  /**
   * 直近の model 更新種別 + 発生順の連番。連番は毎回インクリメントするため、
   * 同じ種別(例: save が連続)でも呼び出し側の useEffect が確実に再発火できる。
   */
  modelUpdate: { kind: ModelUpdateKind; seq: number } | null;
  /** ファイル選択ダイアログを開いて読み込む。実際にファイルを開いたら true(キャンセルなら false)。 */
  openFile: () => Promise<boolean>;
  /**
   * 指定パス(履歴からの選択など)を直接読み込む。読み込めたら true、
   * ファイルが存在しない/読めない場合は false(呼び出し側で履歴除去などに使う)。
   */
  openPath: (path: string) => Promise<boolean>;
  /**
   * 呼び出し側(最小編集関数)が生成した新しいDBML全文を検証し、currentTextへ適用する。
   * - パース失敗(不正なDBML)ならトーストを出し false を返す。currentTextは変更しない。
   * - 成功したら Undo履歴に直前のcurrentTextをpushし、currentText/modelを差し替えて true を返す。
   * - ディスクへの書き込みは行わない(保存は saveFile で別途行う)。
   */
  applyEdit: (newText: string) => boolean;
  /** 1つ前のcurrentTextへ戻す。戻せるものが無ければ何もしない。 */
  undo: () => void;
  /** undoを取り消し、1つ先のcurrentTextへ進める。進められるものが無ければ何もしない。 */
  redo: () => void;
  /** undo() で戻せる履歴があるか。 */
  canUndo: boolean;
  /** redo() で進められる履歴があるか。 */
  canRedo: boolean;
  /**
   * 現在の currentText をディスクへ書き込む(明示保存)。
   * 成功したら savedText = currentText(isDirty=falseになる)。Undo履歴はクリアしない。
   */
  saveFile: () => Promise<boolean>;
  /**
   * ディスクの最新内容を読み直し、currentText/savedText/modelを差し替える(手動リロード)。
   * 未保存編集がある場合の破棄確認はApp側の責務(呼ばれたら無条件で読み直す)。
   * 取り込み後はUndo/Redo履歴をクリアする(別内容に差し替わるため)。
   */
  reloadFromDisk: () => Promise<void>;
  /**
   * 見た目状態(配置座標 + 列幅)をサイドカー(.jpdbml.json)へ保存する。
   * サイドカーは全上書きするため、2種すべての最新値をまとめて渡すこと(一部だけ渡すと
   * 残りが消える)。テーブル幅(tableWidths)は箱リサイズ廃止により関数内部で常に空マップを書く。
   * `.dbml` 本体は一切変更しない。ファイル未オープン時は何もしない。
   * 保存失敗時はトーストを出し、それ以外は静かに成功する(見た目状態のため主機能を止めない)。
   */
  saveSidecarState: (
    positions: Record<string, TablePosition>,
    columnWidths: Record<string, TableColumnWidthOverride>,
  ) => Promise<void>;
}

export function useDbmlFile(): UseDbmlFileResult {
  const { enqueueSnackbar } = useSnackbar();
  const [filePath, setFilePath] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  // 編集履歴 + 現在状態(present/past/future/savedText/model)を1つの reducer で原子的に管理する。
  // Docs/計画-保存UNDO計画.md: 「編集状態の持ち方」/ レビュー H-1・H-2 の非対称バグ対策。
  const [edit, dispatch] = useReducer(editReducer, initialEditState);
  const { present: currentText, savedText, model } = edit;
  // undo/redo/applyEdit のコールバックが依存配列に present を持たずに最新値を読めるよう、
  // reducer 状態を ref にも同期しておく(コールバック再生成を減らし、クロージャ古値も避ける)。
  const editRef = useRef(edit);
  editRef.current = edit;
  // サイドカー由来の保存済み配置座標。ファイルを開いた時点で読み込む(再パース=reloadでは
  // 触らない。ユーザーがこのセッションで動かした最新座標は App 側が保持し、保存もそちらが行う)。
  const [savedPositions, setSavedPositions] = useState<Record<string, TablePosition>>({});
  // サイドカー由来の保存済み列幅(名前/型/note の手動リサイズ分)。座標と同じく開いた時点で読む。
  const [savedColumnWidths, setSavedColumnWidths] = useState<Record<string, TableColumnWidthOverride>>({});
  const [modelUpdate, setModelUpdate] = useState<{ kind: ModelUpdateKind; seq: number } | null>(null);
  // seq はコンポーネント外(ref)で単調増加させる。同一種別が連続しても呼び出し側の
  // useEffect(seq依存)が確実に再発火できるようにするため。
  const updateSeqRef = useRef(0);

  const recordModelUpdate = useCallback((kind: ModelUpdateKind) => {
    updateSeqRef.current += 1;
    setModelUpdate({ kind, seq: updateSeqRef.current });
  }, []);

  // 指定パスの内容を読み込みパースする共通処理。
  // 返り値: 読み込めて反映できたら true。読み込み失敗/パースエラーは false。
  const loadAndParse = useCallback(
    async (path: string, { isReload }: { isReload: boolean }): Promise<boolean> => {
      setIsLoading(true);
      try {
        const source = await readTextFile(path);
        const result = parseDbml(source);
        if (result.ok) {
          // 履歴を捨て、present=savedText=読み込んだ内容にする(取り込み後はUndo不能でよい)。
          dispatch({ type: 'load', text: source, model: result.model });
          // Docs/設計-視点移動.md: F1(open)のみ視点移動対象。F2(reload)は視点維持。
          recordModelUpdate(isReload ? 'reload' : 'open');
          if (isReload) {
            enqueueSnackbar('再読み込みしました', { variant: 'success' });
          }
          return true;
        } else {
          const loc = result.error.line != null ? ` (${result.error.line}行目)` : '';
          enqueueSnackbar(`パースエラー${loc}: ${result.error.message}`, { variant: 'error' });
          // 直前の表示を維持する(model は更新しない)。
          return false;
        }
      } catch (err) {
        enqueueSnackbar(`ファイルの読み込みに失敗しました: ${String(err)}`, { variant: 'error' });
        return false;
      } finally {
        setIsLoading(false);
      }
    },
    [enqueueSnackbar, recordModelUpdate],
  );

  // 指定パスを直接開く共通処理(ダイアログ選択後/履歴選択の両方から使う)。
  // 本文が読み込めなかった場合(欠損・パースエラー)は false を返す。
  const openPath = useCallback(
    async (path: string): Promise<boolean> => {
      // 本文が読めるかを先に確かめ、欠損時は状態を汚さずに false を返す
      // (履歴からの選択で存在しないファイルを開こうとした場合の分岐)。
      const loaded = await loadAndParse(path, { isReload: false });
      if (!loaded) return false;

      setFilePath(path);
      // サイドカー(配置座標)は本文パースと独立に、開いた時点で1回だけ読む。
      // 無い/壊れは空マップ(自動レイアウトにフォールバック)。本文の読み込み失敗とは分離する。
      const sidecar = await readSidecar(path);
      setSavedPositions(sidecar?.tablePositions ?? {});
      // tableWidths は読み飛ばす(箱リサイズ廃止。旧ファイルにあっても列幅から再計算するため無害)。
      setSavedColumnWidths(sidecar?.columnWidths ?? {});
      return true;
    },
    [loadAndParse],
  );

  const openFile = useCallback(async (): Promise<boolean> => {
    const selected = await open({
      multiple: false,
      filters: [{ name: 'DBML', extensions: ['dbml'] }],
    });
    if (!selected || Array.isArray(selected)) return false;
    return openPath(selected);
  }, [openPath]);

  // 呼び出し側(最小編集関数)が生成した新テキストを検証し、present へ適用する。
  // writeはしない(保存は別API=saveFile)。parse は reducer の外で行い、結果を action に載せる。
  const applyEdit = useCallback(
    (newText: string): boolean => {
      const result = parseDbml(newText);
      if (!result.ok) {
        const loc = result.error.line != null ? ` (${result.error.line}行目)` : '';
        enqueueSnackbar(`パースエラー${loc}: ${result.error.message}`, { variant: 'error' });
        return false;
      }
      dispatch({ type: 'apply', text: newText, model: result.model });
      // 保存前の編集反映。視点維持(全体フィットしない)。
      recordModelUpdate('edit');
      return true;
    },
    [enqueueSnackbar, recordModelUpdate],
  );

  // present は編集適用時に検証済みなので past/future の各スナップショットは必ずパース可能。
  // ただし parse は必要(model を差し替えるため)。最新の履歴は editRef から読む(依存を減らす)。
  const undo = useCallback(() => {
    const { past } = editRef.current;
    if (past.length === 0) return;
    const previous = past[past.length - 1];
    const result = parseDbml(previous);
    if (!result.ok) return; // 念のため(適用時検証済みのはず)
    dispatch({ type: 'undo', model: result.model });
    recordModelUpdate('edit');
  }, [recordModelUpdate]);

  const redo = useCallback(() => {
    const { future } = editRef.current;
    if (future.length === 0) return;
    const next = future[0];
    const result = parseDbml(next);
    if (!result.ok) return;
    dispatch({ type: 'redo', model: result.model });
    recordModelUpdate('edit');
  }, [recordModelUpdate]);

  // 多重保存防止(レビュー M-1): Cmd+S 連打やボタン連打で writeTextFile が並走しないよう、
  // 実行中は早期 return する。書き込む内容は「保存開始時点の present」で固定する。
  const isSavingRef = useRef(false);
  const saveFile = useCallback(async (): Promise<boolean> => {
    if (!filePath) return false;
    if (isSavingRef.current) return false;
    isSavingRef.current = true;
    // await をまたぐため、書き込む値はここで固定する。savedText には「実際に書いた内容」を
    // セットする(await 中に更に編集が入っても、その分は dirty として正しく残る)。
    const textToWrite = editRef.current.present;
    try {
      await writeTextFile(filePath, textToWrite);
      // 明示保存。視点維持(全体フィットしない)。Undo履歴はクリアしない。
      dispatch({ type: 'markSaved', text: textToWrite });
      recordModelUpdate('save');
      enqueueSnackbar('保存しました', { variant: 'success' });
      return true;
    } catch (err) {
      enqueueSnackbar(`保存に失敗しました: ${String(err)}`, { variant: 'error' });
      return false;
    } finally {
      isSavingRef.current = false;
    }
  }, [filePath, enqueueSnackbar, recordModelUpdate]);

  const reloadFromDisk = useCallback(async () => {
    if (!filePath) return;
    // loadAndParse が成功時に past/future を空にする(取り込み後はUndo履歴をクリア)。
    await loadAndParse(filePath, { isReload: true });
  }, [filePath, loadAndParse]);

  // サイドカー(.jpdbml.json)を「現在の見た目状態(座標+列幅)」で丸ごと書き直す。
  // writeSidecar はファイルを全上書きするため、一部だけを別々に書くと残りが消える。
  // そこで保存は必ず2種すべての最新値をまとめて受け取り、1つの現在状態として書く
  // (呼び出し側=App が2種の最新値を保持している)。テーブル幅(tableWidths)は箱リサイズ廃止に
  // より常に空マップを書く(スキーマ形状は後方互換のため維持)。
  const saveSidecarState = useCallback(
    async (
      positions: Record<string, TablePosition>,
      columnWidths: Record<string, TableColumnWidthOverride>,
    ) => {
      if (!filePath) return;
      const ok = await writeSidecar(filePath, {
        version: SIDECAR_VERSION,
        tablePositions: positions,
        tableWidths: {},
        columnWidths,
      });
      if (!ok) {
        enqueueSnackbar('見た目状態の保存に失敗しました(.jpdbml.json)', { variant: 'warning' });
      }
    },
    [filePath, enqueueSnackbar],
  );

  return {
    filePath,
    model,
    isLoading,
    currentText,
    savedText,
    isDirty: currentText !== savedText,
    savedPositions,
    savedColumnWidths,
    modelUpdate,
    openFile,
    openPath,
    applyEdit,
    undo,
    redo,
    canUndo: edit.past.length > 0,
    canRedo: edit.future.length > 0,
    saveFile,
    reloadFromDisk,
    saveSidecarState,
  };
}
