import * as core from "@polaris/core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ADDRESS = "0190b6a2-0000-7000-8000-000000000001";

const state = vi.hoisted(() => ({
    members: [] as string[],
    teamMembers: [] as string[],
    orgOwner: "owner-org",
    automation: { enabled: true, publishedVersionId: "v1" } as Record<string, unknown> | null,
    trigger: null as Record<string, unknown> | null,
    fired: [] as Array<Record<string, unknown>>,
    used: 0
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        organization: { findUnique: async () => ({ ownerId: state.orgOwner }), findMany: async () => [] },
        organizationMember: {
            findMany: async ({ where }: { where: { userId?: { in?: string[] } } }) =>
                state.members.filter((id) => (where.userId?.in ?? []).includes(id)).map((userId) => ({ userId }))
        },
        teamMember: { findMany: async () => state.teamMembers.map((userId) => ({ userId })) },
        automation: { findUnique: async () => state.automation },
        automationTrigger: { findUnique: async () => state.trigger },
        automationAlertAddress: {
            updateMany: async () => {
                state.used += 1;
                return { count: 1 };
            }
        }
    }
}));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/automations/combine", () => ({
    fireTrigger: async (input: Record<string, unknown>) => {
        state.fired.push(input);
        return { id: "run-1", status: "queued" };
    }
}));
vi.mock("@/lib/automations/engine", () => ({ advanceRun: async () => undefined }));

const addresses = await import("@/lib/alerts/addresses");
const { alertSnippets } = await import("@/lib/alerts/snippets");
const { armedTriggers } = await import("@/lib/automations/triggers");
const { parseNtfyText } = await import("@/lib/alerts/parse");

beforeEach(() => {
    state.members = [];
    state.teamMembers = [];
    state.automation = { enabled: true, publishedVersionId: "v1" };
    state.trigger = {
        versionId: "v1",
        eventType: "core.alert",
        subjectKey: ADDRESS,
        state: { config: JSON.stringify({ addressId: ADDRESS, defaultPriority: 4 }) }
    };
    state.fired = [];
    state.used = 0;
});

const alertOf = (text: string, headers: Record<string, string> = {}) => {
    const parsed = parseNtfyText(new Headers(headers), new URLSearchParams(), text);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.alert;
};
const address = { id: ADDRESS, automationId: "auto-1", nodeId: "alert" };

describe("alert address secrets", () => {
    it("matches only the secret whose hash is stored", () => {
        const secret = addresses.newSecret();
        const hash = addresses.hashSecret(secret);
        expect(addresses.secretMatches(secret, hash)).toBe(true);
        expect(addresses.secretMatches(`${secret}x`, hash)).toBe(false);
        expect(addresses.secretMatches(secret, "abcd")).toBe(false);
    });
});

describe("firing an alert", () => {
    it("starts a run with the alert as its trigger, at the trigger's default severity", async () => {
        const result = await addresses.fireAlert(address, alertOf("Backup finished"), "ntfy");
        expect(result).toEqual({ ok: true, runId: "run-1", priority: 4 });
        expect(state.fired[0]).toMatchObject({
            automationId: "auto-1",
            versionId: "v1",
            triggerNodeId: "alert",
            cause: { message: "Backup finished", priority: 4, source: "ntfy" }
        });
        expect(state.used).toBe(1);
    });

    it("keeps the severity the sender gave", async () => {
        await addresses.fireAlert(address, alertOf("Disk full", { Priority: "urgent" }), "ntfy");
        expect((state.fired[0]!.cause as Record<string, unknown>).priority).toBe(5);
    });

    it("answers off when the automation is off, unpublished, or armed for another address", async () => {
        state.automation = { enabled: false, publishedVersionId: "v1" };
        expect(await addresses.fireAlert(address, alertOf("x"), "json")).toEqual({ ok: false, reason: "off" });
        state.automation = { enabled: true, publishedVersionId: null };
        expect(await addresses.fireAlert(address, alertOf("x"), "json")).toEqual({ ok: false, reason: "off" });
        state.automation = { enabled: true, publishedVersionId: "v1" };
        state.trigger = { ...state.trigger, subjectKey: "0190b6a2-0000-7000-8000-000000000002" };
        expect(await addresses.fireAlert(address, alertOf("x"), "json")).toEqual({ ok: false, reason: "off" });
        expect(state.fired).toHaveLength(0);
    });
});

describe("who an alert reaches", () => {
    it("is the run-as account alone on a personal automation", async () => {
        const reached = await addresses.alertRecipients({
            runAsId: "me",
            orgId: null,
            recipientUserIds: ["other"],
            recipientTeamIds: []
        });
        expect(reached).toEqual(["me"]);
    });

    it("is only current members of an organization, plus its owner", async () => {
        state.members = ["me", "teammate", "named"];
        state.teamMembers = ["teammate", "left-the-org"];
        const reached = await addresses.alertRecipients({
            runAsId: "me",
            orgId: "org-1",
            recipientUserIds: ["named", "stranger", "owner-org"],
            recipientTeamIds: ["team-1"]
        });
        expect(new Set(reached)).toEqual(new Set(["me", "teammate", "named", "owner-org"]));
    });
});

