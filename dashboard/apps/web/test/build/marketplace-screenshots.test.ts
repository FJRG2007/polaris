/**
 * The marketplace screenshots are copies of the documentation's.
 *
 * The dashboard image is built from `dashboard/`, which cannot reach `docs/`, so
 * the pictures the app detail page shows are copied into `public/marketplace`.
 * A copy drifts the moment the original is retaken; this fails until the copy is
 * refreshed, so the store never shows an older screen than the docs.
 */

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

const COPIES = resolve(__dirname, "../../public/marketplace");
const ORIGINALS = resolve(__dirname, "../../../../../docs/assets/media");

const files = readdirSync(COPIES).filter((name) => !name.startsWith("."));

describe("marketplace screenshots", () => {
    it("has copies to check", () => {
        expect(files.length).toBeGreaterThan(0);
    });

    it.each(files)("%s matches its original in docs/assets/media byte for byte", (name) => {
        const copy = readFileSync(resolve(COPIES, name));
        const original = readFileSync(resolve(ORIGINALS, name));
        expect(copy.equals(original)).toBe(true);
    });
});
