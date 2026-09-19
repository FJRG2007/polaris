/**
 * Moderating somebody in a call: the rules, with nothing that reaches a database
 * or a media server.
 *
 * Who may do it is the conversation's own standing, never the instance's: in a
 * space it is whoever may moderate the channel the call is in (the space's owner
 * and its admins, and an admin of that channel), and in a group it is the person
 * whose group it is. That is `mayModerate` from `access.ts`, asked here rather
 * than restated.
 *
 * Kept apart from `call-moderation.ts` so the browser can import the half it
 * needs - whether its own microphone may go up, and what to tell the person it
 * happened to - without dragging the server's half into every bundle.
 */

import { z } from "zod";

/** What a moderator can do to a seat. Each of the first four has its undo. */
export const CALL_MODERATIONS = ["mute", "unmute", "deafen", "undeafen", "disconnect"] as const;

export type CallModeration = (typeof CALL_MODERATIONS)[number];

/** The request, as the action layer accepts it. */
export const callModerationSchema = z.object({
    participantId: z.string().uuid(),
    action: z.enum(CALL_MODERATIONS)
});

export type CallModerationInput = z.infer<typeof callModerationSchema>;

/** What a moderator has done to one seat. Both off is an ordinary seat. */
export interface SeatRestriction {
    readonly serverMuted: boolean;
    readonly serverDeafened: boolean;
}

export const UNRESTRICTED: SeatRestriction = { serverMuted: false, serverDeafened: false };

/**
 * Why this actor may not moderate this seat, or null when they may.
 *
 * - Somebody who does not moderate the conversation, whatever they are anywhere
 *   else in Polaris. An instance administrator is not a moderator of a space they
 *   are only a member of.
 * - Themselves: their own buttons already do it, and a moderator who muted
 *   themselves by accident would be the one person who could not tell why.
 * - Whoever owns the space or the group, unless it is the owner asking. An admin
 *   who could silence the person who made them an admin has a standing that
 *   outranks the one it was handed by.
 */
export function moderationRefusal(input: {
    readonly mayModerate: boolean;
    readonly actorId: string;
    readonly ownerId: string | null;
    readonly targetUserId: string | null;
    readonly group: boolean;
}): string | null {
    if (!input.mayModerate) {
        return input.group
            ? "Only whoever runs this group can do that"
            : "Only a moderator of this server can do that";
    }
    if (input.targetUserId !== null && input.targetUserId === input.actorId) {
        return "That is you. Your own controls do that";
    }
    if (
        input.targetUserId !== null &&
        input.ownerId !== null &&
        input.targetUserId === input.ownerId
    ) {
        return input.group
            ? "Whoever runs the group cannot be moderated"
            : "The owner of this server cannot be moderated";
    }
    return null;
}

/** The seat's restriction once this has been done to it. Disconnecting leaves
 *  it alone: somebody shown out of a room keeps whatever they were carrying, so
 *  walking back in is not how a mute is lifted. */
export function restrictionAfter(current: SeatRestriction, action: CallModeration): SeatRestriction {
    switch (action) {
        case "mute":
            return { ...current, serverMuted: true };
        case "unmute":
            return { ...current, serverMuted: false };
        case "deafen":
            return { ...current, serverDeafened: true };
        case "undeafen":
            return { ...current, serverDeafened: false };
        case "disconnect":
            return current;
    }
}

/**
 * The media server's own names for what a seat publishes.
 *
 * The values of its protocol enum, written out so the browser can compare with
 * them without importing the server library. A test holds them to the library's
 * own values, so a renumbering upstream is a failing test here rather than a
 * microphone that quietly stays off.
 */
export const MEDIA_SOURCE = {
    CAMERA: 1,
    MICROPHONE: 2,
    SCREEN_SHARE: 3,
    SCREEN_SHARE_AUDIO: 4
} as const;

/** What the media server is told a seat may do. The fields it replaces
 *  atomically, so every one is always said. */
export interface MediaPermissions {
    readonly canPublish: boolean;
    readonly canSubscribe: boolean;
    readonly canPublishData: boolean;
    /** Empty is every source. */
    readonly canPublishSources: readonly number[];
}

/**
 * What a seat may send and receive, given what a moderator has done to it.
 *
 * Muted: everything but the microphone, so a camera and a shared screen keep
 * going - which is what every voice client does. Deafened: nothing arrives at
 * all, and the microphone goes with it, because somebody who cannot hear the room
 * is not talking to it. The media server enforces both, so a browser that ignores
 * the notice is still silent and still deaf.
 *
 * A deafened seat also stops receiving pictures. The media server has one switch
 * for everything arriving, not one per kind, and a deafen that the browser could
 * lift by asking for the audio again would be a request rather than a rule.
 */
export function mediaPermissions(restriction: SeatRestriction): MediaPermissions {
    const quiet = restriction.serverMuted || restriction.serverDeafened;
    return {
        canPublish: true,
        canSubscribe: !restriction.serverDeafened,
        canPublishData: true,
        canPublishSources: quiet
            ? [MEDIA_SOURCE.CAMERA, MEDIA_SOURCE.SCREEN_SHARE, MEDIA_SOURCE.SCREEN_SHARE_AUDIO]
            : []
    };
}

/**
 * Whether the media server will take a microphone from this browser, read off
 * the permissions it holds.
 *
 * Asked before a microphone is put back on a call, so a seat a moderator muted
 * does not spend three attempts being refused and then tell its owner their
 * device is broken.
 */
export function microphoneAllowed(
    permissions:
        | { readonly canPublish?: boolean; readonly canPublishSources?: readonly number[] }
        | null
        | undefined
): boolean {
    if (!permissions) return true;
    if (permissions.canPublish === false) return false;
    const sources = permissions.canPublishSources ?? [];
    return sources.length === 0 || sources.includes(MEDIA_SOURCE.MICROPHONE);
}

/** What the person it was done to is told, in a note on their screen. */
export function moderationNotice(action: CallModeration): string {
    switch (action) {
        case "mute":
            return "A moderator muted you. Only a moderator can unmute you.";
        case "unmute":
            return "A moderator unmuted you.";
        case "deafen":
            return "A moderator deafened you. You cannot hear the call until a moderator undoes it.";
        case "undeafen":
            return "A moderator undeafened you.";
        case "disconnect":
            return "A moderator disconnected you from the call.";
    }
}

/** What a press of mute or deafen says while a moderator's restriction is on. */
export function heldBack(restriction: SeatRestriction): string | null {
    if (restriction.serverDeafened) return moderationNotice("deafen");
    if (restriction.serverMuted) return moderationNotice("mute");
    return null;
}
