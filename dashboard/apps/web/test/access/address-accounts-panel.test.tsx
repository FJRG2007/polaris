/**
 * What the firewall puts on screen about the people behind an address.
 *
 * The panel exists to answer one question before a ban is placed - whether the
 * address belongs to somebody who is signed in - so the facts that answer it
 * have to be rendered rather than merely fetched: who, whether they are here
 * now, and whether the address was ever refused. It also has to say plainly that
 * nobody has been seen, because "no accounts" is the finding that makes a ban
 * easy and a blank space says nothing at all.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AddressAccount } from "@/lib/address-accounts";
import { AddressAccounts } from "../../src/app/(app)/apps/firewall/address-accounts";

function account(overrides: Partial<AddressAccount> = {}): AddressAccount {
    return {
        id: "11111111-1111-4111-8111-111111111111",
        name: "Ada Lovelace",
        email: "ada@example.com",
        image: null,
        banned: false,
        sessions: [
            {
                id: "session-1",
                device: "Chrome on Windows",
                host: "polaris.example.com",
                country: "ES",
                live: true,
                approval: "approved",
                signIn: { method: "password", secondFactor: "totp" },
                startedAt: "2026-08-04T10:00:00.000Z",
                lastSeenAt: "2026-08-04T11:00:00.000Z"
            }
        ],
        live: 1,
        signIns: { accepted: 0, refused: 0, awaiting: 0 },
        lastAt: "2026-08-04T11:00:00.000Z",
        ...overrides
    };
}

function render(list: AddressAccount[], more = false): string {
    return renderToStaticMarkup(<AddressAccounts accounts={{ list, more }} />);
}

describe("the accounts behind an address", () => {
    it("names who is signed in and how, and opens the account", () => {
        const markup = render([account()]);
        expect(markup).toContain("Ada Lovelace");
        expect(markup).toContain("ada@example.com");
        expect(markup).toContain("1 signed in now");
        expect(markup).toContain("Chrome on Windows");
        expect(markup).toContain("polaris.example.com");
        expect(markup).toContain("/admin/users?user=11111111-1111-4111-8111-111111111111");
    });

    // An address that keeps being refused is the one worth banning, and it holds
    // no session at all - so the count has to carry the whole finding.
    it("shows the sign-ins that were refused, for an account with nothing open", () => {
        const markup = render([
            account({ sessions: [], live: 0, signIns: { accepted: 0, refused: 12, awaiting: 1 } })
        ]);
        expect(markup).toContain("12 refused");
        expect(markup).toContain("1 left waiting for approval");
        expect(markup).not.toContain("signed in now");
    });

    it("marks a session that has expired rather than leaving it reading as open", () => {
        const markup = render([
            account({
                live: 0,
                sessions: [{ ...account().sessions[0]!, live: false }]
            })
        ]);
        expect(markup).toContain("Expired");
        expect(markup).toContain("Last active");
    });

    it("marks a sign-in the account has not approved", () => {
        const markup = render([
            account({ sessions: [{ ...account().sessions[0]!, approval: "pending" }] })
        ]);
        expect(markup).toContain("Waiting for approval");
    });

    it("says so when nobody has ever signed in from the address", () => {
        expect(render([])).toContain("No account has signed in from this address.");
    });

    // Silently showing the first few would read as the whole list, on exactly the
    // addresses - an office gateway, a VPN exit - where it is not.
    it("says how many accounts it left out", () => {
        const many = Array.from({ length: 9 }, (_, index) =>
            account({ id: `user-${index}`, name: `Person ${index}` })
        );
        const markup = render(many);
        expect(markup).toContain("Person 5");
        expect(markup).not.toContain("Person 6");
        expect(markup).toContain("and 3 more");
        expect(markup).not.toContain("at least");
    });

    // The server cuts the list too, and on a shared address the rest is exactly
    // what an exact-looking number would be hiding.
    it("stops claiming an exact number once the server itself had to cut", () => {
        const many = Array.from({ length: 9 }, (_, index) =>
            account({ id: `user-${index}`, name: `Person ${index}` })
        );
        expect(render(many, true)).toContain("and at least 3 more");
    });

    it("still says there are more when the cut left nothing extra to show", () => {
        expect(render([account()], true)).toContain("and at least 1 more");
    });
});
