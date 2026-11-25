/**
 * Every session on the table sits under a header that is really its own.
 *
 * Sessions on a known device are listed under that device's header. The ones on
 * no device used to follow the last group with nothing in between, so an iPhone
 * or a TV box read as one more session of "Unnamed device". They now sit under
 * an "Other sessions" header of their own, separated like any other group.
 */

import { withMessages } from "../setup/i18n";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionView } from "@/lib/session-directory";
import { SessionsTable } from "@/components/sessions-table";

const DESKTOP_KEY = "a".repeat(64);

function session(id: string, overrides: Partial<SessionView> = {}): SessionView {
    return {
        id,
        current: false,
        approval: "approved",
        locked: false,
        name: `Name ${id}`,
        device: "Chrome on Windows",
        browser: "Chrome",
        browserVersion: "131",
        os: "Windows",
        osVersion: null,
        ip: "10.0.1.131",
        publicIp: null,
        country: "ES",
        host: "polaris.local",
        lastSeenAt: "2026-08-03T10:00:00.000Z",
        createdAt: "2026-08-01T10:00:00.000Z",
        expiresAt: "2026-08-08T10:00:00.000Z",
        signIn: { method: "password", secondFactor: "totp" },
        authorizedBy: null,
        deviceKey: null,
        deviceName: null,
        ...overrides
    };
}

function render(sessions: SessionView[]): string {
    return renderToStaticMarkup(
        withMessages(<SessionsTable sessions={sessions} busyId={null} emptyLabel="Nothing is signed in." onRevoke={() => {}} />)
    );
}

const grouped = [
    session("desk-1", { deviceKey: DESKTOP_KEY, deviceName: "DRAGON" }),
    session("desk-2", { deviceKey: DESKTOP_KEY, deviceName: "DRAGON" })
];
const loose = [
    session("phone-1", { name: "Phone session", device: "Safari on iOS", browser: "Safari", os: "iOS" }),
    session("tv-1", { name: "TV session", device: "Polaris TV", browser: "Polaris TV", os: "Android" })
];

describe("sessions on no device of their own", () => {
    it("sit under an Other sessions header, after every device group", () => {
        const markup = render([...grouped, ...loose]);
        const device = markup.indexOf("DRAGON");
        const other = markup.indexOf("Other sessions");
        expect(device).toBeGreaterThan(-1);
        expect(other).toBeGreaterThan(device);
        // No loose session renders before the separator, under the device group.
        expect(markup.indexOf("Phone session")).toBeGreaterThan(other);
        expect(markup.indexOf("TV session")).toBeGreaterThan(other);
        // And every grouped one renders before it.
        expect(markup.indexOf("Name desk-1")).toBeLessThan(other);
        expect(markup.indexOf("Name desk-2")).toBeLessThan(other);
    });

    it("counts what is under the header", () => {
        const markup = render([...grouped, ...loose]);
        const header = markup.slice(markup.indexOf('data-testid="other-sessions"'));
        expect(header.slice(0, header.indexOf("</tr>"))).toContain("2 sessions");
    });

    it("needs no header when no device group is drawn", () => {
        expect(render(loose)).not.toContain("Other sessions");
    });

    it("needs no header when every session belongs to a device", () => {
        expect(render(grouped)).not.toContain("Other sessions");
    });
});
