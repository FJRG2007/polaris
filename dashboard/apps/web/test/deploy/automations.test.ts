/**
 * Project automations start when they should, once, and stop where they must.
 *
 * Pinned because each failure is quiet: an event heard by two processes that
 * redeploys twice, a rule that answers its own deploy for ever, a migration
 * that failed and a restart that went ahead anyway, or a rule that keeps
 * deploying for somebody who was taken off the project.
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface RuleRow {
    id: string;
    projectId: string;
    name: string;
    enabled: boolean;
    trigger: string;
    schedule: string | null;
    timezone: string;
    event: string | null;
    eventApplicationId: string | null;
    webhookTokenHash: string | null;
    actions: string;
    nextRunAt: Date | null;
    lastRunAt: Date | null;
    lastStatus: string | null;
    createdById: string | null;
}

interface RunRow {
    id: string;
    automationId: string;
    trigger: string;
    status: string;
    log: string;
    startedAt: Date;
    finishedAt: Date | null;
}

const PROJECT = "00000000-0000-4000-8000-000000000001";
const WEB = "00000000-0000-4000-8000-0000000000a1";
const WORKER = "00000000-0000-4000-8000-0000000000a2";
const MAKER = "00000000-0000-4000-8000-0000000000c1";
const OWNER = "00000000-0000-4000-8000-0000000000c0";

let rules: RuleRow[] = [];
let runs: RunRow[] = [];
let goneServices = new Set<string>();
let environments: Record<string, string> = {};
let users: Record<
    string,
    { id: string; isAdmin: boolean; bannedAt: Date | null; disabledAt: Date | null }
> = {};

const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, wanted]) => {
        if (key === "project" || key === "automation") return true;
        const value = row[key];
        if (wanted && typeof wanted === "object" && !(wanted instanceof Date)) {
            const cond = wanted as { lte?: Date; gt?: Date; not?: unknown };
            if ("not" in cond) return value !== cond.not;
            if (cond.lte) return value instanceof Date && value <= cond.lte;
            if (cond.gt) return value instanceof Date && value > cond.gt;
            return true;
        }
        if (wanted instanceof Date)
            return value instanceof Date && value.getTime() === wanted.getTime();
        return value === wanted;
    });

const project = { id: PROJECT, name: "Shop", ownerId: OWNER, orgId: null, binnedAt: null };

vi.mock("@polaris/db", () => ({
    prisma: {
        deployAutomation: {
            findMany: async ({ where }: { where: Record<string, unknown> }) =>
                rules.filter((row) => matches(row as never, where)),
            findFirst: async ({ where }: { where: Record<string, unknown> }) =>
                rules.find((row) => matches(row as never, where)) ?? null,
            findUnique: async ({ where }: { where: { id: string } }) => {
                const row = rules.find((one) => one.id === where.id);
                return row ? { ...row, project } : null;
            },
            updateMany: async ({
                where,
                data
            }: {
                where: Record<string, unknown>;
                data: Partial<RuleRow>;
            }) => {
                const hit = rules.filter((row) => matches(row as never, where));
                for (const row of hit) Object.assign(row, data);
                return { count: hit.length };
            },
            update: async ({ where, data }: { where: { id: string }; data: Partial<RuleRow> }) => {
                const row = rules.find((one) => one.id === where.id)!;
                Object.assign(row, data);
                return row;
            }
        },
        deployAutomationRun: {
            create: async ({ data }: { data: Partial<RunRow> }) => {
                const row: RunRow = {
                    id: `run-${runs.length + 1}`,
                    automationId: data.automationId!,
                    trigger: data.trigger!,
                    status: data.status ?? "running",
                    log: data.log ?? "",
                    startedAt: data.startedAt ?? new Date(),
                    finishedAt: data.finishedAt ?? null
                };
                runs.push(row);
                return row;
            },
            findFirst: async ({
                where,
                orderBy
            }: {
                where: Record<string, unknown>;
                orderBy?: unknown;
            }) =>
                [...runs]
                    .sort((a, b) => (orderBy ? b.startedAt.getTime() - a.startedAt.getTime() : 0))
                    .find((row) => matches(row as never, where)) ?? null,
            findUnique: async ({ where }: { where: { id: string } }) => {
                const run = runs.find((one) => one.id === where.id);
                if (!run) return null;
                const automation = rules.find((one) => one.id === run.automationId)!;
                return { ...run, automation: { ...automation, project } };
            },
            update: async ({ where, data }: { where: { id: string }; data: Partial<RunRow> }) => {
                const row = runs.find((one) => one.id === where.id)!;
                Object.assign(row, data);
                return row;
            },
            findMany: async ({
                where,
                skip = 0,
                take
            }: {
                where: { automationId: string };
                skip?: number;
                take?: number;
            }) =>
                runs
                    .filter((row) => row.automationId === where.automationId)
                    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
                    .slice(skip, take === undefined ? undefined : skip + take),
            deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
                const before = runs.length;
                runs = runs.filter((row) => !where.id.in.includes(row.id));
                return { count: before - runs.length };
            }
        },
        application: {
            findFirst: async ({ where }: { where: { id: string } }) =>
                goneServices.has(where.id) ? null : { id: where.id },
            findUnique: async ({ where }: { where: { id: string } }) => ({
                id: where.id,
                name: "web"
            }),
            findMany: async ({ where }: { where: { id?: { in?: string[] } } }) =>
                (where.id?.in ?? []).map((id) => ({
                    id,
                    environmentId: environments[id] ?? "env-production"
                }))
        },
        user: {
            findUnique: async ({ where }: { where: { id: string } }) => users[where.id] ?? null
        }
    }
}));

const runInService = vi.fn();
const deployApplication = vi.fn();
const restartApplication = vi.fn();
const notify = vi.fn();
let capabilities: string[] = ["project.read", "deploy.run", "console.use"];
let hasAccess = true;

vi.mock("@/lib/deploy/service-cron", () => ({
    runInService: (...args: unknown[]) => runInService(...args)
}));
vi.mock("@/lib/deploy-service", () => ({
    deployApplication: (...args: unknown[]) => deployApplication(...args),
    restartApplication: (...args: unknown[]) => restartApplication(...args)
}));
vi.mock("@/lib/notifications/dispatch", () => ({
    notify: (...args: unknown[]) => notify(...args)
}));
vi.mock("@/lib/notifications/notice-words", () => ({
    wordsFor: async () => (key: string) => key
}));
vi.mock("@/lib/domain-service", () => ({ appBaseUrl: async () => "https://polaris.example/" }));
vi.mock("@polaris/auth", () => ({ userHasPermission: async () => true }));
vi.mock("@/lib/deploy-project-access", () => ({
    projectAccess: async () =>
        hasAccess
            ? {
                  projectId: PROJECT,
                  ownerId: OWNER,
                  orgId: null,
                  capabilities,
                  environmentIds: null
              }
            : null,
    accessCan: (access: { capabilities: string[] }, capability: string) =>
        access.capabilities.includes(capability),
    accessInEnvironment: (access: { environmentIds: string[] | null }, environmentId: string) =>
        access.environmentIds === null || access.environmentIds.includes(environmentId)
}));

const automations = await import("@/lib/deploy/automations");

function rule(overrides: Partial<RuleRow> = {}): RuleRow {
    const row: RuleRow = {
        id: `rule-${rules.length + 1}`,
        projectId: PROJECT,
        name: "Nightly",
        enabled: true,
        trigger: "event",
        schedule: null,
        timezone: "UTC",
        event: "deploy.failed",
        eventApplicationId: null,
        webhookTokenHash: null,
        actions: JSON.stringify([{ type: "restart", applicationId: WEB }]),
        nextRunAt: null,
        lastRunAt: null,
        lastStatus: null,
        createdById: MAKER,
        ...overrides
    };
    rules.push(row);
    return row;
}

/** The run started in the background, once it has finished. */
async function settled(): Promise<RunRow[]> {
    await vi.waitFor(() => {
        if (runs.some((run) => run.status === "running")) throw new Error("still running");
    });
    return runs;
}

