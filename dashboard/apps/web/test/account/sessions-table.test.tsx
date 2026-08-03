/**
 * What the session table actually puts on screen. The list is the surface a
 * person uses to notice access they did not expect, so the facts that let them
 * tell two sessions apart - the address it came from and the name it was opened
 * on - have to be rendered, not merely fetched.
 *
 * Rendered to static markup rather than driven in a browser: this asserts the
 * table's own contract (a row per session, a cell per fact), which is exactly
 * what regressed when the list was a stack of identical-looking cards.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionView } from "@/lib/session-directory";
import { SessionsTable, sessionOrigin } from "@/components/sessions-table";

function session(overrides: Partial<SessionView> = {}): SessionView {
    return {
        id: "11111111-1111-4111-8111-111111111111",
        current: false,
        approval: "approved",
        locked: false,
        device: "Chrome on Windows",
        ip: "192.168.1.131",
        publicIp: null,
        country: "ES",
        host: "polaris.local",
        lastSeenAt: "2026-08-03T10:00:00.000Z",
        createdAt: "2026-08-01T10:00:00.000Z",
        expiresAt: "2026-08-08T10:00:00.000Z",
        signIn: { method: "password", secondFactor: "totp" },
        ...overrides
    };
}

function render(sessions: SessionView[]): string {
    return renderToStaticMarkup(
        <SessionsTable sessions={sessions} busyId={null} emptyLabel="Nothing is signed in." onRevoke={() => {}} />
    );
}

describe("the session table", () => {
    it("names every column a session is judged by", () => {
        const markup = render([session()]);
        for (const column of ["Device", "Address", "Domain", "Last active"]) {
            expect(markup).toContain(`>${column}</th>`);
        }
    });

    it("keeps two sessions on the same machine apart by the address each was opened on", () => {
        const markup = render([
            session({ id: "session-1", host: "polaris.local" }),
            session({ id: "session-2", host: "polaris.example.com" })
        ]);
        expect(markup).toContain("polaris.local");
        expect(markup).toContain("polaris.example.com");
        expect(markup.match(/<tr/g)).toHaveLength(3); // the header row, plus one per session
    });

    it("renders a row per session rather than dropping any", () => {
        const sessions = Array.from({ length: 6 }, (_, index) => session({ id: `session-${index}` }));
        expect(render(sessions).match(/<tr/g)).toHaveLength(7);
    });

    it("says so rather than leaving a blank cell for a session with no address recorded", () => {
        expect(render([session({ host: null })])).toContain("Not recorded");
    });

    it("marks the session doing the reading, so nobody signs themselves out by accident", () => {
        expect(render([session({ current: true })])).toContain("This device");
    });

    it("says how each session got in, which is the fact the list exists to check", () => {
        expect(render([session()])).toContain("Password + Authenticator app");
    });

    // The one worth noticing at a glance: the account has a second step armed and
    // this sign-in was let past it because the browser had been remembered.
    it("shows a skipped second step rather than a session that merely lacks one", () => {
        const markup = render([session({ signIn: { method: "password", secondFactor: "trusted-device" } })]);
        expect(markup).toContain("Password + Remembered device");
    });

    it("shows a scanned code and a passkey as the ways in they are", () => {
        expect(render([session({ signIn: { method: "qr-code", secondFactor: null } })])).toContain("QR code");
        expect(render([session({ signIn: { method: "passkey", secondFactor: null } })])).toContain("Passkey");
    });

    // Silence would read as "a password and nothing else", which is a claim
    // nobody made about a session that predates the record.
    it("admits it does not know rather than implying nothing was asked for", () => {
        const markup = render([session({ signIn: { method: null, secondFactor: null } })]);
        expect(markup).toContain("Sign-in not recorded");
    });

    it("labels its row actions, which carry no text of their own", () => {
        expect(render([session()])).toContain('aria-label="Sign Chrome on Windows out"');
    });

    it("links a row to that session's own history rather than to the whole log", () => {
        const markup = renderToStaticMarkup(
            <SessionsTable
                sessions={[session({ id: "session-1" })]}
                busyId={null}
                emptyLabel="Nothing is signed in."
                activityHref={(entry) => `/account/activity?session=${entry.id}`}
                onRevoke={() => {}}
            />
        );
        expect(markup).toContain('href="/account/activity?session=session-1"');
        expect(markup).toContain('aria-label="Activity from Chrome on Windows"');
    });

    it("leaves the history out where the reader has no business reading it", () => {
        expect(render([session()])).not.toContain("Activity from");
    });

    it("explains an empty table instead of showing an empty frame", () => {
        expect(render([])).toContain("Nothing is signed in.");
    });

    // A local address is not something a person can connect with the rows for the
    // same device seen from outside, which is most of the list.
    it("shows the address a local session leaves the network by, beside the local one", () => {
        const markup = render([session({ ip: "192.168.1.131", publicIp: "85.87.156.88" })]);
        expect(markup).toContain("192.168.1.131");
        expect(markup).toContain("85.87.156.88");
    });

    it("leaves a public address alone rather than pairing it with itself", () => {
        const markup = render([session({ ip: "85.87.156.88", publicIp: null })]);
        expect(markup).not.toContain("via");
    });
});

describe("the one-line origin", () => {
    it("reads address, country, then the name it was opened on", () => {
        expect(sessionOrigin(session())).toBe("192.168.1.131 - ES - polaris.local");
    });

    it("carries both addresses when the session came in over the local network", () => {
        expect(sessionOrigin(session({ publicIp: "85.87.156.88" }))).toBe(
            "192.168.1.131 via 85.87.156.88 - ES - polaris.local"
        );
    });

    it("skips what was never recorded rather than printing gaps", () => {
        expect(sessionOrigin(session({ country: null, host: null }))).toBe("192.168.1.131");
    });

    it("says something when nothing at all is known", () => {
        expect(sessionOrigin(session({ ip: null, country: null, host: null }))).toBe("Unknown location");
    });
});
