import { describe, expect, it } from "vitest";
import {
    defaultPrivateName,
    normalizePrivateName,
    privateNameProblem,
    privateNameSchema
} from "./private-name.js";

describe("a private name", () => {
    it("is normalized the one way DNS compares names", () => {
        expect(normalizePrivateName("  Api ")).toBe("api");
        expect(privateNameSchema.parse(" DymoAPI ")).toBe("dymoapi");
    });

    it("is one DNS label with a letter in it", () => {
        expect(privateNameProblem("api")).toBeNull();
        expect(privateNameProblem("dymo-api-2")).toBeNull();
        expect(privateNameProblem("")).toBe("empty");
        expect(privateNameProblem("a".repeat(64))).toBe("tooLong");
        expect(privateNameProblem("api.v2")).toBe("characters");
        expect(privateNameProblem("api_v2")).toBe("characters");
        expect(privateNameProblem("-api")).toBe("edges");
        expect(privateNameProblem("api-")).toBe("edges");
        expect(privateNameProblem("1234")).toBe("letter");
        expect(privateNameProblem("localhost")).toBe("reserved");
        expect(privateNameSchema.safeParse("Not Valid").success).toBe(false);
    });

    it("defaults to the slug, made valid when the slug is not", () => {
        expect(defaultPrivateName("api")).toBe("api");
        expect(defaultPrivateName("2024")).toBe("svc-2024");
        expect(defaultPrivateName("localhost")).toBe("svc-localhost");
        expect(privateNameProblem(defaultPrivateName("x".repeat(80)))).toBeNull();
        expect(defaultPrivateName("")).toBe("svc");
    });
});