beforeEach(() => {
    rules = [];
    runs = [];
    users = { [MAKER]: { id: MAKER, isAdmin: false, bannedAt: null, disabledAt: null } };
    capabilities = ["project.read", "deploy.run", "console.use"];
    hasAccess = true;
    goneServices = new Set();
    environments = {};
    runInService.mockReset();
    deployApplication.mockReset().mockResolvedValue("deployment-1");
    restartApplication.mockReset().mockResolvedValue(undefined);
    notify.mockReset().mockResolvedValue(undefined);
});

describe("an event", () => {
    it("starts the rules that follow it, and only those", async () => {
        rule();
        rule({ event: "domain.down" });
        const started = await automations.raiseAutomationEvent({
            projectId: PROJECT,
            event: "deploy.failed",
            applicationId: WEB
        });
        expect(started).toBe(1);
        await settled();
        expect(restartApplication).toHaveBeenCalledTimes(1);
        expect(runs[0]).toMatchObject({
            automationId: "rule-1",
            trigger: "event",
            status: "succeeded"
        });
    });

    it("skips a rule that follows another service", async () => {
        rule({ eventApplicationId: WORKER });
        expect(
            await automations.raiseAutomationEvent({
                projectId: PROJECT,
                event: "deploy.failed",
                applicationId: WEB
            })
        ).toBe(0);
        expect(runs).toEqual([]);
    });

    it("waits out the cool-off after the last run", async () => {
        rule({ lastRunAt: new Date(Date.now() - 60_000) });
        expect(
            await automations.raiseAutomationEvent({
                projectId: PROJECT,
                event: "deploy.failed",
                applicationId: WEB
            })
        ).toBe(0);
    });

    it("is started once when two processes hear it together", async () => {
        rule();
        const event = { projectId: PROJECT, event: "deploy.failed" as const, applicationId: WEB };
        const [first, second] = await Promise.all([
            automations.raiseAutomationEvent(event),
            automations.raiseAutomationEvent(event)
        ]);
        expect(first + second).toBe(1);
        await settled();
        expect(restartApplication).toHaveBeenCalledTimes(1);
    });
});

