// @vitest-environment jsdom
/**
 * A banner published, edited, withdrawn or closed reaches every open tab it is
 * for without a reload, and a scheduled one changes phase on time.
 *
 * The write says so on the shell's live channel, the stream delivers the frame
 * only to the accounts it concerns, the tab reads its banners again, and a
 * timer reads again at the next phase boundary.
 */

import { MessagesWrapper } from "../setup/i18n";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const streams = vi.hoisted(() => ({ listeners: [] as ((frame: { data: string; owner: boolean }) => void)[] }));
const read = vi.hoisted(() => vi.fn());

vi.mock("@/lib/shared-stream", () => ({
    subscribeSharedStream: (_path: string, _scope: string, listener: (frame: { data: string; owner: boolean }) => void) => {
        streams.listeners.push(listener);
        return () => {
            streams.listeners = streams.listeners.filter((one) => one !== listener);
        };
    }
}));
vi.mock("@/components/session-scope", () => ({ useSessionScope: () => "scope" }));
vi.mock("@/app/(app)/announcement-actions", () => ({
    announcementBannersAction: read,
    dismissAnnouncementAction: vi.fn(async () => ({ ok: true }))
}));
vi.mock("@/lib/announcements/audience", () => ({
    matchesAudience: (member: { groupIds: Set<string> } | null, audience: { groupIds: string[] }) =>
        !!member && audience.groupIds.some((id) => member.groupIds.has(id))
}));

import type { BannerState, BannerView } from "@/lib/announcements/service";
import { rereadDelay, REREAD_MAX_MS, REREAD_SLACK_MS } from "@/lib/announcements/phase";
import { AnnouncementBannerList } from "@/components/announcements/announcement-banner-list";
import { noticeReaches, publishNoticeChange, subscribeNotices } from "@/lib/shell-notices-live";

const GROUP = "0190f3c6-0000-7000-8000-0000000000a1";
const audience = (over: Record<string, unknown> = {}) => ({
    everyone: false,
    roleIds: [],
    groupIds: [],
    orgIds: [],
    userIds: [],
    ...over
});

function banner(over: Partial<BannerView> = {}): BannerView {
    return {
        id: "0190f3c6-0000-7000-8000-000000000001",
        severity: "warning",
        phase: "live",
        title: "Scheduled maintenance",
        body: "",
        linkUrl: null,
        linkLabel: null,
        dismissible: true,
        countdownTo: null,
        ...over
    };
}

function frame(topic: string) {
    for (const listener of streams.listeners)
        listener({ data: JSON.stringify({ kind: "notices", topic, seq: 1 }), owner: true });
}

describe("who a change reaches", () => {
    const ana = { id: "ana", isAdmin: false };
    const none = vi.fn(async () => null);

    it("reaches everyone for an audience of everyone, without reading memberships", async () => {
        const member = vi.fn(async () => null);
        const change = { topic: "announcements" as const, reach: { audiences: [audience({ everyone: true })] } };
        expect(await noticeReaches(change, ana, member)).toBe(true);
        expect(member).not.toHaveBeenCalled();
    });

    it("reaches a person named in it, and nobody else, without reading memberships", async () => {
        const member = vi.fn(async () => null);
        const change = { topic: "announcements" as const, reach: { audiences: [audience({ userIds: ["ana"] })] } };
        expect(await noticeReaches(change, ana, member)).toBe(true);
        expect(await noticeReaches(change, { id: "ben", isAdmin: false }, member)).toBe(false);
        expect(member).not.toHaveBeenCalled();
    });

    it("reaches a group's members through one read of the reader's memberships", async () => {
        const change = { topic: "announcements" as const, reach: { audiences: [audience({ groupIds: [GROUP] })] } };
        const inGroup = vi.fn(async () => ({ id: "ana", roleIds: new Set<string>(), groupIds: new Set([GROUP]), orgIds: new Set<string>() }));
        expect(await noticeReaches(change, ana, inGroup)).toBe(true);
        expect(inGroup).toHaveBeenCalledTimes(1);
        expect(await noticeReaches(change, ana, none)).toBe(false);
    });

    it("reaches the old audience and the new one of an edit", async () => {
        const change = {
            topic: "announcements" as const,
            reach: { audiences: [audience({ userIds: ["ben"] }), audience({ userIds: ["ana"] })] }
        };
        expect(await noticeReaches(change, ana, none)).toBe(true);
        expect(await noticeReaches(change, { id: "ben", isAdmin: false }, none)).toBe(true);
        expect(await noticeReaches(change, { id: "cy", isAdmin: false }, none)).toBe(false);
    });

    it("keeps an administrators' notice to administrators", async () => {
        const change = { topic: "disk" as const, reach: "admins" as const };
        expect(await noticeReaches(change, ana, none)).toBe(false);
        expect(await noticeReaches(change, { id: "root", isAdmin: true }, none)).toBe(true);
    });

    it("is carried by the in-process bus to every listener", () => {
        const heard: string[] = [];
        const stop = subscribeNotices((change) => heard.push(change.topic));
        publishNoticeChange({ topic: "lan", reach: "admins" });
        stop();
        publishNoticeChange({ topic: "lan", reach: "admins" });
        expect(heard).toEqual(["lan"]);
    });
});

