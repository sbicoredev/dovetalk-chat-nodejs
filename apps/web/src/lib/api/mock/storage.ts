import type { MockDb } from "./seed";

/** Where the mock server keeps its data between visits. */
export interface MockStorage {
  clear: () => void;
  load: () => MockDb | null;
  /** Whether somebody is signed in. It stands in for the refresh cookie of the real API. */
  loadSession: () => boolean;
  save: (db: MockDb) => void;
  saveSession: (signedIn: boolean) => void;
}

const KEY = "dovetalk:mock-db:v2";

export function createLocalStorageStorage(key = KEY): MockStorage {
  return {
    load() {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) {
          return null;
        }
        const parsed = JSON.parse(raw) as MockDb | null;
        if (!(parsed?.me && Array.isArray(parsed.chats) && Array.isArray(parsed.contacts))) {
          return null;
        }
        // Data saved before `phone` existed has no such field. The contract says it is always there.
        return { ...parsed, me: { ...parsed.me, phone: parsed.me.phone ?? null }, uploads: {} };
      } catch {
        return null;
      }
    },
    save(db) {
      try {
        // Pending uploads are not worth keeping, and attachments are already inside messages.
        localStorage.setItem(key, JSON.stringify({ ...db, uploads: {} }));
      } catch {
        // Storage can be full or unavailable. The mock keeps working in memory.
      }
    },
    clear() {
      try {
        localStorage.removeItem(key);
      } catch {
        // Nothing to clear.
      }
    },
    loadSession() {
      try {
        return localStorage.getItem(`${key}:session`) === "1";
      } catch {
        return false;
      }
    },
    saveSession(signedIn) {
      try {
        if (signedIn) {
          localStorage.setItem(`${key}:session`, "1");
        } else {
          localStorage.removeItem(`${key}:session`);
        }
      } catch {
        // The sign-in then lasts until the page closes.
      }
    },
  };
}
