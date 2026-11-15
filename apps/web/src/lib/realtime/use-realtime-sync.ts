"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { useApi, useRealtime } from "@/lib/api/context";
import { type MeDto, SERVER_EVENT_NAMES } from "@/lib/api/types";
import { keys } from "@/lib/queries/keys";
import { playChime } from "@/lib/sound";
import { useUi } from "@/lib/stores/ui";

import { applyServerEvent, type ServerEventMessage } from "./apply";

/**
 * Keeps the app live: connects to the real-time backend, feeds each event into the query cache,
 * and refetches everything after a dropped connection comes back, since events may have been missed.
 * Mount it once, while signed in.
 */
export function useRealtimeSync(meId: string) {
  const realtime = useRealtime();
  const api = useApi();
  const qc = useQueryClient();
  const hadConnection = useRef(false);
  const wasDisconnected = useRef(false);

  useEffect(() => {
    const stops: Array<() => void> = [];

    for (const name of SERVER_EVENT_NAMES) {
      stops.push(
        realtime.on(name, (payload) => {
          const effects = applyServerEvent(qc, { event: name, payload } as ServerEventMessage, {
            meId,
            activeChatId: useUi.getState().activeChatId,
          });
          for (const effect of effects) {
            if (effect.type === "chime") {
              if (qc.getQueryData<MeDto>(keys.me)?.preferences.sounds) {
                playChime();
              }
            } else if (effect.type === "markRead") {
              void api.chats.markRead(effect.chatId).catch(() => undefined);
            } else {
              useUi.getState().setTyping(effect.chatId, effect.name);
            }
          }
        }),
      );
    }

    stops.push(
      realtime.onConnection((state) => {
        useUi.getState().setConnection(state);
        if (state === "disconnected") {
          wasDisconnected.current = hadConnection.current;
        } else if (state === "connected") {
          if (wasDisconnected.current) {
            void qc.invalidateQueries();
          }
          wasDisconnected.current = false;
          hadConnection.current = true;
        }
      }),
    );

    realtime.connect();
    return () => {
      stops.forEach((stop) => stop());
      realtime.disconnect();
      useUi.getState().setConnection("disconnected");
    };
  }, [realtime, api, qc, meId]);
}
