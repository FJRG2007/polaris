// @vitest-environment jsdom

/**
 * The one cameras page: the live wall, managed from the wall itself.
 *
 * Somebody who runs the house gets each tile's management menu, the add and
 * discover buttons in the header and the privacy switch; a visitor lent a
 * camera sees the same tiles and nothing to manage. The search narrows the wall
 * as it narrowed the old list, the compact list is a toggle away and the toggle
 * is remembered, and the old wall address sends people here.
 */

import type { CameraView } from "@polaris-app/places/src/lib/cameras";
import { cameraSwitchSchema } from "@polaris-app/places/src/lib/schemas";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
    CamerasView,
    CAMERAS_VIEW_KEY
} from "@polaris-app/places/src/screens/cameras/cameras-view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The dashboard's pieces the screen takes, as the layout provides them.
import "@/components/app-host/client";

let cameras: CameraView[] = [];
const switched = vi.fn();

vi.mock("@/app/(app)/access-actions", () => ({
    listGrantsAction: async () => ({ grants: [], candidates: [] }),
    shareAction: async () => ({ grants: [] }),
    revokeShareAction: async () => ({ grants: [] }),
    findSharePeopleAction: async () => ({ people: [] })
}));

vi.mock("@polaris-app/places/src/screens/actions", () => ({
    listCamerasAction: async () => ({ cameras }),
    liveCamerasAction: async () => ({ live: [] }),
    listCameraSetsAction: async () => ({ sets: [] }),
    listRoomsAction: async () => ({ rooms: [] }),
    listServersAction: async () => ({ servers: [] }),
    listStorageOptionsAction: async () => ({ options: [] }),
    detectionDefaultsAction: async () => ({
        defaults: { sensitivity: 50, settleSeconds: 2, minGapSeconds: 30 }
    }),
    switchCameraAction: async (...args: unknown[]) => {
        switched(...args);
        return { error: "refused" };
    }
}));

const redirect = vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
});
vi.mock("next/navigation", async (original) => ({
    ...(await original<typeof import("next/navigation")>()),
    redirect: (to: string) => redirect(to)
}));

function camera(overrides: Partial<CameraView>): CameraView {
    return {
        id: "cam",
        name: "Front door",
        placeId: "place",
        zone: "Porch",
        roomId: "",
        vendor: "generic",
        model: null,
        modelId: "",
        power: "mains",
        address: "192.0.2.1",
        rtspPort: 554,
        onvifPort: null,
        mainPath: "",
        subPath: "",
        username: "",
        hasPassword: false,
        reachVia: "local",
        detector: "none",
        detectorTargetId: null,
        detection: { sensitivity: 50, settleSeconds: 2, minGapSeconds: 30 },
        recording: "off",
        storageTarget: "",
        retentionDays: 30,
        enabled: true,
        ptz: false,
        lastSeenAt: null,
        offlineSince: null,
        privacy: false,
        privacyNative: false,
        privacyPreset: "",
        ...overrides
    } as CameraView;
}

async function painted(): Promise<void> {
    await act(async () => {
        for (let step = 0; step < 6; step += 1) await Promise.resolve();
    });
}

/** jsdom here has no working localStorage; an in-memory one stands in. */
function memoryStorage(): Storage {
    const items = new Map<string, string>();
    return {
        get length() {
            return items.size;
        },
        clear: () => items.clear(),
        getItem: (key) => items.get(key) ?? null,
        key: (index) => [...items.keys()][index] ?? null,
        removeItem: (key) => void items.delete(key),
        setItem: (key, value) => void items.set(key, String(value))
    };
}

beforeEach(() => {
    cameras = [];
    switched.mockClear();
    Object.defineProperty(window, "localStorage", { value: memoryStorage(), configurable: true });
    // jsdom has neither; a tile only needs them to exist.
    vi.stubGlobal(
        "IntersectionObserver",
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        }
    );
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("{}", { status: 404 }))
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("somebody who runs the house", () => {
    it("gets the wall with each tile's management menu and the header buttons", async () => {
        cameras = [camera({ id: "a", name: "Front door" }), camera({ id: "b", name: "Garden" })];
        render(<CamerasView canManage canControl openId={null} header={<h1>Cameras</h1>} />);
        // The header is there before a camera has been read.
        expect(screen.getByRole("button", { name: "Add a camera" })).toBeDefined();
        expect(screen.getByRole("button", { name: "Look for cameras" })).toBeDefined();
        await painted();

        expect(screen.getByRole("button", { name: "Open Front door" })).toBeDefined();
        expect(screen.getByRole("button", { name: "More for Front door" })).toBeDefined();
        expect(screen.getByRole("button", { name: "More for Garden" })).toBeDefined();
        expect(screen.getAllByRole("button", { name: /privacy/i }).length).toBeGreaterThan(0);
        // The wall, not the table.
        expect(document.querySelector("table")).toBeNull();
    });
});

