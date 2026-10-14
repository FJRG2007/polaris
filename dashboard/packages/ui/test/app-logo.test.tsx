import { describe, expect, it } from "vitest";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppLogo, APP_LOGO_IDS, appLogoPalette, hasAppLogo } from "../src/shell/app-logo";

/**
 * The app logos: one per app id, decorative, and safe to draw many times on a
 * page - each copy names its own gradients, so the launcher's trigger and its
 * grid never borrow each other's fills.
 */
describe("app logos", () => {
    it("draws every registered logo as a decorative svg on the shared canvas", () => {
        expect(APP_LOGO_IDS.length).toBeGreaterThan(0);
        for (const id of APP_LOGO_IDS) {
            const html = renderToStaticMarkup(createElement(AppLogo, { appId: id, size: 40 }));
            expect(html).toContain('viewBox="0 0 32 32"');
            expect(html).toContain('aria-hidden="true"');
            expect(html).toContain(`data-app-logo="${id}"`);
            expect(html).toContain("url(#");
        }
    });

    it("draws at the size asked for, even inside a rule that sizes every svg", () => {
        const html = renderToStaticMarkup(createElement(AppLogo, { appId: "mail", size: 16 }));
        expect(html).toContain('width="16"');
        expect(html).toContain("width:16px");
    });

    it("draws nothing for an app without a logo", () => {
        expect(hasAppLogo("not-an-app")).toBe(false);
        expect(hasAppLogo("toString")).toBe(false);
        expect(appLogoPalette("not-an-app")).toBeNull();
        expect(renderToStaticMarkup(createElement(AppLogo, { appId: "not-an-app" }))).toBe("");
    });

    it("draws the fallback for an app without a logo, and only then", () => {
        const fallback = createElement("i", { "data-fallback": "" });
        expect(renderToStaticMarkup(createElement(AppLogo, { appId: "not-an-app", fallback }))).toBe(
            '<i data-fallback=""></i>'
        );
        const html = renderToStaticMarkup(createElement(AppLogo, { appId: "mail", fallback }));
        expect(html).toContain('data-app-logo="mail"');
        expect(html).not.toContain("data-fallback");
    });

    it("gives each copy on a page its own gradient and mask ids", () => {
        const html = renderToStaticMarkup(
            createElement(
                Fragment,
                null,
                ...APP_LOGO_IDS.flatMap((id) => [
                    createElement(AppLogo, { key: `${id}-a`, appId: id }),
                    createElement(AppLogo, { key: `${id}-b`, appId: id })
                ])
            )
        );
        const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
        expect(ids.length).toBeGreaterThanOrEqual(APP_LOGO_IDS.length * 4);
        expect(new Set(ids).size).toBe(ids.length);
        // Only characters a url(#...) reference resolves everywhere.
        for (const id of ids) expect(id).toMatch(/^[a-zA-Z0-9]+$/);
        // Every reference points at an id drawn on the page.
        const refs = [...html.matchAll(/url\(#([^)]+)\)/g)].map((match) => match[1]);
        for (const ref of refs) expect(ids).toContain(ref);
    });

    it("gives every app a colour of its own", () => {
        const middles = APP_LOGO_IDS.map((id) => appLogoPalette(id)![1]);
        expect(new Set(middles).size).toBe(middles.length);
    });
});
