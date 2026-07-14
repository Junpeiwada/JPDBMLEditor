// 未保存破棄ガード(Docs/計画-保存UNDO計画.md「未保存破棄のガード」)の確認ダイアログ。
// 別ファイルを開く/履歴選択/手動リロードの前に、未保存編集があれば確認する。
// 状態を持たない純粋な表示コンポーネント(状態・ロジックは useDiscardGuard 側にある)。
import { Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle } from "@mui/material";

interface DiscardGuardDialogProps {
  open: boolean;
  onClose: () => void;
  onDiscardAndProceed: () => void;
  onSaveAndProceed: () => Promise<void>;
}

export function DiscardGuardDialog({ open, onClose, onDiscardAndProceed, onSaveAndProceed }: DiscardGuardDialogProps) {
  return (
    <Dialog open={open} onClose={onClose}>
      <DialogTitle>保存していない変更があります</DialogTitle>
      <DialogContent>
        <DialogContentText>保存していない変更があります。破棄して続行しますか?</DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} color="inherit">
          キャンセル
        </Button>
        <Button onClick={onDiscardAndProceed} color="error">
          破棄して続行
        </Button>
        <Button onClick={() => void onSaveAndProceed()} variant="contained">
          保存して続行
        </Button>
      </DialogActions>
    </Dialog>
  );
}