describe("the schedule", () => {
    it("starts a rule that has come due and moves its next firing on", async () => {
        const now = new Date("2026-10-15T03:00:30Z");
        const due = rule({
            trigger: "schedule",
            event: null,
            schedule: "0 3 * * *",
            nextRunAt: new Date("2026-10-15T03:00:00Z")
        });
        rule({
            trigger: "schedule",
            event: null,
            schedule: "0 3 * * *",
            nextRunAt: new Date("2026-10-16T03:00:00Z")
        });
        expect(await automations.tickDeployAutomations(now)).toEqual({ started: 1, skipped: 0 });
        expect(due.nextRunAt?.toISOString()).toBe("2026-10-16T03:00:00.000Z");
        await settled();
        expect(runs).toHaveLength(1);
    });

    it("records a firing as skipped while the previous run is still going", async () => {
        const now = new Date();
        const due = rule({
            trigger: "schedule",
            event: null,
            schedule: "* * * * *",
            nextRunAt: now
        });
        runs.push({
            id: "old",
            automationId: due.id,
            trigger: "schedule",
            status: "running",
            log: "",
            startedAt: new Date(now.getTime() - 30_000),
            finishedAt: null
        });
        expect(await automations.tickDeployAutomations(now)).toEqual({ started: 0, skipped: 1 });
        expect(runs[1]).toMatchObject({ status: "skipped" });
        expect(JSON.parse(runs[1]!.log)).toMatchObject({ note: "busy" });
    });
});

