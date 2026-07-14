// トップバー: ファイル名 + ファイル操作(開く・履歴) + 配色モード切替。
// Docs/UI設計.md「A. トップバー」に準拠。
//
// 検索フィールドは左サイドパネル(SidePanel)へ移設済み。トップバーはファイル操作と
// 全体設定に専念する。
import {
  AppBar,
  Toolbar,
  Typography,
  IconButton,
  Tooltip,
  Menu,
  MenuItem,
  ListItemText,
} from '@mui/material';
import { useState } from 'react';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import HistoryIcon from '@mui/icons-material/History';
import LightModeIcon from '@mui/icons-material/LightMode';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import SaveIcon from '@mui/icons-material/Save';
import UndoIcon from '@mui/icons-material/Undo';
import RedoIcon from '@mui/icons-material/Redo';
import RefreshIcon from '@mui/icons-material/Refresh';
import type { ColorMode } from '../theme/theme';

interface TopBarProps {
  onOpenFile: () => void;
  /** 現在の配色モード(light/dark)。トグルボタンのアイコン切替に使う。 */
  colorMode: ColorMode;
  /** 配色モードの切替。 */
  onToggleColorMode: () => void;
  /** 最近開いたファイル(新しい順のフルパス一覧)。履歴メニューに表示する。 */
  recentFiles: string[];
  /** 履歴からファイルを選んだときの通知(フルパス)。 */
  onSelectRecent: (path: string) => void;
  /** 未保存の編集があるか(Docs/計画-保存UNDO計画.md)。タイトルの「*」表示・保存ボタンに使う。 */
  isDirty: boolean;
  /** 明示保存(Cmd/Ctrl+Sと共通処理)。 */
  onSave: () => void;
  /** 1つ前のcurrentTextへ戻す。 */
  onUndo: () => void;
  /** undoを取り消し、1つ先へ進める。 */
  onRedo: () => void;
  /** undoできる履歴があるか。 */
  canUndo: boolean;
  /** redoできる履歴があるか。 */
  canRedo: boolean;
  /** ディスクから手動で再読み込みする(監視は廃止済み)。 */
  onReload: () => void;
  /** 開いているファイルのフルパス(未オープンは null)。ファイル名表示に使う。 */
  filePath: string | null;
}

export function TopBar({
  onOpenFile,
  colorMode,
  onToggleColorMode,
  recentFiles,
  onSelectRecent,
  isDirty,
  onSave,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onReload,
  filePath,
}: TopBarProps) {
  // 履歴メニューのアンカー要素(null=閉じている)。
  const [recentAnchorEl, setRecentAnchorEl] = useState<null | HTMLElement>(null);
  const recentMenuOpen = recentAnchorEl != null;

  // フルパスの末尾(ベース名)だけを表示する。区切りは / と \ の両方に対応。
  const fileName = filePath ? (filePath.split(/[/\\]/).pop() ?? filePath) : 'ファイル未選択';

  return (
    <AppBar position="static" color="default" elevation={1}>
      <Toolbar variant="dense" sx={{ gap: 1 }}>
        <Tooltip title="DBMLファイルを開く">
          <IconButton onClick={onOpenFile} size="small" color="inherit" aria-label="DBMLファイルを開く">
            <FolderOpenIcon />
          </IconButton>
        </Tooltip>
        <Tooltip title="最近開いたファイル">
          {/* disabled時もTooltipのイベントをつなぐためspanでIconButtonを包む(MUI推奨)。 */}
          <span>
            <IconButton
              onClick={(e) => setRecentAnchorEl(e.currentTarget)}
              size="small"
              color="inherit"
              aria-label="最近開いたファイル"
              disabled={recentFiles.length === 0}
            >
              <HistoryIcon />
            </IconButton>
          </span>
        </Tooltip>
        <Menu
          anchorEl={recentAnchorEl}
          open={recentMenuOpen}
          onClose={() => setRecentAnchorEl(null)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
          transformOrigin={{ vertical: 'top', horizontal: 'left' }}
          slotProps={{ paper: { sx: { maxWidth: '80vw' } } }}
        >
          {recentFiles.map((path) => (
            <MenuItem
              key={path}
              onClick={() => {
                setRecentAnchorEl(null);
                onSelectRecent(path);
              }}
            >
              {/* フルパスを表示。長い場合は末尾を省略(…)し、全体はホバーの title で確認できる。 */}
              <ListItemText
                primary={path}
                slotProps={{
                  primary: {
                    sx: {
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    },
                    title: path,
                  },
                }}
              />
            </MenuItem>
          ))}
        </Menu>
        <Tooltip title="保存 (Cmd/Ctrl+S)">
          {/* disabled時もTooltipのイベントをつなぐためspanでIconButtonを包む(MUI推奨)。 */}
          <span>
            <IconButton onClick={onSave} size="small" color="inherit" aria-label="保存" disabled={!isDirty}>
              <SaveIcon />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="元に戻す (Cmd/Ctrl+Z)">
          <span>
            <IconButton onClick={onUndo} size="small" color="inherit" aria-label="元に戻す" disabled={!canUndo}>
              <UndoIcon />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="やり直す (Cmd/Ctrl+Shift+Z)">
          <span>
            <IconButton onClick={onRedo} size="small" color="inherit" aria-label="やり直す" disabled={!canRedo}>
              <RedoIcon />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="ディスクから再読み込み">
          <IconButton onClick={onReload} size="small" color="inherit" aria-label="ディスクから再読み込み">
            <RefreshIcon />
          </IconButton>
        </Tooltip>

        {/* 開いているファイル名(ベース名)を表示。長い場合は末尾を省略し、全体はホバーのtitleで確認できる。 */}
        <Typography
          variant="subtitle1"
          component="div"
          title={filePath ?? undefined}
          sx={{
            mr: 2,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {fileName}
          {isDirty ? ' *' : ''}
        </Typography>

        <Tooltip title={colorMode === 'light' ? 'ダークテーマに切替' : 'ライトテーマに切替'}>
          <IconButton
            onClick={onToggleColorMode}
            size="small"
            color="inherit"
            aria-label="配色モードを切り替え"
            sx={{ ml: 'auto' }}
          >
            {colorMode === 'light' ? <DarkModeIcon /> : <LightModeIcon />}
          </IconButton>
        </Tooltip>
      </Toolbar>
    </AppBar>
  );
}
