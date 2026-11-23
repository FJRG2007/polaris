// @vitest-environment jsdom

/**
 * The busy label of a slow submit: the button's own busy text first, the longer
 * line after 300 ms (a CSS delay, so both are in the DOM from the start), and the
 * encryption line only when the submit really runs the key stretching.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SlowSubmitLabel } from "@/components/slow-submit-label";

vi.mock("@/components/i18n/i18n-provider", () => ({
    useTranslations: () => (key: string) => key
}));

afterEach(cleanup);

describe("SlowSubmitLabel", () => {
    it("names the encryption only when the submit runs it", () => {
        const { rerender } = render(<SlowSubmitLabel busyLabel="Signing in..." protecting />);
        expect(screen.getByText("Signing in...")).toBeTruthy();
        expect(screen.getByText("slowSubmit.protecting")).toBeTruthy();
        expect(screen.queryByText("slowSubmit.working")).toBeNull();
        rerender(<SlowSubmitLabel busyLabel="Signing in..." protecting={false} />);
        expect(screen.getByText("slowSubmit.working")).toBeTruthy();
        expect(screen.queryByText("slowSubmit.protecting")).toBeNull();
    });

    it("stacks both lines in one cell, so the button never changes size", () => {
        render(<SlowSubmitLabel busyLabel="Signing in..." protecting />);
        const first = screen.getByText("Signing in...");
        const later = screen.getByText("slowSubmit.protecting").parentElement as HTMLElement;
        expect(first.className).toContain("[grid-area:stack]");
        expect(later.className).toContain("[grid-area:stack]");
        expect(first.className).toContain("slow-submit-first");
        expect(later.className).toContain("slow-submit-later");
        expect(later.getAttribute("title")).toBe("slowSubmit.protecting");
        expect(later.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    });

    it("waits 300 ms in CSS and drops the motion for reduced motion", () => {
        const css = readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8");
        expect(css).toMatch(/\.slow-submit-later\s*\{[^}]*300ms/);
        expect(css).toMatch(/\.slow-submit-first\s*\{[^}]*300ms/);
        const reduced = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
        expect(reduced).toMatch(/\.slow-submit-shield\s*\{\s*animation:\s*none/);
    });

    it("has both lines in every locale", async () => {
        for (const locale of ["en-US", "es-ES"]) {
            const messages = JSON.parse(
                readFileSync(resolve(process.cwd(), `messages/${locale}/common.json`), "utf8")
            ) as { slowSubmit?: Record<string, string> };
            expect(messages.slowSubmit?.protecting).toBeTruthy();
            expect(messages.slowSubmit?.working).toBeTruthy();
        }
    });
});
