/**
 * Who may mute, deafen or disconnect somebody in a call, and what the media
 * server is told as a result.
 *
 * The standing is the conversation's own - a space's owner and admins, or the
 * person whose group it is - and the instance's administrator role is not part
 * of it. What is asserted here is the rule on top of that standing, and the
 * permissions the media server enforces, because those are what actually stop a
 * voice: a browser that ignores every notice is held all the same.
 */

import { describe, expect, it } from "vitest";
import { TrackSource } from "livekit-server-sdk";
import {
    MEDIA_SOURCE,
    UNRESTRICTED,
    callModerationSchema,
    heldBack,
    mediaPermissions,
    microphoneAllowed,
    moderationNotice,
    moderationRefusal,
    restrictionAfter
} from "@/lib/chat/voice-moderation";

const base = {
    mayModerate: true,
    actorId: "admin",
    ownerId: "owner",
    targetUserId: "member",
    group: false
};

describe("who may moderate somebody in a call", () => {
    it("lets somebody who moderates the conversation act on a member", () => {
        expect(moderationRefusal(base)).toBeNull();
    });

    it("refuses anybody who does not moderate the conversation", () => {
        // Whatever they are anywhere else in Polaris: the standing is the
        // server's own roles, not the instance's.
        expect(moderationRefusal({ ...base, mayModerate: false })).toMatch(/moderator of this server/);
        expect(moderationRefusal({ ...base, mayModerate: false, group: true })).toMatch(
            /runs this group/
        );
    });

    it("refuses a moderator acting on themselves", () => {
        expect(moderationRefusal({ ...base, targetUserId: "admin" })).toMatch(/That is you/);
    });

    it("protects the owner from everybody but themselves", () => {
        expect(moderationRefusal({ ...base, targetUserId: "owner" })).toMatch(/owner/);
        expect(moderationRefusal({ ...base, targetUserId: "owner", group: true })).toMatch(
            /runs the group/
        );
    });

    it("lets a guest on the link be moderated", () => {
        expect(moderationRefusal({ ...base, targetUserId: null })).toBeNull();
    });
});

describe("what each press does to a seat", () => {
    it("takes and gives back each restriction on its own", () => {
        const muted = restrictionAfter(UNRESTRICTED, "mute");
        expect(muted).toEqual({ serverMuted: true, serverDeafened: false });
        const both = restrictionAfter(muted, "deafen");
        expect(both).toEqual({ serverMuted: true, serverDeafened: true });
        expect(restrictionAfter(both, "unmute")).toEqual({
            serverMuted: false,
            serverDeafened: true
        });
        expect(restrictionAfter(both, "undeafen")).toEqual({
            serverMuted: true,
            serverDeafened: false
        });
    });

    it("leaves a restriction in place when somebody is disconnected", () => {
        // Walking back in is not how a mute is lifted.
        const muted = { serverMuted: true, serverDeafened: false };
        expect(restrictionAfter(muted, "disconnect")).toEqual(muted);
    });

    it("accepts only a seat id and one of the five actions", () => {
        const seat = "018f2b6e-0000-7000-8000-000000000001";
        expect(callModerationSchema.safeParse({ participantId: seat, action: "mute" }).success).toBe(
            true
        );
        expect(callModerationSchema.safeParse({ participantId: seat, action: "ban" }).success).toBe(
            false
        );
        expect(
            callModerationSchema.safeParse({ participantId: "not-a-seat", action: "mute" }).success
        ).toBe(false);
    });
});

describe("what the media server enforces", () => {
    it("uses the media server's own numbers for what a seat publishes", () => {
        // Written out so the browser need not import the server library. A
        // renumbering upstream fails here rather than leaving a microphone off.
        expect(MEDIA_SOURCE.CAMERA).toBe(TrackSource.CAMERA);
        expect(MEDIA_SOURCE.MICROPHONE).toBe(TrackSource.MICROPHONE);
        expect(MEDIA_SOURCE.SCREEN_SHARE).toBe(TrackSource.SCREEN_SHARE);
        expect(MEDIA_SOURCE.SCREEN_SHARE_AUDIO).toBe(TrackSource.SCREEN_SHARE_AUDIO);
    });

    it("holds nothing back from an ordinary seat", () => {
        expect(mediaPermissions(UNRESTRICTED)).toEqual({
            canPublish: true,
            canSubscribe: true,
            canPublishData: true,
            canPublishSources: []
        });
    });

    it("takes the microphone and nothing else from a muted seat", () => {
        const muted = mediaPermissions({ serverMuted: true, serverDeafened: false });
        expect(muted.canSubscribe).toBe(true);
        expect(muted.canPublishSources).not.toContain(MEDIA_SOURCE.MICROPHONE);
        expect(muted.canPublishSources).toContain(MEDIA_SOURCE.CAMERA);
        expect(muted.canPublishSources).toContain(MEDIA_SOURCE.SCREEN_SHARE);
    });

    it("stops everything arriving at a deafened seat, and its microphone with it", () => {
        const deaf = mediaPermissions({ serverMuted: false, serverDeafened: true });
        expect(deaf.canSubscribe).toBe(false);
        expect(deaf.canPublishSources).not.toContain(MEDIA_SOURCE.MICROPHONE);
    });

    it("reads whether a microphone may go up off the permissions a browser holds", () => {
        expect(microphoneAllowed(null)).toBe(true);
        expect(microphoneAllowed({ canPublish: true, canPublishSources: [] })).toBe(true);
        expect(microphoneAllowed({ canPublish: false })).toBe(false);
        expect(
            microphoneAllowed(mediaPermissions({ serverMuted: true, serverDeafened: false }))
        ).toBe(false);
        expect(microphoneAllowed(mediaPermissions(UNRESTRICTED))).toBe(true);
    });
});

describe("what the person it happened to is told", () => {
    it("says a moderator did it, and that only a moderator undoes it", () => {
        expect(moderationNotice("mute")).toMatch(/moderator muted you.*Only a moderator/);
        expect(moderationNotice("disconnect")).toMatch(/moderator disconnected you/);
    });

    it("refuses their own unmute while a moderator's mute stands", () => {
        expect(heldBack(UNRESTRICTED)).toBeNull();
        expect(heldBack({ serverMuted: true, serverDeafened: false })).toBe(
            moderationNotice("mute")
        );
        expect(heldBack({ serverMuted: false, serverDeafened: true })).toBe(
            moderationNotice("deafen")
        );
    });
});
