import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';

export interface ThemeFonts {
  display: string;
  body: string;
  mono: string;
  stylesheet?: string;
}

export interface Theme {
  id: string;
  name: string;
  fonts: ThemeFonts;
  dark: Record<string, unknown>;
  light: Record<string, unknown>;
}

export function loadThemes(builtinPath: string, overridePath: string): Theme[] {
  const base = JSON.parse(readFileSync(builtinPath, 'utf8')) as { themes: Theme[] };
  const themes = [...base.themes];
  if (existsSync(overridePath)) {
    try {
      const over = JSON.parse(readFileSync(overridePath, 'utf8')) as { themes?: Theme[] };
      for (const t of over.themes ?? []) {
        const i = themes.findIndex((x) => x.id === t.id);
        if (i >= 0) themes[i] = t;
        else themes.push(t);
      }
    } catch (e) {
      console.warn(`[review] ignoring malformed theme override at ${overridePath}:`, e);
    }
  }
  return themes;
}