describe("a run's actions", () => {
    it("run in order and pass the command's output along", async () => {
        rule({
            actions: JSON.stringify([
                {
                    type: "command",
                    applicationId: WEB,
                    command: "npm run migrate",
                    timeoutSeconds: 60
                },
                { type: "redeploy", applicationId: WORKER }
            ])
        });
        runInService.mockResolvedValue({
            status: "succeeded",
            error: null,
            reason: null,
            exitCode: 0,
            output: "migrated 3"
        });
        await automations.raiseAutomationEvent({
            projectId: PROJECT,
            event: "deploy.failed",
            applicationId: null
        });
        await settled();
        expect(runInService).toHaveBeenCalledWith(
            expect.objectContaining({ id: WEB }),
            OWNER,
            "npm run migrate",
            60
        );
        expect(deployApplication).toHaveBeenCalledWith(
            WORKER,
            OWNER,
            MAKER,
            expect.objectContaining({ trigger: "automation" })
        );
        const log = automations.readRunLog(runs[0]!.log);
        expect(log.steps.map((step) => step.status)).toEqual(["succeeded", "succeeded"]);
        expect(log.steps[0]?.output).toBe("migrated 3");
    });

    it("stop at the first that fails, and the owner hears about it", async () => {
        rule({
            actions: JSON.stringify([
                {
                    type: "command",
                    applicationId: WEB,
                    command: "npm run migrate",
                    timeoutSeconds: 60
                },
                { type: "restart", applicationId: WEB }
            ])
        });
        runInService.mockResolvedValue({
            status: "failed",
            error: "exit 1",
            reason: "exited",
            exitCode: 1,
            output: "boom"
        });
        await automations.raiseAutomationEvent({
            projectId: PROJECT,
            event: "deploy.failed",
            applicationId: null
        });
        await settled();
        expect(restartApplication).not.toHaveBeenCalled();
        expect(runs[0]?.status).toBe("failed");
        const log = automations.readRunLog(runs[0]!.log);
        expect(log.steps.map((step) => step.status)).toEqual(["failed", "skipped"]);
        expect(notify).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: OWNER,
                event: "deploy.automation.failed",
                body: "automations.reasons.exited"
            })
        );
        expect(log.steps[0]).toMatchObject({ status: "failed", reason: "exited" });
    });

    it("do not run for somebody who may no longer deploy the project", async () => {
        rule();
        hasAccess = false;
        await automations.raiseAutomationEvent({
            projectId: PROJECT,
            event: "deploy.failed",
            applicationId: null
        });
        await settled();
        expect(restartApplication).not.toHaveBeenCalled();
        expect(runs[0]?.status).toBe("failed");
        expect(automations.readRunLog(runs[0]!.log).note).toBe("creator");
    });

    it("say once, not on every firing, that the maker may no longer deploy", async () => {
        const due = rule({
            trigger: "schedule",
            event: null,
            schedule: "* * * * *",
            nextRunAt: new Date()
        });
        hasAccess = false;
        await automations.tickDeployAutomations(new Date());
        await settled();
        expect(notify).toHaveBeenCalledTimes(2);
        due.nextRunAt = new Date();
        await automations.tickDeployAutomations(new Date(Date.now() + 60_000));
        await settled();
        expect(runs).toHaveLength(2);
        expect(runs.every((run) => automations.readRunLog(run.log).note === "creator")).toBe(true);
        expect(notify).toHaveBeenCalledTimes(2);
    });

    it("do not run once the service the rule follows is outside the maker's environments", async () => {
        const one = rule({
            eventApplicationId: WORKER,
            actions: JSON.stringify([{ type: "notify", message: "Worker failed" }])
        });
        environments = { [WORKER]: "env-staging" };
        const access = {
            projectId: PROJECT,
            ownerId: OWNER,
            orgId: null,
            capabilities: ["deploy.run"],
            environmentIds: ["env-production"]
        };
        expect(await automations.accessReaches(access as never, one)).toBe(false);
        expect(
            await automations.accessReaches(
                { ...access, environmentIds: ["env-staging"] } as never,
                one
            )
        ).toBe(true);
    });

    it("do not run a command once the maker loses the console", async () => {
        rule({
            actions: JSON.stringify([
                { type: "command", applicationId: WEB, command: "ls", timeoutSeconds: 60 }
            ])
        });
        capabilities = ["project.read", "deploy.run"];
        await automations.raiseAutomationEvent({
            projectId: PROJECT,
            event: "deploy.failed",
            applicationId: null
        });
        await settled();
        expect(runInService).not.toHaveBeenCalled();
        expect(automations.readRunLog(runs[0]!.log).note).toBe("creator");
    });
});

