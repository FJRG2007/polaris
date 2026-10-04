// @vitest-environment jsdom

/**
 * The Overview of a place, drawn.
 *
 * Its summaries name only what the place has, its rooms carry each device's own
 * control, a visitor is shown neither the automations nor the events, and a
 * copy kept from earlier paints at once but is not pressed until the fresh read
 * lands.
 */

import "@/components/app-host/client";
import { withMessages } from "../setup/i18n";
import { writeSnapshot } from "@/lib/snapshot-cache";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceView } from "@polaris-app/places/src/lib/device-kinds";
import type { PlaceOverview } from "@polaris-app/places/src/screens/overview/actions";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

function device(overrides: Partial<DeviceView>): DeviceView {
    return {
        id: "lamp",
        vendor: "fixture",
        kind: "light",
        name: "Reading lamp",
        zone: "Living room",
        placeId: "place-1",
        model: "",
        firmware: "",
        state: "off",
        doorState: "none",
        batteryPercent: null,
        batteryCritical: false,
        online: true,
        controllable: true,
        reading: null,
        stateAt: null,
        ...overrides
    };
}

const HOUSE: PlaceOverview = {
    placeId: "place-1",
    devices: [
        device({}),
        device({ id: "door", kind: "lock", name: "Front door", zone: "Hall", state: "locked" }),
        device({ id: "porch", name: "Porch light", zone: "", online: false, state: "unknown" })
    ],
    cameras: [],
    automations: [
        {
            id: "auto-1",
            name: "Lights off at midnight",
            enabled: true,
            lastRunAt: null,
            lastStatus: null
        }
    ],
    events: [
        {
            id: "event-1",
            cameraName: "Driveway",
            at: new Date().toISOString(),
            kind: "person",
            person: null,
            acked: false
        }
    ]
};

let reply: (value: { overview?: PlaceOverview; error?: string }) => void = () => undefined;
let served: PlaceOverview = HOUSE;
let hold = false;
const pressed: [string, string][] = [];

vi.mock("@polaris-app/places/src/screens/overview/actions", () => ({
    placeOverviewAction: () =>
        hold
            ? new Promise((resolve) => {
                  reply = resolve;
              })
            : Promise.resolve({ overview: served })
}));

vi.mock("@polaris-app/places/src/screens/actions", () => ({
    deviceHistoryAction: async () => ({ events: [] }),
    deviceUsageAction: async () => ({ used: [] }),
    operateDeviceAction: async (id: string, action: string) => {
        pressed.push([id, action]);
        return { error: "The light did not answer." };
    }
}));

vi.mock("@polaris-app/places/src/screens/automations/actions", () => ({
    runAutomationAction: async () => ({})
}));

const { OverviewView } = await import("@polaris-app/places/src/screens/overview/overview-view");

beforeEach(() => {
    sessionStorage.clear();
    served = HOUSE;
    hold = false;
    pressed.length = 0;
});

afterEach(cleanup);

function draw(options: { resident?: boolean; canControl?: boolean; locale?: "es-ES" } = {}) {
    render(
        withMessages(
            <OverviewView
                placeId="place-1"
                places={[]}
                resident={options.resident ?? true}
                canControl={options.canControl ?? true}
                canManage={false}
            />,
            options.locale
        )
    );
}

describe("the Overview", () => {
    it("draws the frame of every card before anything is read", () => {
        hold = true;
        draw();
        expect(screen.getByText("Rooms")).toBeTruthy();
        expect(screen.getByText("Cameras")).toBeTruthy();
        expect(screen.getByText("Automations")).toBeTruthy();
        expect(screen.getByText("Recent events")).toBeTruthy();
    });

    it("sums up only what the place has", async () => {
        draw();
        await screen.findByText("Reading lamp");
        const summary = screen.getByRole("region", { name: "At a glance" });
        expect(summary.textContent).toContain("2 of 3 online");
        expect(summary.textContent).toContain("1 offline");
        expect(summary.textContent).toContain("All locked");
        expect(summary.textContent).toContain("All off");
        // No air conditioner, no thermometer, no camera: no tile for them.
        expect(summary.textContent).not.toContain("Climate");
        expect(summary.textContent).not.toContain("Cameras");
    });

    it("puts each device in its room, with its own control", async () => {
        draw();
        await screen.findByText("Reading lamp");
        expect(screen.getByText("Living room")).toBeTruthy();
        expect(screen.getByText("Hall")).toBeTruthy();
        expect(screen.getByText("Not in a room")).toBeTruthy();
        expect(screen.getByRole("switch", { name: "Turn Reading lamp on or off" })).toBeTruthy();
    });

    it("lists what is not answering under Needs attention", async () => {
        draw();
        await screen.findByText("Needs attention");
        expect(screen.getAllByText("Not answering").length).toBeGreaterThan(0);
    });

    it("flips a switch at once and puts it back, with the reason, when refused", async () => {
        draw();
        const toggle = await screen.findByRole("switch", { name: "Turn Reading lamp on or off" });
        await act(async () => {
            fireEvent.click(toggle);
        });
        expect(pressed).toEqual([["lamp", "turn-on"]]);
        await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("The light did not answer."));
        expect(toggle.getAttribute("aria-checked")).toBe("false");
    });

    it("shows a visitor neither the automations nor the events", async () => {
        served = { ...HOUSE, automations: null, events: null };
        draw({ resident: false });
        await screen.findByText("Reading lamp");
        expect(screen.queryByText("Automations")).toBeNull();
        expect(screen.queryByText("Recent events")).toBeNull();
    });

    it("lists the automations and what the cameras saw", async () => {
        draw();
        expect(await screen.findByText("Lights off at midnight")).toBeTruthy();
        expect(screen.getByText("Driveway")).toBeTruthy();
    });

    it("paints the copy it kept, and waits for the fresh one before anything is pressed", async () => {
        writeSnapshot("places.overview.place-1", HOUSE);
        hold = true;
        draw();
        const toggle = screen.getByRole("switch", { name: "Turn Reading lamp on or off" });
        expect(toggle.hasAttribute("disabled") || toggle.getAttribute("aria-disabled") === "true").toBe(true);
        await act(async () => reply({ overview: HOUSE }));
        await waitFor(() => {
            const fresh = screen.getByRole("switch", { name: "Turn Reading lamp on or off" });
            expect(fresh.hasAttribute("disabled")).toBe(false);
        });
    });

    it("speaks Spanish", async () => {
        draw({ locale: "es-ES" });
        await screen.findByText("Reading lamp");
        expect(screen.getByText("Salas")).toBeTruthy();
        expect(screen.getByRole("region", { name: "De un vistazo" }).textContent).toContain("2 de 3 en línea");
        expect(screen.getByText("Sin sala")).toBeTruthy();
    });
});
