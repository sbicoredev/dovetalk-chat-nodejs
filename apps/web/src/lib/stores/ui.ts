import { create } from "zustand";

import type { ConnectionState } from "@/lib/api/types";

export type DialogName =
  | "newChat"
  | "newGroup"
  | "addStatus"
  | "addContact"
  | "settings"
  | "forward"
  | "groupInfo"
  | "editContact";

export interface DialogData {
  chatId?: string;
  contactId?: string;
  messageId?: string;
}

export interface CallTarget {
  group: boolean;
  hue: number;
  mode: "voice" | "video";
  name: string;
}

interface UiState {
  /** The chat that is open on screen, if any. */
  activeChatId: string | null;
  call: CallTarget | null;
  closeDialog: () => void;
  closeStatus: () => void;
  connection: ConnectionState;
  dialog: DialogName | null;
  dialogData: DialogData;
  endCall: () => void;
  notify: (text: string) => void;

  openDialog: (name: DialogName, data?: DialogData) => void;
  openStatus: (owner: string) => void;
  reset: () => void;
  setActiveChat: (chatId: string | null) => void;
  setConnection: (state: ConnectionState) => void;
  setTyping: (chatId: string, name: string | null) => void;
  startCall: (target: CallTarget) => void;
  statusOwner: string | null;
  toast: { id: number; text: string } | null;
  /** Chat id to the first name of whoever is typing there. */
  typing: Record<string, string | null>;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

const initial = {
  dialog: null,
  dialogData: {},
  statusOwner: null,
  call: null,
  toast: null,
  activeChatId: null,
  typing: {},
  connection: "disconnected" as ConnectionState,
};

/** Everything that only matters on this screen. Server data lives in TanStack Query. */
export const useUi = create<UiState>((set) => ({
  ...initial,
  openDialog: (name, data = {}) => set({ dialog: name, dialogData: data }),
  closeDialog: () => set({ dialog: null }),
  openStatus: (owner) => set({ statusOwner: owner }),
  closeStatus: () => set({ statusOwner: null }),
  startCall: (target) => set({ call: target }),
  endCall: () => set({ call: null }),
  notify: (text) => {
    if (toastTimer) {
      clearTimeout(toastTimer);
    }
    set({ toast: { id: Date.now(), text } });
    toastTimer = setTimeout(() => set({ toast: null }), 3200);
  },
  setActiveChat: (chatId) => set({ activeChatId: chatId }),
  setTyping: (chatId, name) => {
    const existing = typingTimers.get(chatId);
    if (existing) {
      clearTimeout(existing);
    }
    set((s) => ({ typing: { ...s.typing, [chatId]: name } }));
    if (name) {
      // If the "stopped typing" event is lost, don't show typing forever.
      typingTimers.set(
        chatId,
        setTimeout(() => set((s) => ({ typing: { ...s.typing, [chatId]: null } })), 8000),
      );
    } else {
      typingTimers.delete(chatId);
    }
  },
  setConnection: (connection) => set({ connection }),
  reset: () => {
    typingTimers.forEach((t) => clearTimeout(t));
    typingTimers.clear();
    set(initial);
  },
}));

export const notify = (text: string) => useUi.getState().notify(text);
