import { describe, expect, it } from "vitest";
import * as resources from "../src/resources";
import { driveResource, matchesGlob } from "../src/authz";
import { PERMISSIONS, type Permission } from "../src/permissions";

describe("resource references", () => {
    it("round-trips every kind", () => {
        for (const kind of resources.RESOURCE_KINDS) {
            const ref = resources.resourceRef(kind, "0198c0de-0000-7000-8000-000000000001");
            expect(resources.parseResource(resources.resourceString(ref))).toEqual(ref);
        }
    });

    it("reads nothing it does not recognise", () => {
        // These arrive from a stored row and from an admin-authored policy, so
        // every one of them has to reach nothing rather than something wider.
        for (const raw of ["", ":", "install:", ":abc", "install", "server:abc", "*"]) {
            expect(resources.parseResource(raw)).toBeNull();
        }
    });

    it("keeps the id whole when it carries separators of its own", () => {
        expect(resources.parseResource("drive:cxx:reports/q1")).toEqual({ kind: "drive", id: "cxx:reports/q1" });
    });

    it("agrees with the Drive form that already exists", () => {
        // Drive predates this vocabulary and its rows are already written. The two
        // must produce the same string or every existing ACL silently stops matching.
        expect(resources.resourceString(resources.resourceRef("drive", "cxx:reports/q1"))).toBe(
            driveResource("cxx", "reports/q1")
        );
    });
});

describe("resource patterns", () => {
    it("matches itself and no sibling", () => {
        const [pattern] = resources.resourcePatterns(resources.resourceRef("install", "a"));
        expect(matchesGlob(pattern as string, "install:a")).toBe(true);
        expect(matchesGlob(pattern as string, "install:b")).toBe(false);
    });

    it("covers the whole kind when the grant names every one of them", () => {
        const [pattern] = resources.resourcePatterns(resources.resourceRef("install", resources.EVERY_RESOURCE));
        expect(matchesGlob(pattern as string, "install:anything")).toBe(true);
        expect(matchesGlob(pattern as string, "project:anything")).toBe(false);
    });

    it("still inherits down a Drive subtree", () => {
        const patterns = resources.resourcePatterns(resources.resourceRef("drive", "cxx:reports"));
        expect(patterns.some((pattern) => matchesGlob(pattern, "drive:cxx:reports/q1/sales.csv"))).toBe(true);
        expect(patterns.some((pattern) => matchesGlob(pattern, "drive:cxx:payroll"))).toBe(false);
    });

    it("keeps the two asymmetries the two gates rest on", () => {
        // A hand-authored policy saying "*" genuinely means every resource...
        expect(matchesGlob("*", "install:abc")).toBe(true);
        // ...while a resource-scoped grant never answers the global question, which
        // is what stops one server's grant satisfying requirePermission().
        expect(matchesGlob("install:*", "*")).toBe(false);
        expect(matchesGlob("install:abc", "*")).toBe(false);
    });
});

describe("what may be scoped to what", () => {
    it("only names permissions that exist", () => {
        for (const kind of resources.RESOURCE_KINDS) {
            for (const action of resources.RESOURCE_KIND_META[kind].actions) {
                expect(PERMISSIONS).toContain(action);
            }
        }
    });

    it("refuses a permission that means nothing on the thing", () => {
        expect(resources.grantableOn("install", "games.moderate")).toBe(true);
        expect(resources.grantableOn("install", "users.manage" as Permission)).toBe(false);
        expect(resources.grantableActions("install", ["games.read", "users.manage", "tasks.manage"])).toEqual([
            "games.read"
        ]);
    });

    it("builds every preset out of what its kind allows", () => {
        for (const kind of resources.RESOURCE_KINDS) {
            for (const preset of resources.RESOURCE_PRESETS[kind]) {
                for (const action of preset.actions) expect(resources.grantableOn(kind, action)).toBe(true);
            }
        }
    });
});

describe("preset recognition", () => {
    it("names a stored grant by the preset it was picked from", () => {
        // Stored expanded, so Moderate holds games.read as well as games.moderate.
        expect(resources.presetFor("install", ["games.read", "games.moderate"])?.slug).toBe("moderate");
        expect(resources.presetFor("install", ["games.read"])?.slug).toBe("watch");
    });

    it("says nothing for a set somebody assembled by hand", () => {
        expect(resources.presetFor("install", ["games.read", "deploy.read"])).toBeNull();
        expect(resources.presetFor("install", [])).toBeNull();
    });
});
