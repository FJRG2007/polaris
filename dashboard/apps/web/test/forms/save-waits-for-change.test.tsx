// @vitest-environment jsdom

/**
 * Save stays off until something actually changed.
 *
 * Opening a record and saving it untouched writes what is already stored, and so
 * does changing a value and putting it back. Each dialog here is opened on a
 * stored record: Save is off on open, on after a real change, and off again once
 * the change is undone.
 */

import "@/components/app-host/client";
import { withMessages } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@polaris-app/places/src/screens/actions", () => ({
    savePlaceAction: async () => ({}),
    saveAlertAction: async () => ({})
}));
vi.mock("@polaris-app/status-pages/src/actions/manage", () => ({}));

const { PlaceDialog } = await import("@polaris-app/places/src/screens/place-dialog");
const { AlertDialog } = await import("@polaris-app/places/src/screens/alerts/alert-dialog");
const { ComponentDialog } = await import("@polaris-app/status-pages/src/screens/forms");

afterEach(cleanup);

function saveButton(name: RegExp = /^save$/i): HTMLButtonElement {
    return screen.getByRole("button", { name }) as HTMLButtonElement;
}

/** Off by either attribute: some forms keep the button focusable and say so with aria. */
function off(button: HTMLButtonElement): boolean {
    return button.disabled || button.getAttribute("aria-disabled") === "true";
}

function type(field: HTMLElement, value: string): void {
    fireEvent.change(field, { target: { value } });
}

describe("a dialog opened on a stored record", () => {
    it("keeps Save off for a place until it differs, and again once it is put back", () => {
        render(
            withMessages(
                <PlaceDialog
                    place={{
                        id: "place-1",
                        name: "Home",
                        kind: "house",
                        address: "",
                        location: null,
                        cameras: 0
                    }}
                    onClose={() => undefined}
                    onSaved={() => undefined}
                />
            )
        );
        const name = screen.getByDisplayValue("Home");
        expect(off(saveButton())).toBe(true);
        type(name, "Cabin");
        expect(off(saveButton())).toBe(false);
        type(name, "Home ");
        expect(off(saveButton())).toBe(true);
    });

    it("keeps Save off for an alert until it differs, and again once it is put back", () => {
        render(
            withMessages(
                <AlertDialog
                    rule={{
                        id: "rule-1",
                        name: "Night",
                        placeId: "place-1",
                        cameraId: null,
                        kinds: ["person"],
                        label: null,
                        zones: [],
                        hours: null,
                        recipients: ["user-1"],
                        notify: false,
                        enabled: true
                    } as never}
                    cameras={[]}
                    people={[{ id: "user-1", name: "Ana" }]}
                    known={[]}
                    areas={[]}
                    onClose={() => undefined}
                    onSaved={() => undefined}
                />
            )
        );
        const name = screen.getByDisplayValue("Night");
        expect(off(saveButton())).toBe(true);
        type(name, "Late night");
        expect(off(saveButton())).toBe(false);
        type(name, "Night");
        expect(off(saveButton())).toBe(true);
    });

    it("keeps Save off for a status component until it differs, and again once it is put back", () => {
        const initial = { id: "component-1", name: "API", description: "" };
        render(
            withMessages(
                <ComponentDialog
                    open
                    onOpenChange={() => undefined}
                    pageId="2f0c3a8e-5b1d-4c7a-9e6f-0a1b2c3d4e5f"
                    initial={initial}
                    onSaved={() => undefined}
                />
            )
        );
        const name = screen.getByDisplayValue("API");
        expect(off(saveButton())).toBe(true);
        type(name, "Public API");
        expect(off(saveButton())).toBe(false);
        type(name, "API");
        expect(off(saveButton())).toBe(true);
    });
});
