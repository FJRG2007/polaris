/**
 * The capability vocabulary a project's access is written in.
 *
 * Pure, and the same module the checkbox grid and the server both read - so the
 * cases here are the ones where the two could disagree: what a role expands to,
 * what a half-picked set completes to, and what an unreadable stored value means.
 */

import { describe, expect, it } from "vitest";
import {
    expandProjectCapabilities,
    parseEnvironmentScope,
    parseProjectCapabilities,
    projectRoleFor,
    resolveProjectCapabilities,
    PROJECT_CAPABILITIES,
    PROJECT_CAPABILITY_AREAS,
    PROJECT_CAPABILITY_META,
    PROJECT_ROLE_CAPABILITIES
} from "@polaris/core";

describe("expandProjectCapabilities", () => {
    it("carries what a capability cannot sensibly be held without", () => {
        expect(expandProjectCapabilities(["variables.write"])).toEqual([
            "project.read",
            "variables.read",
            "variables.write"
        ]);
    });

    it("answers in catalogue order however the set was picked", () => {
        expect(expandProjectCapabilities(["files.write", "deploy.run"])).toEqual(
            expandProjectCapabilities(["deploy.run", "files.write"])
        );
    });
});

describe("the roles", () => {
    it("give a developer the variables, and a viewer none of them", () => {
        expect(PROJECT_ROLE_CAPABILITIES.developer).toContain("variables.write");
        expect(PROJECT_ROLE_CAPABILITIES.viewer).not.toContain("variables.read");
    });

    it("keep deleting a service and handing out access to the admin", () => {
        expect(PROJECT_ROLE_CAPABILITIES.developer).not.toContain("service.delete");
        expect(PROJECT_ROLE_CAPABILITIES.developer).not.toContain("members.manage");
        expect(PROJECT_ROLE_CAPABILITIES.admin).toContain("service.delete");
        expect(PROJECT_ROLE_CAPABILITIES.admin).toContain("members.manage");
    });

    it("are recognised back from the set they produce", () => {
        expect(projectRoleFor(expandProjectCapabilities(PROJECT_ROLE_CAPABILITIES.viewer))).toBe("viewer");
        expect(projectRoleFor(expandProjectCapabilities(PROJECT_ROLE_CAPABILITIES.developer))).toBe("developer");
        expect(projectRoleFor(expandProjectCapabilities(PROJECT_ROLE_CAPABILITIES.admin))).toBe("admin");
    });

    it("are not claimed for a set nobody picked from one", () => {
        expect(projectRoleFor(["project.read", "logs.read", "console.use"])).toBeNull();
    });
});

describe("resolveProjectCapabilities", () => {
    it("takes the explicit set when there is one", () => {
        expect(resolveProjectCapabilities({ role: "admin", capabilities: ["logs.read"] })).toEqual([
            "project.read",
            "logs.read"
        ]);
    });

    it("falls back to the role, expanded", () => {
        expect(resolveProjectCapabilities({ role: "viewer" })).toEqual(["project.read", "logs.read"]);
    });
});

describe("reading stored values", () => {
    it("drops a key this version does not know rather than the whole row", () => {
        expect(parseProjectCapabilities('["project.read","invented.key"]')).toEqual(["project.read"]);
    });

    it("reads an unparseable set as nothing, never as everything", () => {
        expect(parseProjectCapabilities("{oops")).toEqual([]);
        expect(parseProjectCapabilities(null)).toEqual([]);
    });

    it("reads no environment restriction as every environment", () => {
        expect(parseEnvironmentScope(null)).toBeNull();
        expect(parseEnvironmentScope('["env-1"]')).toEqual(["env-1"]);
    });

    it("reads an unparseable restriction as no environment at all", () => {
        // The safe direction is the narrow one: a row nobody can read must not
        // widen to every environment in the project.
        expect(parseEnvironmentScope("{oops")).toEqual([]);
    });
});

describe("the catalogue", () => {
    it("puts every capability in an area the editor renders", () => {
        for (const capability of PROJECT_CAPABILITIES) {
            expect(PROJECT_CAPABILITY_AREAS).toContain(PROJECT_CAPABILITY_META[capability].area);
        }
    });
});
