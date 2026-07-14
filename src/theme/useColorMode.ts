// 配色モード(light/dark)の状態を localStorage に永続化して保持するフック。
// 既定は light(白＋グレー基調。2026-07-14 ユーザー決定)。lodThreshold と同じ流儀で、
// 読み書きを一箇所に閉じ込める。
import { useCallback, useEffect, useState } from 'react';
import type { ColorMode } from './theme';

const STORAGE_KEY = 'jpdbml.colorMode';
const DEFAULT_MODE: ColorMode = 'light';

function readStored(): ColorMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark') return raw;
  } catch {
    // localStorage 不使用環境ではデフォルトにフォールバック。
  }
  return DEFAULT_MODE;
}

export function useColorMode(): [ColorMode, () => void] {
  const [mode, setMode] = useState<ColorMode>(readStored);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // 保存失敗は無視(次回起動時にデフォルトへ戻るだけ)。
    }
  }, [mode]);

  const toggleMode = useCallback(() => {
    setMode((prev) => (prev === 'light' ? 'dark' : 'light'));
  }, []);

  return [mode, toggleMode];
}
