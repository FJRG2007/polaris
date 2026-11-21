// @vitest-environment jsdom

/**
 * What do not disturb changes on screen: the tab's title stops carrying a count,
 * and the account's own state is read from the presence store.
 */

import { cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let quiet = false;
let mine: { status: string } | null = null;

vi.mock("@/components/notifications/notifications-provider", () => ({
    useNotificationFeed: () => ({ items: [{ id: "n1", type: "deploy.failed", read: false }] })
}));
vi.mock("@/components/app-unread", () => ({ useAppUnread: () => ({}) }));
vi.mock("@/components/admin-waiting", () => ({
    useAdminWaiting: () => ({ update: false, reports: 0, cases: 0 })
}));
vi.mock("@/lib/favicon", () => ({
    applyFavicon: () => undefined,
    currentFavicon: () => null,
    drawFavicon: () => null
}));
vi.mock("@/components/presence-store", () => ({ usePresence: () => mine }));
vi.mock("@/components/session-scope", () => ({ useSessionScope: () => "ada" }));

beforeEach(() => {
    quiet = false;
    mine = null;
    document.title = "Polaris";
    vi.resetModules();
});

afterEach(() => {
    cleanup();
    vi.doUnmock("@/components/do-not-disturb");
});

describe("the tab's title", () => {
    async function favicon() {
        vi.doMock("@/components/do-not-disturb", () => ({ useDoNotDisturb: () => quiet }));
        return (await import("@/components/notifications/notification-favicon"))
            .NotificationFavicon;
    }

    it("carries the count normally", async () => {
        const Favicon = await favicon();
        render(<Favicon />);
        expect(document.title).toBe("(1) Polaris");
    });

    it("carries nothing in do not disturb", async () => {
        quiet = true;
        const Favicon = await favicon();
        render(<Favicon />);
        expect(document.title).toBe("Polaris");
    });
});

describe("the account's own state", () => {
    it("is do not disturb when its own dot is busy, and not otherwise", async () => {
        const { useDoNotDisturb } = await import("@/components/do-not-disturb");
        mine = { status: "busy" };
        expect(renderHook(() => useDoNotDisturb()).result.current).toBe(true);
        mine = { status: "online" };
        expect(renderHook(() => useDoNotDisturb()).result.current).toBe(false);
        mine = null;
        expect(renderHook(() => useDoNotDisturb()).result.current).toBe(false);
    });
});
