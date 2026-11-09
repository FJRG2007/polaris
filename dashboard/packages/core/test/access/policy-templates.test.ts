/**
 * The ready-made policies say what their names promise once they meet a role.
 *
 * A template is added on top of a role and an explicit deny wins, so "Drive
 * user" on a member has to keep the files and lose adding a storage connection -
 * the case the templates were asked for.
 */

import { describe, expect, it } from "vitest";
import * as core from "../../src/index.js";
import type { PolicyStatement } from "../../src/index.js";

function memberWith(key: string): PolicyStatement[] {
    const template = core.POLICY_TEMPLATES.find((entry) => entry.key === key);
    if (!template) throw new Error(`no template ${key}`);
    const role = (core.DEFAULT_ROLES.member ?? []).map((grant) => ({
        effect: "allow" as const,
        actions: [grant],
        resources: ["*"]
    }));
    return [...role, ...template.statements];
}

const can = (statements: PolicyStatement[], action: string) =>
    core.evaluateStatements(statements, action, "*") === "allow";

describe("the ready-made policies", () => {
    it("are one per key, each a valid document of known permissions", () => {
        expect(core.POLICY_TEMPLATES.map((template) => template.key)).toEqual([...core.POLICY_TEMPLATE_KEYS]);
        const known = new Set<string>(core.PERMISSIONS);
        for (const template of core.POLICY_TEMPLATES) {
            expect(core.policyDocumentSchema.safeParse(JSON.parse(core.policyTemplateDocument(template))).success).toBe(true);
            for (const statement of template.statements) {
                for (const action of statement.actions) expect(known.has(action), action).toBe(true);
            }
        }
    });

    it("are found again from the name they are stored under, and nothing else is", () => {
        for (const template of core.POLICY_TEMPLATES) {
            expect(core.policyTemplateOf(core.policyTemplateName(template.key))?.key).toBe(template.key);
        }
        expect(core.policyTemplateOf("drive-user")).toBeNull();
        expect(core.policyTemplateOf("polaris:not-one")).toBeNull();
    });

    it("keep a member's files and take away adding a NAS", () => {
        const statements = memberWith("drive-user");
        expect(can(statements, "drive.read")).toBe(true);
        expect(can(statements, "drive.write")).toBe(true);
        expect(can(statements, "shares.create")).toBe(true);
        expect(can(statements, "connections.manage")).toBe(false);
        // Nothing outside Drive is touched.
        expect(can(statements, "chat.use")).toBe(true);
    });

    it("leave a member with Drive viewer able to read and nothing more", () => {
        const statements = memberWith("drive-viewer");
        expect(can(statements, "drive.read")).toBe(true);
        expect(can(statements, "drive.write")).toBe(false);
        expect(can(statements, "drive.delete")).toBe(false);
        expect(can(statements, "shares.create")).toBe(false);
    });

    it("make a member read-only everywhere, still able to open what they could", () => {
        const statements = memberWith("read-only");
        expect(can(statements, "drive.read")).toBe(true);
        expect(can(statements, "deploy.read")).toBe(true);
        for (const action of ["drive.write", "deploy.manage", "tasks.manage", "connections.manage", "games.manage"]) {
            expect(can(statements, action), action).toBe(false);
        }
    });

    it("give somebody with no role only what the template allows", () => {
        const template = core.POLICY_TEMPLATES.find((entry) => entry.key === "game-moderator");
        const statements = [...(template?.statements ?? [])];
        expect(can(statements, "games.moderate")).toBe(true);
        expect(can(statements, "games.manage")).toBe(false);
        expect(can(statements, "drive.read")).toBe(false);
    });
});
