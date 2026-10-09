import { createContext, useContext, useEffect, useState, useCallback } from "react";
import * as api from "../services/api.js";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadUser = useCallback(async () => {
    if (!api.getToken()) {
      setLoading(false);
      return;
    }
    try {
      const me = await api.getCurrentUser();
      setUser(me);
    } catch {
      api.setAuthToken(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadUser(); }, [loadUser]);

  const signIn = async (email, password) => {
    const { token, user: u } = await api.login(email, password);
    api.setAuthToken(token);
    setUser(u);
    return u;
  };

  const signOut = async () => {
    try { await api.logout(); } catch { /* token may already be invalid, still clear locally */ }
    api.setAuthToken(null);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, signIn, signOut, refresh: loadUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