describe("a visitor lent a camera", () => {
    it("sees the tile and nothing to manage it with", async () => {
        cameras = [camera({ id: "a", name: "Front door" })];
        render(
            <CamerasView
                canManage={false}
                canControl={false}
                openId={null}
                header={<h1>Cameras</h1>}
            />
        );
        await painted();

        expect(screen.getByRole("button", { name: "Open Front door" })).toBeDefined();
        expect(screen.queryByRole("button", { name: /More for/ })).toBeNull();
        expect(screen.queryByRole("button", { name: "Add a camera" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Look for cameras" })).toBeNull();
        expect(screen.queryByRole("button", { name: /privacy/i })).toBeNull();
    });

    it("gets no row actions in the list either", async () => {
        window.localStorage.setItem(CAMERAS_VIEW_KEY, "list");
        cameras = [camera({ id: "a", name: "Front door" })];
        render(
            <CamerasView
                canManage={false}
                canControl={false}
                openId={null}
                header={<h1>Cameras</h1>}
            />
        );
        await painted();

        expect(document.querySelector("table")).not.toBeNull();
        expect(
            screen.queryByRole("button", { name: /Change Front door|Remove Front door/ })
        ).toBeNull();
    });
});

describe("narrowing the wall", () => {
    it("shows only the cameras the search matches", async () => {
        cameras = ["Front door", "Garden", "Garage", "Kitchen", "Hall"].map((name, index) =>
            camera({ id: `c${index}`, name, zone: index < 2 ? "Outside" : "Inside" })
        );
        render(<CamerasView canManage canControl openId={null} header={null} />);
        await painted();
        expect(screen.getAllByRole("button", { name: /^Open / })).toHaveLength(5);

        fireEvent.change(screen.getByRole("textbox", { name: "Search cameras" }), {
            target: { value: "gar" }
        });

        const open = screen.getAllByRole("button", { name: /^Open / });
        expect(open.map((button) => button.getAttribute("aria-label"))).toEqual([
            "Open Garage",
            "Open Garden"
        ]);
    });
});

describe("the compact list", () => {
    it("is a toggle away, keeps every row action, and is remembered", async () => {
        cameras = [camera({ id: "a", name: "Front door" })];
        render(<CamerasView canManage canControl openId={null} header={null} />);
        await painted();

        fireEvent.click(screen.getByRole("radio", { name: /List/ }));
        await painted();

        expect(document.querySelector("table")).not.toBeNull();
        for (const name of [
            "Change Front door",
            "Draw areas on Front door",
            "Share Front door",
            "Remove Front door",
            "More for Front door"
        ]) {
            expect(screen.getByRole("button", { name })).toBeDefined();
        }
        expect(window.localStorage.getItem(CAMERAS_VIEW_KEY)).toBe("list");
    });

    it("still draws when the browser keeps nothing", async () => {
        Object.defineProperty(window, "localStorage", {
            configurable: true,
            get() {
                throw new Error("blocked");
            }
        });
        cameras = [camera({ id: "a", name: "Front door" })];
        render(<CamerasView canManage canControl openId={null} header={null} />);
        await painted();
        expect(screen.getByRole("button", { name: "Open Front door" })).toBeDefined();
    });
});

describe("switching a camera from the page", () => {
    it("accepts only the two switches, and at least one", () => {
        expect(cameraSwitchSchema.safeParse({ enabled: false }).success).toBe(true);
        expect(cameraSwitchSchema.safeParse({ recording: "continuous" }).success).toBe(true);
        expect(cameraSwitchSchema.safeParse({}).success).toBe(false);
        expect(cameraSwitchSchema.safeParse({ recording: "always" }).success).toBe(false);
        expect(cameraSwitchSchema.safeParse({ enabled: true, name: "x" }).success).toBe(false);
    });
});

describe("the old wall address", () => {
    it("sends people to the cameras page", async () => {
        const page = await import("@polaris-app/places/src/routes/places/live/page");
        expect(() => page.default()).toThrow("redirect:/places/cameras");
        expect(redirect).toHaveBeenCalledWith("/places/cameras");
    });
});
