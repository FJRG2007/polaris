/**
 * The Alerts screen's server actions: input checked by the shared schema,
 * changes allowed to whoever may change the project, and a rule never naming
 * somebody who could not open the issue it would link them to.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const PROJECT = "0192f0aa-0000-7000-8000-0000000000d1";
const RULE = "0192f0aa-0000-7000-8000-0000000000b1";
const PERSON = "0192f0aa-0000-7000-8000-0000000000a1";
const CALLER = "0192f0aa-0000-7000-8000-0000000000c1";

const state = vi.hoisted(() => ({ manages: true, granted: new Map<string, string>(), mayRead: true }));

const alerts = vi.hoisted(() => ({
    listRules: vi.fn(async () => []),
    listFires: vi.fn(async () => ({ items: [], next: null })),
    saveRule: vi.fn(async () => true),
    setRuleEnabled: vi.fn(async () => true),
    deleteRule: vi.fn(async () => true),
    AlertLimitError: class AlertLimitError extends Error {}
}));

vi.mock("@/lib/telemetry/alerts", () => alerts);
vi.mock("@/lib/telemetry/workflow-service", () => ({ mayRead: vi.fn(async () => state.mayRead) }));
vi.mock("@/lib/tasks/task-service", () => ({ createTask: vi.fn() }));
vi.mock("@/lib/tasks/access", () => ({ requireList: vi.fn(), TaskAccessError: class TaskAccessError extends Error {} }));
vi.mock("@/lib/telemetry/project-service", () => ({
    TelemetryAccessError: class TelemetryAccessError extends Error {
        constructor(message = "You do not have access to that project") {
            super(message);
        }
    },
    requireProject: vi.fn(async (_actor: unknown, id: string) => ({ id })),
    listProjects: vi.fn(async () => []),
    dsnFor: vi.fn(() => "dsn")
}));
vi.mock("@/lib/access/grants", () => ({
    grantedSubjects: vi.fn(async () => new Map(state.granted)),
    dropGrantsFor: vi.fn()
}));
vi.mock("@/lib/session", () => ({
    requireUser: vi.fn(async () => ({ id: CALLER, isAdmin: false, name: "Caller" })),
    sessionCan: vi.fn(async () => state.manages),
    requirePermission: vi.fn(async () => ({ id: CALLER, isAdmin: false }))
}));
vi.mock("@/lib/telemetry/report-service", () => ({ TELEMETRY_WINDOW_DAYS: 30 }));
vi.mock("@/lib/people-search", () => ({ findPeople: vi.fn(async () => ({ people: [] })) }));
vi.mock("@/lib/domain-service", () => ({ appBaseUrl: vi.fn(async () => "https://polaris.example.test") }));
vi.mock("@/lib/workspace-scope", () => ({ scopeOrgIdFor: vi.fn(async () => null) }));
vi.mock("@polaris/deploy", () => ({ slugify: (value: string) => value }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));

const actions = await import("@/app/(app)/telemetry/actions");

const RULE_INPUT = {
    name: "Checkout",
    trigger: "new",
    levels: [],
    environment: "",
    recipients: [PERSON],
    notifyMembers: false,
    throttleMinutes: 60
};

beforeEach(() => {
    vi.clearAllMocks();
    state.manages = true;
    state.granted = new Map();
    state.mayRead = true;
});

describe("alert rule actions", () => {
    it("saves a valid rule as the caller", async () => {
        expect(await actions.saveAlertRuleAction({ projectId: PROJECT, rule: RULE_INPUT })).toEqual({});
        expect(alerts.saveRule).toHaveBeenCalledWith(
            PROJECT,
            undefined,
            expect.objectContaining({ name: "Checkout", environment: null, recipients: [PERSON] }),
            CALLER
        );
    });

    it("says which field is wrong", async () => {
        expect(
            await actions.saveAlertRuleAction({
                projectId: PROJECT,
                rule: { ...RULE_INPUT, trigger: "frequency", threshold: 0, windowMinutes: 5 }
            })
        ).toEqual({ error: "alerts.errors.threshold" });
        expect(
            await actions.saveAlertRuleAction({ projectId: PROJECT, rule: { ...RULE_INPUT, recipients: [] } })
        ).toEqual({ error: "alerts.errors.nobody" });
        expect(await actions.saveAlertRuleAction({ projectId: "nope", rule: RULE_INPUT })).toEqual({
            error: "alerts.errors.invalid"
        });
        expect(alerts.saveRule).not.toHaveBeenCalled();
    });

    it("never names somebody who could not open the project", async () => {
        state.mayRead = false;
        expect(await actions.saveAlertRuleAction({ projectId: PROJECT, rule: RULE_INPUT })).toEqual({
            error: "alerts.errors.recipientCannotSee"
        });
        expect(alerts.saveRule).not.toHaveBeenCalled();
    });

    it("refuses a reader the project was only shared with to view", async () => {
        state.manages = false;
        state.granted = new Map([[PROJECT, "view"]]);
        expect(await actions.saveAlertRuleAction({ projectId: PROJECT, rule: RULE_INPUT })).toEqual({
            error: "errors.noAccess"
        });
        expect(await actions.alertRulesAction({ projectId: PROJECT })).toEqual({ error: "errors.noAccess" });
        expect(await actions.deleteAlertRuleAction({ projectId: PROJECT, ruleId: RULE })).toEqual({
            error: "errors.noAccess"
        });
    });

    it("lets somebody it was shared with to edit change its rules", async () => {
        state.manages = false;
        state.granted = new Map([[PROJECT, "edit"]]);
        expect(
            await actions.setAlertRuleEnabledAction({ projectId: PROJECT, ruleId: RULE, enabled: false })
        ).toEqual({});
        expect(alerts.setRuleEnabled).toHaveBeenCalledWith(PROJECT, RULE, false);
    });

    it("says so when the rule is gone or the project is full", async () => {
        alerts.setRuleEnabled.mockResolvedValueOnce(false);
        expect(
            await actions.setAlertRuleEnabledAction({ projectId: PROJECT, ruleId: RULE, enabled: true })
        ).toEqual({ error: "alerts.errors.gone" });
        alerts.saveRule.mockRejectedValueOnce(new alerts.AlertLimitError());
        expect(await actions.saveAlertRuleAction({ projectId: PROJECT, rule: RULE_INPUT })).toEqual({
            error: "alerts.errors.limit"
        });
    });

    it("pages the history", async () => {
        expect(await actions.alertHistoryAction({ projectId: PROJECT, cursor: null })).toEqual({
            data: { items: [], next: null }
        });
        expect(alerts.listFires).toHaveBeenCalledWith(PROJECT, null);
    });
});
