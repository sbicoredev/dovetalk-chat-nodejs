import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import type { Backend } from "@/lib/api";
import type { Api } from "@/lib/api/api";
import { BackendProvider } from "@/lib/api/context";
import { ApiError } from "@/lib/api/errors";
import { createMockApi } from "@/lib/api/mock/server";
import type { ChatDto, MeDto } from "@/lib/api/types";
import { createSessionManager } from "@/lib/auth/session-manager";
import { useUi } from "@/lib/stores/ui";

import { createQueryClient } from "./client";
import { keys } from "./keys";
import { useDeleteMessage, useSendMessage, useToggleReaction, useUpdateChat } from "./mutations";
import { useChats, useMessages } from "./queries";

function setup(wrap?: (api: Api) => Api) {
  const mock = createMockApi({ getToken: () => "mock.t", latencyMs: 0, autoReply: false });
  const api = wrap ? wrap(mock.api) : mock.api;
  const session = createSessionManager({ getApi: () => api });
  const backend: Backend = { api, realtime: mock.realtime, mock, session };
  const qc = createQueryClient();
  qc.setDefaultOptions({ ...qc.getDefaultOptions(), queries: { retry: false, staleTime: 30_000 } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <BackendProvider backend={backend}>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </BackendProvider>
  );
  return { qc, wrapper, api, mock };
}

async function withMe(qc: QueryClient, api: Api) {
  qc.setQueryData<MeDto>(keys.me, await api.me.get());
}

beforeEach(() => useUi.getState().reset());

describe("useMessages", () => {
  it("loads the newest page, then older pages in order", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useMessages("chat-c1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const firstCount = result.current.messages.length;
    expect(result.current.hasNextPage).toBe(true);
    const newest = result.current.messages.at(-1)!.id;

    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.messages.length).toBeGreaterThan(firstCount));
    expect(result.current.messages.at(-1)!.id).toBe(newest);
    const times = result.current.messages.map((m) => m.createdAt);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

describe("useSendMessage", () => {
  it("shows the message at once, then swaps in the server copy without duplicating", async () => {
    const { wrapper, qc, api } = setup((a) => ({
      ...a,
      messages: {
        ...a.messages,
        send: (...args) =>
          new Promise((r) => setTimeout(r, 400)).then(() => a.messages.send(...args)),
      },
    }));
    await withMe(qc, api);
    const { result } = renderHook(
      () => ({ msgs: useMessages("chat-c3"), send: useSendMessage() }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.msgs.isSuccess).toBe(true));
    const before = result.current.msgs.messages.length;

    act(() =>
      result.current.send.mutate({
        chatId: "chat-c3",
        input: { clientId: "k1", kind: "text", text: "optimistic" },
      }),
    );
    await waitFor(() =>
      expect(result.current.msgs.messages.at(-1)).toMatchObject({
        text: "optimistic",
        pending: true,
      }),
    );

    await waitFor(() => expect(result.current.send.isSuccess).toBe(true));
    const after = result.current.msgs.messages;
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)).toMatchObject({ text: "optimistic", clientId: "k1" });
    expect(after.at(-1)!.pending).toBeFalsy();
    expect(after.at(-1)!.id.startsWith("pending-")).toBe(false);
  });

  it("marks the message failed on error and retries with the same clientId", async () => {
    let fail = true;
    const { wrapper, qc, api } = setup((a) => ({
      ...a,
      messages: {
        ...a.messages,
        send: (...args) =>
          fail
            ? Promise.reject(new ApiError(0, "NETWORK_ERROR", "offline"))
            : a.messages.send(...args),
      },
    }));
    await withMe(qc, api);
    const { result } = renderHook(
      () => ({ msgs: useMessages("chat-c3"), send: useSendMessage() }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.msgs.isSuccess).toBe(true));
    const before = result.current.msgs.messages.length;
    const vars = {
      chatId: "chat-c3",
      input: { clientId: "k2", kind: "text" as const, text: "retry me" },
    };

    act(() => result.current.send.mutate(vars));
    await waitFor(() =>
      expect(result.current.msgs.messages.at(-1)).toMatchObject({ failed: true, text: "retry me" }),
    );
    await waitFor(() => expect(useUi.getState().toast?.text).toMatch(/offline/u));

    fail = false;
    act(() => result.current.send.mutate(vars));
    await waitFor(() => expect(result.current.send.isSuccess).toBe(true));
    const after = result.current.msgs.messages;
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)!.failed).toBeFalsy();
  });
});

describe("other mutations", () => {
  it("toggles a reaction optimistically", async () => {
    const { wrapper, qc, api } = setup();
    await withMe(qc, api);
    const { result } = renderHook(
      () => ({ msgs: useMessages("chat-c1"), react: useToggleReaction() }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.msgs.isSuccess).toBe(true));
    const target = await api.messages.send("chat-c1", {
      clientId: "k-react",
      kind: "text",
      text: "react to me",
    });
    await act(async () => {
      await result.current.msgs.refetch();
    });
    await act(async () => {
      await result.current.react.mutateAsync({
        chatId: "chat-c1",
        messageId: target.id,
        emoji: "😂",
      });
    });
    await waitFor(() =>
      expect(result.current.msgs.messages.find((m) => m.id === target.id)!.reactions["😂"]).toEqual(
        ["u_me"],
      ),
    );
  });

  it("deleting for everyone leaves a tombstone", async () => {
    const { wrapper, qc, api } = setup();
    await withMe(qc, api);
    const mine = await api.messages.send("chat-c3", { clientId: "k3", kind: "text", text: "bye" });
    const { result } = renderHook(
      () => ({ msgs: useMessages("chat-c3"), del: useDeleteMessage() }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.msgs.isSuccess).toBe(true));
    await act(async () => {
      await result.current.del.mutateAsync({
        chatId: "chat-c3",
        messageId: mine.id,
        scope: "everyone",
      });
    });
    await waitFor(() =>
      expect(result.current.msgs.messages.find((m) => m.id === mine.id)).toMatchObject({
        deleted: true,
      }),
    );
  });

  it("rolls back a pin that the server refuses and shows a toast", async () => {
    const { wrapper, qc, api } = setup();
    await withMe(qc, api);
    const { result } = renderHook(() => ({ chats: useChats(), update: useUpdateChat() }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.chats.isSuccess).toBe(true));

    const unpinned = () =>
      result.current.chats.data!.filter((c: ChatDto) => !(c.pinned || c.archived));
    // Pin until the limit is reached, then the next pin has to fail.
    while (result.current.chats.data!.filter((c: ChatDto) => c.pinned).length < 3) {
      const [next] = unpinned();
      await act(async () => {
        await result.current.update.mutateAsync({ id: next.id, input: { pinned: true } });
      });
    }
    const [victim] = unpinned();
    await act(async () => {
      await result.current.update
        .mutateAsync({ id: victim.id, input: { pinned: true } })
        .catch(() => undefined);
    });
    await waitFor(() =>
      expect(result.current.chats.data!.find((c: ChatDto) => c.id === victim.id)!.pinned).toBe(
        false,
      ),
    );
    await waitFor(() => expect(useUi.getState().toast?.text).toMatch(/pin up to 3/iu));
  });
});
