/**
 * What the require-login panel actually puts on screen.
 *
 * Two lists that read the same way would be the failure that matters here: an operator
 * who adds somebody to the wrong one has written the opposite rule, and the edge will
 * enforce it silently. So each list has to say which it is, and an entry with a window
 * has to show that window rather than looking like access that simply applies.
 *
 * Rendered to static markup rather than driven in a browser - this asserts the panel's
 * own contract, and the directory it would otherwise fetch is stubbed.
 */

import { describe, expect, it, vi } from "vitest";
import type { WafPrincipalGrant } from "@polaris/core";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../../src/app/(app)/apps/firewall/actions", () => ({
    listWafPrincipalsAction: async () => ({
        principals: [
            { ref: "group:ops", type: "group", label: "Operations" },
            { ref: "group:contractors", type: "group", label: "Contractors" },
            { ref: "user:u1", type: "user", label: "Ada", sublabel: "ada@example.com" }
        ]
    })
}));

const { LoginPrincipals } = await import("../../src/app/(app)/apps/firewall/login-principals");
const { LoginRulePage } = await import("../../src/app/(app)/apps/firewall/access-rules");

function render(admitted: WafPrincipalGrant[], refused: WafPrincipalGrant[]): string {
    return renderToStaticMarkup(
        <LoginPrincipals admitted={admitted} refused={refused} onChange={() => {}} />
    );
}

describe("the require-login panel", () => {
    it("tells the two lists apart", () => {
        const markup = render([], []);
        expect(markup).toContain("Who gets in");
        expect(markup).toContain("Who never gets in");
    });

    it("says an empty admitted list means any account, not nobody", () => {
        expect(render([], [])).toContain("Anyone with a Polaris account gets in");
    });

    it("shows an expiry on the entry that carries one", () => {
        // The window is the difference between access and access until Friday, and it
        // is not visible anywhere else on this screen.
        const until = Math.floor(Date.now() / 1000) + 3600;
        const markup = render([{ ref: "group:ops", until }], []);
        expect(markup).toContain("until ");
    });

    it("marks a grant whose window has already passed", () => {
        const markup = render([{ ref: "group:ops", until: Math.floor(Date.now() / 1000) - 3600 }], []);
        expect(markup).toContain("expired ");
    });

    it("keeps a refused principal that no longer exists visible, since it still applies", () => {
        const markup = render([], [{ ref: "group:gone" }]);
        expect(markup).toContain("group:gone");
    });
});

describe("the require-login page, when a broader scope already demands one", () => {
    function page(required: boolean, requiredAbove: boolean): string {
        return renderToStaticMarkup(
            <LoginRulePage
                required={required}
                requiredAbove={requiredAbove}
                admitted={[]}
                refused={[]}
                onBack={() => {}}
                onChange={() => {}}
            />
        );
    }

    it("says a login is required rather than showing this scope's unused off", () => {
        // requireLogin unions downward, so a project demanding one means its services
        // demand one - and the switch here cannot take it back.
        const markup = page(false, true);

        expect(markup).toContain("A login is required");
        expect(markup).toContain("cannot waive it");
    });

    it("still offers the lists, because every scope naming who it admits gets a say", () => {
        expect(page(false, true)).toContain("Who gets in");
    });

    it("leaves the switch alone when this scope is the one deciding", () => {
        expect(page(false, false)).toContain("No login is required");
        expect(page(false, false)).not.toContain("cannot waive it");
    });
});