describe("a webhook address", () => {
    const token = "a".repeat(43);
    const hash = createHash("sha256").update(token).digest("hex");
    const id = "00000000-0000-4000-8000-0000000000b1";

    it("is answered for the right secret only", async () => {
        rule({ id, trigger: "webhook", event: null, webhookTokenHash: hash });
        expect(await automations.automationForWebhook(id, token)).toEqual({ id, enabled: true });
        expect(await automations.automationForWebhook(id, "b".repeat(43))).toBeNull();
        expect(await automations.automationForWebhook(id, "short")).toBeNull();
    });

    it("is not answered against a stored hash of the wrong length, without throwing", async () => {
        rule({ id, trigger: "webhook", event: null, webhookTokenHash: "abcd" });
        expect(await automations.automationForWebhook(id, token)).toBeNull();
    });

    it("is not answered once the rule is no longer a webhook", async () => {
        rule({ id, trigger: "schedule", event: null, webhookTokenHash: hash });
        expect(await automations.automationForWebhook(id, token)).toBeNull();
    });

    it("is refused, and the refusal recorded, once the maker loses access", async () => {
        rule({ id, trigger: "webhook", event: null, webhookTokenHash: hash });
        users[MAKER]!.disabledAt = new Date();
        expect(await automations.fireAutomationWebhook(id)).toEqual({ refused: "creator" });
        expect(runs[0]).toMatchObject({ status: "skipped", trigger: "webhook" });
        expect(restartApplication).not.toHaveBeenCalled();
    });
});

describe("running a rule by hand", () => {
    it("asks of the person pressing Run what the rule does", async () => {
        const one = rule({
            actions: JSON.stringify([
                { type: "command", applicationId: WEB, command: "ls", timeoutSeconds: 60 }
            ])
        });
        const access = {
            projectId: PROJECT,
            ownerId: OWNER,
            orgId: null,
            capabilities: ["deploy.run"],
            environmentIds: null
        };
        await expect(
            automations.runAutomationNow(access as never, one.id, MAKER)
        ).rejects.toMatchObject({
            code: "reach"
        });
        expect(runs).toEqual([]);
    });
});

