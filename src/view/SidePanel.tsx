// 左サイドパネル。Docs/UI設計.md「B. 左サイドパネル」に準拠。
// B-1 テーブル一覧: 全テーブルを「テーブル名|日本語名(noteの1行目)」の2カラムで
//     リスト表示、クリックでフォーカス。ヘッダー行の境界ドラッグでカラム幅を調整できる。
//     絞り込み/フォーカス中は表示中(ヒット/近傍)テーブルを上に並べ、範囲外は薄字で下に置く。
// B-2 フォーカス設定: 対象テーブル名 + 表示範囲ボタン([全体][0][1][2][3][4])。
//     「全体」選択=フォーカス解除、番号選択=そのホップ数に変更(フォーカス中のみ有効)。
// パネル右端のドラッグで全体幅を調整できる。幅はカラム幅とともに localStorage に永続化
// (usePanelLayout.ts)。`⟨`/`⟩` ボタンで折りたたみ可能。
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type Ref,
} from 'react';
import {
  Box,
  Divider,
  IconButton,
  List,
  ListItemButton,
  Slider,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import type { DbmlModel } from '../parser/model';
import { MAX_FOCUS_HOPS, MIN_FOCUS_HOPS, type ViewMode } from './viewMode';
import { MAX_LOD_THRESHOLD, MIN_LOD_THRESHOLD } from './useLodThreshold';
import { SearchField, type SearchFieldHandle } from './SearchField';
import { MIN_NAME_COL_WIDTH, useNameColWidth, usePanelWidth } from './usePanelLayout';

const COLLAPSED_WIDTH = 32;

/** テーブル一覧の行/ヘッダーの左右パディング(px)。カラム境界の位置計算にも使う。 */
const LIST_PX = 12;

/** 「日本語名」カラムに最低限残す幅(px)。テーブル名カラムの実効幅の上限を決める。 */
const MIN_NOTE_COL_WIDTH = 60;

/** 表示範囲ボタンのホップ数候補([0..4])。 */
const HOP_CHOICES = Array.from(
  { length: MAX_FOCUS_HOPS - MIN_FOCUS_HOPS + 1 },
  (_, i) => MIN_FOCUS_HOPS + i,
);

/** 「全体」ボタンの ToggleButtonGroup 上の値。 */
const RANGE_ALL = 'all';

interface SidePanelProps {
  model: DbmlModel | null;
  viewMode: ViewMode;
  /**
   * 表示中テーブルID集合。絞り込みモードでは検索ヒット、フォーカスモードでは
   * 起点+Nホップ近傍。null なら全体モード(=全テーブルを定義順で表示、薄字なし)。
   * この集合に含まれるテーブルを一覧の上に並べ、含まれないものは薄字で下に置く。
   */
  visibleTableIds: ReadonlySet<string> | null;
  collapsed: boolean;
  /** LOD(省略表示)閾値。ズーム率がこの値未満のときテーブルを代表行だけに間引く。 */
  lodThreshold: number;
  onToggleCollapsed: () => void;
  onSelectTable: (tableId: string) => void;
  onChangeFocusHops: (hops: number) => void;
  onClearFocus: () => void;
  /** LOD閾値の変更(スライダー確定時に呼ぶ)。 */
  onChangeLodThreshold: (value: number) => void;
  /** 確定クエリ(debounce済み・IME確定後)の通知。空文字は検索クリアを意味する。 */
  onQueryChange: (query: string) => void;
  /** App 側から検索フィールドを操作するためのハンドル(Cmd/Ctrl+F・Esc 用)。 */
  searchFieldRef: Ref<SearchFieldHandle>;
}

// 検索キー入力などパネルに関係ない再レンダリングを避けるためmemo化。
export const SidePanel = memo(function SidePanel({
  model,
  viewMode,
  visibleTableIds,
  collapsed,
  lodThreshold,
  onToggleCollapsed,
  onSelectTable,
  onChangeFocusHops,
  onClearFocus,
  onChangeLodThreshold,
  onQueryChange,
  searchFieldRef,
}: SidePanelProps) {
  // 表示中(ヒット/近傍)のテーブルを上、それ以外を下に並べる安定ソート。
  // 各グループ内の相対順は元の定義順を維持する。全体モード(null)では定義順のまま。
  // (hooks のため collapsed の早期 return より前に置く)
  const sortedTables = useMemo(() => {
    const tables = model?.tables ?? [];
    if (!visibleTableIds) return tables;
    return [
      ...tables.filter((t) => visibleTableIds.has(t.id)),
      ...tables.filter((t) => !visibleTableIds.has(t.id)),
    ];
  }, [model, visibleTableIds]);

  // スライダーのドラッグ中は親stateを毎フレーム更新せず、ローカルで滑らかに追従させる
  // (確定=onChangeCommitted で初めて親へ伝え、localStorage 保存とLOD再評価を1回にまとめる)。
  // 親の値が外部要因で変わったとき(初期復元など)はローカルにも反映する。
  const [lodDraft, setLodDraft] = useState(lodThreshold);
  useEffect(() => {
    setLodDraft(lodThreshold);
  }, [lodThreshold]);

  // パネル幅とテーブル名カラム幅(いずれも localStorage 永続)。
  const [panelWidth, setPanelWidth] = usePanelWidth();
  const [nameColWidth, setNameColWidth] = useNameColWidth();
  // カラム幅の実効値。パネルを狭めたときは日本語名カラムの最低幅を優先して詰める
  // (保存値は変えず表示だけクランプするので、パネルを広げ直せば元の幅に戻る)。
  const nameWidth = Math.max(
    MIN_NAME_COL_WIDTH,
    Math.min(nameColWidth, panelWidth - LIST_PX * 2 - MIN_NOTE_COL_WIDTH),
  );

  // 幅リサイズのドラッグ状態。ハンドルの pointerdown で開始し、setPointerCapture で
  // 要素外へ出ても move/up を受け続ける(パネル幅・カラム幅の2つのハンドルで共用)。
  const dragRef = useRef<{ startX: number; startWidth: number; apply: (v: number) => void } | null>(
    null,
  );
  const beginDrag = (
    e: ReactPointerEvent<HTMLElement>,
    startWidth: number,
    apply: (v: number) => void,
  ) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startWidth, apply };
  };
  const moveDrag = (e: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (drag) drag.apply(drag.startWidth + (e.clientX - drag.startX));
  };
  const endDrag = () => {
    dragRef.current = null;
  };

  if (collapsed) {
    return (
      <Box
        sx={{
          width: COLLAPSED_WIDTH,
          borderRight: '1px solid',
          borderColor: 'divider',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          pt: 1,
        }}
      >
        <Tooltip title="パネルを開く" placement="right">
          <IconButton size="small" onClick={onToggleCollapsed} aria-label="パネルを開く">
            <ChevronRightIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        {/* 折りたたみ中も検索フィールドは非表示でマウントしておく(Cmd/Ctrl+F で
            フォーカスできる状態を保つ。可視化はしないが検索state自体は生き続ける)。 */}
        <Box sx={{ display: 'none' }}>
          <SearchField ref={searchFieldRef} onQueryChange={onQueryChange} />
        </Box>
      </Box>
    );
  }

  const focusTableId = viewMode.kind === 'focus' ? viewMode.tableId : null;
  const focusHops = viewMode.kind === 'focus' ? viewMode.hops : null;
  const focusTable = focusTableId ? sortedTables.find((t) => t.id === focusTableId) : null;

  return (
    <Box
      sx={{
        width: panelWidth,
        flexShrink: 0,
        borderRight: '1px solid',
        borderColor: 'divider',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        position: 'relative',
      }}
    >
      {/* パネル幅リサイズハンドル。右端の境界線に重ねた細い帯をドラッグする。 */}
      <Box
        role="separator"
        aria-label="パネルの幅を調整"
        onPointerDown={(e) => beginDrag(e, panelWidth, setPanelWidth)}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        sx={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          right: -3,
          width: 7,
          cursor: 'col-resize',
          touchAction: 'none',
          zIndex: 10,
          '&:hover': { bgcolor: 'action.hover' },
        }}
      />
      {/* 検索フィールド(パネル最上部に常設)。テーブル名・カラム名で一覧とER図を絞り込む。 */}
      <Box sx={{ px: 1.5, pt: 1.5, pb: 1, flexShrink: 0 }}>
        <SearchField ref={searchFieldRef} onQueryChange={onQueryChange} />
      </Box>
      <Divider />

      {/* B-1. テーブル一覧 */}
      <Stack sx={{ minHeight: 0, flex: '1 1 auto' }}>
        <Stack
          direction="row"
          sx={{ alignItems: 'center', justifyContent: 'space-between', px: 1.5, py: 1 }}
        >
          <Typography variant="subtitle2">テーブル一覧</Typography>
          <Tooltip title="パネルを折りたたむ">
            <IconButton size="small" onClick={onToggleCollapsed} aria-label="パネルを折りたたむ">
              <ChevronLeftIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
        <Divider />
        {/* カラムヘッダー行。「テーブル名|日本語名」のラベルと、境界に重ねた
            ドラッグハンドル(カラム幅調整)を置く。境界線は各行の日本語名セルの
            borderLeft と同じ x 位置(LIST_PX + nameWidth)に揃えて連続して見せる。 */}
        <Stack
          direction="row"
          sx={{ position: 'relative', alignItems: 'stretch', px: `${LIST_PX}px`, py: 0.5, flexShrink: 0 }}
        >
          <Typography
            variant="caption"
            color="text.secondary"
            noWrap
            sx={{ width: nameWidth, flexShrink: 0, pr: 1 }}
          >
            テーブル名
          </Typography>
          <Box
            sx={{
              flex: 1,
              minWidth: 0,
              borderLeft: '1px solid',
              borderColor: 'divider',
              pl: 1,
            }}
          >
            <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
              日本語名
            </Typography>
          </Box>
          <Box
            role="separator"
            aria-label="テーブル名カラムの幅を調整"
            onPointerDown={(e) => beginDrag(e, nameWidth, setNameColWidth)}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            sx={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: LIST_PX + nameWidth - 4,
              width: 9,
              cursor: 'col-resize',
              touchAction: 'none',
              zIndex: 1,
              '&:hover': { bgcolor: 'action.hover' },
            }}
          />
        </Stack>
        <Divider />
        <List
          dense
          disablePadding
          sx={{ overflowY: 'auto', flex: 1, minHeight: 0 }}
        >
          {sortedTables.map((table) => {
            const isHidden = visibleTableIds != null && !visibleTableIds.has(table.id);
            const isSelected = table.id === focusTableId;
            const note = table.note ? table.note.split('\n')[0] : undefined;
            return (
              <ListItemButton
                key={table.id}
                selected={isSelected}
                onClick={() => onSelectTable(table.id)}
                sx={{
                  py: 0.5,
                  px: `${LIST_PX}px`,
                  opacity: isHidden ? 0.35 : 1,
                }}
              >
                <Typography
                  variant="body2"
                  noWrap
                  title={table.name}
                  sx={{ width: nameWidth, flexShrink: 0, pr: 1 }}
                >
                  {table.name}
                </Typography>
                <Box
                  sx={{
                    flex: 1,
                    minWidth: 0,
                    alignSelf: 'stretch',
                    display: 'flex',
                    alignItems: 'center',
                    borderLeft: '1px solid',
                    borderColor: 'divider',
                    pl: 1,
                  }}
                >
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    noWrap
                    title={note}
                    sx={{ flex: 1, minWidth: 0 }}
                  >
                    {note}
                  </Typography>
                </Box>
              </ListItemButton>
            );
          })}
        </List>
      </Stack>

      <Divider />

      {/* B-2. フォーカス設定 */}
      <Box sx={{ px: 1.5, py: 1.5, flexShrink: 0 }}>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          フォーカス設定
        </Typography>
        <Typography variant="body2" sx={{ mb: 1 }} noWrap title={focusTable?.name}>
          対象: {focusTable ? focusTable.name : 'なし'}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          表示範囲{focusHops != null ? ` (${focusHops}ホップ)` : ''}
        </Typography>
        {/* [全体][0][1][2][3][4] の排他ボタン。「全体」=フォーカス解除、番号=ホップ数変更。
            現在の状態(全体 or フォーカス中のホップ数)が常に選択表示される。 */}
        <ToggleButtonGroup
          exclusive
          size="small"
          fullWidth
          value={focusHops ?? RANGE_ALL}
          onChange={(_, value) => {
            // 選択中ボタンの再クリック(選択解除)は null が来るので無視する。
            if (value == null) return;
            if (value === RANGE_ALL) {
              onClearFocus();
            } else {
              onChangeFocusHops(value as number);
            }
          }}
          sx={{ mt: 0.5 }}
        >
          <ToggleButton value={RANGE_ALL} sx={{ px: 0.5, py: 0.5, whiteSpace: 'nowrap' }}>
            全体
          </ToggleButton>
          {HOP_CHOICES.map((n) => (
            <ToggleButton
              key={n}
              value={n}
              disabled={focusTableId == null}
              sx={{ px: 0, py: 0.5, minWidth: 0 }}
            >
              {n}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Box>

      <Divider />

      {/* 表示設定: LOD(省略表示)閾値。ズーム率がこの値未満のとき、テーブルは代表行だけに
          間引いて描画される。値を上げるほど早く(大きめのズームでも)省略され、下げるほど
          縮小しても全カラムを描き続ける(そのぶん俯瞰時は重くなる)。 */}
      <Box sx={{ px: 1.5, py: 1.5, flexShrink: 0 }}>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          表示設定
        </Typography>
        <Stack direction="row" sx={{ alignItems: 'baseline', justifyContent: 'space-between' }}>
          <Tooltip title="この値よりズームが小さいと、テーブルは代表行(PK/FK)だけに省略されます。値を上げると早めに省略、下げると縮小しても全カラムを表示します。">
            <Typography variant="caption" color="text.secondary">
              省略表示のしきい値
            </Typography>
          </Tooltip>
          <Typography variant="caption" color="text.secondary">
            {lodDraft.toFixed(2)}
          </Typography>
        </Stack>
        <Slider
          size="small"
          min={MIN_LOD_THRESHOLD}
          max={MAX_LOD_THRESHOLD}
          step={0.05}
          value={lodDraft}
          onChange={(_, value) => setLodDraft(value as number)}
          onChangeCommitted={(_, value) => onChangeLodThreshold(value as number)}
          aria-label="省略表示のしきい値"
          sx={{ mt: 0.5 }}
        />
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          小さく縮小したときほど省略表示になります
        </Typography>
      </Box>
    </Box>
  );
});
