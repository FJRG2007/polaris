/**
 * The address a copied link is built on.
 *
 * The bug this guards: a link copied from a task, a form or a tracker snippet
 * was built from the hostname of the tab, so a dashboard opened on the LAN name
 * handed out `http://polaris.local/...` even with a domain configured - a link
 * nobody outside the house can open. The provider carries the resolved address
 * down to the client screens, and this asserts they use it.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AppUrlProvider, useAppUrl } from "@/components/app-url";

/** Stands in for any screen that hands out a link. */
function Probe() {
    return <span>{`${useAppUrl()}/tasks/t/abc`}</span>;
}

function render(baseUrl: string | null): string {
    return renderToStaticMarkup(
        baseUrl === null ? <Probe /> : <AppUrlProvider baseUrl={baseUrl}>{<Probe />}</AppUrlProvider>
    );
}

describe("the link a screen hands out", () => {
    it("is built on the configured domain", () => {
        expect(render("https://polaris.example.com")).toContain("https://polaris.example.com/tasks/t/abc");
    });

    it("does not double the separator when the address carries a trailing slash", () => {
        expect(render("https://polaris.example.com/")).toContain("https://polaris.example.com/tasks/t/abc");
    });

    it("stays a path rather than inventing a hostname when no address is provided", () => {
        expect(render(null)).toContain(">/tasks/t/abc<");
    });
});
