/**
 * How a session's agent asks before it acts: a mode picked for Claude Code is
 * its own launch flag, which outranks the account's bypass setting; no mode, or
 * a tool whose questions Polaris cannot answer, leaves the old rule in charge;
 * and the start form only takes the modes there are.
 */

import { describe, expect, it } from "vitest";
import {
    permissionModeArgs,
    sessionPermissionMode,
    startAgentSessionSchema,
    takesPermissionMode
} from "../src/index.js";

describe("a session's permission mode", () => {
    it("is Claude Code's own flag for each mode", () => {
        expect(permissionModeArgs("claude", "ask")).toEqual(["--permission-mode", "default"]);
        expect(permissionModeArgs("claude", "edits")).toEqual(["--permission-mode", "acceptEdits"]);
        expect(permissionModeArgs("claude", "plan")).toEqual(["--permission-mode", "plan"]);
        expect(permissionModeArgs("claude", "full")).toEqual([
            "--permission-mode",
            "bypassPermissions"
        ]);
    });

    it("leaves the place and Enigma to decide without a mode, or for another tool", () => {
        expect(permissionModeArgs("claude", null)).toBeNull();
        expect(permissionModeArgs("codex", "ask")).toBeNull();
        expect(takesPermissionMode("claude")).toBe(true);
        expect(takesPermissionMode("codex")).toBe(false);
    });

    it("reads back only a mode this version knows", () => {
        expect(sessionPermissionMode("plan")).toBe("plan");
        expect(sessionPermissionMode("yolo")).toBeNull();
        expect(sessionPermissionMode(null)).toBeNull();
    });

    it("is taken by the start form, and nothing else is", () => {
        const base = { repoId: null, title: "Fix it", cli: "claude", place: "local" };
        expect(startAgentSessionSchema.parse(base).permissionMode).toBeNull();
        expect(
            startAgentSessionSchema.parse({ ...base, permissionMode: "edits" }).permissionMode
        ).toBe("edits");
        expect(startAgentSessionSchema.safeParse({ ...base, permissionMode: "yolo" }).success).toBe(
            false
        );
    });
});
