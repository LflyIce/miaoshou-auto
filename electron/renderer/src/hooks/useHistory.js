import { useState, useCallback, useRef } from 'react';

export function useHistory() {
  const [history, setHistory] = useState([]);
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchEmpty, setSearchEmpty] = useState(false);
  const timerRef = useRef(null);

  const loadHistory = useCallback(async () => {
    try {
      const result = await window.miaoshouApp.listFillHistory();
      setHistory(result.items || []);
      return result.items || [];
    } catch (error) {
      return [];
    }
  }, []);

  const openHistory = useCallback(async (fileName) => {
    const result = await window.miaoshouApp.openFillHistory(fileName);
    return result;
  }, []);

  const search = useCallback(async (query) => {
    const q = query.trim();
    if (!q) {
      setSearchResults([]);
      setSearchEmpty(false);
      return;
    }
    setSearching(true);
    try {
      const result = await window.miaoshouApp.searchFillHistory(q);
      const items = result.items || [];
      setSearchResults(items);
      setSearchEmpty(items.length === 0);
    } catch (error) {
      setSearchResults([]);
      setSearchEmpty(true);
    } finally {
      setSearching(false);
    }
  }, []);

  const searchDebounced = useCallback((query) => {
    clearTimeout(timerRef.current);
    if (!query.trim()) {
      setSearchResults([]);
      setSearchEmpty(false);
      return;
    }
    timerRef.current = setTimeout(() => search(query), 300);
  }, [search]);

  const copyProductUrl = useCallback(async (url) => {
    const result = await window.miaoshouApp.writeClipboard(url);
    return result;
  }, []);

  return {
    history,
    searchResults,
    searching,
    searchEmpty,
    loadHistory,
    openHistory,
    search,
    searchDebounced,
    copyProductUrl,
  };
}
