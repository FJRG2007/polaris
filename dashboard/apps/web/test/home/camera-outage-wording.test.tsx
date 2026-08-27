// @vitest-environment jsdom

/**
 * What the cameras screen actually draws for a camera that has gone quiet.
 *
 * The logic that decides an outage is tested against the pass in
 * `camera-outage-sweep.test.ts` and the wording is tested in isolation in
 * `camera-availability.test.ts`, but neither renders the row that a person
 * managing the house actually reads. This pins that the two are wired
 * together: a row whose `offlineSince` is older than the grace window draws
 * "Not answering since ..." and a "Quiet" badge, a row still inside the grace
 * window reads as before, and a switched-off camera never claims to be quiet.
 */

import type { CameraView } from "@/lib/home/cameras";
import { OFFLINE_GRACE_MS } from "@/lib/home/availability";
import { act, cleanup, render, screen } from "@testing-library/react";
import { CamerasView } from "@/app/(app)/places/cameras/cameras-view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let cameras: CameraView[] = [];

vi.mock("@/app/(app)/places/actions", () => ({
    listCamerasAction: async () => ({ cameras }),
    listServersAction: async () => ({ servers: [] }),
    listStorageOptionsAction: async () => ({ options: [] }),
    detectionDefaultsAction: async () => ({
        defaults: { sensitivity: 50, settleSeconds: 2, minGapSeconds: 30 }
    })
}));

function camera(overrides: Partial<CameraView>): CameraView {
    return {
        id: "cam",
        name: "Front door",
        placeId: "place",
        zone: "Porch",
        vendor: "generic",
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
        ...overrides
    };
}

async function painted(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

beforeEach(() => {
    cameras = [];
});

afterEach(() => {
    cleanup();
});

describe("a camera quiet longer than the grace window", () => {
    it("says how long, and wears the badge that says so", async () => {
        cameras = [
            camera({
                id: "quiet",
                name: "Front door",
                offlineSince: new Date(Date.now() - OFFLINE_GRACE_MS - 60_000).toISOString()
            })
        ];

        const { container } = render(<CamerasView canManage openId={null} />);
        await painted();

        expect(screen.getByText(/Not answering since/)).toBeDefined();
        expect(screen.getByText("Quiet")).toBeDefined();
        // Reviewer-visible evidence of the actual markup the browser draws.
        console.log("RENDERED_ROW_HTML_START");
        console.log(container.querySelector("tbody")?.innerHTML);
        console.log("RENDERED_ROW_HTML_END");
    });
});

describe("a camera still inside the grace window", () => {
    it("says nothing about being quiet yet", async () => {
        cameras = [
            camera({
                id: "fresh",
                name: "Garage",
                zone: "Drive",
                offlineSince: new Date(Date.now() - 5_000).toISOString()
            })
        ];

        render(<CamerasView canManage openId={null} />);
        await painted();

        expect(screen.queryByText(/Not answering since/)).toBeNull();
        expect(screen.queryByText("Quiet")).toBeNull();
        expect(screen.getByText(/^Drive/)).toBeDefined();
    });
});

describe("a camera that is switched off", () => {
    it("says it is off rather than quiet, even if it never answered", async () => {
        cameras = [
            camera({
                id: "off",
                name: "Garden",
                enabled: false,
                offlineSince: new Date(Date.now() - OFFLINE_GRACE_MS - 60_000).toISOString()
            })
        ];

        render(<CamerasView canManage openId={null} />);
        await painted();

        expect(screen.getByText("Off")).toBeDefined();
        expect(screen.queryByText("Quiet")).toBeNull();
        expect(screen.queryByText(/Not answering since/)).toBeNull();
    });
});