describe("the actions themselves", () => {
    it("tell the owner and the maker, in the rule's own words", async () => {
        rule({ actions: JSON.stringify([{ type: "notify", message: "The nightly job ran" }]) });
        await automations.raiseAutomationEvent({
            projectId: PROJECT,
            event: "deploy.failed",
            applicationId: null
        });
        await settled();
        const told = notify.mock.calls.map(
            ([call]) => call as { userId: string; body: string; event: string }
        );
        expect(told.map((call) => call.userId).sort()).toEqual([MAKER, OWNER].sort());
        expect(told.every((call) => call.body === "The nightly job ran")).toBe(true);
        expect(told.every((call) => call.event === "deploy.automation.notice")).toBe(true);
        expect(runs[0]?.status).toBe("succeeded");
    });

    it("fail, and say why, on a service that has left the project", async () => {
        rule({ actions: JSON.stringify([{ type: "restart", applicationId: WORKER }]) });
        goneServices.add(WORKER);
        await automations.raiseAutomationEvent({
            projectId: PROJECT,
            event: "deploy.failed",
            applicationId: null
        });
        await settled();
        expect(restartApplication).not.toHaveBeenCalled();
        const [step] = automations.readRunLog(runs[0]!.log).steps;
        expect(step).toMatchObject({ status: "failed", reason: "gone" });
    });

    it("turn a thrown error into a failed step instead of a lost run", async () => {
        rule();
        restartApplication.mockRejectedValue(
            new Error("connect ECONNREFUSED /var/run/polaris.sock")
        );
        const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
        await automations.raiseAutomationEvent({
            projectId: PROJECT,
            event: "deploy.failed",
            applicationId: null
        });
        await settled();
        expect(runs[0]?.status).toBe("failed");
        expect(automations.readRunLog(runs[0]!.log).steps[0]).toMatchObject({
            status: "failed",
            reason: "failed"
        });
        expect(runs[0]!.log).not.toContain("ECONNREFUSED");
        expect(logged).toHaveBeenCalled();
        logged.mockRestore();
    });

    it("keep only the end of a long command's output", async () => {
        rule({
            actions: JSON.stringify([
                { type: "command", applicationId: WEB, command: "ls", timeoutSeconds: 60 }
            ])
        });
        const output = `${"x".repeat(automations.AUTOMATION_OUTPUT_LIMIT)}the reason`;
        runInService.mockResolvedValue({
            status: "succeeded",
            error: null,
            reason: null,
            exitCode: 0,
            output
        });
        await automations.raiseAutomationEvent({
            projectId: PROJECT,
            event: "deploy.failed",
            applicationId: null
        });
        await settled();
        const kept = automations.readRunLog(runs[0]!.log).steps[0]?.output ?? "";
        expect(kept).toHaveLength(automations.AUTOMATION_OUTPUT_LIMIT);
        expect(kept.endsWith("the reason")).toBe(true);
    });

    it("record a rule with nothing left to do as an empty run", async () => {
        rule({ actions: "[]" });
        await automations.raiseAutomationEvent({
            projectId: PROJECT,
            event: "deploy.failed",
            applicationId: null
        });
        await settled();
        expect(runs[0]?.status).toBe("failed");
        expect(automations.readRunLog(runs[0]!.log).note).toBe("empty");
    });
});

describe("a schedule that no longer parses", () => {
    it("is switched off instead of refused every minute", async () => {
        const now = new Date();
        const broken = rule({
            trigger: "schedule",
            event: null,
            schedule: "not a cron",
            nextRunAt: now
        });
        expect(await automations.tickDeployAutomations(now)).toEqual({ started: 0, skipped: 0 });
        expect(broken).toMatchObject({ enabled: false, nextRunAt: null });
        expect(runs).toEqual([]);
    });
});

describe("the webhook firing", () => {
    it("starts a run as the rule's maker", async () => {
        const one = rule({ trigger: "webhook", event: null });
        const fired = await automations.fireAutomationWebhook(one.id);
        expect(fired).toEqual({ runId: "run-1" });
        await settled();
        expect(runs[0]).toMatchObject({ trigger: "webhook", status: "succeeded" });
        expect(restartApplication).toHaveBeenCalledWith(WEB, OWNER);
    });

    it("is refused for a switched-off rule, and records nothing", async () => {
        const one = rule({ trigger: "webhook", event: null, enabled: false });
        expect(await automations.fireAutomationWebhook(one.id)).toEqual({ refused: "disabled" });
        expect(await automations.fireAutomationWebhook("missing")).toEqual({ refused: "disabled" });
        expect(runs).toEqual([]);
    });

    it("is refused while the previous run is still going", async () => {
        const one = rule({ trigger: "webhook", event: null });
        runs.push({
            id: "old",
            automationId: one.id,
            trigger: "webhook",
            status: "running",
            log: "",
            startedAt: new Date(Date.now() - 10_000),
            finishedAt: null
        });
        expect(await automations.fireAutomationWebhook(one.id)).toEqual({ refused: "busy" });
        const skipped = runs.find((run) => run.id !== "old");
        expect(skipped).toMatchObject({ status: "skipped" });
        expect(JSON.parse(skipped!.log)).toMatchObject({ note: "busy" });
    });

    it("ignores a run left marked running by a process that died", async () => {
        const one = rule({ trigger: "webhook", event: null });
        runs.push({
            id: "old",
            automationId: one.id,
            trigger: "webhook",
            status: "running",
            log: "",
            startedAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
            finishedAt: null
        });
        expect(await automations.fireAutomationWebhook(one.id)).toMatchObject({
            runId: expect.any(String)
        });
    });

    it("answers no rule for an id that is not one", async () => {
        expect(await automations.automationForWebhook("../../etc", "a".repeat(43))).toBeNull();
    });
});

