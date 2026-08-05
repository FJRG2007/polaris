/**
 * The name somebody gives one of their provider keys.
 *
 * It is the only thing telling two keys for the same provider apart, on a screen
 * and in an audit row, so it is bounded at both ends and holds nothing that
 * changes meaning when it is pasted somewhere else.
 */

import { describe, expect, it } from "vitest";
import { modelKeyNameSchema } from "./agents.js";

describe("modelKeyNameSchema", () => {
    it("takes the names people actually use", () => {
        for (const name of ["prod-main", "work_key", "openai2", "abc"]) {
            expect(modelKeyNameSchema.safeParse(name).success).toBe(true);
        }
    });

    it("trims before measuring, so padding cannot buy length", () => {
        expect(modelKeyNameSchema.parse("  prod-main  ")).toBe("prod-main");
        expect(modelKeyNameSchema.safeParse("  a  ").success).toBe(false);
    });

    it("holds both ends", () => {
        expect(modelKeyNameSchema.safeParse("ab").success).toBe(false);
        expect(modelKeyNameSchema.safeParse("a".repeat(20)).success).toBe(true);
        expect(modelKeyNameSchema.safeParse("a".repeat(21)).success).toBe(false);
    });

    it("refuses what would not survive being shown somewhere else", () => {
        for (const name of ["prod main", "prod/main", "prod.main", "-leading", "<script>"]) {
            expect(modelKeyNameSchema.safeParse(name).success).toBe(false);
        }
    });
});
