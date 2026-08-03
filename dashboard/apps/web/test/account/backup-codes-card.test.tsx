/**
 * What the Security page says about backup codes.
 *
 * The card exists because the codes used to appear once, inside the enrolment
 * dialog, and never again - so what it has to get right is telling somebody
 * where they stand before they are locked out rather than after. That means the
 * count is on screen, a set running out reads as something to act on, and the
 * control that replaces it is reachable.
 *
 * Rendered to static markup: these are assertions about what the card says, and
 * none of them need a browser.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("../../src/app/(app)/account/security/two-factor-actions", () => ({
    regenerateBackupCodesAction: async () => ({ codes: [] })
}));

const { BackupCodesCard } = await import("../../src/app/(app)/account/security/backup-codes-card");

function render(props: { twoFactorEnabled: boolean; remaining: number | null; lock?: { reason: string } }): string {
    return renderToStaticMarkup(<BackupCodesCard {...props} />);
}

describe("the backup codes card", () => {
    it("says how many are left, so nobody has to guess", () => {
        const markup = render({ twoFactorEnabled: true, remaining: 8 });
        expect(markup).toContain("8 left");
        expect(markup).toContain("New codes");
    });

    it("never puts a code on the page, only the count", () => {
        // The card is handed a number and nothing else, so a code cannot reach
        // it - what is pinned here is that its own copy does not invent one
        // either. Read as text rather than markup: class names are full of
        // hyphenated words that look like codes and are not.
        const text = render({ twoFactorEnabled: true, remaining: 10 }).replace(/<[^>]*>/g, " ");
        expect(text).toContain("10 left");
        expect(text).not.toMatch(/[a-z0-9]{5}-[a-z0-9]{5}/i);
    });

    it("warns while there is still time to act on it", () => {
        const markup = render({ twoFactorEnabled: true, remaining: 2 });
        expect(markup).toContain("2 left");
        expect(markup).toContain("Running low");
    });

    it("says plainly when a set has been used up", () => {
        const markup = render({ twoFactorEnabled: true, remaining: 0 });
        expect(markup).toContain("None left");
        // Still offers the way out of it, which is the whole point of saying so.
        expect(markup).toContain("New codes");
    });

    it("offers to replace a set it could not read rather than going quiet", () => {
        const markup = render({ twoFactorEnabled: true, remaining: null });
        expect(markup).toContain("Unknown");
        expect(markup).toContain("New codes");
    });

    it("points at the authenticator when there is no factor to back up", () => {
        const markup = render({ twoFactorEnabled: false, remaining: null });
        expect(markup).toContain("Off");
        expect(markup).not.toContain("New codes");
    });

    it("holds the control shut for a device the account is still waiting out", () => {
        const markup = render({
            twoFactorEnabled: true,
            remaining: 5,
            lock: { reason: "This device is still new here." }
        });
        expect(markup).toContain("disabled");
    });
});
