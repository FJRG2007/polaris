// @vitest-environment jsdom

/**
 * The "Which devices" field of a block: what it offers, and the count under it
 * once an area is picked - the same reading the engine makes on a run.
 */

import "@/components/app-host/client";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { DeviceView } from "@polaris-app/places/src/lib/device-kinds";
import {
    PlaceTargetField,
    RoomsProvider,
    TargetPlaceProvider
} from "@polaris-app/places/src/screens/automations/flow-fields";

const ROOMS = [{ id: "kitchen", placeId: "p", name: "Kitchen", floor: "Ground", floorId: "g" }];
const LABELS = [{ id: "top", placeId: "p", name: "Ceiling" }];
const DEVICES = [
    { id: "a", name: "Ceiling lamp", kind: "light", roomId: "kitchen", labelIds: ["top"] },
    { id: "b", name: "Counter lamp", kind: "light", roomId: "kitchen", labelIds: [] },
    { id: "c", name: "Kettle", kind: "outlet", roomId: "kitchen" }
].map((device) => ({ ...device, controllable: true, zone: "" })) as unknown as DeviceView[];

function draw(block: Record<string, unknown>) {
    render(
        <RoomsProvider value={ROOMS}>
            <TargetPlaceProvider value={{ labels: LABELS, devices: DEVICES }}>
                <PlaceTargetField
                    block={{ id: "s", kind: "device", deviceId: "", do: "turn-on", ...block }}
                    path={[]}
                    onChange={() => undefined}
                />
            </TargetPlaceProvider>
        </RoomsProvider>
    );
}

afterEach(cleanup);

describe("which devices a block is about", () => {
    it("draws no count while the devices are the ones chosen", () => {
        draw({});
        expect(document.querySelector("[aria-live]")).toBeNull();
        expect(screen.queryByText("Except")).toBeNull();
    });

    it("counts the lights of a room, less what is left out", () => {
        draw({
            targets: [{ kind: "room", id: "kitchen" }],
            only: ["light"],
            exclude: [{ kind: "label", id: "top" }]
        });
        expect(screen.getByText("1 light, 1 excluded")).toBeTruthy();
        expect(screen.getByText("Light")).toBeTruthy();
        expect(screen.getByText("All labelled Ceiling")).toBeTruthy();
    });

    it("counts every kind in the whole place", () => {
        draw({ targets: [{ kind: "place", id: "all" }] });
        expect(screen.getByText("3 devices")).toBeTruthy();
    });

    it("says so when nothing there answers", () => {
        draw({ targets: [{ kind: "label", id: "top" }], only: ["lock"] });
        expect(screen.getByText("Nothing there answers this yet.")).toBeTruthy();
    });
});
