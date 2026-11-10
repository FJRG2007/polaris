/**
 * Tasks memberships move into AccessGrant. Every row of the four older tables
 * has to arrive as a grant of the same shape the share dialog writes, with its
 * role as the capability, without removing anything and without duplicating a
 * grant on a second run.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
    join(
        process.cwd(),
        "../../packages/db/prisma/migrations/20270326000000_task_access_grants/migration.sql"
    ),
    "utf8"
);

const statements = sql
    .split(";")
    .map((one) => one.replace(/^--.*$/gm, "").trim())
    .filter((one) => one.length > 0);

const COPIES = [
    { table: "TaskSpaceMember", subject: "task.space", column: "spaceId", principal: "user", id: "userId" },
    { table: "TaskFolderMember", subject: "task.folder", column: "folderId", principal: "user", id: "userId" },
    { table: "TaskSpaceTeam", subject: "task.space", column: "spaceId", principal: "team", id: "teamId" },
    { table: "TaskFolderTeam", subject: "task.folder", column: "folderId", principal: "team", id: "teamId" }
];

describe("the task access grants migration", () => {
    it("only adds: nothing is dropped, deleted or truncated", () => {
        expect(sql).not.toMatch(/\bDROP\b|\bDELETE\b|\bTRUNCATE\b|\bUPDATE\b/i);
        expect(statements).toHaveLength(COPIES.length);
    });

    for (const copy of COPIES) {
        it(`copies every ${copy.table} row into a ${copy.subject} grant to a ${copy.principal}`, () => {
            const statement = statements.find((one) => one.includes(`FROM "${copy.table}"`));
            expect(statement).toBeDefined();
            expect(statement).toMatch(/^INSERT INTO "AccessGrant"/);
            expect(statement).toContain(
                `'${copy.subject}', o."${copy.column}", '${copy.principal}', o."${copy.id}", o."role"`
            );
            // The share dialog's shape: no listed actions, and the dated columns
            // left to their defaults.
            expect(statement).toContain("ARRAY[]::TEXT[]");
            expect(statement).not.toMatch(/"startsAt"|"endsAt"|"maxUses"/);
            // Only roles the subject has as capabilities.
            expect(statement).toContain(`o."role" IN ('guest', 'member', 'admin')`);
            // Rerunnable: a pair that already holds a grant is skipped.
            expect(statement).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM "AccessGrant" g/);
            expect(statement).toContain(`g."subjectType" = '${copy.subject}'`);
            expect(statement).toContain(`g."subjectId" = o."${copy.column}"`);
            expect(statement).toContain(`g."principalType" = '${copy.principal}'`);
            expect(statement).toContain(`g."principalId" = o."${copy.id}"`);
        });
    }
});
