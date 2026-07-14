// カラムのインライン入力行。Docs/UI設計.md「E-1」(追加) + 「E-2 セル直接編集」(既存カラム編集)に対応。
// テーブルノード内の対象位置にその場で表示され、Excel感覚でセル入力する。
// Tab/Shift+Tabでセル移動、Enter/外側クリックで確定、Escで破棄(Excel流)。
// Tab の順序は DOM 順(=見た目の順)。note 列を持たないテーブルでは note が補助段へ回るため、
// note と PK/NN/default の前後関係が入れ替わる(どちらも見た目の並びとは一致する)。
// React Flow のノードドラッグ/パン/背景クリックと干渉しないよう nodrag/nopan を付与し、
// クリック/キー入力イベントの伝播を止める。
//
// レイアウト(2026-07-14 ユーザー決定): 編集開始で行がガタつかないよう、1段目は表示行と
// 同一のグリッド(アイコン | 名前 | 型 | note)・同一の列幅・同一の行高で描き、名前/型/note の
// 入力欄を表示セルに重ねる。表示行に対応する場所が無い PK/NOT NULL/default は、行の直下に
// 補助段としてせり出させる(編集中だけ行が下に伸びる。ノード高さは固定していないので切れない)。
// このため列幅テンプレート(gridTemplate)と行高(rowHeight)は TableNode から受け取る。
import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Checkbox, Stack, TextField, Tooltip } from '@mui/material';
import type { Theme } from '@mui/material/styles';
import type { ColumnInput } from '../edit/lineFormat';
import {
  COLUMN_GAP,
  ICON_COL_WIDTH,
  MOVE_GUTTER_WIDTH,
  NOTE_LINE_HEIGHT,
  ROW_HEIGHT,
  ROW_PADDING_X,
  editContentColumnWidth,
} from '../layout/nodeSize';

/** 初期フォーカスを合わせるセル(ダブルクリックしたセルに合わせる用)。 */
export type EditRowFocusField = 'name' | 'type' | 'default' | 'note';

export interface ColumnEditRowProps {
  /** 型候補(モデル中の既出型 + Enum名)。datalistとして提示する。 */
  typeOptions: string[];
  /** 確定(Enter/外側クリック)時に呼ばれる。バリデーションNGならこの関数を呼ばずエラー表示のみ行う。 */
  onCommit: (input: ColumnInput) => void;
  /** 破棄(Esc)時に呼ばれる。 */
  onCancel: () => void;
  /** カラム名の重複チェック(true なら重複エラー)。編集モードでは自分自身を除外した判定を渡すこと。 */
  isDuplicateName: (name: string) => boolean;
  /** 既存カラム編集時の初期値(未指定なら空=追加モード)。note/default はUI入力表記。 */
  initialValues?: ColumnInput;
  /** 初期フォーカスセル(既定: name)。 */
  autoFocusField?: EditRowFocusField;
  /** 表示行と同じ列テンプレート(TableNode の rowGridTemplate)。1段目をこれで敷いて列位置を揃える。 */
  gridTemplate: string;
  /** 置き換える表示行の高さ(px)。1段目の最小高に使う。追加モードでは ROW_HEIGHT を渡す。 */
  rowHeight: number;
  /** note列がテーブルに存在するか。無い場合は1段目に note セルが無いので、note入力を補助段へ回す。 */
  hasNoteColumn: boolean;
  /**
   * 入力内容(名前/型/note)が収まるために必要な列幅(px)の通知。入力のたびに呼ばれる。
   * TableNode 側は現在の列幅を超えた列だけライブで広げ、編集中のテキストが切れないようにする
   * (2026-07-14 ユーザー決定「切れないこと最優先」。Docs/設計-行オーバレイ.md)。
   */
  onContentWidthsChange?: (widths: { name: number; type: number; note: number }) => void;
}

const TYPE_DATALIST_ID = 'jpdbml-column-type-options';

