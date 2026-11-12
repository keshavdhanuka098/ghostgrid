import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { readStore, writeStore } from '../lib/storage';

export type MotionPref = 'system' | 'reduce' | 'full';
export type Density = 'comfortable' | 'compact';

interface Prefs {
  motion: MotionPref;
  density: Density;
}

const PREFS_KEY = 'ghostgrid.prefs.v1';
const INTRO_KEY = 'ghostgrid.intro.v1';
function readSession(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeSession(key: string, value: string) {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the splash simply shows again next load */
  }
}
const DEFAULTS: Prefs = { motion: 'system', density: 'comfortable' };

function loadPrefs(): Prefs {
  try {
    const raw = readStore(PREFS_KEY);
    if (!raw) return DEFAULTS;
    const p = JSON.parse(raw) as Partial<Prefs>;
    return {
      motion: p.motion === 'reduce' || p.motion === 'full' ? p.motion : 'system',
      density: p.density === 'compact' ? 'compact' : 'comfortable',
    };
  } catch {
    return DEFAULTS;
  }
}

interface SettingsApi extends Prefs {
  /** The motion setting resolved against the operating system preference. */
  reducedMotion: boolean;
  setMotion: (m: MotionPref) => void;
  setDensity: (d: Density) => void;
  resetPrefs: () => void;
  introVisible: boolean;
  replayIntro: () => void;
  dismissIntro: () => void;
}

const SettingsContext = createContext<SettingsApi | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [systemReduced, setSystemReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  );
  // Shown once per browser tab session (startup). Marked as seen immediately so a refresh mid-animation never loops.
  const [introVisible, setIntroVisible] = useState(() => readSession(INTRO_KEY) === null);

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return;
    const onChange = () => setSystemReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const reducedMotion = prefs.motion === 'reduce' || (prefs.motion === 'system' && systemReduced);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.motion = reducedMotion ? 'reduce' : 'full';
    root.dataset.density = prefs.density;
  }, [reducedMotion, prefs.density]);

  const update = useCallback((patch: Partial<Prefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      writeStore(PREFS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const value = useMemo<SettingsApi>(
    () => ({
      ...prefs,
      reducedMotion,
      setMotion: (motion) => update({ motion }),
      setDensity: (density) => update({ density }),
      resetPrefs: () => {
        writeStore(PREFS_KEY, null);
        setPrefs(DEFAULTS);
      },
      introVisible,
      replayIntro: () => setIntroVisible(true),
      dismissIntro: () => {
        writeSession(INTRO_KEY, '1');
        setIntroVisible(false);
      },
    }),
    [prefs, reducedMotion, update, introVisible],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsApi {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used inside SettingsProvider');
  return ctx;
}

export const markIntroSeen = () => writeSession(INTRO_KEY, '1');
