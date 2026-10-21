"use client";

/**
 * Whether the signed-in account is in do not disturb, read from the presence
 * store every face is already drawn from - so a chosen status, a weekly
 * schedule and automatic status (a call, a meeting) all count, and the answer
 * follows the server's own on every refresh.
 *
 * While it is on, the in-app things still appear - the card for a call, the
 * note for a message, the row in the bell - and what is held back is the sound,
 * the notice outside the window and the count in the tab's title.
 */

import { usePresence } from "@/components/presence-store";
import { useSessionScope } from "@/components/session-scope";

export function useDoNotDisturb(): boolean {
    const me = useSessionScope();
    return usePresence(me || null)?.status === "busy";
}