describe("a manual run", () => {
    it("acts as the person who pressed Run and does not notify on failure", async () => {
        const one = rule({ actions: JSON.stringify([{ type: "redeploy", applicationId: WEB }]) });
        const presser = "00000000-0000-4000-8000-0000000000c2";
        deployApplication.mockRejectedValue(new Error("Build failed"));
        const access = {
            projectId: PROJECT,
            ownerId: OWNER,
            orgId: null,
            capabilities: ["deploy.run"],
            environmentIds: null
        };
        await automations.runAutomationNow(access as never, one.id, presser);
        await settled();
        expect(deployApplication).toHaveBeenCalledWith(WEB, OWNER, presser, expect.anything());
        expect(runs[0]).toMatchObject({ trigger: "manual", status: "failed" });
        expect(notify).not.toHaveBeenCalled();
        expect(one.lastStatus).toBe("failed");
    });
});

describe("the run history", () => {
    it("reads newest first, with each step", async () => {
        const one = rule();
        const step = { type: "restart", applicationId: WEB, status: "succeeded", reason: null };
        runs.push(
            {
                id: "older",
                automationId: one.id,
                trigger: "schedule",
                status: "succeeded",
                log: JSON.stringify({ note: null, steps: [step] }),
                startedAt: new Date("2026-10-14T03:00:00Z"),
                finishedAt: new Date("2026-10-14T03:00:05Z")
            },
            {
                id: "newer",
                automationId: one.id,
                trigger: "webhook",
                status: "skipped",
                log: JSON.stringify({ note: "creator", steps: [] }),
                startedAt: new Date("2026-10-15T03:00:00Z"),
                finishedAt: new Date("2026-10-15T03:00:00Z")
            }
        );
        const history = await automations.listAutomationRuns(PROJECT, one.id);
        expect(history.map((run) => run.id)).toEqual(["newer", "older"]);
        expect(history[0]).toMatchObject({
            note: "creator",
            steps: [],
            finishedAt: "2026-10-15T03:00:00.000Z"
        });
        expect(history[1]?.steps).toHaveLength(1);
    });

    it("reads a log of an older shape as no steps", () => {
        expect(automations.readRunLog("not json")).toEqual({ note: null, steps: [] });
        expect(automations.readRunLog(JSON.stringify({ note: "other", steps: "x" }))).toEqual({
            note: null,
            steps: []
        });
    });

    it("keeps the newest fifty runs of a rule", async () => {
        const one = rule();
        for (let index = 0; index < 55; index += 1) {
            runs.push({
                id: `past-${index}`,
                automationId: one.id,
                trigger: "event",
                status: "succeeded",
                log: "",
                startedAt: new Date(Date.UTC(2026, 9, 1, 0, index)),
                finishedAt: null
            });
        }
        await automations.raiseAutomationEvent({
            projectId: PROJECT,
            event: "deploy.failed",
            applicationId: null
        });
        await settled();
        expect(runs).toHaveLength(50);
        expect(runs.some((run) => run.id === "past-0")).toBe(false);
        expect(runs.some((run) => !run.id.startsWith("past-"))).toBe(true);
    });
});