describe("setup snippets", () => {
    const snippets = alertSnippets("https://polaris.example", ADDRESS, "s3cret");
    const text = (id: string) => snippets.find((one) => one.id === id)?.text ?? "";

    it("give Windows PowerShell a command it runs, not curl's flags", () => {
        const line = text("powershell");
        expect(line.startsWith("Invoke-RestMethod -Method Post")).toBe(true);
        expect(line).toContain(`-Uri "https://polaris.example/api/alerts/${ADDRESS}/s3cret"`);
        expect(line).not.toMatch(/(^|\s)-d\s/);
    });

    it("post to the same address the routes answer", () => {
        expect(text("curl")).toBe(`curl -d "Backup finished" https://polaris.example/api/alerts/${ADDRESS}/s3cret`);
        expect(text("gotify")).toContain(`/api/alerts/${ADDRESS}/message?token=s3cret`);
    });
});

describe("alert topics carried into automations", () => {
    const migrations = "../../../../packages/db/prisma/migrations";
    const read = (name: string) =>
        readFileSync(fileURLToPath(new URL(`${migrations}/${name}/migration.sql`, import.meta.url)), "utf8");
    const carry = read("20270422000000_alert_topics_to_automations");
    const drop = read("20270422000001_archive_alert_topics");

    // What the migration writes for a topic, as its SQL builds it.
    const carried = core.automationGraphSchema.parse({
        schema: 1,
        timeZone: "UTC",
        nodes: [
            {
                id: "alert",
                type: "core.alertIn",
                typeVersion: 1,
                position: { x: 0, y: 0 },
                config: { addressId: ADDRESS, defaultPriority: 4 }
            },
            {
                id: "notify",
                type: "core.alertNotify",
                typeVersion: 1,
                position: { x: 0, y: 160 },
                config: {
                    title: "{{trigger.title}}",
                    body: "{{trigger.message}}",
                    priority: "{{trigger.priority}}",
                    pushFrom: 3,
                    click: "{{trigger.click}}",
                    dedupKey: "{{trigger.dedupKey}}",
                    recipientUserIds: [],
                    recipientTeamIds: []
                }
            }
        ],
        edges: [{ from: { node: "alert", port: "next" }, to: { node: "notify" } }],
        finally: { entry: null, onCancel: false }
    });

    it("writes the graph asserted here, node for node", () => {
        const pieces = [
            "'id', 'alert'",
            "'type', 'core.alertIn'",
            "'addressId', t.\"id\"::text",
            "'id', 'notify'",
            "'type', 'core.alertNotify'",
            "'title', '{{trigger.title}}'",
            "'body', '{{trigger.message}}'",
            "'priority', '{{trigger.priority}}'",
            "'click', '{{trigger.click}}'",
            "'dedupKey', '{{trigger.dedupKey}}'",
            "'alert', 'core.alert', c.\"id\"::text"
        ];
        for (const piece of pieces) expect(carry, piece).toContain(piece);
        expect(addresses.CARRIED_NODE_ID).toBe("alert");
    });

    it("is a graph that publishes and arms the address it kept", () => {
        expect(core.graphProblems(carried, { forPublish: true })).toEqual([]);
        const armed = armedTriggers("auto-1", carried, [], new Date());
        expect(armed).toEqual([
            expect.objectContaining({ nodeId: "alert", eventType: "core.alert", subjectKey: ADDRESS })
        ]);
    });

    it("keeps every delivery as a finished run, with the fields the trigger hands a run", () => {
        expect(carry).toContain('INSERT INTO "AutomationRun"');
        expect(carry).toContain("'alert:delivery:' || d.\"id\"::text");
        const cause = addresses.alertCause(
            "alert",
            { title: "t", message: "m", markdown: false, priority: 3, tags: [], actions: [] },
            3,
            "json",
            new Date()
        );
        for (const field of Object.keys(cause)) expect(carry, field).toContain(`'${field}', `);
        expect(carry).toContain("'/automations/runs/' || r.\"id\"::text");
    });

    it("keeps the old tables, archived with their rows, never dropped", () => {
        expect(carry).not.toMatch(/DROP TABLE IF EXISTS "Alert(Topic|Delivery)"/);
        expect(drop).not.toMatch(/DROP TABLE/);
        expect(drop).toContain('ALTER TABLE "AlertTopic" RENAME TO "AlertTopic_archived"');
        expect(drop).toContain('ALTER TABLE "AlertDelivery" RENAME TO "AlertDelivery_archived"');
    });
});
