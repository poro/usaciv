// Namespaced localStorage for game saves and stats: keys are "usaciv:<game>:<key>", values JSON.
// Never throws (private browsing or a full quota just means nothing is saved).
export function makeStorage(ns) {
  const k = (key) => `usaciv:${ns}:${key}`;
  return {
    get(key, fallback = null) {
      try {
        const v = localStorage.getItem(k(key));
        return v == null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(k(key), JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    },
    remove(key) {
      try { localStorage.removeItem(k(key)); } catch { /* ignore */ }
    },
  };
}
