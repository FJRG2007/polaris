import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { DEFAULT_ROLES, PERMISSION_META, hasPermission } from "@polaris/core";
import {
    DEFAULT_POLAR_POLICY,
    decidePolarAccess,
    polarGrantsOf,
    polarPolicySchema,
    type AccessFacts
} from "@/lib/polar/access";

vi.mock("@/lib/api-session", () => ({ apiUser: async () => null }));
vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/agents/model-keys", () => ({}));
vi.mock("@polaris/auth", () => ({ resolveGlobalStatements: async () => [] }));
vi.mock("@/lib/polar/access-carry", () => ({ ensurePolarAccessCarried: async () => {} }));

const allow = (action: string) => ({ effect: "allow" as const, actions: [action], resources: ["*"] });
const deny = (action: string) => ({ effect: "deny" as const, actions: [action], resources: ["*"] });

const withRole = (...grants: string[]): AccessFacts => ({
    isAdmin: false,
    grants: polarGrantsOf(grants.map(allow))
});
const member = withRole("polar.use");
const nobody: AccessFacts = { isAdmin: false };
const admin: AccessFacts = { isAdmin: true };

describe("Polar access", () => {
    it("is decided by the permission system alone, and an administrator always has it", () => {
        expect(decidePolarAccess(DEFAULT_POLAR_POLICY, member)).toMatchObject({ use: true, spend: false });
        expect(decidePolarAccess(DEFAULT_POLAR_POLICY, nobody)).toMatchObject({ use: false, spend: false });
        expect(decidePolarAccess(DEFAULT_POLAR_POLICY, admin)).toMatchObject({ use: true, spend: true });
        expect(decidePolarAccess(DEFAULT_POLAR_POLICY, withRole("polar.use", "polar.spend")).spend).toBe(true);
    });

    it("never spends for somebody without Polar itself", () => {
        expect(decidePolarAccess(DEFAULT_POLAR_POLICY, withRole("polar.spend"))).toMatchObject({
            use: false,
            spend: false
        });
        const grants = polarGrantsOf([deny("polar.use"), allow("polar.use"), allow("polar.spend")]);
        expect(decidePolarAccess(DEFAULT_POLAR_POLICY, { isAdmin: false, grants }).spend).toBe(false);
    });

    it("lets a deny anywhere win over an allow", () => {
        const grants = polarGrantsOf([allow("polar.use"), deny("polar.use")]);
        expect(decidePolarAccess(DEFAULT_POLAR_POLICY, { isAdmin: false, grants }).use).toBe(false);
        expect(polarGrantsOf([allow("polar.use"), deny("*")]).use).toBe("deny");
    });

    it("does not let a wildcard allow use Polar or spend the deployment's keys", () => {
        const everything = polarGrantsOf([allow("*")]);
        expect(everything).toEqual({ use: "implicit-deny", spend: "implicit-deny" });
        expect(decidePolarAccess(DEFAULT_POLAR_POLICY, { isAdmin: false, grants: everything }).spend).toBe(
            false
        );
        expect(polarGrantsOf([allow("polar.*")])).toEqual({ use: "allow", spend: "allow" });
        // Something else allowed says nothing about Polar.
        expect(polarGrantsOf([allow("chat.use")]).use).toBe("implicit-deny");
    });

    it("is held by every built-in role but guest, and the keys by none of them", () => {
        for (const [name, grants] of Object.entries(DEFAULT_ROLES)) {
            if (grants.includes("*")) continue;
            expect(hasPermission(grants, "polar.use"), name).toBe(name !== "guest");
            expect(hasPermission(grants, "polar.spend"), name).toBe(false);
        }
        // Listed with no app, so Roles and Capabilities always show both.
        expect(PERMISSION_META["polar.use"].app).toBeUndefined();
        expect(PERMISSION_META["polar.spend"].app).toBeUndefined();
    });

    it("keeps no audience of its own in the stored options", () => {
        const parsed = polarPolicySchema.parse({
            use: { who: "admins" },
            spend: { who: "everyone" },
            web: false
        });
        expect(Object.keys(parsed).sort()).toEqual([
            "connectors",
            "freeModels",
            "web",
            "zenStandInEveryone"
        ]);
        expect(parsed.web).toBe(false);
    });

    it("lets Polar on the web by default, and not once an administrator turns it off", () => {
        expect(decidePolarAccess(DEFAULT_POLAR_POLICY, member).web).toBe(true);
        const saved = polarPolicySchema.parse({});
        expect(saved.web).toBe(true);
        expect(decidePolarAccess({ ...saved, web: false }, member).web).toBe(false);
        expect(decidePolarAccess({ ...saved, web: false }, admin).web).toBe(false);
        // Nobody barred from Polar reaches its web tools.
        expect(decidePolarAccess(DEFAULT_POLAR_POLICY, nobody).web).toBe(false);
    });

    it("opens connectors to everybody who uses Polar until an administrator narrows them", () => {
        expect(decidePolarAccess(DEFAULT_POLAR_POLICY, member).connectors).toBe(true);
        const saved = polarPolicySchema.parse({});
        expect(saved.connectors).toEqual({ who: "everyone", hosts: [], privateNetwork: false });
        const admins = { ...saved, connectors: { ...saved.connectors, who: "admins" as const } };
        expect(decidePolarAccess(admins, member).connectors).toBe(false);
        expect(decidePolarAccess(admins, admin).connectors).toBe(true);
        const off = { ...saved, connectors: { ...saved.connectors, who: "off" as const } };
        expect(decidePolarAccess(off, admin).connectors).toBe(false);
    });

    it("is asked by every Polar route instead of the plain session check", () => {
        const root = resolve(__dirname, "../../src/app/api/polar");
        const routes: string[] = [];
        const walk = (dir: string) => {
            for (const name of readdirSync(dir)) {
                const path = join(dir, name);
                if (statSync(path).isDirectory()) walk(path);
                else if (name === "route.ts") routes.push(path);
            }
        };
        walk(root);
        expect(routes.length).toBeGreaterThan(10);
        for (const path of routes) {
            const source = readFileSync(path, "utf8");
            // A stream a tab holds open reads the caller without counting as
            // activity (`backgroundUser`), and asks the Polar policy itself.
            const background = source.includes("backgroundUser()") && source.includes("polarAccessFor(");
            if (!background) expect(source, path).toContain("polarCaller()");
            expect(source, path).not.toMatch(/\bapiUser\(/);
        }
    });

    it("has no audience card or editor left on any screen", () => {
        const roles = resolve(__dirname, "../../src/app/(app)/admin/roles");
        expect(readdirSync(roles)).not.toContain("polar-audience-card.tsx");
        expect(readdirSync(roles)).not.toContain("polar-actions.ts");
        for (const locale of ["en-US", "es-ES"]) {
            const admin = JSON.parse(
                readFileSync(resolve(__dirname, `../../messages/${locale}/admin.json`), "utf8")
            );
            expect(admin.roles.polarDefault, locale).toBeUndefined();
            expect(admin.agents.polarAccess.use, locale).toBeUndefined();
            expect(admin.agents.polarAccess.spend, locale).toBeUndefined();
        }
    });
});
