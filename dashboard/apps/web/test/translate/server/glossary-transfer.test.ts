/**
 * Moving Polaris to another machine carries every person's glossaries and
 * never-translate list along with the rest.
 */

import { Prisma } from "@polaris/db";
import { describe, expect, it } from "vitest";
import { LEFT_BEHIND } from "@/lib/instance-transfer/transfer";
import { writePlan, type SchemaModel } from "@/lib/instance-transfer/plan";

const real = Prisma.dmmf.datamodel.models as unknown as SchemaModel[];

describe("an export of Polaris", () => {
    it.each(["TranslateGlossary", "TranslateKeepList"])("carries %s", (name) => {
        expect(real.some((model) => model.name === name)).toBe(true);
        expect(LEFT_BEHIND.has(name)).toBe(false);
        const order = writePlan(real).order;
        // Written after the person it belongs to.
        expect(order.indexOf(name)).toBeGreaterThan(order.indexOf("User"));
    });
});
