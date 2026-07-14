// ステータスバー: 開いているファイルパス / テーブル数・リレーション数 / 同期状態。
import { Box, Stack, Typography } from '@mui/material';

interface StatusBarProps {
  filePath: string | null;
  tableCount: number;
  refCount: number;
  syncing: boolean;
}

export function StatusBar({ filePath, tableCount, refCount, syncing }: StatusBarProps) {
  return (
    <Box
      sx={{
        borderTop: '1px solid',
        borderColor: 'divider',
        px: 2,
        py: 0.5,
        bgcolor: 'background.paper',
      }}
    >
      <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
        <Typography variant="caption" color="text.secondary" noWrap sx={{ flex: 1, minWidth: 0 }}>
          {filePath ?? 'ファイルが開かれていません'}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {tableCount} テーブル / {refCount} リレーション
        </Typography>
        {filePath && (
          <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
            <Box
              sx={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                bgcolor: syncing ? 'warning.main' : 'success.main',
              }}
            />
            <Typography variant="caption" color="text.secondary">
              {syncing ? '読み込み中...' : '同期中'}
            </Typography>
          </Stack>
        )}
      </Stack>
    </Box>
  );
}
