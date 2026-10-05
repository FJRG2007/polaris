/**
 * A filter saved with "and the mail already here".
 *
 * It used to run every filter again over the inbox, one message at a time with
 * two reads each - which also meant a forwarding filter sent old mail a second
 * time. It now runs only the filter just saved, reads the inbox a page at a time
 * with only what a filter looks at, and acts only where it matched.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ruleFind = vi.fn();
const ruleUpdate = vi.fn(async () => undefined);
const folderFind = vi.fn(async () => [{ id: "inbox-1" }]);
const messageFind = vi.fn();
const actOnMessages = vi.fn(async () => 1);
const mailRuleFindMany = vi.fn();

vi.mock("@polaris/db", () => ({
    prisma: {
        mailRule: { findFirst: ruleFind, update: ruleUpdate, findMany: mailRuleFindMany },
        mailFolder: { findMany: folderFind },
        mailMessage: { findMany: messageFind },
        mailAccount: { findUnique: vi.fn(async () => ({ userId: "u1" })) }
    }
}));
vi.mock("@/lib/mailbox/messages", () => ({ actOnMessages, moveMessages: vi.fn() }));
vi.mock("@/lib/mailbox/access", () => ({ ownedAccount: vi.fn(async () => ({ id: "acc-1" })) }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock("@polaris/auth", () => ({ listUserEmails: vi.fn(async () => []) }));

const { applyRuleToInbox, listRulesFor, runRuleOverInbox } = await import("@/lib/mailbox/rules");

const message = (id: string, subject: string) => ({
    id,
    subject,
    snippet: "",
    bodyText: "",
    listId: "",
    hasAttachments: false,
    size: 100,
    fromJson: [{ name: "", address: "ci@example.com" }],
    toJson: [],
    ccJson: []
});

beforeEach(() => {
    vi.clearAllMocks();
    messageFind.mockReset();
    ruleFind.mockResolvedValue({
        id: "r1",
        name: "CI",
        enabled: true,
        match: "all",
        conditions: [{ field: "subject", operator: "similar", value: "run failed: ci (*)" }],
        actions: [{ kind: "archive" }],
        stop: false
    });
});

describe("running one filter over the inbox", () => {
    it("acts only on what it matches, reading a page at a time", async () => {
        messageFind
            .mockResolvedValueOnce([
                message("m1", "Run failed: CI (3f2a9c1)"),
                message("m2", "Lunch on Friday?"),
                message("m3", "Run failed: CI (9b1e0d4)")
            ])
            .mockResolvedValueOnce([]);

        expect(await applyRuleToInbox("acc-1", "r1")).toBe(2);
        expect(actOnMessages.mock.calls.map((call) => call[1])).toEqual([["m1"], ["m3"]]);
        // Only the columns a filter reads, from the inbox's own folders.
        const asked = messageFind.mock.calls[0]![0] as {
            where: unknown;
            select: Record<string, boolean>;
        };
        expect(asked.where).toEqual({ folderId: { in: ["inbox-1"] } });
        expect(asked.select.bodyText).toBe(true);
        expect(ruleUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ matchCount: { increment: 2 } })
            })
        );
    });

    it("does nothing for a filter that is not on this mailbox", async () => {
        ruleFind.mockResolvedValue(null);
        expect(await applyRuleToInbox("acc-1", "nope")).toBe(0);
        expect(messageFind).not.toHaveBeenCalled();
    });

    it("never forwards the mail already here, so running it again sends nothing", async () => {
        ruleFind.mockResolvedValue({
            id: "r1",
            name: "CI",
            enabled: true,
            match: "all",
            conditions: [{ field: "subject", operator: "similar", value: "run failed: ci (*)" }],
            actions: [{ kind: "forward", to: "me@example.com" }],
            stop: false
        });
        expect(await applyRuleToInbox("acc-1", "r1")).toBe(0);
        expect(messageFind).not.toHaveBeenCalled();
    });

    it("runs a filter once at a time, however often it is asked", async () => {
        let release: (page: unknown[]) => void = () => undefined;
        messageFind.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
        await runRuleOverInbox("u1", "acc-1", "r1");
        await vi.waitFor(() => expect(messageFind).toHaveBeenCalledTimes(1));
        await runRuleOverInbox("u1", "acc-1", "r1");
        release([]);
        await vi.waitFor(() => expect(ruleFind).toHaveBeenCalledTimes(3));
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(messageFind).toHaveBeenCalledTimes(1);

        messageFind.mockResolvedValueOnce([]);
        await runRuleOverInbox("u1", "acc-1", "r1");
        await vi.waitFor(() => expect(messageFind).toHaveBeenCalledTimes(2));
    });

    it("stops at its bound", async () => {
        messageFind.mockResolvedValue(
            Array.from({ length: 250 }, (_, at) => message(`m${at}`, "Lunch on Friday?"))
        );
        await applyRuleToInbox("acc-1", "r1", 500);
        expect(messageFind).toHaveBeenCalledTimes(2);
    });
});

describe("listing the filters of every mailbox", () => {
    it("reads them in one query and hands each mailbox its own, in order", async () => {
        mailRuleFindMany.mockResolvedValue([
            {
                id: "a",
                accountId: "acc-1",
                name: "A",
                enabled: true,
                match: "all",
                conditions: [],
                actions: [],
                stop: false,
                position: 0,
                matchCount: 0
            },
            {
                id: "b",
                accountId: "acc-2",
                name: "B",
                enabled: true,
                match: "all",
                conditions: [],
                actions: [],
                stop: false,
                position: 0,
                matchCount: 3
            }
        ]);
        const byAccount = await listRulesFor(["acc-1", "acc-2", "acc-3"]);
        expect(mailRuleFindMany).toHaveBeenCalledTimes(1);
        expect(byAccount["acc-1"]?.map((rule) => rule.id)).toEqual(["a"]);
        expect(byAccount["acc-2"]?.[0]?.matchCount).toBe(3);
        expect(byAccount["acc-3"]).toEqual([]);
    });
});
