/**
 * The root directory is how one repository holds several services. It reaches a shell
 * argument on the target and a header the host daemon reads, so the normalization is
 * the security boundary as much as the convenience: a value that can climb out of the
 * build context is a build that can read the deploy root.
 */

import { describe, expect, it } from "vitest";
import { buildCommand, buildSpec, normalizeRoot, resolveDockerfilePath } from "../src/builders/index.js";

describe("normalizing a root directory", () => {
    it("keeps a plain path as it is", () => {
        expect(normalizeRoot("apps/web")).toBe("apps/web");
    });

    it("strips the separators around it and accepts a Windows-style path", () => {
        expect(normalizeRoot("/apps/web/")).toBe("apps/web");
        expect(normalizeRoot("apps\\web")).toBe("apps/web");
    });

    it("reads the repository root as no root at all", () => {
        expect(normalizeRoot("")).toBeUndefined();
        expect(normalizeRoot(".")).toBeUndefined();
        expect(normalizeRoot(undefined)).toBeUndefined();
    });

    it("refuses a path that climbs out of the context", () => {
        expect(normalizeRoot("../etc")).toBeUndefined();
        expect(normalizeRoot("apps/../../etc")).toBeUndefined();
    });
});

describe("the Dockerfile a rooted service builds", () => {
    it("resolves the path inside the root directory", () => {
        expect(resolveDockerfilePath("apps/web", "Dockerfile")).toBe("apps/web/Dockerfile");
    });

    it("defaults to a Dockerfile in the root when none was stated", () => {
        expect(resolveDockerfilePath("services/api", undefined)).toBe("services/api/Dockerfile");
    });

    it("leaves a path that already carries the root alone", () => {
        // Services configured before there was a root directory store the full path.
        // Setting the root on one of those must not nest it inside itself.
        expect(resolveDockerfilePath("apps/web", "apps/web/Dockerfile")).toBe("apps/web/Dockerfile");
    });

    it("changes nothing for a service with no root directory", () => {
        expect(resolveDockerfilePath(undefined, "apps/web/Dockerfile")).toBe("apps/web/Dockerfile");
        expect(resolveDockerfilePath(undefined, undefined)).toBeUndefined();
    });
});

describe("the auto-detecting builder", () => {
    it("is pointed at the service's own directory inside the context", () => {
        const spec = buildSpec({ method: "nixpacks", name: "web", contextPath: "/ctx", rootDirectory: "apps/web" });

        expect(buildCommand(spec)).toEqual(["nixpacks", "build", "/ctx/apps/web", "--name", "web:latest"]);
    });

    it("builds the context itself when there is no root directory", () => {
        const spec = buildSpec({ method: "nixpacks", name: "web", contextPath: "/ctx" });

        expect(buildCommand(spec)).toEqual(["nixpacks", "build", "/ctx", "--name", "web:latest"]);
    });
});
