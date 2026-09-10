/**
 * The pure pieces around a push and a connection: the API key's shape, the
 * docker arguments, how a finished deployment is announced, and the sentences a
 * failed load or health probe is explained with.
 */

import { describe, expect, it } from "vitest";
import { apiKeySchema } from "@/shared/api-key";
import { buildArgs, dockerEnv } from "@/main/docker";
import { deployOutcome, firstLine } from "@/main/deploy-outcome";
import { classifyHealth, describeNetError, describeProbe, netErrorCode } from "@/main/reachability";

describe("apiKeySchema", () => {
    it("takes a whole key, trimmed", () => {
        expect(apiKeySchema.parse("  plk_Ab3-_x9Z.s3cr3t-Value_  ")).toBe("plk_Ab3-_x9Z.s3cr3t-Value_");
    });

    it("refuses an empty field, a half-copied key, and something else entirely", () => {
        expect(apiKeySchema.safeParse("").success).toBe(false);
        expect(apiKeySchema.safeParse("plk_Ab3-_x9Z").success).toBe(false);
        expect(apiKeySchema.safeParse("plk_short.secret").success).toBe(false);
        expect(apiKeySchema.safeParse("ghp_0123456789abcdef").success).toBe(false);
        expect(apiKeySchema.safeParse("plk_Ab3-_x9Z.secret with space").success).toBe(false);
    });
});

describe("buildArgs", () => {
    it("builds like the CLI, with the platform only when one was chosen", () => {
        expect(buildArgs("reg/app:abc", "/work/app", "")).toEqual(["build", "-t", "reg/app:abc", "/work/app"]);
        expect(buildArgs("reg/app:abc", "C:\\work\\my app", "linux/amd64")).toEqual([
            "build",
            "-t",
            "reg/app:abc",
            "--platform",
            "linux/amd64",
            "C:\\work\\my app"
        ]);
    });
});

describe("dockerEnv", () => {
    it("adds Docker's usual places after PATH on macOS, once", () => {
        const env = dockerEnv({ PATH: "/usr/bin:/bin:/usr/local/bin" }, "darwin");
        const parts = (env.PATH ?? "").split(":");
        expect(parts.slice(0, 3)).toEqual(["/usr/bin", "/bin", "/usr/local/bin"]);
        expect(parts).toContain("/opt/homebrew/bin");
        expect(parts.filter((part) => part === "/usr/local/bin")).toHaveLength(1);
    });

    it("leaves Windows alone", () => {
        const base = { PATH: "C:\\Windows" };
        expect(dockerEnv(base, "win32")).toBe(base);
    });
});

describe("deployOutcome", () => {
    it("reads running and success as serving, anything else as a failure with its first line", () => {
        expect(deployOutcome("shop / api", "running", null)).toEqual({
            ok: true,
            title: "Deployed shop / api",
            body: "shop / api is serving the new release."
        });
        expect(deployOutcome("api", "success", null).ok).toBe(true);
        expect(deployOutcome("api", "failed", "\n  Error: port 3000 in use\nat x")).toEqual({
            ok: false,
            title: "Deploy failed: api",
            body: "Error: port 3000 in use"
        });
        expect(deployOutcome("api", "cancelled", null).ok).toBe(false);
    });

    it("says something when no reason was given, and keeps a long one short", () => {
        expect(firstLine(null)).toMatch(/No reason was reported/);
        expect(firstLine("x".repeat(400))).toHaveLength(300);
    });
});

describe("reachability", () => {
    it("finds Chromium's code in a message", () => {
        expect(netErrorCode("net::ERR_NAME_NOT_RESOLVED")).toBe("ERR_NAME_NOT_RESOLVED");
        expect(netErrorCode("TypeError: Failed to fetch")).toBeNull();
    });

    it("explains the common failures in terms of what to do", () => {
        expect(describeNetError("ERR_NAME_NOT_RESOLVED", "polaris.example.com")).toMatch(/typo/);
        expect(describeNetError("ERR_CONNECTION_REFUSED", "polaris.example.com")).toMatch(/Nothing is answering/);
        expect(describeNetError("ERR_CERT_AUTHORITY_INVALID", "polaris.example.com")).toMatch(/not trusted/);
        expect(describeNetError("ERR_INTERNET_DISCONNECTED", "polaris.example.com")).toMatch(/not connected/);
        expect(describeNetError("ERR_SOMETHING_NEW", "polaris.example.com")).toBe(
            "Could not reach polaris.example.com (ERR_SOMETHING_NEW)."
        );
        expect(describeNetError(null, "polaris.example.com")).toBe("Could not reach polaris.example.com.");
    });

    it("recognises Polaris by its health probe", () => {
        expect(classifyHealth(200, { status: "ok" })).toEqual({ ok: true });
        expect(classifyHealth(503, { status: "error", database: false })).toEqual({ ok: false, reason: "not-ready" });
        expect(classifyHealth(200, "<html>")).toEqual({ ok: false, reason: "not-polaris" });
        expect(classifyHealth(404, { error: "Not found" })).toEqual({ ok: false, reason: "not-polaris" });
        expect(describeProbe({ ok: false, reason: "not-polaris" }, "example.com")).toBe(
            "Something answered at example.com, but it is not Polaris."
        );
        expect(describeProbe({ ok: true }, "example.com")).toBeNull();
    });
});
