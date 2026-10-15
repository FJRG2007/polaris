/**
 * A deploy project's automations: what a rule may be saved as, how a stored
 * action list reads back, and which events reach which rules.
 */

import * as core from "../src/index.js";
import { describe, expect, it } from "vitest";

const PROJECT = "0190a8a0-0000-7000-8000-000000000001";
const SERVICE = "0190a8a0-0000-7000-8000-000000000002";
const OTHER = "0190a8a0-0000-7000-8000-000000000003";

function rule(overrides: Record<string, unknown>) {
    return core.deployAutomationInputSchema.safeParse({
        projectId: PROJECT,
        name: "Nightly restart",
        trigger: "schedule",
        schedule: "0 3 * * *",
        timezone: "Europe/Madrid",
        actions: [{ type: "restart", applicationId: SERVICE }],
        ...overrides
    });
}

describe("deployAutomationInputSchema", () => {
    it("takes a schedule with a time zone", () => {
        const parsed = rule({});
        expect(parsed.success).toBe(true);
    });

    it("refuses a schedule that does not parse", () => {
        const parsed = rule({ schedule: "every night" });
        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues[0]?.path).toEqual(["schedule"]);
    });

    it("refuses a time zone the server does not know", () => {
        expect(rule({ timezone: "Mars/Olympus" }).success).toBe(false);
    });

    it("asks an event rule for its event", () => {
        const parsed = rule({ trigger: "event", schedule: undefined });
        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues[0]?.path).toEqual(["event"]);
    });

    it("lets a deploy event follow one service, but not a domain event", () => {
        expect(rule({ trigger: "event", event: "deploy.failed", eventApplicationId: SERVICE }).success).toBe(true);
        const domain = rule({ trigger: "event", event: "domain.down", eventApplicationId: SERVICE });
        expect(domain.success).toBe(false);
        expect(domain.error?.issues[0]?.path).toEqual(["eventApplicationId"]);
    });

    it("takes a webhook rule with nothing more", () => {
        expect(rule({ trigger: "webhook", schedule: undefined }).success).toBe(true);
    });

    it("needs at least one action and caps how many", () => {
        expect(rule({ actions: [] }).success).toBe(false);
        const many = Array.from({ length: core.DEPLOY_AUTOMATION_ACTION_LIMIT + 1 }, () => ({
            type: "restart",
            applicationId: SERVICE
        }));
        expect(rule({ actions: many }).success).toBe(false);
    });

    it("bounds a command's time and refuses a NUL in it", () => {
        const ok = rule({ actions: [{ type: "command", applicationId: SERVICE, command: "npm run migrate" }] });
        expect(ok.success).toBe(true);
        expect(ok.data?.actions[0]).toMatchObject({ timeoutSeconds: 300 });
        expect(
            rule({
                actions: [{ type: "command", applicationId: SERVICE, command: "ls", timeoutSeconds: 5 }]
            }).success
        ).toBe(false);
        expect(
            rule({
                actions: [{ type: "command", applicationId: SERVICE, command: `ls${String.fromCharCode(0)}` }]
            }).success
        ).toBe(false);
    });
});

describe("readAutomationActions", () => {
    it("keeps the actions that still read and drops the rest", () => {
        const stored = JSON.stringify([
            { type: "redeploy", applicationId: SERVICE },
            { type: "teleport", applicationId: SERVICE },
            { type: "notify", message: "Done" }
        ]);
        expect(core.readAutomationActions(stored)).toEqual([
            { type: "redeploy", applicationId: SERVICE },
            { type: "notify", message: "Done" }
        ]);
    });

    it("reads anything that is not a list as no actions", () => {
        expect(core.readAutomationActions("not json")).toEqual([]);
        expect(core.readAutomationActions("{}")).toEqual([]);
    });
});

describe("automationHears", () => {
    const now = new Date("2026-10-15T12:00:00Z");
    const base = {
        enabled: true,
        trigger: "event",
        event: "deploy.failed",
        eventApplicationId: null,
        lastRunAt: null
    };

    it("hears its own event from any service when it names none", () => {
        expect(core.automationHears(base, { event: "deploy.failed", applicationId: SERVICE }, now)).toBe(true);
        expect(core.automationHears(base, { event: "deploy.succeeded", applicationId: SERVICE }, now)).toBe(false);
    });

    it("hears only the service it names", () => {
        const one = { ...base, eventApplicationId: SERVICE };
        expect(core.automationHears(one, { event: "deploy.failed", applicationId: SERVICE }, now)).toBe(true);
        expect(core.automationHears(one, { event: "deploy.failed", applicationId: OTHER }, now)).toBe(false);
    });

    it("waits out the cool-off after its last run", () => {
        const recent = { ...base, lastRunAt: new Date(now.getTime() - 60_000) };
        const old = {
            ...base,
            lastRunAt: new Date(now.getTime() - core.DEPLOY_AUTOMATION_EVENT_COOLDOWN_MS - 1)
        };
        expect(core.automationHears(recent, { event: "deploy.failed", applicationId: null }, now)).toBe(false);
        expect(core.automationHears(old, { event: "deploy.failed", applicationId: null }, now)).toBe(true);
    });

    it("never hears anything when switched off or not an event rule", () => {
        const event = { event: "deploy.failed", applicationId: null };
        expect(core.automationHears({ ...base, enabled: false }, event, now)).toBe(false);
        expect(core.automationHears({ ...base, trigger: "schedule" }, event, now)).toBe(false);
    });
});
