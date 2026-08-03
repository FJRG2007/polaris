/**
 * What a runner secret may be called and may hold.
 *
 * Both rules exist because of where these end up rather than for tidiness. A name
 * becomes an environment variable and is written into a file the runner reads one
 * line at a time, so a name that is not an identifier either vanishes or corrupts
 * the line it is on. And a name the runner sets for itself must not be
 * replaceable: GITHUB_REPOSITORY is what the guard reads to decide whether the
 * job may run at all, and ACTIONS_RUNNER_HOOK_JOB_STARTED is the guard.
 */

import { describe, expect, it } from "vitest";
import { secretKeyRefusal, secretValueRefusal } from "@polaris/core";

describe("secretKeyRefusal", () => {
    it("accepts a name that is a shell identifier", () => {
        expect(secretKeyRefusal("REGISTRY_TOKEN")).toBeNull();
        expect(secretKeyRefusal("_private2")).toBeNull();
    });

    it("refuses a name that would not survive being exported", () => {
        expect(secretKeyRefusal("")).toBeTruthy();
        expect(secretKeyRefusal("2FA_CODE")).toBeTruthy();
        expect(secretKeyRefusal("my-token")).toBeTruthy();
        expect(secretKeyRefusal("PATH=x")).toBeTruthy();
        expect(secretKeyRefusal("A B")).toBeTruthy();
    });

    it("refuses to let a secret impersonate what the runner tells the guard", () => {
        expect(secretKeyRefusal("GITHUB_REPOSITORY")).toBeTruthy();
        expect(secretKeyRefusal("GITHUB_EVENT_NAME")).toBeTruthy();
        expect(secretKeyRefusal("ACTIONS_RUNNER_HOOK_JOB_STARTED")).toBeTruthy();
        expect(secretKeyRefusal("RUNNER_TEMP")).toBeTruthy();
        // Case is not a way around it.
        expect(secretKeyRefusal("github_token")).toBeTruthy();
    });
});

describe("secretValueRefusal", () => {
    it("accepts an ordinary one-line value", () => {
        expect(secretValueRefusal("ghp_abc123")).toBeNull();
        expect(secretValueRefusal("a value with spaces and = signs")).toBeNull();
    });

    it("refuses a value that would break the line it is written on", () => {
        expect(secretValueRefusal("-----BEGIN KEY-----\nabc\n-----END KEY-----")).toBeTruthy();
        expect(secretValueRefusal("one\rtwo")).toBeTruthy();
    });

    it("says what to do instead rather than only refusing", () => {
        expect(secretValueRefusal("a\nb")).toContain("base64");
    });

    it("refuses an empty value and an absurd one", () => {
        expect(secretValueRefusal("")).toBeTruthy();
        expect(secretValueRefusal("x".repeat(8001))).toBeTruthy();
    });
});
