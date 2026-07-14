import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ThemeProvider, CssBaseline, Box } from "@mui/material";
import { SnackbarProvider, useSnackbar } from "notistack";
import { TopBar } from "./view/TopBar";
import { StatusBar } from "./view/StatusBar";
import { ErCanvas } from "./view/ErCanvas";
import { SidePanel } from "./view/SidePanel";
import type { SearchFieldHandle } from "./view/SearchField";
import { useDbmlFile } from "./parser/useDbmlFile";
import { useSidecarAutosave } from "./meta/useSidecarAutosave";
import { useRecentFiles } from "./parser/useRecentFiles";
import { useViewMode } from "./view/useViewMode";
import { useLodThreshold } from "./view/useLodThreshold";
import { useDiscardGuard } from "./view/useDiscardGuard";
import { useDerivedModelViews } from "./view/useDerivedModelViews";
import { useColumnEditSession } from "./view/useColumnEditSession";
import { useCameraFocus } from "./view/useCameraFocus";
import { useGlobalShortcuts } from "./view/useGlobalShortcuts";
import { DiscardGuardDialog } from "./view/DiscardGuardDialog";
import { DeleteColumnDialog } from "./view/DeleteColumnDialog";
import { PerfOverlay } from "./perf/PerfOverlay";
import { getTheme, getModeColors, type ColorMode } from "./theme/theme";
import { useColorMode } from "./theme/useColorMode";
import { ModeColorsProvider } from "./theme/ModeColorsContext";

