// フェーズ4: インラインカラム編集セッション(挿入/既存カラム編集/削除)一式をまとめるフック。
// 挿入(pendingInsert)と既存カラム編集(pendingEdit)は排他(同時に開かない)。どちらもフォーカス
// 起点テーブルにのみ表示される。削除は確認ダイアログ(deleteTarget)を経由する。
//
// currentText(メモリ上の現在テキスト)に最小編集を適用し、applyEditで検証してcurrentTextへ
// 反映する(Docs/計画-保存UNDO計画.md「編集状態の持ち方」)。ディスクへの書き込みはしない
// (保存は別途 Cmd/Ctrl+S・保存ボタン)。
import { useCallback, useRef, useState } from "react";
import type { RefObject } from "react";
import type { ProviderContext } from "notistack";
import type { DbmlModel } from "../parser/model";
import { insertColumnLine, type InsertPosition } from "../edit/insertColumn";
import { replaceColumnLine } from "../edit/replaceColumnLine";
import { deleteColumnLine, findRefsUsingColumn } from "../edit/deleteColumn";
import { moveColumnLine, type MoveDirection } from "../edit/moveColumn";
import { reanchor } from "../edit/reanchor";
import type { ColumnInput } from "../edit/lineFormat";
import type { EditRowFocusField } from "./ColumnEditRow";
import type { PendingInsertState, PendingEditState } from "./ErCanvas";
import type { SearchFieldHandle } from "./SearchField";

/** カラム削除の確認ダイアログ状態(対象と Ref 使用の警告文言を保持する)。 */
export interface ColumnDeleteTarget {
  tableId: string;
  tableName: string;
  columnId: string;
  columnName: string;
  /** このカラムを参照している Ref があれば、その説明(警告表示用)。無ければ null。 */
  refWarning: string | null;
}

interface UseColumnEditSessionParams {
  model: DbmlModel | null;
  currentText: string;
  applyEdit: (newText: string) => boolean;
  enqueueSnackbar: ProviderContext["enqueueSnackbar"];
  /** handleRequestEdit がフォーカス遷移(検索クリア込み)も行うために必要。 */
  focusTable: (tableId: string) => void;
  searchFieldRef: RefObject<SearchFieldHandle | null>;
}

export interface UseColumnEditSessionResult {
  pendingInsert: PendingInsertState | null;
  pendingEdit: PendingEditState | null;
  deleteTarget: ColumnDeleteTarget | null;
  isDuplicateName: (name: string) => boolean;
  handleRequestInsert: (
    tableId: string,
    anchorColumnId: string | null,
    anchorColumnName: string | null,
    position: InsertPosition,
  ) => void;
  handleRequestEdit: (tableId: string, columnId: string, columnName: string, focusField: EditRowFocusField) => void;
  handleCancelInsert: () => void;
  handleRequestDelete: (tableId: string, columnId: string, columnName: string) => void;
  handleRequestMove: (tableId: string, columnId: string, columnName: string, direction: MoveDirection) => void;
  handleCommitInsert: (input: ColumnInput) => void;
  handleCommitEdit: (input: ColumnInput) => void;
  handleConfirmDelete: () => void;
  /** 削除確認ダイアログを閉じる(キャンセル)。 */
  closeDeleteTarget: () => void;
  /** 開いている編集セッション(挿入/既存カラム編集)を全リセットする。テーブル遷移/フォーカス解除で使う。 */
  resetSession: () => void;
}

