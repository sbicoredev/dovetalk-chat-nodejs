import { create } from "zustand";

interface SessionState {
  clear: () => void;
  /**
   * True once the first attempt to restore a sign-in has finished, whatever came of it. Until
   * then the app cannot tell "signed out" from "not asked yet", so it shows a loading screen.
   */
  hydrated: boolean;
  /** Restoring failed because the server could not be reached, not because nobody is signed in. */
  restoreError: string | null;
  restoreFailed: (message: string) => void;
  /** Goes back to "not asked yet", ready for another restore. */
  restoreReset: () => void;
  setToken: (token: string) => void;
  /** The access token, or null when signed out. */
  token: string | null;
}

/**
 * Holds the access token, in memory only. Scripts on the page can read localStorage, so the token
 * is never saved there: it is short-lived (15 minutes) and the long-lived sign-in is an httpOnly
 * cookie that the browser keeps and scripts cannot see. A reload starts with no token and gets a
 * new one from `POST /auth/refresh` (see `lib/auth/session-manager.ts`).
 */
export const useSession = create<SessionState>((set) => ({
  token: null,
  hydrated: false,
  restoreError: null,
  setToken: (token) => set({ token, hydrated: true, restoreError: null }),
  clear: () => set({ token: null, hydrated: true, restoreError: null }),
  restoreFailed: (message) => set({ token: null, hydrated: true, restoreError: message }),
  restoreReset: () => set({ hydrated: false, restoreError: null }),
}));

export const getToken = () => useSession.getState().token;
