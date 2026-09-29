/**
 * The challenge catalogue as data: all of it there, in both languages, and
 * every template carrying the anti-exploit rule it claims to.
 */

import { describe, expect, it } from "vitest";
import * as draw from "@polaris-app/game-servers/src/lib/minecraft/challenges/draw";
import * as catalog from "@polaris-app/game-servers/src/lib/minecraft/challenges/catalog";

const parts = (check: catalog.Check): catalog.Part[] =>
    check.kind === "sum"
        ? [...check.parts, ...(check.capBy ?? [])]
        : check.kind === "distinct"
          ? check.groups.flat()
          : check.kind === "survive"
            ? check.parts
            : [];

const checks = (template: catalog.Template): catalog.Check[] =>
    template.variants ? template.variants.map((one) => one.check) : [template.check!];

/** Crafts that can be undone: counting them alone counts stock out of a chest. */
const REVERSIBLE = [
    "iron_ingot",
    "gold_ingot",
    "copper_ingot",
    "netherite_ingot",
    "diamond",
    "emerald",
    "redstone",
    "lapis_lazuli",
    "coal",
    "wheat",
    "bone_meal",
    "slime_ball",
    "dried_kelp"
];

describe("the challenge catalogue", () => {
    it("has all 86 templates in 11 categories, and the four streak rules", () => {
        expect(catalog.TEMPLATES).toHaveLength(86);
        expect(new Set(catalog.TEMPLATES.map((one) => one.id)).size).toBe(86);
        expect(new Set(catalog.TEMPLATES.map((one) => one.category)).size).toBe(11);
        expect(catalog.CATEGORIES).toHaveLength(11);
        const perCategory = Object.fromEntries(
            catalog.CATEGORIES.map((category) => [category, catalog.TEMPLATES.filter((one) => one.category === category).length])
        );
        expect(perCategory).toEqual({
            mining: 10,
            combat: 11,
            farming: 10,
            fishing: 5,
            exploration: 10,
            crafting: 10,
            taming: 7,
            nether: 8,
            building: 5,
            social: 6,
            collection: 4
        });
        expect(catalog.META_RULES.map((one) => one.id)).toEqual(["X1", "X2", "X3", "X4"]);
    });

    it("says every template in English and Spanish, with no braces the text writer would read as variables", () => {
        for (const template of catalog.TEMPLATES) {
            for (const language of ["en", "es"] as const) {
                for (const text of [template.title, template.how, template.exploit]) {
                    expect(text[language].trim().length, `${template.id} ${language}`).toBeGreaterThan(3);
                    expect(text[language]).not.toMatch(/[{}]/);
                }
                for (const variant of template.variants ?? []) expect(variant.label[language].length).toBeGreaterThan(0);
            }
        }
    });

    it("gives every layer a template can be dealt in a target", () => {
        for (const template of catalog.TEMPLATES) {
            expect(template.layers.length, template.id).toBeGreaterThan(0);
            for (const layer of template.layers) {
                const tiers = layer === "daily" && template.easyOnly ? (["easy"] as const) : catalog.DIFFICULTIES;
                for (const tier of tiers) {
                    const target = catalog.baseTarget(template, layer, tier);
                    expect(target, `${template.id} ${layer} ${tier}`).not.toBeNull();
                    expect(target!).toBeGreaterThan(0);
                }
            }
            expect(template.check !== undefined || (template.variants?.length ?? 0) > 0, template.id).toBe(true);
        }
        // Once-per-world advancements belong on the card, never on a daily.
        for (const template of catalog.TEMPLATES.filter((one) => checks(one).some((check) => check.kind === "advancement"))) {
            expect(template.layers, template.id).not.toContain("daily");
        }
    });

    it("counts only statistics spelled the way the game spells criteria", () => {
        for (const template of catalog.TEMPLATES) {
            for (const check of checks(template)) {
                for (const criterion of catalog.criteriaOf(check)) {
                    expect(criterion).toMatch(/^minecraft\.(mined|used|killed|picked_up|dropped|crafted|broken|custom):minecraft\.[a-z0-9_]+$/);
                }
            }
        }
    });

    it("nets out placing: every block mined is taken off again when placed", () => {
        for (const template of catalog.TEMPLATES) {
            for (const check of checks(template)) {
                const counted = parts(check);
                for (const part of counted.filter((one) => one.sign > 0 && one.criterion.startsWith("minecraft.mined:"))) {
                    const id = part.criterion.split(":")[1];
                    // Amethyst clusters and chorus plants regrow; everything else is placeable.
                    if (id === "minecraft.chorus_plant") continue;
                    expect(
                        counted.some((one) => one.sign < 0 && one.criterion === `minecraft.used:${id}`),
                        `${template.id} mines ${id} without taking placed ones off`
                    ).toBe(true);
                }
            }
        }
    });

    it("nets out dropping: every item picked up is taken off again when dropped", () => {
        for (const template of catalog.TEMPLATES) {
            for (const check of checks(template)) {
                const counted = parts(check);
                for (const part of counted.filter((one) => one.sign > 0 && one.criterion.startsWith("minecraft.picked_up:"))) {
                    const id = part.criterion.split(":")[1];
                    expect(
                        counted.some((one) => one.sign < 0 && one.criterion === `minecraft.dropped:${id}`),
                        `${template.id} picks up ${id} without dropping`
                    ).toBe(true);
                }
            }
        }
    });

    it("never counts a craft that can be undone without capping it by what was gathered", () => {
        for (const template of catalog.TEMPLATES) {
            for (const check of checks(template)) {
                if (check.kind !== "sum") continue;
                for (const part of check.parts.filter((one) => one.criterion.startsWith("minecraft.crafted:"))) {
                    const id = part.criterion.split("minecraft.crafted:minecraft.")[1]!;
                    if (REVERSIBLE.includes(id)) expect(check.capBy, `${template.id} crafts ${id}`).toBeDefined();
                }
            }
        }
        expect(catalog.TEMPLATES.find((one) => one.id === "Cr2")?.check).toMatchObject({ capBy: expect.any(Array) });
    });

    it("never counts cobblestone or stone, which generators make endlessly", () => {
        for (const template of catalog.TEMPLATES.filter((one) => one.category === "mining")) {
            for (const check of checks(template)) {
                for (const criterion of catalog.criteriaOf(check)) {
                    expect(criterion).not.toMatch(/minecraft\.mined:minecraft\.(stone|cobblestone)$/);
                }
            }
        }
    });

    it("caps what farms produce per minute", () => {
        for (const id of ["C1", "C2", "C5", "C7", "C11", "Fi1", "E1", "E3", "T1", "N1", "N6", "F3"]) {
            expect(catalog.templateOf(id)?.perMinute, id).toBeGreaterThan(0);
        }
    });

    it("fits the busiest template within one layer's objective budget", () => {
        for (const template of catalog.TEMPLATES) {
            for (const variant of template.variants ?? [{ key: null }]) {
                const count = draw.criteriaOfEntry(template, variant.key as string | null).length;
                expect(count, template.id).toBeLessThanOrEqual(draw.BUDGET.card);
            }
        }
    });

    it("names a fallback that exists for every once-per-world template", () => {
        for (const template of catalog.TEMPLATES.filter((one) => one.fallback)) {
            const fallback = catalog.templateOf(template.fallback!);
            expect(fallback, template.id).not.toBeNull();
            expect(fallback!.fallback).toBeUndefined();
        }
    });

    it("writes a title with its figure in the reader's unit and language", () => {
        const walk = catalog.templateOf("E1")!;
        expect(catalog.titleOf(walk, null, 200_000, "en")).toBe("Walk 2,000 blocks");
        expect(catalog.titleOf(walk, null, 200_000, "es")).toBe("Camina 2.000 bloques");
        const hunt = catalog.templateOf("C2")!;
        expect(catalog.titleOf(hunt, "spider", 25, "es")).toBe("Caza 25 arañas");
        expect(catalog.titleOf(catalog.templateOf("C9")!, null, 216_000, "en")).toBe("Play 3 hours without dying");
        expect(catalog.shapeOf(catalog.templateOf("M1")!, "en")).toBe("Mine x ore blocks");
    });

    it("reads versions the way servers print them", () => {
        expect(catalog.atLeast("1.16.5", [1, 17])).toBe(false);
        expect(catalog.atLeast("1.17", [1, 17])).toBe(true);
        expect(catalog.atLeast("1.21.4", [1, 21, 6])).toBe(false);
        expect(catalog.atLeast(null, [1, 21, 6])).toBe(true);
        expect(catalog.atLeast("1.21.4", undefined)).toBe(true);
    });
});
