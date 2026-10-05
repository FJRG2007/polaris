/**
 * "If the subject contains 'PR run failed:', put it in the trash" - and it did
 * not.
 *
 * Reproduced on the path a message takes when it arrives after the filter was
 * saved: the subject as imapflow decodes it from the server's ENVELOPE (RFC 2047
 * encoded words, split across a folded header, in another case than the
 * filter's), judged by the filter, and the trash step carried out. Pinned with
 * it are the two ways a matching message used to stay where it was:
 *
 * - a step that failed threw out of the sync that delivered the message, and the
 *   message - already stored - was never judged again;
 * - a subject whose spacing differed from what is on screen (a folded line, a
 *   no-break space) did not "contain" the words it showed.
 *
 * Mail that was already in the inbox when the filter was saved is the third,
 * covered by `rule-over-existing-mail.test.ts` and the list's "Run over the
 * inbox now".
 */

import tools from "imapflow/lib/tools.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const MAILBOX = "00000000-0000-4000-8000-000000000001";

const ruleRows = vi.fn();
const messageRow = vi.fn();
const ruleUpdateMany = vi.fn(async () => ({ count: 1 }));
const actOnMessages = vi.fn(async (..._args: unknown[]) => 1);

vi.mock("@polaris/db", () => ({
    prisma: {
        mailRule: { findMany: ruleRows, updateMany: ruleUpdateMany },
        mailMessage: { findUnique: messageRow },
        mailAccount: { findUnique: vi.fn(async () => ({ userId: "u1" })) }
    }
}));
vi.mock("@/lib/mailbox/messages", () => ({
    actOnMessages: (...args: unknown[]) => actOnMessages(...args),
    moveMessages: vi.fn()
}));
vi.mock("@/lib/mailbox/access", () => ({ ownedAccount: vi.fn() }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: vi.fn() }));
vi.mock("@polaris/auth", () => ({ listUserEmails: vi.fn(async () => []) }));

const { applyRulesToMessage } = await import("@/lib/mailbox/rules");

/** The subject as the sync gets it: imapflow's own reading of an ENVELOPE. */
function envelopeSubject(raw: string): string {
    const parse = (tools as unknown as { parseEnvelope: (entry: unknown[]) => { subject: string } })
        .parseEnvelope;
    return parse([{ value: "Mon, 5 Oct 2026 10:00:00 +0000" }, { value: raw }]).subject;
}

/** The filter from the report, exactly as the old form saved it. */
const REPORTED = {
    id: "r1",
    name: "Auto delete GitHub Failed PRs email notifications",
    enabled: true,
    match: "all",
    conditions: [{ field: "subject", operator: "contains", value: "PR run failed:" }],
    actions: [{ kind: "trash" }],
    stop: false,
    definition: null
};

function arriving(subject: string) {
    return {
        subject,
        snippet: "",
        bodyText: null,
        listId: "",
        hasAttachments: false,
        size: 2048,
        fromJson: [{ name: "GitHub", address: "notifications@github.example" }],
        toJson: [],
        ccJson: [],
        headers: {}
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    ruleRows.mockResolvedValue([REPORTED]);
});

describe("a message that arrives after the filter was saved", () => {
    it("is trashed when its subject was encoded, folded and in another case", async () => {
        const subject = envelopeSubject(
            "=?UTF-8?Q?[FJRG2007/polaris]_PR_RUN_FAILED=3A_CI_-_feat/m?=\r\n =?UTF-8?Q?ail_(3f2a9c1)?="
        );
        expect(subject).toBe("[FJRG2007/polaris] PR RUN FAILED: CI - feat/mail (3f2a9c1)");
        messageRow.mockResolvedValue(arriving(subject));

        const outcome = await applyRulesToMessage(MAILBOX, "m1");

        expect(outcome).toEqual({ actions: [{ kind: "trash" }], applied: true });
        expect(actOnMessages).toHaveBeenCalledWith("u1", ["m1"], "trash");
        expect(ruleUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: { in: ["r1"] } } })
        );
    });

    it("is trashed when the server handed the subject over still folded", async () => {
        // Plain ASCII, folded by the sender's mail system and not unfolded on
        // the way: the line break and its indent are inside the subject.
        messageRow.mockResolvedValue(arriving(envelopeSubject("[acme/api] PR run\r\n failed: CI")));
        expect((await applyRulesToMessage(MAILBOX, "m2")).applied).toBe(true);
        messageRow.mockResolvedValue(arriving("[acme/api] PR run failed: CI"));
        expect((await applyRulesToMessage(MAILBOX, "m3")).applied).toBe(true);
        expect(actOnMessages).toHaveBeenCalledTimes(2);
    });

    it("is left alone when the subject does not say it", async () => {
        messageRow.mockResolvedValue(arriving("[acme/api] Run succeeded: CI"));
        expect((await applyRulesToMessage(MAILBOX, "m4")).applied).toBe(false);
        expect(actOnMessages).not.toHaveBeenCalled();
    });

    it("does not stop the sync when a step fails, and still takes the steps after it", async () => {
        ruleRows.mockResolvedValue([
            {
                ...REPORTED,
                actions: [{ kind: "trash" }, { kind: "star" }]
            }
        ]);
        messageRow.mockResolvedValue(arriving("PR run failed: CI"));
        // What a mailbox with no folder recognised as its Trash, or a server
        // that refused the move, used to throw out of the sync.
        actOnMessages.mockRejectedValueOnce(new Error("This mailbox has no folder for trash."));
        const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);

        await expect(applyRulesToMessage(MAILBOX, "m5")).resolves.toEqual({
            actions: [{ kind: "trash" }, { kind: "star" }],
            applied: true
        });
        expect(actOnMessages.mock.calls.map((call) => call[2])).toEqual(["trash", "star"]);
        // Said where an operator can find it, without anything the message says.
        expect(String(quiet.mock.calls[0]?.[0])).toContain(
            `could not trash a message in mailbox ${MAILBOX}`
        );
        quiet.mockRestore();
    });

    it("is not judged by a filter that is switched off", async () => {
        ruleRows.mockResolvedValue([]);
        messageRow.mockResolvedValue(arriving("PR run failed: CI"));
        expect((await applyRulesToMessage(MAILBOX, "m6")).applied).toBe(false);
        expect(ruleRows).toHaveBeenCalledWith(
            expect.objectContaining({ where: { accountId: MAILBOX, enabled: true } })
        );
    });
});