// App.tsx は状態の結線に徹する(実処理は parser/layout/view/edit 配下に委譲)。
// 検索の生入力(1キーごとの state)は TopBar 内部に閉じており、App には
// debounce済み・IME確定後の確定クエリだけが setDebouncedQuery 経由で届く
// (キー入力のたびにアプリ全体が再レンダリングされるのを防ぐ)。
function AppContent({ colorMode, onToggleColorMode }: { colorMode: ColorMode; onToggleColorMode: () => void }) {
  const { enqueueSnackbar } = useSnackbar();
  const {
    filePath,
    model,
    isLoading,
    currentText,
    isDirty,
    savedPositions,
    savedColumnWidths,
    modelUpdate,
    openFile,
    openPath,
    applyEdit,
    undo,
    redo,
    canUndo,
    canRedo,
    saveFile,
    reloadFromDisk,
    saveSidecarState,
  } = useDbmlFile();
  const { recentFiles, add: addRecent, remove: removeRecent } = useRecentFiles();
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const searchFieldRef = useRef<SearchFieldHandle>(null);

  // LOD(省略表示)閾値。左パネルのスライダーで調整し、localStorage に永続化する。
  const [lodThreshold, setLodThreshold] = useLodThreshold();

  // 表示モード(全体/絞り込み/フォーカス)の遷移は useViewMode に集約する。
  const { viewMode, debouncedQuery, focusTable, setFocusHops, clearFocus, setDebouncedQuery } =
    useViewMode();

  // 開いているファイルが確定したら履歴の先頭へ記録する(ダイアログ/履歴どちらの経路も
  // filePath 変化で一括して拾う)。同一パスは先頭へ繰り上げ、最大件数で溢れる。
  useEffect(() => {
    if (filePath) addRecent(filePath);
  }, [filePath, addRecent]);

  // 未保存破棄ガード(Docs/計画-保存UNDO計画.md「未保存破棄のガード」)一式は useDiscardGuard に集約する。
  // 「別ファイルを開く」「履歴から開く」「ウィンドウを閉じる」の前に、未保存編集があれば確認する。
  const {
    discardGuardOpen,
    guardDiscard,
    closeDiscardGuard,
    handleDiscardAndProceed,
    handleSaveAndProceed,
    handleOpenFile,
    handleSelectRecentGuarded,
  } = useDiscardGuard({
    isDirty,
    saveFile,
    openFile,
    openPath,
    removeRecent,
    enqueueSnackbar,
  });

  // 見た目状態(配置座標 + 列幅)のサイドカー保存(debounce・アンマウント時flush込み)は
  // useSidecarAutosave に集約する(.dbml 本体は一切変更しない)。
  const { handlePositionsChange, handleColumnWidthsChange } = useSidecarAutosave({
    savedColumnWidths,
    saveSidecarState,
  });

  // フェーズ4: インライン編集セッション(挿入/既存カラム編集/削除)一式は useColumnEditSession に集約する。
  const {
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
    resetSession: resetEditSession,
  } = useColumnEditSession({
    model,
    currentText,
    applyEdit,
    enqueueSnackbar,
    focusTable,
    searchFieldRef,
  });

  // カメラ(視点)移動コマンド(Docs/設計-視点移動.md)とフォーカス遷移ハンドラ一式は useCameraFocus に集約する。
  const {
    cameraCommand,
    fireCameraCommand,
    handleSelectTable,
    handleSelectTableFromPanel,
    handleChangeFocusHopsFromPanel,
    handleClearFocus,
    handleClearFocusFromPanel,
  } = useCameraFocus({
    viewMode,
    modelUpdate,
    focusTable,
    setFocusHops,
    clearFocus,
    searchFieldRef,
    resetEditSession,
  });

  const handleToggleCollapsed = useCallback(() => {
    setPanelCollapsed((prev) => !prev);
  }, []);

  // 明示保存(ツールバー/Cmd+S共通)。
  const handleSave = useCallback(() => {
    void saveFile();
  }, [saveFile]);

  // 手動リロード(Docs/計画-保存UNDO計画.md「ファイル監視の廃止と手動リロード」)。
  // 未保存編集があれば破棄確認ダイアログを経由してから読み直す。
  const handleReload = useCallback(() => {
    guardDiscard(() => reloadFromDisk());
  }, [guardDiscard, reloadFromDisk]);

  // グローバルキーボードショートカット(F12/IME変換中判定/Cmd+S/Cmd+Z/Cmd+F/Cmd+0/Esc)は
  // useGlobalShortcuts に集約する。
  useGlobalShortcuts({
    viewMode,
    discardGuardOpen,
    fireCameraCommand,
    handleSave,
    undo,
    redo,
    handleClearFocus,
    searchFieldRef,
  });

  // model・viewMode からの派生値(隣接グラフ・表示中テーブルID集合・フォーカス起点・型入力候補)は
  // useDerivedModelViews に集約する。
  const { visibleTableIds, focusOriginId, typeOptions } = useDerivedModelViews(model, viewMode);

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        width: "100vw",
        height: "100vh",
        // React Flow のUI部品(Controls/MiniMap)はデフォルトCSSが持つ色で描かれるため、
        // MUIテーマの色に合わせて CSS変数を上書きし、ライト/ダーク双方で地に馴染ませる。
        "& .react-flow__controls-button": {
          bgcolor: "background.paper",
          borderBottomColor: "divider",
          color: "text.primary",
          fill: "currentColor",
          "&:hover": { bgcolor: "action.hover" },
        },
        "& .react-flow__minimap": {
          bgcolor: "background.paper",
        },
      }}
    >
      <TopBar
        onOpenFile={handleOpenFile}
        colorMode={colorMode}
        onToggleColorMode={onToggleColorMode}
        recentFiles={recentFiles}
        onSelectRecent={handleSelectRecentGuarded}
        isDirty={isDirty}
        onSave={handleSave}
        onUndo={undo}
        onRedo={redo}
        canUndo={canUndo}
        canRedo={canRedo}
        onReload={handleReload}
        filePath={filePath}
      />
      <Box sx={{ flex: 1, display: "flex", minHeight: 0 }}>
        <SidePanel
          model={model}
          viewMode={viewMode}
          visibleTableIds={visibleTableIds}
          collapsed={panelCollapsed}
          lodThreshold={lodThreshold}
          onToggleCollapsed={handleToggleCollapsed}
          onSelectTable={handleSelectTableFromPanel}
          onChangeFocusHops={handleChangeFocusHopsFromPanel}
          onClearFocus={handleClearFocusFromPanel}
          onChangeLodThreshold={setLodThreshold}
          onQueryChange={setDebouncedQuery}
          searchFieldRef={searchFieldRef}
        />
        <ErCanvas
          model={model}
          viewMode={viewMode}
          debouncedQuery={debouncedQuery}
          lodThreshold={lodThreshold}
          cameraCommand={cameraCommand}
          onSelectTable={handleSelectTable}
          onClearFocus={handleClearFocus}
          focusOriginId={focusOriginId}
          typeOptions={typeOptions}
          pendingInsert={pendingInsert}
          pendingEdit={pendingEdit}
          onRequestInsert={handleRequestInsert}
          onRequestDelete={handleRequestDelete}
          onRequestMove={handleRequestMove}
          onRequestEdit={handleRequestEdit}
          onCommitInsert={handleCommitInsert}
          onCommitEdit={handleCommitEdit}
          onCancelInsert={handleCancelInsert}
          isDuplicateName={isDuplicateName}
          savedPositions={savedPositions}
          savedColumnWidths={savedColumnWidths}
          onPositionsChange={handlePositionsChange}
          onColumnWidthsChange={handleColumnWidthsChange}
        />
      </Box>
      <StatusBar
        filePath={filePath}
        tableCount={model?.tables.length ?? 0}
        refCount={model?.refs.length ?? 0}
        syncing={isLoading}
      />

      {/* 未保存破棄ガード(Docs/計画-保存UNDO計画.md「未保存破棄のガード」)。
          別ファイルを開く/履歴選択/手動リロードの前に、未保存編集があれば確認する。 */}
      <DiscardGuardDialog
        open={discardGuardOpen}
        onClose={closeDiscardGuard}
        onDiscardAndProceed={handleDiscardAndProceed}
        onSaveAndProceed={handleSaveAndProceed}
      />

      {/* カラム削除の確認ダイアログ。Ref で参照されている場合は警告文を併記する。 */}
      <DeleteColumnDialog deleteTarget={deleteTarget} onClose={closeDeleteTarget} onConfirm={handleConfirmDelete} />
    </Box>
  );
}

function App() {
  const [colorMode, toggleColorMode] = useColorMode();
  const theme = useMemo(() => getTheme(colorMode), [colorMode]);
  const modeColors = useMemo(() => getModeColors(colorMode), [colorMode]);
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <ModeColorsProvider value={modeColors}>
        <SnackbarProvider maxSnack={3} anchorOrigin={{ vertical: "bottom", horizontal: "right" }}>
          <AppContent colorMode={colorMode} onToggleColorMode={toggleColorMode} />
          <PerfOverlay />
        </SnackbarProvider>
      </ModeColorsProvider>
    </ThemeProvider>
  );
}

export default App;
