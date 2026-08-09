/**
 * Every mutation on the backups console has to answer, not throw.
 *
 * An error thrown out of a Server Action is rethrown in the React tree, where the
 * dashboard's boundary replaces the whole console with "This page stopped
 * working". `testDestinationAction` was the one that did not catch, so the button
 * whose entire job is to find out whether a destination is reachable took the
 * page down when the answer was "it is not".
 *
 * Read off the source rather than by calling them: the actions reach the session,
 * Prisma and the storage drivers, and what is being protected here is a property
 * of how they are written.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "src/app/(app)/apps/backups/actions.ts"), "utf8");

/** The body of each exported action, by name. */
function actionBodies(): { name: string; body: string }[] {
    const found: { name: string; body: string }[] = [];
    const pattern = /export async function (\w+)\(/g;
    for (const match of source.matchAll(pattern)) {
        const start = match.index ?? 0;
        const next = source.indexOf("\nexport async function ", start + 1);
        found.push({ name: match[1] ?? "", body: source.slice(start, next === -1 ? source.length : next) });
    }
    return found;
}

describe("the console's mutations", () => {
    it("are all there to be checked", () => {
        const names = actionBodies().map((entry) => entry.name);
        expect(names).toContain("testDestinationAction");
        expect(names.length).toBeGreaterThan(5);
    });

    it("each catch, so a refusal is a sentence and not a broken page", () => {
        for (const { name, body } of actionBodies()) {
            expect(body, `${name} must catch what it throws`).toMatch(/\bcatch\b/);
        }
    });
});
