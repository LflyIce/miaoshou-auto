import { useState, useCallback } from 'react';

export function useAuth() {
  const [role, setRole] = useState(null); // null | 'guest' | 'admin'

  const login = useCallback(async (username, password) => {
    const result = await window.miaoshouApp.authLogin({ username, password });
    if (result.ok) {
      setRole('admin');
    }
    return result;
  }, []);

  const loginGuest = useCallback(() => {
    setRole('guest');
  }, []);

  const logout = useCallback(() => {
    setRole(null);
  }, []);

  const isLoggedIn = role !== null;
  const isGuest = role === 'guest';

  return {
    role,
    isLoggedIn,
    isGuest,
    login,
    loginGuest,
    logout,
  };
}
