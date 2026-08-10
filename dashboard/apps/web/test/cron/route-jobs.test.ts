/**
 * Every cron route names a job that exists.
 *
 * The routes no longer carry the work - they authorise and hand a name to the
 * scheduler - so a typo in that name is not a compile error, it is a 500 the first
 * time somebody's external scheduler calls it, months after the change that caused
 * it. Read as source rather than imported, because importing a route pulls in the
 * database and every game-server client behind it to check a string.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

const CRON_DIR = join(process.cwd(), "src/app/api/cron");
const JOBS = readFileSync(join(process.cwd(), "src/lib/cron/jobs.ts"), "utf8");

/** The job names the table defines. */
const defined = new Set([...JOBS.matchAll(/key:\s*"([^"]+)"/g)].map((match) => match[1]));

/** Each route directory, and the job name its handler asks for. */
const routes = readdirSync(CRON_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
        const source = readFileSync(join(CRON_DIR, entry.name, "route.ts"), "utf8");
        return {
            route: entry.name,
            asks: [...source.matchAll(/runScheduledJob\("([^"]+)"\)/g)].map((match) => match[1]),
            source
        };
    });

describe("what the cron routes trigger", () => {
    it("finds the routes at all, so this file cannot pass by looking at nothing", () => {
        expect(routes.length).toBeGreaterThanOrEqual(6);
        expect(defined.size).toBeGreaterThanOrEqual(6);
    });

    it.each(routes)("$route asks for a job that exists", ({ asks }) => {
        expect(asks).toHaveLength(1);
        expect(defined).toContain(asks[0]);
    });

    it.each(routes)("$route authorises before it runs anything", ({ source }) => {
        // The order matters and is easy to get wrong when copying one of these:
        // an unauthorised caller must not be able to start a backup and only then
        // be told no.
        const guard = source.indexOf("authorizeCron(request)");
        const work = source.indexOf("runScheduledJob(");
        expect(guard).toBeGreaterThan(-1);
        expect(work).toBeGreaterThan(guard);
    });

    it("has a job defined for every one of them, and none spare", () => {
        const asked = new Set(routes.flatMap((entry) => entry.asks));
        // `game-backups` is the deprecated alias of `backups`, so there is one
        // fewer name than there are routes.
        expect([...defined].sort()).toEqual([...asked].sort());
    });
});
