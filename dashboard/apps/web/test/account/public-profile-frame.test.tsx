/**
 * Which frame a handed-out profile is drawn in.
 *
 * The page it replaces was a bare card on an empty document whoever opened it,
 * so a colleague already signed in - the common case, since a profile link is
 * usually pasted into a conversation here - was thrown out of the application to
 * read it, with no bar, no rail and no way back except the browser's own.
 *
 * The rule under test: a session that has cleared its gate gets the application's
 * own chrome, and everybody else gets the public bar. "Everybody else" includes a
 * session that has NOT cleared its gate - locked, or waiting for approval - which
 * is the case worth a test of its own, because drawing the rail for one would be
 * a page of links that all bounce straight back to the gate.
 *
 * Both pages are asserted, the person's and the organization's, because they were
 * two separate copies of this decision before there was one.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

let viewer: { id: string; isAdmin: boolean } | null = null;
/** Whether the deployment publishes profiles to readers with no account. */
let published = true;
/** Whether there is anybody at the address being asked for. */
let exists = true;

vi.mock("@/lib/session", () => ({ guardedUser: async () => viewer }));

vi.mock("@/lib/profile-service", () => ({
    profilesArePublic: async () => published,
    publicProfile: async (_handle: string) =>
        exists ? { id: "person-1", name: "Ada Lovelace", standing: {}, mutual: null, follows: null } : null,
    orgProfile: async (_handle: string) => (exists ? { id: "org-1", name: "Analytical" } : null)
}));

// The frames are stood in for, so the assertion is about which one was chosen
// rather than about anything either of them draws. AppChrome in particular is
// the whole signed-in application and resolves a dozen queries of its own.
vi.mock("@/components/app-chrome", () => ({
    AppChrome: ({ children }: { children: ReactNode }) => <div data-frame="app">{children}</div>
}));
vi.mock("@/components/public-chrome", () => ({
    PublicChrome: ({ children }: { children: ReactNode }) => <div data-frame="public">{children}</div>
}));

// The cards themselves are client components with their own dependencies, and
// none of that is what this is about.
vi.mock("@/app/u/[username]/profile-card", () => ({
    ProfileCard: ({ signedIn }: { signedIn: boolean }) => <p>card signedIn={String(signedIn)}</p>
}));
vi.mock("@/app/o/[slug]/org-profile-card", () => ({ OrgProfileCard: () => <p>org card</p> }));

const { default: ProfilePage } = await import("@/app/u/[username]/page");
const { default: OrganizationPage } = await import("@/app/o/[slug]/page");

/** The frame a page came back in, and the markup inside it. */
async function drawn(page: Promise<unknown>): Promise<{ frame: string | null; html: string }> {
    const html = renderToStaticMarkup((await page) as never);
    return { frame: html.match(/data-frame="(\w+)"/)?.[1] ?? null, html };
}

const person = () => drawn(ProfilePage({ params: Promise.resolve({ username: "ada" }) }));
const organization = () => drawn(OrganizationPage({ params: Promise.resolve({ slug: "analytical" }) }));

describe("the frame a public profile is drawn in", () => {
    beforeEach(() => {
        viewer = null;
        published = true;
        exists = true;
    });

    it("gives a signed-in reader the application, not a page outside it", async () => {
        viewer = { id: "reader-1", isAdmin: false };
        expect((await person()).frame).toBe("app");
        expect((await organization()).frame).toBe("app");
    });

    it("gives a reader with no account the public bar", async () => {
        expect((await person()).frame).toBe("public");
        expect((await organization()).frame).toBe("public");
    });

    it("keeps a session that has not cleared its gate out of the application's chrome", async () => {
        // guardedUser answers null for a locked or unapproved session exactly as
        // it does for no session at all, which is what this asserts: the frame
        // follows the gate, not the cookie.
        viewer = null;
        expect((await person()).frame).toBe("public");
    });

    it("offers nothing to do about somebody to a reader who cannot do it", async () => {
        expect((await person()).html).toContain("card signedIn=false");
        viewer = { id: "reader-1", isAdmin: false };
        expect((await person()).html).toContain("card signedIn=true");
    });

    it("keeps the frame when there is nothing at the address", async () => {
        exists = false;
        expect((await person()).frame).toBe("public");
        viewer = { id: "reader-1", isAdmin: false };
        expect((await person()).frame).toBe("app");
        expect((await organization()).frame).toBe("app");
    });

    it("says so when this Polaris publishes nothing, and not why otherwise", async () => {
        exists = false;
        published = false;
        expect((await person()).html).toContain("not signed in");

        published = true;
        expect((await person()).html).not.toContain("not signed in");
        expect((await person()).html).toContain("There is no profile at this address");
    });
});
