/**
 * Grants started naming their actions. Every grant written before that has to
 * keep doing exactly what it did - a guest who could open and lock the door
 * yesterday can today - so the migration only adds, and spells out for each
 * existing Places grant the actions its capability reached.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import * as core from "@polaris/core";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
    join(
        process.cwd(),
        "../../packages/db/prisma/migrations/20261231004500_grant_actions/migration.sql"
    ),
    "utf8"
);

describe("the grant actions migration", () => {
    it("only adds: a column with a default, and no row or column removed", () => {
        expect(sql).toMatch(/ADD COLUMN (?:IF NOT EXISTS )?"actions" TEXT\[\] NOT NULL DEFAULT ARRAY\[\]::TEXT\[\]/);
        expect(sql).not.toMatch(/\bDROP\b|\bDELETE\b|\bTRUNCATE\b/i);
    });

    it("hands a lent door everything control reached, and a camera its watching", () => {
        const door = core.grantActions("place.device", "control", []);
        expect(sql).toContain(`SET "actions" = ARRAY[${door.map((one) => `'${one}'`).join(", ")}]`);
        expect(sql).toMatch(/"subjectType" = 'place\.device' AND "capability" = 'control'/);
        expect(sql).toContain(`SET "actions" = ARRAY['watch']`);
        expect(sql).toMatch(/"subjectType" = 'place\.camera'/);
    });

    it("leaves a row it does not touch meaning what it meant", () => {
        // An empty list reads as everything the capability reaches, so a row
        // the backfill missed - or one written by an older dashboard mid-update -
        // still allows what it did.
        expect(core.grantActions("place.device", "control", [])).toEqual([
            "open",
            "close",
            "operate"
        ]);
        expect(core.grantActions("place.device", "view", [])).toEqual([]);
    });
});
