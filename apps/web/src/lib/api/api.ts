import type {
  AttachmentDto,
  AuthResult,
  ChatDto,
  ClientEventName,
  ClientEvents,
  ConnectionState,
  ContactDto,
  CreateChatInput,
  CreateContactInput,
  CreateStatusInput,
  DeleteScope,
  LoginInput,
  MeDto,
  MessageDto,
  MessagePage,
  MessagesQuery,
  RegisterInput,
  SendMessageInput,
  ServerEventName,
  ServerEvents,
  StatusDto,
  UpdateChatInput,
  UpdateContactInput,
  UpdateMeInput,
} from "./types";

/**
 * Everything the app asks of a backend. There are two implementations:
 * `createHttpApi` (talks to your Nest server) and `createMockApi` (runs in the browser).
 */
export interface Api {
  auth: {
    /** Starts a throwaway account with the demo data. It cannot be signed in to again. */
    guest: () => Promise<AuthResult>;
    login: (input: LoginInput) => Promise<AuthResult>;
    /** Ends the sign-in on this device. Works with an expired access token. */
    logout: () => Promise<void>;
    /**
     * Trades the refresh cookie for a new access token. It is how the app signs back in when a
     * page loads, and how it renews a token that is about to expire. 401 `UNAUTHORIZED` means
     * there is no sign-in to restore.
     */
    refresh: () => Promise<AuthResult>;
    /** Creates an account and signs in. 409 `EMAIL_TAKEN` or `PHONE_TAKEN` when it exists. */
    register: (input: RegisterInput) => Promise<AuthResult>;
  };
  chats: {
    list: () => Promise<ChatDto[]>;
    /** Creating a direct chat that already exists returns the existing one. */
    create: (input: CreateChatInput) => Promise<ChatDto>;
    update: (id: string, input: UpdateChatInput) => Promise<ChatDto>;
    remove: (id: string) => Promise<void>;
    markRead: (id: string) => Promise<void>;
    clear: (id: string) => Promise<void>;
    addMembers: (id: string, memberIds: string[]) => Promise<ChatDto>;
    removeMember: (id: string, contactId: string) => Promise<ChatDto>;
    messages: (id: string, query?: MessagesQuery) => Promise<MessagePage>;
  };
  contacts: {
    list: () => Promise<ContactDto[]>;
    create: (input: CreateContactInput) => Promise<ContactDto>;
    update: (id: string, input: UpdateContactInput) => Promise<ContactDto>;
    remove: (id: string) => Promise<void>;
    setBlocked: (id: string, blocked: boolean) => Promise<ContactDto>;
  };
  me: {
    get: () => Promise<MeDto>;
    update: (input: UpdateMeInput) => Promise<MeDto>;
  };
  messages: {
    send: (chatId: string, input: SendMessageInput) => Promise<MessageDto>;
    edit: (id: string, text: string) => Promise<MessageDto>;
    remove: (id: string, scope: DeleteScope) => Promise<void>;
    /** Adds the reaction, or removes it if the current user already used that emoji. */
    toggleReaction: (id: string, emoji: string) => Promise<MessageDto>;
    forward: (id: string, chatIds: string[]) => Promise<MessageDto[]>;
  };
  statuses: {
    list: () => Promise<StatusDto[]>;
    create: (input: CreateStatusInput) => Promise<StatusDto>;
    remove: (id: string) => Promise<void>;
    markSeen: (id: string) => Promise<void>;
  };
  uploads: {
    create: (file: Blob, meta: UploadMeta) => Promise<AttachmentDto>;
  };
}

export interface UploadMeta {
  height?: number | null;
  name: string;
  width?: number | null;
}

/** The live connection to the backend (socket.io, or an in-browser stand-in). */
export interface RealtimeClient {
  connect: () => void;
  disconnect: () => void;
  emit: <K extends ClientEventName>(event: K, payload: ClientEvents[K]) => void;
  on: <K extends ServerEventName>(
    event: K,
    handler: (payload: ServerEvents[K]) => void,
  ) => () => void;
  onConnection: (handler: (state: ConnectionState) => void) => () => void;
}
