/**
 * What the remembered-devices list actually puts on screen.
 *
 * This is the surface a person reaches for after noticing their phone was not
 * asked for a code - so it has to show the facts a device is recognisable by,
 * mark the one they are reading it on, and offer to end each pass on its own.
 * The whole point of the card is that ending one is not ending all of them, so
 * the per-row control is what is pinned here.
 *
 * Rendered to static markup: the assertions are about the table's contract, and
 * none of them need a browser.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TrustedDeviceRow } from "@/lib/session-directory";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/components/confirm-dialog", () => ({ useConfirm: () => [async () => true, null] }));
vi.mock("@/components/relative-time", () => ({
    RelativeTime: ({ iso, tense }: { iso: string; tense?: string }) => `${tense ?? "past"}:${iso}`
}));
vi.mock("../../src/app/(app)/account/sessions/actions", () => ({
    forgetTrustedDeviceAction: async () => ({}),
    forgetTrustedDevicesAction: async () => ({ count: 0 })
}));

const { TrustedDevicesCard } = await import("../../src/app/(app)/account/sessions/trusted-devices-card");

function device(overrides: Partial<TrustedDeviceRow> = {}): TrustedDeviceRow {
    return {
        id: "trust-device-aaaaaaaa",
        current: false,
        device: "Chrome on Android",
        ip: "192.168.1.131",
        host: "polaris.local",
        rememberedAt: "2026-07-20T10:00:00.000Z",
        lastSeenAt: "2026-08-01T10:00:00.000Z",
        expiresAt: "2026-08-19T10:00:00.000Z",
        ...overrides
    };
}

function render(devices: TrustedDeviceRow[]): string {
    return renderToStaticMarkup(<TrustedDevicesCard devices={devices} />);
}

describe("the remembered-devices card", () => {
    it("names every column a device is recognised by", () => {
        const markup = render([device()]);
        for (const column of ["Device", "Address", "Domain", "Remembered", "Until"]) {
            expect(markup).toContain(`>${column}</th>`);
        }
    });

    it("shows what the device was and where it signed in from", () => {
        const markup = render([device()]);
        expect(markup).toContain("Chrome on Android");
        expect(markup).toContain("192.168.1.131");
        expect(markup).toContain("polaris.local");
        // The expiry is ahead of us, so it has to be phrased as such.
        expect(markup).toContain("future:2026-08-19T10:00:00.000Z");
    });

    it("offers to end each pass on its own, named so it can be told apart", () => {
        const markup = render([device(), device({ id: "trust-device-bbbbbbbb", device: "Safari on iOS" })]);
        expect(markup).toContain('aria-label="Stop remembering Chrome on Android"');
        expect(markup).toContain('aria-label="Stop remembering Safari on iOS"');
    });

    it("marks the device the page is being read on", () => {
        expect(render([device({ current: true })])).toContain("This device");
        expect(render([device()])).not.toContain("This device");
    });

    it("lists a pass granted before Polaris described them, rather than hiding it", () => {
        const markup = render([device({ rememberedAt: null, device: "Unknown device", ip: null, host: null })]);
        expect(markup).toContain("Remembered earlier");
        expect(markup).toContain('aria-label="Stop remembering this device"');
    });

    it("only offers the blunt control when there is more than one to end", () => {
        expect(render([device()])).not.toContain("Forget them all");
        expect(render([device(), device({ id: "trust-device-bbbbbbbb" })])).toContain("Forget them all");
    });

    it("says plainly when nothing is remembered", () => {
        expect(render([])).toContain("Nothing is remembered.");
    });
});
