/**
 * Reading a stored conversation into a handoff, and copying it onto the
 * session that carries it on: bounded reads, oldest first, and copied rows the
 * new session's transcript sync can never take for its own.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const FROM = "00000000-0000-4000-8000-000000000001";
const TO = "00000000-0000-4000-8000-000000000002";

const findMany = vi.fn();
const createMany = vi.fn();

vi.mock("@polaris/db", () => ({
    prisma: { agentSessionMessage: { findMany: (...args: unknown[]) => findMany(...args), createMany: (...args: unknown[]) => createMany(...args) } }
}));

const service = await import("@/lib/agents/session-handoff-service");
const handoff = await import("@/lib/agents/session-handoff");

const row = (role: string, body: string, minute: number) => ({
    role,
    kind: "text",
    subject: "",
    ref: "",
    body,
    authorId: role === "user" ? "00000000-0000-4000-8000-0000000000aa" : null,
    vendorId: `line:${minute}`,
    createdAt: new Date(Date.UTC(2026, 10, 17, 9, minute))
});

beforeEach(() => {
    findMany.mockReset();
    createMany.mockReset();
    // Newest first, as the query asks for them.
    findMany.mockResolvedValue([row("agent", "Fixed it.", 2), row("user", "Fix the login", 1)]);
    createMany.mockImplementation(async ({ data }: { data: unknown[] }) => ({ count: data.length }));
});

describe("handoffFor", () => {
    it("reads a bounded page and builds the note and the file from it", async () => {
        const answer = await service.handoffFor(
            { id: FROM, title: "Fix", cli: "claude", branch: "polaris/fix", repoFullName: "acme/web" },
            { kind: "switch", targetCli: "codex", at: new Date("2026-11-17T10:00:00.000Z") }
        );
        const query = findMany.mock.calls[0]?.[0] as { take: number; where: unknown };
        expect(query.take).toBe(handoff.HANDOFF_MESSAGES_MOST);
        expect(query.where).toEqual({ sessionId: FROM });
        expect(answer.note).toContain("You are Codex, taking over this Polaris session from Claude Code.");
        expect(answer.note).toContain("User:\nFix the login\nAssistant:\nFixed it.");
        expect(answer.file.path).toBe(handoff.HANDOFF_FILE);
        expect(answer.file.text.indexOf("Fix the login")).toBeLessThan(answer.file.text.indexOf("Fixed it."));
    });
});

describe("copyHistory", () => {
    it("copies oldest first, keeps the times, and marks every row as carried", async () => {
        expect(await service.copyHistory(FROM, TO)).toBe(2);
        const query = findMany.mock.calls[0]?.[0] as { take: number };
        expect(query.take).toBe(service.COPIED_MESSAGES_MOST);
        const { data, skipDuplicates } = createMany.mock.calls[0]?.[0] as {
            data: Array<{ sessionId: string; body: string; vendorId: string; createdAt: Date }>;
            skipDuplicates: boolean;
        };
        expect(skipDuplicates).toBe(true);
        expect(data.map((one) => one.body)).toEqual(["Fix the login", "Fixed it."]);
        expect(data.every((one) => one.sessionId === TO)).toBe(true);
        expect(data.every((one) => one.vendorId.startsWith(`carried:${FROM}:`))).toBe(true);
        expect(data[0]?.createdAt.toISOString()).toBe("2026-11-17T09:01:00.000Z");
    });

    it("writes nothing for a session with no history", async () => {
        findMany.mockResolvedValue([]);
        expect(await service.copyHistory(FROM, TO)).toBe(0);
        expect(createMany).not.toHaveBeenCalled();
    });
});
