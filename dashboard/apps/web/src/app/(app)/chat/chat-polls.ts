/**
 * What the chat screen asks again on a timer, asked through routes.
 *
 * A tab on the chat screen stays open across Polaris updates, and a server
 * action is addressed by an id only the build that served the page knows: after
 * an update every one of these failed until a reload, freezing the names under
 * the voice rooms and taking a call's Join button away from everybody outside
 * it. A route's path is the same in every build. Server actions from one tab
 * also run one at a time, so a poll no longer waits behind whatever else the
 * screen is doing.
 *
 * `undefined` is "could not ask", kept apart from an answer, so a failed request
 * leaves what is on screen rather than emptying it.
 */

import type { VoicePresence } from "@/lib/chat/meetings";
import type { LiveCall } from "./meeting-actions";

async function getJson<T>(url: string): Promise<T | undefined> {
    try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) return undefined;
        return (await response.json()) as T;
    } catch {
        return undefined;
    }
}

/** Who is in each of these voice rooms; rooms the reader cannot reach are left out. */
export async function fetchVoicePresence(
    ids: readonly string[]
): Promise<Record<string, VoicePresence[]> | undefined> {
    if (ids.length === 0) return {};
    const body = await getJson<{ inRoom: Record<string, VoicePresence[]> }>(
        `/api/chat/voice-presence?ids=${ids.map(encodeURIComponent).join(",")}`
    );
    return body?.inRoom;
}

/** The call running in a conversation, null for none. */
export async function fetchLiveCall(channelId: string): Promise<LiveCall | null | undefined> {
    const body = await getJson<{ live: LiveCall | null }>(
        `/api/chat/channels/${encodeURIComponent(channelId)}/live-call`
    );
    return body === undefined ? undefined : body.live;
}
