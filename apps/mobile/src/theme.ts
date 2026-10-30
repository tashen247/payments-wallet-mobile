import { useColorScheme } from 'react-native';

const light = {
  bg: '#F5F7F6',
  card: '#FFFFFF',
  text: '#0E1A16',
  muted: '#5B6B65',
  border: '#E1E7E4',
  primary: '#0B6E4F',
  primaryText: '#FFFFFF',
  accent: '#F2B705',
  danger: '#C0392B',
  success: '#1E8E5A',
  pending: '#B7791F',
  hero: '#0B3D2E',
  heroText: '#E9F5EF',
};

const dark: typeof light = {
  bg: '#0B1210',
  card: '#141E1B',
  text: '#E8F0EC',
  muted: '#93A49D',
  border: '#22302B',
  primary: '#2FBF8A',
  primaryText: '#04140E',
  accent: '#F5C842',
  danger: '#F0705F',
  success: '#43D19A',
  pending: '#E8B04B',
  hero: '#123D30',
  heroText: '#E9F5EF',
};

export type Theme = typeof light;
export const useTheme = (): Theme => (useColorScheme() === 'dark' ? dark : light);
export const space = (n: number) => n * 4;
