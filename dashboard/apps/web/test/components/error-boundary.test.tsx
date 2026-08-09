/**
 * What the dashboard's error boundary tells whoever is looking at it.
 *
 * The screen it replaces is already a mystery: something threw somewhere behind a
 * panel, and the only two people who can act on it are the operator reading the
 * card and whoever they forward it to. A boundary that logs to a console nobody has
 * open and shows a digest with no message leaves both with nothing, which is how a
 * crash gets reported as "the page broke" and stays unfixed.
 *
 * Rendered to static markup: effects do not run, so this is the frame the operator
 * actually meets.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The boundary asks the router for a fresh answer when it retries, and there is no
// app router mounted around a static render.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const { default: AppError } = await import("../../src/app/(app)/error");

function thrown(message: string, digest?: string): Error & { digest?: string } {
    return Object.assign(new Error(message), digest ? { digest } : {});
}

describe("the dashboard error boundary", () => {
    it("shows what was thrown rather than only logging it", () => {
        const markup = renderToStaticMarkup(
            <AppError error={thrown("Cannot read properties of undefined (reading 'id')")} reset={vi.fn()} />
        );

        expect(markup).toContain("Cannot read properties of undefined");
    });

    it("keeps the digest, which is what ties the screen to the server log", () => {
        const markup = renderToStaticMarkup(<AppError error={thrown("boom", "1a2b3c")} reset={vi.fn()} />);

        expect(markup).toContain("1a2b3c");
        expect(markup).toContain("boom");
    });

    it("offers both a retry and a reload, since only one of them picks up a new build", () => {
        const markup = renderToStaticMarkup(<AppError error={thrown("boom")} reset={vi.fn()} />);

        expect(markup).toContain("Try again");
        expect(markup).toContain("Reload");
    });

    it("says nothing where there is nothing to say", () => {
        const markup = renderToStaticMarkup(<AppError error={thrown("")} reset={vi.fn()} />);

        // An error with no message and no digest must not leave an empty box behind
        // pretending to hold detail.
        expect(markup).not.toContain("font-mono");
    });
});
