// @vitest-environment jsdom

/**
 * Admin screens draw before their data.
 *
 * The display defaults and the retention counts used to be awaited by the page,
 * so the navigation held on them and nothing was on screen. The pages now draw
 * their header and hand the read to the browser, which paints the last reading
 * it kept, asks again in the background, and swaps only what moved.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const reads = vi.hoisted(() => ({
    platform: vi.fn(async () => {
        throw new Error("the page must not read the display defaults");
    }),
    theme: vi.fn(async () => {
        throw new Error("the page must not read the theme policy");
    }),
    totals: vi.fn(async () => {
        throw new Error("the page must not count the retained tables");
    })
}));

vi.mock("@/lib/session", () => ({ requireAdmin: vi.fn(async () => ({ id: "admin-1", isAdmin: true })) }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: vi.fn(async () => (key: string) => key) }));
vi.mock("@/lib/display-prefs-service", () => ({
    getPlatformDisplayPreferences: reads.platform,
    usersMayChooseTheme: reads.theme
}));
vi.mock("@/lib/retention-service", () => ({
    retentionPolicy: vi.fn(async () => ({ notifications: 30, activity: 90, audit: 0 })),
    retentionTotals: reads.totals
}));
vi.mock("@/lib/setting-store", () => ({ getSetting: vi.fn(async () => null) }));
vi.mock("@/app/(app)/admin/display/actions", () => ({
    savePlatformDisplayAction: vi.fn(async () => ({})),
    setThemePolicyAction: vi.fn(async () => ({}))
}));
vi.mock("@/app/(app)/admin/retention/actions", () => ({
    saveRetentionAction: vi.fn(async () => ({})),
    sweepRetentionAction: vi.fn(async () => ({}))
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { writeSnapshot } from "@/lib/snapshot-cache";
import RetentionPage from "@/app/(app)/admin/retention/page";
import DisplayAdminPage from "@/app/(app)/admin/display/page";
import { RetentionView } from "@/app/(app)/admin/retention/retention-view";
import { DisplayAdminPanel } from "@/app/(app)/admin/display/display-admin-panel";

/** The kept copy of `subject`, wherever the shelf put it. */
function keptValue(subject: string): unknown {
    for (let index = 0; index < sessionStorage.length; index += 1) {
        const key = sessionStorage.key(index)!;
        if (key.endsWith(`:${subject}`)) return JSON.parse(sessionStorage.getItem(key)!).value;
    }
    return undefined;
}

/** Write a kept reading under the key the screen will look for. */
function keep(subject: string, value: unknown): void {
    // The hook prefixes the shelf; outside a provider that is the personal one.
    writeSnapshot(`personal:${subject}`, value);
}

/** A fetch that answers only when the test lets it. */
function heldFetch() {
    let release: (body: unknown) => void = () => undefined;
    const gate = new Promise<unknown>((resolve) => (release = resolve));
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
            const body = await gate;
            return { ok: true, status: 200, json: async () => body } as unknown as Response;
        })
    );
    return { release: (body: unknown) => release(body) };
}

beforeEach(() => sessionStorage.clear());

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("the pages draw without awaiting the data", () => {
    it("display defaults renders its header with no settings read", async () => {
        const page = await DisplayAdminPage();
        expect(page).toBeTruthy();
        expect(reads.platform).not.toHaveBeenCalled();
        expect(reads.theme).not.toHaveBeenCalled();
    });

    it("retention renders without counting the tables", async () => {
        const page = await RetentionPage();
        expect(page).toBeTruthy();
        expect(reads.totals).not.toHaveBeenCalled();
    });
});

describe("the display defaults panel", () => {
    it("shows a skeleton shaped like the cards on a first visit", () => {
        heldFetch();
        render(<DisplayAdminPanel />);
        expect(screen.getByTestId("display-admin-skeleton")).toBeTruthy();
    });

    it("paints the kept reading at once, then swaps in a newer answer", async () => {
        keep("admin.display", { platform: {}, mayChooseTheme: false });
        const fetches = heldFetch();
        render(<DisplayAdminPanel />);

        // No skeleton: the kept reading is on screen before anything answered.
        expect(screen.queryByTestId("display-admin-skeleton")).toBeNull();
        expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");

        await act(async () => fetches.release({ platform: {}, mayChooseTheme: true }));
        await waitFor(() =>
            expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true")
        );
        expect(keptValue("admin.display")).toEqual({ platform: {}, mayChooseTheme: true });
    });

    it("rewrites the kept reading when a change is saved", async () => {
        keep("admin.display", { platform: {}, mayChooseTheme: true });
        const fetches = heldFetch();
        render(<DisplayAdminPanel />);
        await act(async () => fetches.release({ platform: {}, mayChooseTheme: true }));

        await act(async () => fireEvent.click(screen.getByRole("switch")));
        await waitFor(() =>
            expect(keptValue("admin.display")).toEqual({ platform: {}, mayChooseTheme: false })
        );
    });
});

describe("the retention counts", () => {
    const policy = { notifications: 30, activity: 90, audit: 0 } as const;
    const totals = {
        notifications: { total: 1200, due: 40 },
        activity: { total: 5, due: 0 },
        audit: { total: 7, due: 0 }
    };

    it("holds a skeleton line per table until the first count", () => {
        heldFetch();
        const { container } = render(<RetentionView policy={policy} />);
        expect(container.querySelectorAll(".animate-pulse")).toHaveLength(3);
    });

    it("paints the kept counts before the count is asked again", () => {
        keep("admin.retention.totals", totals);
        heldFetch();
        const { container } = render(<RetentionView policy={policy} />);
        expect(container.querySelectorAll(".animate-pulse")).toHaveLength(0);
    });
});
