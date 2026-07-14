// アプリ全体の配色テーマ。白＋グレー基調のライトを既定とし、従来のダークも切替可能に残す
// (2026-07-14 ユーザー決定)。「純ライト＋グレーアクセント」= 青などの原色を排し、
// ヘッダー/アクセントもグレー系で統一して落ち着いた見た目にする。
//
// 個々のコンポーネントは原則この palette トークン(primary / background / divider / text ...)を
// 参照しており、色そのものはここだけで決まる。モードに追従させたいハードコード色は
// modeColors(下)で切り出し、view 側から参照する。
import { createTheme, type Theme } from '@mui/material';

export type ColorMode = 'light' | 'dark';

/**
 * テーマトークンで表現しづらい「モードごとの生の色」(検索ハイライト・MiniMap など)。
 * MUI の palette と別に持つのは、これらが React Flow など MUI 外の描画に渡る色のため。
 */
export interface ModeColors {
  /** 検索ヒットしたカラム行の背景ハイライト。 */
  searchHighlight: string;
  /** MiniMap 上のノード色(通常 / 薄表示)。 */
  minimapNode: string;
  minimapNodeDimmed: string;
  /** MiniMap の枠・背景マスク。 */
  minimapMask: string;
  /** React Flow 背景ドットの色。 */
  canvasDot: string;
}

const lightTheme = createTheme({
  palette: {
    mode: 'light',
    // 白＋グレー基調。アクセントも彩度を抑えたグレー系にして原色を排す。
    primary: {
      main: '#616161', // グレー700。ヘッダー・アクセントの主色。
      dark: '#424242', // グレー800。テーブルヘッダー背景に使う濃いめのグレー。
      light: '#9e9e9e',
      contrastText: '#ffffff',
    },
    secondary: {
      main: '#757575',
      contrastText: '#ffffff',
    },
    background: {
      default: '#f5f5f5', // アプリ地の薄グレー。
      paper: '#ffffff', // テーブルノード・パネルの白。
    },
    divider: '#e0e0e0',
    text: {
      primary: '#212121',
      secondary: '#616161',
      disabled: '#9e9e9e',
    },
    // PK/FK アイコンや同期インジケータは意味色として控えめに残す(原色を避けたトーン)。
    warning: { main: '#b28900', light: '#c9a227' },
    info: { main: '#5c6b73', light: '#78909c' },
    success: { main: '#5c8a5c' },
  },
});

const darkTheme = createTheme({
  palette: {
    mode: 'dark',
  },
});

export function getTheme(mode: ColorMode): Theme {
  return mode === 'light' ? lightTheme : darkTheme;
}

export function getModeColors(mode: ColorMode): ModeColors {
  if (mode === 'light') {
    return {
      // 黄系ハイライトはライトでも視認しやすいよう不透明度を上げる。
      searchHighlight: 'rgba(255, 193, 7, 0.35)',
      minimapNode: '#9e9e9e',
      minimapNodeDimmed: '#e0e0e0',
      minimapMask: 'rgba(0, 0, 0, 0.08)',
      canvasDot: '#d0d0d0',
    };
  }
  return {
    searchHighlight: 'rgba(255, 213, 79, 0.28)',
    minimapNode: '#00bcd4',
    minimapNodeDimmed: '#555',
    minimapMask: 'rgba(0, 0, 0, 0.6)',
    canvasDot: '#444',
  };
}
