// @vitest-environment jsdom

/**
 * Places, drawn in Spanish.
 *
 * Places is an installed app with catalogs of its own, and reads the language
 * from the host rather than from the dashboard's provider - so what is asserted
 * first is that a screen of it follows the page into Spanish at all. Then the
 * words that live as data (a kind of place, a device's history, a sensor's
 * reading) and a camera's detector explained.
 */

import "@/components/app-host/client";
import { withMessages } from "../../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("@polaris-app/places/src/screens/actions", () => ({
    savePlaceAction: async () => ({}),
    discoverCamerasAction: async () => ({ found: [] })
}));

const { PlaceDialog } = await import("@polaris-app/places/src/screens/place-dialog");
const { DiscoverDialog } = await import("@polaris-app/places/src/screens/cameras/discover-dialog");
const { placesCatalogs } = await import("@polaris-app/places/messages");
const kinds = await import("@polaris-app/places/src/lib/device-kinds");

const t = placesCatalogs.translator("es-ES", "places");

afterEach(cleanup);

/** What a dialog put on the page - it draws into a portal, not into its parent. */
function drawn(node: React.ReactNode, locale?: "es-ES"): string {
    render(withMessages(node, locale));
    return document.body.textContent ?? "";
}

describe("a Places screen", () => {
    it("follows the page into Spanish", () => {
        const markup = drawn(
            <PlaceDialog place={null} onClose={() => undefined} onSaved={() => undefined} />,
            "es-ES"
        );
        expect(markup).toContain("Añadir sitio");
        expect(markup).toContain("Qué es");
        expect(markup).not.toContain("Add a place");
    });

    it("stays in English for an English reader", () => {
        const markup = drawn(
            <PlaceDialog place={null} onClose={() => undefined} onSaved={() => undefined} />
        );
        expect(markup).toContain("Add a place");
    });

    it("says what looking for cameras does, in Spanish", () => {
        const markup = drawn(
            <DiscoverDialog known={new Set()} servers={[]} onClose={() => undefined} onPick={() => undefined} />,
            "es-ES"
        );
        expect(markup).toContain("Polaris pregunta primero a la red");
        expect(markup).toContain("Rango de IP");
    });
});

describe("words that live as data", () => {
    it("names a place's kind and a device's state in Spanish", () => {
        expect(t("placeKinds.office")).toBe("Oficina");
        expect(kinds.stateLabel("lock", "jammed", t)).toBe("Atascada");
        expect(kinds.stateLabel("opener", "unlatched", t)).toBe("Dejando pasar");
    });

    it("writes a device's history as one Spanish sentence", () => {
        const line = kinds.describeEvent(
            {
                id: "e1",
                deviceId: "d1",
                deviceName: "Front door",
                action: "unlock",
                actor: "Ana",
                via: "keypad",
                outcome: "ok",
                note: "",
                at: "2026-01-01T10:00:00.000Z"
            },
            t
        );
        expect(line).toBe("Abierta por Ana en el teclado");
    });

    it("reads a two-state sensor in Spanish and a measured value as it came", () => {
        expect(kinds.readingLine({ value: "Somebody there", unit: "" }, t)).toBe("Hay alguien");
        expect(kinds.readingLine({ value: "21.5", unit: "°C" }, t)).toBe("21.5°C");
    });
});
