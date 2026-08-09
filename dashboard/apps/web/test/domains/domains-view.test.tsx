/**
 * What the Domains panel shows before its data has arrived.
 *
 * The whole point of the panel reading for itself is that the page is on screen
 * first: it used to be rendered on the server, and the reads behind it dial the
 * tunnel daemon and probe every hostname the deployment answers on, so opening
 * Domains left the previous page up until the slowest of them came back.
 *
 * The way that regresses is one `await` moving back into the page, and the way it
 * shows is a first paint with nothing in it - so what is asserted is that every
 * card an operator navigates by is in the markup with no data at all, and that the
 * regions genuinely waiting are pulsing rather than blank.
 *
 * Rendered to static markup, which is exactly the state under test: effects do not
 * run, so this is the frame before the fetch resolves.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The panel's server actions, which a render never calls but the import graph
// pulls in - they reach Prisma, the SSH stack and the DNS helpers.
vi.mock("../../src/app/(app)/admin/domains/actions", () => ({}));
vi.mock("../../src/app/(app)/admin/domains/setup-actions", () => ({}));
vi.mock("../../src/app/(app)/integrations/actions", () => ({}));

const { DomainsView } = await import("../../src/app/(app)/admin/domains/domains-view");

describe("the domains panel before its read lands", () => {
    it("is already the page an operator can navigate by", () => {
        const markup = renderToStaticMarkup(<DomainsView />);

        expect(markup).toContain("Guided setup");
        expect(markup).toContain("own addresses");
        expect(markup).toContain("Where Polaris answers");
        expect(markup).toContain("Domains of their own");
        // Neither of these waits on anything, so neither may be held back by a card
        // that does.
        expect(markup).toContain("Trust this device");
        expect(markup).toContain("Advanced: exposure mode and DuckDNS");
    });

    it("holds the shape of what is coming rather than a blank or a spinner", () => {
        const markup = renderToStaticMarkup(<DomainsView />);

        expect(markup).toContain("animate-pulse");
        expect(markup).not.toContain("animate-spin");
    });

    it("says nothing about the game ports until it knows there are any", () => {
        const markup = renderToStaticMarkup(<DomainsView />);

        // A deployment that runs no game server has no card there at all, so a
        // placeholder would be a page that moves under whoever is reading it.
        expect(markup).not.toContain("Game server ports");
    });
});
