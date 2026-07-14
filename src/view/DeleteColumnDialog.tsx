// カラム削除の確認ダイアログ。Ref で参照されている場合は警告文を併記する。
// 状態を持たない純粋な表示コンポーネント(状態・ロジックは useColumnEditSession 側にある)。
import { Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle } from "@mui/material";
import type { ColumnDeleteTarget } from "./useColumnEditSession";

interface DeleteColumnDialogProps {
  deleteTarget: ColumnDeleteTarget | null;
  onClose: () => void;
  onConfirm: () => void;
}

export function DeleteColumnDialog({ deleteTarget, onClose, onConfirm }: DeleteColumnDialogProps) {
  return (
    <Dialog open={deleteTarget !== null} onClose={onClose}>
      <DialogTitle>カラムを削除しますか?</DialogTitle>
      <DialogContent>
        <DialogContentText>
          テーブル「{deleteTarget?.tableName}」のカラム「{deleteTarget?.columnName}」を削除します。(Cmd/Ctrl+Zで元に戻せます)
        </DialogContentText>
        {deleteTarget?.refWarning && (
          <DialogContentText sx={{ mt: 2, color: "warning.main" }}>{deleteTarget.refWarning}</DialogContentText>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} color="inherit">
          キャンセル
        </Button>
        <Button onClick={onConfirm} variant="contained" color="error">
          削除する
        </Button>
      </DialogActions>
    </Dialog>
  );
}