export function useColumnEditSession({
  model,
  currentText,
  applyEdit,
  enqueueSnackbar,
  focusTable,
  searchFieldRef,
}: UseColumnEditSessionParams): UseColumnEditSessionResult {
  const [pendingInsert, setPendingInsert] = useState<PendingInsertState | null>(null);
  const [pendingEdit, setPendingEdit] = useState<PendingEditState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ColumnDeleteTarget | null>(null);
  // 確定処理(ファイルI/O)の多重実行防止。Enterと外側クリックがほぼ同時に発火しても1回だけ保存する。
  const isCommittingRef = useRef(false);

  // isCommittingRef ガード + try/finally のボイラープレートを共通化する。
  // ガード成立前(model無し等)の早期returnは各ハンドラ側の責務のまま(呼び出し前に判定する)。
  const withCommitGuard = useCallback((fn: () => void) => {
    if (isCommittingRef.current) return; // Enter+外側クリックの多重発火防止
    isCommittingRef.current = true;
    try {
      fn();
    } finally {
      isCommittingRef.current = false;
    }
  }, []);

  // 開いている編集セッション(挿入/既存カラム編集)を全リセットする。
  const resetSession = useCallback(() => {
    setPendingInsert(null);
    setPendingEdit(null);
  }, []);

  // カラム名の重複チェック(現在の編集セッションの対象テーブル基準)。
  // 既存カラム編集では自分自身(編集中のカラム)を重複対象から除外する。
  const isDuplicateName = useCallback(
    (name: string) => {
      if (!model) return false;
      const session = pendingInsert ?? pendingEdit;
      if (!session) return false;
      const table = model.tables.find((t) => t.id === session.tableId);
      if (!table) return false;
      const trimmed = name.trim();
      const excludeColumnId = pendingEdit?.columnId ?? null;
      return table.columns.some((c) => c.name === trimmed && c.id !== excludeColumnId);
    },
    [model, pendingInsert, pendingEdit],
  );

  // 右クリックメニュー/ヘッダー[+]から挿入入力行を開く要求。
  const handleRequestInsert = useCallback(
    (tableId: string, anchorColumnId: string | null, anchorColumnName: string | null, position: InsertPosition) => {
      const table = model?.tables.find((t) => t.id === tableId);
      if (!table) return;
      setPendingEdit(null); // セッションは排他
      setPendingInsert({
        tableId,
        tableName: table.name,
        anchorColumnId,
        anchorColumnName,
        position,
      });
    },
    [model],
  );

  // ダブルクリック/F2から既存カラムの編集を開始する要求。
  // 任意のテーブルから呼ばれるため、フォーカス遷移(handleSelectTable相当)も一緒に行う。
  const handleRequestEdit = useCallback(
    (tableId: string, columnId: string, columnName: string, focusField: EditRowFocusField) => {
      const table = model?.tables.find((t) => t.id === tableId);
      if (!table) return;
      // フォーカス遷移(検索クリア込み)。同じテーブルなら実質no-op。
      searchFieldRef.current?.clearSearch();
      focusTable(tableId);
      setPendingInsert(null); // セッションは排他
      setPendingEdit({
        tableId,
        tableName: table.name,
        columnId,
        columnName,
        focusField,
      });
    },
    [model, focusTable, searchFieldRef],
  );

  const handleCancelInsert = useCallback(() => {
    setPendingInsert(null);
    setPendingEdit(null);
  }, []);

  // 右クリックメニュー「削除」からの要求。実削除の前に確認ダイアログを開く。
  // このカラムが Ref に使われている場合は、削除すると DBML が壊れる旨を警告文言として持たせる。
  const handleRequestDelete = useCallback(
    (tableId: string, columnId: string, columnName: string) => {
      if (!model) return;
      const table = model.tables.find((t) => t.id === tableId);
      if (!table) return;
      const column = table.columns.find((c) => c.id === columnId);
      if (!column) return;
      // 挿入/編集セッションが開いていたら閉じる(削除と排他)。
      setPendingInsert(null);
      setPendingEdit(null);

      const usingRefs = findRefsUsingColumn(model, table, column);
      const refWarning =
        usingRefs.length > 0
          ? `このカラムはリレーション(${usingRefs.length}件)で参照されています。削除するとその参照が壊れ、DBMLが不正になるため保存できない可能性があります。`
          : null;

      setDeleteTarget({ tableId, tableName: table.name, columnId, columnName, refWarning });
    },
    [model],
  );

  // 行ホバーの ▲▼ からのカラム並べ替え。確認ダイアログは挟まず即座に適用する
  // (1行移動は影響が小さく、間違えても Undo(Cmd/Ctrl+Z)と ▲▼ の押し戻しで即やり直せるため)。
  // カラムID は「テーブル名.カラム名」由来で並び順に依存しないので、移動後も行選択・
  // 編集セッションの参照は切れない。
  const handleRequestMove = useCallback(
    (tableId: string, columnId: string, columnName: string, direction: MoveDirection) => {
      if (!model) return;
      withCommitGuard(() => {
        const table = model.tables.find((t) => t.id === tableId);
        const column = table?.columns.find((c) => c.id === columnId);
        if (!table || !column) {
          enqueueSnackbar(`カラム "${columnName}" を特定できませんでした。移動を中断します。`, {
            variant: "error",
          });
          return;
        }

        const { newText, changed } = moveColumnLine(currentText, table, column, direction);
        // 端で押された場合(ボタンは disabled のはずだが防御)は何も起きない。
        if (!changed) return;
        applyEdit(newText); // 不正ならapplyEdit内でトースト済み
      });
    },
    [model, currentText, applyEdit, enqueueSnackbar, withCommitGuard],
  );

  // 挿入入力行の確定。currentText(メモリ上の現在テキスト)に最小編集を適用し、
  // applyEditで検証してcurrentTextへ反映する(Docs/計画-保存UNDO計画.md「編集状態の持ち方」)。
  // ディスクへの書き込みはしない(保存は別途 Cmd/Ctrl+S・保存ボタン)。
  // model は currentText のパース結果なので通常 id で見つかるはずだが、念のため
  // 見つからない場合はテーブル/アンカーカラムを名前で再特定(reanchor)する防御を残す。
  const handleCommitInsert = useCallback(
    (input: ColumnInput) => {
      if (!pendingInsert || !model) return;
      withCommitGuard(() => {
        // 非同期処理中に別のセッションが開かれた場合、完了時のクローズで
        // 新しいセッションを巻き添えにしないよう、このコミットの対象を捕まえておく。
        const session = pendingInsert;
        const closeThisSession = () => setPendingInsert((prev) => (prev === session ? null : prev));

        const table = model.tables.find((t) => t.id === pendingInsert.tableId);
        if (!table) {
          enqueueSnackbar("対象テーブルが見つかりませんでした", { variant: "error" });
          closeThisSession();
          return;
        }

        const anchorColumn = pendingInsert.anchorColumnId
          ? table.columns.find((c) => c.id === pendingInsert.anchorColumnId) ?? null
          : null;

        // アンカーが指定されていたのに現行モデルで見つからない場合、名前で再特定を試みる(防御)。
        let targetTable = table;
        let targetAnchor = anchorColumn;
        if (pendingInsert.anchorColumnId && !anchorColumn) {
          const reanchored = reanchor(model, {
            tableName: pendingInsert.tableName,
            anchorColumnName: pendingInsert.anchorColumnName,
          });
          if (!reanchored) {
            enqueueSnackbar("アンカーカラムを再特定できませんでした。編集を中断します。", { variant: "error" });
            closeThisSession();
            return;
          }
          targetTable = reanchored.table;
          targetAnchor = reanchored.anchorColumn;
        }

        const { newText } = insertColumnLine(currentText, targetTable, targetAnchor, pendingInsert.position, input);
        const ok = applyEdit(newText); // 不正ならapplyEdit内でトースト済み。入力行は開いたまま(修正して再確定できる)
        if (ok) {
          closeThisSession();
        }
      });
    },
    [pendingInsert, model, currentText, applyEdit, enqueueSnackbar, withCommitGuard],
  );

  // 既存カラム編集の確定。挿入と同じくcurrentTextに最小編集(行置換)を適用する。
  // 値が何も変わっていなければ適用せずセッションを閉じるだけ(Excel流)。
  const handleCommitEdit = useCallback(
    (input: ColumnInput) => {
      if (!pendingEdit || !model) return;
      withCommitGuard(() => {
        // 非同期処理中に別のセッションが開かれた場合の巻き添えクローズ防止(insert側と同様)。
        const session = pendingEdit;
        const closeThisSession = () => setPendingEdit((prev) => (prev === session ? null : prev));

        const table = model.tables.find((t) => t.id === pendingEdit.tableId);
        let targetTable = table ?? null;
        let targetColumn = table?.columns.find((c) => c.id === pendingEdit.columnId) ?? null;

        // id で見つからない場合の防御(通常は起きないが、旧カラム名での再特定を残す)。
        if (!targetTable || !targetColumn) {
          const reanchored = reanchor(model, {
            tableName: pendingEdit.tableName,
            anchorColumnName: pendingEdit.columnName,
          });
          if (!reanchored || !reanchored.anchorColumn) {
            enqueueSnackbar("編集対象のカラムを再特定できませんでした。編集を中断します。", { variant: "error" });
            closeThisSession();
            return;
          }
          targetTable = reanchored.table;
          targetColumn = reanchored.anchorColumn;
        }

        const { newText, changed } = replaceColumnLine(currentText, targetTable, targetColumn, input);

        if (!changed) {
          // 無変更: 適用せずに閉じるだけ。
          closeThisSession();
          return;
        }

        const ok = applyEdit(newText); // 不正ならapplyEdit内でトースト済み。編集行は開いたまま(修正して再確定できる)
        if (ok) {
          closeThisSession();
        }
      });
    },
    [pendingEdit, model, currentText, applyEdit, enqueueSnackbar, withCommitGuard],
  );

  // 削除確認ダイアログ「削除する」。currentTextに対して最小編集(行削除)を適用する。
  // id で見つからない場合(防御)は、テーブル名+カラム名で再特定する。
  const handleConfirmDelete = useCallback(() => {
    const target = deleteTarget;
    if (!target || !model) {
      setDeleteTarget(null);
      return;
    }
    withCommitGuard(() => {
      const table = model.tables.find((t) => t.id === target.tableId);
      let targetTable = table ?? null;
      let targetColumn = table?.columns.find((c) => c.id === target.columnId) ?? null;

      if (!targetTable || !targetColumn) {
        const reanchored = reanchor(model, {
          tableName: target.tableName,
          anchorColumnName: target.columnName,
        });
        if (!reanchored || !reanchored.anchorColumn) {
          enqueueSnackbar("削除対象のカラムを再特定できませんでした。削除を中断します。", { variant: "error" });
          setDeleteTarget(null);
          return;
        }
        targetTable = reanchored.table;
        targetColumn = reanchored.anchorColumn;
      }

      const { newText } = deleteColumnLine(currentText, targetTable, targetColumn);

      const ok = applyEdit(newText);
      if (ok) {
        enqueueSnackbar(`カラム "${targetColumn.name}" を削除しました`, { variant: "success" });
      } else {
        // Ref破壊などで不正になり適用できなかった(applyEdit内でパースエラートースト済み)。
        // 挿入/編集と違い、削除は入力を直して再確定という道が無い(先にRefを消す必要がある)。
        // ダイアログを開いたままにするとボタンが実質デッドになるため、閉じて明示的に理由を出す
        // (レビュー M-4)。
        enqueueSnackbar(
          `カラム "${targetColumn.name}" は他のリレーション(Ref)から参照されているため削除できません。先に該当するリレーションを削除してください。`,
          { variant: "error" },
        );
      }
      // 成否にかかわらずダイアログは閉じる(成功=削除済み / 失敗=上記の理由を通知済み)。
      setDeleteTarget(null);
    });
  }, [deleteTarget, model, currentText, applyEdit, enqueueSnackbar, withCommitGuard]);

  const closeDeleteTarget = useCallback(() => {
    setDeleteTarget(null);
  }, []);

  return {
    pendingInsert,
    pendingEdit,
    deleteTarget,
    isDuplicateName,
    handleRequestInsert,
    handleRequestEdit,
    handleCancelInsert,
    handleRequestDelete,
    handleRequestMove,
    handleCommitInsert,
    handleCommitEdit,
    handleConfirmDelete,
    closeDeleteTarget,
    resetSession,
  };
}
