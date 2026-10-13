import { useState, useCallback } from 'react';

export function useSettings({ onSaveSilent } = {}) {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await window.miaoshouApp.loadSettings();
    setSettings(data);
    setLoading(false);
    return data;
  }, []);

  const save = useCallback(async (formValues) => {
    const result = await window.miaoshouApp.saveSettings(formValues);
    return result;
  }, []);

  const saveSilent = useCallback(async () => {
    if (onSaveSilent) {
      const result = await onSaveSilent();
      return result;
    }
    return { ok: true };
  }, [onSaveSilent]);

  return { settings, loading, load, save, saveSilent };
}
