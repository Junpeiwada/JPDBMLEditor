// モード依存の生の色(ModeColors)を、MUI 外の描画(React Flow の MiniMap/Background、
// 検索ハイライト背景など)へ prop ドリリングせずに配るための Context。
// Provider は App が現在モードに応じた値をセットする。
import { createContext, useContext } from 'react';
import { getModeColors, type ModeColors } from './theme';

// 既定は light の色(Provider 未装着でも破綻しないためのフォールバック)。
const ModeColorsContext = createContext<ModeColors>(getModeColors('light'));

export const ModeColorsProvider = ModeColorsContext.Provider;

export function useModeColors(): ModeColors {
  return useContext(ModeColorsContext);
}
