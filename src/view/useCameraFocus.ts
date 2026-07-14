// カメラ(視点)移動コマンド(Docs/設計-視点移動.md)とフォーカス遷移ハンドラ一式をまとめるフック。
// 「視点を動かすべき操作」だけが cameraCommand の seq をインクリメントして発行する。ErCanvas は
// seq の変化にのみ反応するため、viewMode 変化それ自体からは絶対に視点が動かない。
import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { CameraCommand } from "./ErCanvas";
import type { ViewMode } from "./viewMode";
import type { ModelUpdateKind } from "../parser/useDbmlFile";
import type { SearchFieldHandle } from "./SearchField";

interface UseCameraFocusParams {
  viewMode: ViewMode;
  /** F1(open)判定に使う。useDbmlFile の modelUpdate をそのまま渡す。 */
  modelUpdate: { kind: ModelUpdateKind; seq: number } | null;
  focusTable: (tableId: string) => void;
  setFocusHops: (hops: number) => void;
  clearFocus: () => void;
  searchFieldRef: RefObject<SearchFieldHandle | null>;
  /** 開いている編集セッション(挿入/既存カラム編集)を全リセットする(useColumnEditSession由来)。 */
  resetEditSession: () => void;
}

export interface UseCameraFocusResult {
  cameraCommand: CameraCommand | null;
  fireCameraCommand: (type: CameraCommand["type"]) => void;
  /** C1/C2(キャンバス内クリック)専用。カメラは動かさない(Docs/設計-視点移動.md)。 */
  handleSelectTable: (tableId: string) => void;
  /** P1(左パネルの一覧クリック)専用。フォーカス遷移+カメラ移動(fit-tables)を発行する。 */
  handleSelectTableFromPanel: (tableId: string) => void;
  /** P2(表示範囲ボタンでのホップ数変更)専用。新しい近傍集合へのカメラ移動を発行する。 */
  handleChangeFocusHopsFromPanel: (hops: number) => void;
  /** フォーカス解除。C4(背景クリック/Esc)専用: 濃淡が戻るだけでカメラは動かさない。 */
  handleClearFocus: () => void;
  /** P3(左パネル「全体」ボタン)専用。フォーカス解除に加えて全体フィットを発行する。 */
  handleClearFocusFromPanel: () => void;
}

export function useCameraFocus({
  viewMode,
  modelUpdate,
  focusTable,
  setFocusHops,
  clearFocus,
  searchFieldRef,
  resetEditSession,
}: UseCameraFocusParams): UseCameraFocusResult {
  const [cameraCommand, setCameraCommand] = useState<CameraCommand | null>(null);
  const cameraSeqRef = useRef(0);
  const fireCameraCommand = useCallback((type: CameraCommand["type"]) => {
    cameraSeqRef.current += 1;
    setCameraCommand({ seq: cameraSeqRef.current, type });
  }, []);

  // F1: ファイルを開いた(open)ときだけ全体フィットする。F2(外部変更の自動リロード)/
  // F3(アプリ内編集の保存)では発行しない = 視点維持。
  useEffect(() => {
    if (modelUpdate?.kind === "open") {
      fireCameraCommand("fit-all");
    }
  }, [modelUpdate, fireCameraCommand]);

  // テーブルにフォーカスするとき、検索欄の表示テキストも合わせてクリアする
  // (モードは排他。TopBar 内部の生入力を ref 経由で空にし、空クエリが即時通知される)。
  // C1/C2(キャンバス内クリック)専用。「探して飛びたい」操作ではないためカメラは動かさない
  // (Docs/設計-視点移動.md)。
  const handleSelectTable = useCallback(
    (tableId: string) => {
      // 既にフォーカス起点になっているテーブルへの再選択では編集セッションを壊さない。
      // 右クリックメニュー「上/下に追加」のクリックが背後の React Flow ノードに伝播し、
      // setPendingInsert 直後に同一テーブルへの再フォーカスが走って編集行が即座に消える問題を防ぐ
      // (別テーブルへ遷移するときだけ、開いている編集セッションを破棄する)。
      if (viewMode.kind === "focus" && viewMode.tableId === tableId) return;
      // 編集入力行が開いている間はテーブル遷移で握りつぶさない(破棄されるため一旦閉じる)。
      resetEditSession();
      searchFieldRef.current?.clearSearch();
      focusTable(tableId);
    },
    [focusTable, viewMode, resetEditSession, searchFieldRef],
  );

  // P1(左パネルの一覧クリック)専用。「画面外にあるかもしれない対象を探す」操作なので、
  // フォーカス遷移に加えて起点+近傍へのカメラ移動(fit-tables)を発行する。
  const handleSelectTableFromPanel = useCallback(
    (tableId: string) => {
      handleSelectTable(tableId);
      fireCameraCommand("fit-tables");
    },
    [handleSelectTable, fireCameraCommand],
  );

  // P2(表示範囲ボタンでのホップ数変更)専用。新しい近傍集合へのカメラ移動を発行する。
  const handleChangeFocusHopsFromPanel = useCallback(
    (hops: number) => {
      setFocusHops(hops);
      fireCameraCommand("fit-tables");
    },
    [setFocusHops, fireCameraCommand],
  );

  // フォーカス解除。C4(背景クリック/Esc)専用: 濃淡が戻るだけでカメラは動かさない
  // (Docs/設計-視点移動.md)。開いている編集セッションも破棄する
  // (編集行が非表示になるのにセッションだけ残ると、見えない編集中扱いのまま残るため)。
  const handleClearFocus = useCallback(() => {
    resetEditSession();
    clearFocus();
  }, [clearFocus, resetEditSession]);

  // P3(左パネル「全体」ボタン)専用。フォーカス解除に加えて全体フィットを発行する。
  const handleClearFocusFromPanel = useCallback(() => {
    handleClearFocus();
    fireCameraCommand("fit-all");
  }, [handleClearFocus, fireCameraCommand]);

  return {
    cameraCommand,
    fireCameraCommand,
    handleSelectTable,
    handleSelectTableFromPanel,
    handleChangeFocusHopsFromPanel,
    handleClearFocus,
    handleClearFocusFromPanel,
  };
}
