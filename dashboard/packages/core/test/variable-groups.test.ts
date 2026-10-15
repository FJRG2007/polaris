import { describe, expect, it } from "vitest";
import {
    flattenLayers,
    groupFitsProject,
    layerVariables,
    normalizeTag,
    parseTags,
    tagsSchema,
    variableGroupInputSchema,
    TAGS_MAX
} from "../src/variable-groups";

describe("layerVariables", () => {
    const groupA = { kind: "group", id: "a", name: "Shared database" } as const;
    const groupB = { kind: "group", id: "b", name: "Payments" } as const;

    it("lets a later layer win: groups, then the environment, then the service", () => {
        const resolved = layerVariables([
            { source: groupA, values: { DATABASE_URL: "group-a", REGION: "eu" } },
            { source: groupB, values: { REGION: "us", API_KEY: null } },
            { source: { kind: "environment" }, values: { LOG_LEVEL: "info", REGION: "env" } },
            { source: { kind: "service" }, values: { LOG_LEVEL: "debug" } }
        ]);
        expect(resolved.map((one) => one.key)).toEqual([
            "API_KEY",
            "DATABASE_URL",
            "LOG_LEVEL",
            "REGION"
        ]);
        const byKey = Object.fromEntries(resolved.map((one) => [one.key, one]));
        expect(byKey.REGION?.value).toBe("env");
        expect(byKey.REGION?.source).toEqual({ kind: "environment" });
        expect(byKey.REGION?.overridden).toEqual([groupA, groupB]);
        expect(byKey.LOG_LEVEL?.source).toEqual({ kind: "service" });
        expect(byKey.DATABASE_URL?.overridden).toEqual([]);
        expect(byKey.API_KEY?.value).toBeNull();
    });

    it("flattens to what the container gets, dropping values it may not read", () => {
        expect(
            flattenLayers([
                { source: groupA, values: { A: "1", B: "group" } },
                { source: { kind: "service" }, values: { B: "service", C: null } }
            ])
        ).toEqual({ A: "1", B: "service" });
    });

    it("answers nothing for no layers", () => {
        expect(layerVariables([])).toEqual([]);
    });
});

describe("tags", () => {
    it("normalizes before it validates", () => {
        expect(normalizeTag("  Front End ")).toBe("front-end");
        expect(normalizeTag("prod!!")).toBe("prod");
        expect(normalizeTag("***")).toBe("");
        expect(tagsSchema.parse(["Prod", "prod", " ", "Team A"])).toEqual(["prod", "team-a"]);
    });

    it("refuses too many and too long", () => {
        const many = Array.from({ length: TAGS_MAX + 1 }, (_, i) => `t${i}`);
        expect(tagsSchema.safeParse(many).success).toBe(false);
        expect(tagsSchema.safeParse(["x".repeat(40)]).success).toBe(false);
    });

    it("reads a stored column defensively", () => {
        expect(parseTags('["Prod","api"]')).toEqual(["prod", "api"]);
        expect(parseTags("not json")).toEqual([]);
        expect(parseTags('{"a":1}')).toEqual([]);
        expect(parseTags(null)).toEqual([]);
    });
});

describe("variableGroupInputSchema", () => {
    it("trims and collapses, and refuses an empty name", () => {
        expect(variableGroupInputSchema.parse({ name: "  Shared   db " })).toEqual({
            name: "Shared db",
            description: ""
        });
        expect(variableGroupInputSchema.safeParse({ name: "   " }).success).toBe(false);
    });
});

describe("groupFitsProject", () => {
    it("keeps a personal group to that person's personal projects", () => {
        const group = { ownerId: "u1", orgId: null };
        expect(groupFitsProject(group, { ownerId: "u1", orgId: null })).toBe(true);
        expect(groupFitsProject(group, { ownerId: "u2", orgId: null })).toBe(false);
        expect(groupFitsProject(group, { ownerId: "u1", orgId: "o1" })).toBe(false);
    });

    it("keeps an organization's group to that organization's projects", () => {
        const group = { ownerId: "u1", orgId: "o1" };
        expect(groupFitsProject(group, { ownerId: "u9", orgId: "o1" })).toBe(true);
        expect(groupFitsProject(group, { ownerId: "u1", orgId: "o2" })).toBe(false);
        expect(groupFitsProject(group, { ownerId: "u1", orgId: null })).toBe(false);
    });
});