export function ColumnEditRow({
  typeOptions,
  onCommit,
  onCancel,
  isDuplicateName,
  initialValues,
  autoFocusField = 'name',
  gridTemplate,
  rowHeight,
  hasNoteColumn,
  onContentWidthsChange,
}: ColumnEditRowProps) {
  const [name, setName] = useState(initialValues?.name ?? '');
  const [type, setType] = useState(initialValues?.type ?? '');
  const [pk, setPk] = useState(initialValues?.pk ?? false);
  const [notNull, setNotNull] = useState(initialValues?.notNull ?? false);
  const [defaultValue, setDefaultValue] = useState(initialValues?.defaultValue ?? '');
  const [note, setNote] = useState(initialValues?.note ?? '');
  const [nameError, setNameError] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const typeInputRef = useRef<HTMLInputElement>(null);
  const defaultInputRef = useRef<HTMLInputElement>(null);
  // note は複数行入力(Excelと同じ Alt/Option+Enter でセル内改行)なので textarea。
  const noteInputRef = useRef<HTMLTextAreaElement>(null);
  // Alt+Enter で改行を差し込んだ直後にキャレットを戻す位置(null=復元不要)。
  const noteCaretRef = useRef<number | null>(null);

  // マウント時に指定セルへ自動フォーカス(全文選択して即打ち替えできるように)。
  useEffect(() => {
    const target =
      autoFocusField === 'type'
        ? typeInputRef.current
        : autoFocusField === 'default'
          ? defaultInputRef.current
          : autoFocusField === 'note'
            ? noteInputRef.current
            : nameInputRef.current;
    target?.focus();
    target?.select();
    // 初回のみでよい(編集途中でフォーカスを奪い直さない)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 入力のたびに、内容が収まるために必要な列幅を親(TableNode)へ通知する。
  // 親は現在の列幅を超えた列だけライブで広げる(切れないこと最優先)。
  // placeholder(カラム名/型)が見える最低幅も確保するため、空でもその字幅ぶんは要求する。
  const onContentWidthsChangeRef = useRef(onContentWidthsChange);
  useEffect(() => {
    onContentWidthsChangeRef.current = onContentWidthsChange;
  }, [onContentWidthsChange]);
  useEffect(() => {
    const notify = onContentWidthsChangeRef.current;
    if (!notify) return;
    // note は複数行(textarea の実改行)なので最長行に合わせる。
    const noteNeeded = note
      ? Math.max(...note.split(/\r?\n/).map((line) => editContentColumnWidth(line, 'cell')))
      : 0;
    notify({
      name: editContentColumnWidth(name || 'カラム名', 'name'),
      type: editContentColumnWidth(type || '型', 'cell'),
      note: noteNeeded,
    });
  }, [name, type, note]);

  // Alt+Enter による改行挿入後、キャレットを挿入した改行の直後へ戻す。
  // (setNote による再レンダリングでキャレットが末尾へ飛ぶのを防ぐ)
  useEffect(() => {
    const pos = noteCaretRef.current;
    if (pos == null) return;
    noteCaretRef.current = null;
    noteInputRef.current?.setSelectionRange(pos, pos);
  }, [note]);

  /**
   * note セル内での Alt(Option)+Enter を「セル内改行」にする(Excelと同じ操作)。
   * 素の Enter は親の handleKeyDown に委ねて従来どおり確定させる。
   * IME変換中(変換確定のEnter)は改行を挿入しない。isComposing だけでは環境により
   * 取りこぼすため keyCode 229 も併用する(プロジェクト規約)。
   */
  const handleNoteKeyDown = (e: React.KeyboardEvent) => {
    const isComposing = e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229;
    if (e.key !== 'Enter' || !e.altKey || isComposing) return;
    e.preventDefault();
    e.stopPropagation(); // 親の Enter=確定 を発火させない
    const el = noteInputRef.current;
    const start = el?.selectionStart ?? note.length;
    const end = el?.selectionEnd ?? start;
    noteCaretRef.current = start + 1;
    setNote(`${note.slice(0, start)}\n${note.slice(end)}`);
  };

  const validate = useCallback((): string | null => {
    const trimmed = name.trim();
    if (trimmed.length === 0) return 'カラム名を入力してください';
    // DBMLはダブルクォート名の中の `\"` エスケープを受理しないため、`"` を含む名前は事前拒否する
    // (許すと保存前パース検証で分かりにくいエラーになる)。
    if (trimmed.includes('"')) return 'カラム名にダブルクォート(")は使用できません';
    if (isDuplicateName(trimmed)) return `カラム名 "${trimmed}" は既に存在します`;
    return null;
  }, [name, isDuplicateName]);

  const commit = useCallback(() => {
    const error = validate();
    if (error) {
      setNameError(error);
      return;
    }
    setNameError(null);
    onCommit({
      name: name.trim(),
      type: type.trim() || 'varchar',
      pk,
      notNull,
      defaultValue,
      note,
    });
  }, [validate, onCommit, name, type, pk, notNull, defaultValue, note]);

  // Excel流: 編集行の外側をポインタダウンしたら確定を試みる(バリデーションNGなら開いたまま)。
  // - capture段階で拾う(React Flow等が stopPropagation しても検知できるように)。
  // - MUI のポータル(Menu/Dialog/Popover)や notistack のトースト内のクリックは「外側」とみなさない
  //   (保存衝突ダイアログのボタン操作等で誤確定しないため)。
  const commitRef = useRef(commit);
  useEffect(() => {
    commitRef.current = commit;
  }, [commit]);
  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      if (rootRef.current?.contains(target)) return; // 行内クリック
      if (target.closest('.MuiModal-root, .MuiPopover-root, [role="menu"], .notistack-SnackbarContainer')) {
        return; // ポータル内クリックは無視
      }
      commitRef.current();
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, []);

  // Enter確定・Esc破棄。stopPropagationでReact Flowの
  // キーボードショートカット(Delete等)やアプリ側のグローバルショートカットに渡さない。
  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    // IME変換確定のEnterを編集確定と誤認しないためのガード。
    // isComposing だけでは環境により確定Enterのkeydownで既にfalseになる場合があるため、
    // レガシーだが最も互換性の高い keyCode === 229(IME処理中) も併せて見る。
    const isComposing = e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229;
    if (e.key === 'Enter' && !isComposing) {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape' && !isComposing) {
      e.preventDefault();
      onCancel();
    }
    // Tab/Shift+Tab はブラウザ標準のフォーカス移動に任せる(preventDefaultしない)。
  };

  // 入力枠の共通スタイル。表示セルと文字の字面をそのまま重ねるのが狙いなので、
  // 枠線は border ではなく inset の box-shadow で描く(border/padding は内容幅を内側から削り、
  // 表示では収まっている文字が編集中だけ見切れる/折り返すため)。これで文字の左端・使える幅が
  // 表示セルと一致する。フォーカス/エラーは枠の色と太さだけで示す。
  const cellSx = {
    minWidth: 0,
    '& .MuiOutlinedInput-root': {
      bgcolor: 'background.paper',
      boxShadow: (theme: Theme) => `inset 0 0 0 1px ${theme.palette.divider}`,
      '&.Mui-focused': { boxShadow: (theme: Theme) => `inset 0 0 0 2px ${theme.palette.primary.main}` },
      '&.Mui-error': { boxShadow: (theme: Theme) => `inset 0 0 0 2px ${theme.palette.error.main}` },
    },
    // MUI の枠線(fieldset)は消す。上の box-shadow が枠の役目を担う。
    '& .MuiOutlinedInput-notchedOutline': { border: 'none' },
  };

  /** 1行セル(名前/型/default)。高さを表示行1行分(ROW_HEIGHT)に固定する。 */
  const singleLineCellSx = {
    ...cellSx,
    '& .MuiOutlinedInput-root': { ...cellSx['& .MuiOutlinedInput-root'], height: `${ROW_HEIGHT}px` },
  };

  // note 入力欄。テーブルに note 列があれば1段目のその列へ、無ければ補助段へ置く。
  // 行高は表示側(NOTE_LINE_HEIGHT刻み)と揃え、複数行 note でも表示時と同じ高さになるようにする。
  const noteField = (
    <Tooltip title="note(Option+Enter でセル内改行 / Enter で確定)">
      <TextField
        inputRef={noteInputRef}
        size="small"
        variant="outlined"
        placeholder="note"
        value={note}
        // 複数行note。入力欄は内容の行数に応じて伸びる(上限6行で内部スクロール)。
        multiline
        minRows={1}
        maxRows={6}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={handleNoteKeyDown}
        sx={{
          ...cellSx,
          // 1段目の note 列に重ねるときは、表示側 note セルと同じ上余白を持たせて1行目の高さを
          // 揃える(表示側は pt で1行目を名前・型の帯に中央合わせしている。TableNode の note セル
          // と同じ式)。行は alignItems:'start' なので下へずれるだけで、グリッド高は変わらない。
          // 補助段へ回る場合(note列なし)は重ねる相手がいないので余白は不要。
          ...(hasNoteColumn
            ? {
                pt: `${(ROW_HEIGHT - NOTE_LINE_HEIGHT) / 2}px`,
                // 長い note(列上限180pxで省略される)を編集しやすいよう、編集中だけ入力欄を
                // 行の右端側へ延長する(Excelの「編集中セルが隣にはみ出す」感覚。2026-07-14
                // ユーザー決定)。延長先は行パディング + ▲▼用ガター(編集中は原則5で ▲▼ ・
                // リサイズハンドルが消えているので下敷きは無い)。字面の左位置は変わらない。
                width: `calc(100% + ${ROW_PADDING_X + MOVE_GUTTER_WIDTH}px)`,
              }
            : { flex: '1 1 60%' }),
        }}
        // multiline では padding が textarea ではなく Input の root に付くため root 側で 0 にする。
        slotProps={{
          input: { sx: { padding: 0 } },
          htmlInput: {
            style: {
              fontSize: 12,
              lineHeight: `${NOTE_LINE_HEIGHT}px`,
              padding: 0,
              // 表示側と同じく自動折り返しはしない(行数=実改行数のみ)。折り返すと編集中だけ
              // 行数が増えて行高が表示時とズレるため。長い行は横スクロールで見る。
              whiteSpace: 'pre',
              overflowWrap: 'normal',
              overflowX: 'auto',
            },
          },
        }}
      />
    </Tooltip>
  );

  return (
    <Box
      ref={rootRef}
      className="nodrag nopan"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onKeyDown={handleKeyDown}
      sx={{
        bgcolor: 'action.selected',
        borderBottom: '1px solid',
        borderColor: 'divider',
        cursor: 'default',
      }}
    >
      <datalist id={TYPE_DATALIST_ID}>
        {typeOptions.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>

      {/* 1段目: 表示行と同じグリッド(アイコン | 名前 | 型 | note)。列幅・行高・左右パディングを
          表示行と一致させ、編集開始で名前/型/note の位置がずれないようにする。 */}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: gridTemplate,
          columnGap: `${COLUMN_GAP}px`,
          px: `${ROW_PADDING_X}px`,
          // 表示行と同じく上寄せ(複数行 note で伸びても名前・型は先頭の帯に留める)。
          alignItems: 'start',
          minHeight: rowHeight,
        }}
      >
        {/* アイコン列: 編集中は PK/FK アイコンを出さない(PKは補助段のチェックで操作する)。 */}
        <Box />
        <TextField
          inputRef={nameInputRef}
          size="small"
          variant="outlined"
          placeholder="カラム名"
          value={name}
          error={!!nameError}
          onChange={(e) => {
            setName(e.target.value);
            if (nameError) setNameError(null);
          }}
          sx={singleLineCellSx}
          // 表示側のカラム名は body2(14px)。同じ字面の大きさに合わせる。
          slotProps={{ htmlInput: { style: { fontSize: 14, padding: 0 } } }}
        />
        <TextField
          inputRef={typeInputRef}
          size="small"
          variant="outlined"
          placeholder="型"
          value={type}
          onChange={(e) => setType(e.target.value)}
          sx={{
            ...singleLineCellSx,
            // datalist 付き input はブラウザが内部にピッカー矢印を描き、その分(約14px)だけ
            // 字面が押し出されて表示時より狭くなる。表示セルと同じ幅を字に使うため矢印は消す
            // (候補ドロップダウン自体は入力時に従来どおり出る)。
            // (ブラウザ既定のスタイルに負けるため !important が要る)
            '& input::-webkit-calendar-picker-indicator': { display: 'none !important' },
          }}
          // 表示側の型は caption(12px)。
          slotProps={{ htmlInput: { style: { fontSize: 12, padding: 0 }, list: TYPE_DATALIST_ID } }}
        />
        {hasNoteColumn && noteField}
      </Box>

      {nameError && (
        <Box sx={{ fontSize: 10, color: 'error.main', px: `${ROW_PADDING_X}px`, pb: 0.25 }}>{nameError}</Box>
      )}

      {/* 補助段: 表示行に対応する列が無い PK / NOT NULL / default(と、note列が無いテーブルでは note)。
          左端は1段目の名前列の左端に揃える(アイコン列 + ギャップ分だけインデント)。 */}
      <Stack
        direction="row"
        spacing={0.5}
        sx={{
          alignItems: 'center',
          pl: `${ROW_PADDING_X + ICON_COL_WIDTH + COLUMN_GAP}px`,
          pr: `${ROW_PADDING_X}px`,
          pb: 0.5,
        }}
      >
        <Tooltip title="主キー (PK)">
          <Box
            component="span"
            sx={{ fontSize: 10, color: 'text.secondary', display: 'flex', alignItems: 'center', gap: 0.25 }}
          >
            PK
            <Checkbox size="small" checked={pk} onChange={(e) => setPk(e.target.checked)} sx={{ p: 0.25 }} />
          </Box>
        </Tooltip>
        <Tooltip title="NOT NULL">
          <Box
            component="span"
            sx={{ fontSize: 10, color: 'text.secondary', display: 'flex', alignItems: 'center', gap: 0.25 }}
          >
            NN
            <Checkbox size="small" checked={notNull} onChange={(e) => setNotNull(e.target.checked)} sx={{ p: 0.25 }} />
          </Box>
        </Tooltip>
        <TextField
          inputRef={defaultInputRef}
          size="small"
          variant="outlined"
          placeholder="default"
          value={defaultValue}
          onChange={(e) => setDefaultValue(e.target.value)}
          sx={{ ...singleLineCellSx, flex: '1 1 auto' }}
          // 補助段は表示セルに重ねないので、字面が枠に付かないよう最小の内側余白を持たせる。
          slotProps={{ htmlInput: { style: { fontSize: 12, padding: '0 3px' } } }}
        />
        {!hasNoteColumn && noteField}
      </Stack>
    </Box>
  );
}