describe("when a tab reads again by itself", () => {
    it("reads just after the next boundary", () => {
        expect(rereadDelay(60_000)).toBe(60_000 + REREAD_SLACK_MS);
        expect(rereadDelay(0)).toBe(REREAD_SLACK_MS);
        expect(rereadDelay(-5)).toBe(REREAD_SLACK_MS);
    });

    it("never waits longer than the cap, nor forever when nothing is ahead", () => {
        expect(rereadDelay(30 * 24 * 60 * 60_000)).toBe(REREAD_MAX_MS);
        expect(rereadDelay(null)).toBe(REREAD_MAX_MS);
    });
});

describe("the banner stack follows along", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        read.mockReset();
    });
    afterEach(() => {
        cleanup();
        vi.useRealTimers();
        streams.listeners = [];
    });

    const empty: BannerState = { banners: [], nextChangeInMs: null };

    it("shows an announcement published while the tab is open", async () => {
        read.mockResolvedValue({ banners: [banner()], nextChangeInMs: null });
        render(<AnnouncementBannerList initial={empty} locale="en-US" />, { wrapper: MessagesWrapper });
        expect(screen.queryByText("Scheduled maintenance")).toBeNull();
        expect(streams.listeners).toHaveLength(1);

        await act(async () => {
            frame("announcements");
            frame("announcements");
            await vi.advanceTimersByTimeAsync(400);
        });
        // A burst of frames is one read.
        expect(read).toHaveBeenCalledTimes(1);
        expect(screen.getByText("Scheduled maintenance")).toBeTruthy();
    });

    it("takes a withdrawn one down, and ignores other notices' frames", async () => {
        read.mockResolvedValue(empty);
        render(<AnnouncementBannerList initial={{ banners: [banner()], nextChangeInMs: null }} locale="en-US" />, {
            wrapper: MessagesWrapper
        });
        await act(async () => {
            frame("disk");
            await vi.advanceTimersByTimeAsync(400);
        });
        expect(read).not.toHaveBeenCalled();
        await act(async () => {
            frame("announcements");
            await vi.advanceTimersByTimeAsync(400);
        });
        expect(screen.queryByText("Scheduled maintenance")).toBeNull();
    });

    it("switches phase at the boundary without a frame", async () => {
        const upcoming = banner({ title: "Database upgrade", phase: "upcoming", countdownTo: new Date(Date.now() + 60_000).toISOString() });
        read.mockResolvedValue({ banners: [banner({ title: "Database upgrade", phase: "inProgress", dismissible: false })], nextChangeInMs: 3_600_000 });
        render(<AnnouncementBannerList initial={{ banners: [upcoming], nextChangeInMs: 60_000 }} locale="en-US" />, {
            wrapper: MessagesWrapper
        });
        expect(screen.getByText(/^Scheduled maintenance/)).toBeTruthy();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(60_000 + REREAD_SLACK_MS - 10);
        });
        expect(read).not.toHaveBeenCalled();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(20);
        });
        expect(read).toHaveBeenCalledTimes(1);
        expect(screen.getByText("Maintenance in progress")).toBeTruthy();
        // Under way: no close button.
        expect(screen.queryByRole("button", { name: /dismiss|close/i })).toBeNull();
    });

    it("keeps what is on screen when a read fails", async () => {
        read.mockRejectedValue(new Error("offline"));
        render(<AnnouncementBannerList initial={{ banners: [banner()], nextChangeInMs: null }} locale="en-US" />, {
            wrapper: MessagesWrapper
        });
        await act(async () => {
            frame("announcements");
            await vi.advanceTimersByTimeAsync(400);
        });
        expect(screen.getByText("Scheduled maintenance")).toBeTruthy();
    });
});
