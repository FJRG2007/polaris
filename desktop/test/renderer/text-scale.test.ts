/**
 * The account's text size, as the dashboard renders it and as the app's own
 * windows do: the same root size, and the same steps in rem below it, so a
 * setting reads at exactly the pixel size of the dashboard's controls.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TEXT_SIZES } from "@/shared/text-size";

const DASHBOARD = join(__dirname, "../../../dashboard");
const styles = readFileSync(join(__dirname, "../../src/renderer/styles.css"), "utf8");

/** A custom property's value on the app's `:root`. */
function token(name: string): string {
    const value = new RegExp(`${name}:\\s*([^;]+);`).exec(styles)?.[1]?.trim();
    if (!value) throw new Error(`${name} is not defined`);
    return value;
}

function rem(value: string): number {
    const match = /^([\d.]+)rem$/.exec(value);
    if (!match) throw new Error(`${value} is not in rem`);
    return Number(match[1]);
}

/** What one rem step renders at, for a root at the account's size. */
function pixels(size: number, step: number): number {
    return size * step;
}

describe("the text size", () => {
    it("sits on the root, the way the dashboard's html carries it", () => {
        const globals = readFileSync(join(DASHBOARD, "apps/web/src/app/globals.css"), "utf8");
        expect(globals).toMatch(/html\s*\{\s*font-size:\s*var\(--app-text-size,\s*16px\);/);
        // The default the preload replaces, and nothing else in px.
        expect(/:root\s*\{[^}]*font-size:\s*16px;/.exec(styles)).not.toBeNull();
        const fixed = [...styles.matchAll(/font-size:\s*([\d.]+px)/g)].map((match) => match[1]);
        expect(fixed).toEqual(["16px"]);
    });

    it("renders body text at the dashboard's control size for every offered size", () => {
        // The dashboard's field and button text, `text-[0.8125rem]`.
        const input = readFileSync(join(DASHBOARD, "packages/ui/src/components/input.tsx"), "utf8");
        const dashboardStep = Number(/text-\[([\d.]+)rem\]/.exec(input)?.[1]);
        const body = rem(token("--text-body"));
        expect(body).toBe(dashboardStep);
        expect(styles).toMatch(/body\s*\{[^}]*font-size:\s*var\(--text-body\);/);
        for (const size of TEXT_SIZES) expect(pixels(size, body)).toBe(pixels(size, dashboardStep));
        // At the default: the 13px design.md sets the interface in.
        expect(pixels(16, body)).toBe(13);
        expect(pixels(12, body)).toBe(9.75);
        expect(pixels(24, body)).toBe(19.5);
    });

    it("keeps the rest of design.md's scale", () => {
        expect(pixels(16, rem(token("--text-title")))).toBe(17);
        expect(pixels(16, rem(token("--text-dialog")))).toBe(15);
        expect(pixels(16, rem(token("--text-heading")))).toBe(14);
        expect(pixels(16, rem(token("--text-small")))).toBe(12);
        expect(pixels(16, rem(token("--text-label")))).toBe(11);
    });
});
