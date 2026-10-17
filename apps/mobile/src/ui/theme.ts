import { useColorScheme } from 'react-native';

/** Indigo, matching the web app. */
const light = {
  background: '#f6f7fb',
  surface: '#ffffff',
  surfaceMuted: '#eef0f7',
  border: '#e2e5ef',
  text: '#1a1b1e',
  textDim: '#636a7a',
  primary: '#4c6ef5',
  primaryPressed: '#3b5bdb',
  onPrimary: '#ffffff',
  success: '#0ca678',
  successSoft: '#e6fcf5',
  danger: '#e03131',
  dangerSoft: '#fff5f5',
  warning: '#e8590c',
  warningSoft: '#fff4e6',
  info: '#4c6ef5',
  infoSoft: '#edf2ff',
};

const dark: typeof light = {
  background: '#101113',
  surface: '#1a1b1e',
  surfaceMuted: '#25262b',
  border: '#2c2e33',
  text: '#e9ecef',
  textDim: '#9aa0ac',
  primary: '#5c7cfa',
  primaryPressed: '#4c6ef5',
  onPrimary: '#ffffff',
  success: '#20c997',
  successSoft: '#0b2e24',
  danger: '#ff6b6b',
  dangerSoft: '#3b1618',
  warning: '#ff922b',
  warningSoft: '#3a2410',
  info: '#748ffc',
  infoSoft: '#1c2340',
};

export type Colors = typeof light;

export function useColors(): Colors {
  return useColorScheme() === 'dark' ? dark : light;
}

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };
export const radius = { sm: 8, md: 12, lg: 16, pill: 999 };
