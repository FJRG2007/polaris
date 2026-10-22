// @vitest-environment jsdom

/**
 * A camera taken out of privacy on the wall comes back without a reload.
 *
 * The wall asked the relay once, the moment the switch answered, which streams
 * it was serving. That answer lands before the relay has picked the camera up
 * again, so the camera was left out of the live set and its tile said
 * "Starting" until the page was reloaded. The wall now asks again until the
 * camera is served.
 */

import type { CameraView } from "@polaris-app/places/src/lib/cameras";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CamerasView } from "@polaris-app/places/src/screens/cameras/cameras-view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The dashboard's pieces the screen takes, as the layout provides them.
import "@/components/app-host/client";

let cameras: CameraView[] = [];
let served: string[][] = [];
const liveCalls = vi.fn();
const routeCalls = vi.fn();

/** Each ask takes the next answer, and keeps the last one once they run out. */
function nextServed(): string[] {
    return served.length > 1 ? served.shift()! : (served[0] ?? []);
}

vi.mock("@/app/(app)/access-actions", () => ({
    listGrantsAction: async () => ({ grants: [], candidates: [] }),
    shareAction: async () => ({ grants: [] }),
    revokeShareAction: async () => ({ grants: [] }),
    findSharePeopleAction: async () => ({ people: [] })
}));

vi.mock("@polaris-app/places/src/screens/actions", () => ({
    listCamerasAction: async () => ({ cameras }),
    listCameraSetsAction: async () => ({ sets: [] }),
    listRoomsAction: async () => ({ rooms: [] }),
    listServersAction: async () => ({ servers: [] }),
    listStorageOptionsAction: async () => ({ options: [] }),
    detectionDefaultsAction: async () => ({ defaults: null }),
    liveCamerasAction: async () => {
        liveCalls();
        return { live: nextServed() };
    },
    cameraPrivacyAction: async () => ({
        results: [{ cameraId: "cam", name: "Front door", native: true, private: false }]
    })
}));

vi.mock("@polaris-app/places/src/screens/use-detections", () => ({
    useDetections: () => ({})
}));

function camera(overrides: Partial<CameraView>): CameraView {
    return {
        id: "cam",
        name: "Front door",
        placeId: "place",
        zone: "Porch",
        vendor: "tapo",
        model: null,
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
        privacyNative: true,
        privacyPreset: "",
        ...overrides
    } as CameraView;
}

async function settle(ms = 0): Promise<void> {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });
}

/** Time passing a second at a time, so each ask's answer is drawn and the next
 *  one scheduled before the clock moves on. */
async function wait(ms: number): Promise<void> {
    for (let gone = 0; gone < ms; gone += 1_000) await settle(1_000);
}

beforeEach(() => {
    vi.useFakeTimers();
    // The wall is the page's default; this jsdom has no working storage.
    Object.defineProperty(window, "localStorage", {
        configurable: true,
        value: { getItem: () => null, setItem: () => undefined }
    });
    liveCalls.mockClear();
    routeCalls.mockClear();
    // The wall's rechecks are a route, never an action: an update renames every
    // action under a tab left open.
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url !== "/api/home/cameras/live") return new Response(null, { status: 404 });
            liveCalls();
            routeCalls();
            return Response.json({ live: nextServed() });
        })
    );
    globalThis.IntersectionObserver = class {
        observe() {}
        disconnect() {}
        unobserve() {}
    } as unknown as typeof IntersectionObserver;
    HTMLMediaElement.prototype.pause = () => undefined;
    HTMLMediaElement.prototype.load = () => undefined;
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe("the wall after privacy is turned off", () => {
    it("asks the relay again until the camera is served, instead of staying on Starting", async () => {
        cameras = [camera({ privacy: true })];
        // At load the camera is private, so the relay holds nothing. Right after
        // the switch it still holds nothing; a moment later it serves it.
        served = [[], [], ["cam"]];
        render(<CamerasView canManage canControl openId={null} header={null} />);
        await settle();
        expect(screen.getAllByText(/^Private/).length).toBeGreaterThan(0);

        fireEvent.click(screen.getByRole("button", { name: "Turn privacy off" }));
        await settle();
        await settle(2_000);
        expect(screen.getByText("Starting")).toBeTruthy();

        await settle(2_000);
        expect(screen.queryByText("Starting")).toBeNull();
        expect(screen.getByRole("img", { name: "Front door" })).toBeTruthy();
        expect(routeCalls).toHaveBeenCalled();
    });

    it("keeps asking through a failed answer", async () => {
        cameras = [camera({})];
        served = [[]];
        render(<CamerasView canManage canControl openId={null} header={null} />);
        await settle();
        vi.mocked(fetch).mockResolvedValueOnce(new Response("Unavailable", { status: 503 }));
        served = [["cam"]];
        await wait(10_000);
        expect(screen.queryByText("Starting")).toBeNull();
        expect(screen.getByRole("img", { name: "Front door" })).toBeTruthy();
    });

    it("stops asking once every camera is served", async () => {
        cameras = [camera({})];
        served = [["cam"]];
        render(<CamerasView canManage canControl openId={null} header={null} />);
        await settle();
        const asked = liveCalls.mock.calls.length;
        await wait(60_000);
        expect(liveCalls.mock.calls.length).toBe(asked);
    });

    it("backs off for a camera the relay never serves", async () => {
        cameras = [camera({})];
        served = [[]];
        render(<CamerasView canManage canControl openId={null} header={null} />);
        await settle();
        await wait(10 * 60_000);
        // Quick at first, then once every half a minute: about twenty asks in
        // ten minutes, not three hundred.
        expect(liveCalls.mock.calls.length).toBeLessThan(30);
        expect(liveCalls.mock.calls.length).toBeGreaterThan(10);
    });
});
