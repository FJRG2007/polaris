/**
 * The indexes the live table statistics asked for.
 *
 * Two lookups ran as a sequential scan of the whole table, over and over: the
 * analytics rollup asking whether each day since the oldest visit was rolled up
 * yet (`day` + `dimension`, any site), and a calendar pull matching every
 * remote object by its address (`calendarId` + `href`). Each needs its index
 * declared in the schema, so Prisma knows it, and created by a migration, so an
 * existing install gets it on update.
 */

import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const PRISMA = join(process.cwd(), "..", "..", "packages", "db", "prisma");

const model = (schema: string, name: string): string =>
    schema.slice(schema.indexOf(`model ${name} {`)).split("\n}\n")[0] ?? "";

describe("the scan leads' indexes", () => {
    it.each([
        ["AnalyticsDay", "@@index([day, dimension])", "20271120000190_analytics_day_rollup_index", '"AnalyticsDay_day_dimension_idx" ON "AnalyticsDay"("day", "dimension")'],
        ["CalendarObject", "@@index([calendarId, href])", "20271120000191_calendar_object_href_index", '"CalendarObject_calendarId_href_idx" ON "CalendarObject"("calendarId", "href")']
    ])("%s is declared and created", async (name, declared, migration, created) => {
        const schema = await readFile(join(PRISMA, "schema.prisma"), "utf8");
        expect(model(schema, name)).toContain(declared);
        const sql = await readFile(join(PRISMA, "migrations", migration, "migration.sql"), "utf8");
        expect(sql).toContain(`CREATE INDEX IF NOT EXISTS ${created}`);
    });
});
