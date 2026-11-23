import { describe, expect, it } from "vitest";
import { dockerfileBuildOptions } from "@polaris/deploy";
import {
    MAX_BUILD_ARGS,
    buildOptionsProblem,
    buildOptionsView,
    normalizeBuildOptions,
    storedBuildOptions
} from "@/lib/deploy/build-options-schema";

describe("build options", () => {
    it("trims names and values and drops empty rows", () => {
        expect(
            normalizeBuildOptions({
                targetStage: " runtime ",
                args: [
                    { key: " NODE_ENV ", value: " production " },
                    { key: "", value: "  " }
                ]
            })
        ).toEqual({ targetStage: "runtime", args: [{ key: "NODE_ENV", value: "production" }] });
    });

    it("names the first problem", () => {
        const ok = { targetStage: "", args: [] };
        expect(buildOptionsProblem(ok)).toBeNull();
        expect(buildOptionsProblem({ ...ok, targetStage: "-x" })).toBe("stage");
        expect(buildOptionsProblem({ ...ok, targetStage: "a b" })).toBe("stage");
        expect(buildOptionsProblem({ ...ok, args: [{ key: "1A", value: "x" }] })).toBe("name");
        expect(buildOptionsProblem({ ...ok, args: [{ key: "", value: "x" }] })).toBe("name");
        expect(buildOptionsProblem({ ...ok, args: [{ key: "A", value: "x\ny" }] })).toBe("value");
        expect(
            buildOptionsProblem({
                ...ok,
                args: [
                    { key: "A", value: "1" },
                    { key: "A", value: "2" }
                ]
            })
        ).toBe("duplicate");
        const many = Array.from({ length: MAX_BUILD_ARGS + 1 }, (_, i) => ({ key: `A${i}`, value: "x" }));
        expect(buildOptionsProblem({ ...ok, args: many })).toBe("count");
    });

    it("reads a stored config, and a broken one as no option", () => {
        expect(storedBuildOptions({})).toEqual({});
        expect(storedBuildOptions({ targetStage: "runtime", buildArgs: { VERSION: "1.2" } })).toEqual({
            targetStage: "runtime",
            buildArgs: { VERSION: "1.2" }
        });
        expect(storedBuildOptions({ targetStage: "bad stage", buildArgs: { VERSION: "1.2" } })).toEqual({});
        expect(buildOptionsView({ buildArgs: ["x"] })).toEqual({ targetStage: "", args: [] });
    });

    it("go to a Dockerfile build only, and no target for a generated Dockerfile", () => {
        const build = { targetStage: "runtime", buildArgs: { A: "1" } };
        expect(dockerfileBuildOptions(build, "docker", false)).toEqual({ target: "runtime", buildArgs: { A: "1" } });
        expect(dockerfileBuildOptions(build, "docker", true)).toEqual({ buildArgs: { A: "1" } });
        expect(dockerfileBuildOptions(build, "nixpacks", false)).toEqual({});
        expect(dockerfileBuildOptions({}, "docker", false)).toEqual({});
    });
});
