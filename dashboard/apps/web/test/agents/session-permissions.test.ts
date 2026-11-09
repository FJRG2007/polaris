import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));

import { hookDecision, readPermissionRequest, settlesPermissions } from "@/lib/agents/session-permissions";
import { claudeHookSettings, hookScript, PERMISSION_HOOK_TIMEOUT_SECONDS } from "@/lib/agents/session-hooks";
import { pushBody, vapidSubject } from "@/lib/notifications/web-push";
import { arrivedDeployResults } from "@/lib/desktop-bridge";

const SUGGESTION = {
    type: "addRules",
    rules: [{ toolName: "Bash", ruleContent: "npm test" }],
    behavior: "allow",
    destination: "localSettings"
};

describe("readPermissionRequest", () => {
    it("reads the tool, the command and the suggestions", () => {
        const asked = readPermissionRequest({
            hook_event_name: "PermissionRequest",
            tool_name: "Bash",
            tool_input: { command: "npm test" },
            permission_suggestions: [SUGGESTION, "junk"]
        });
        expect(asked).toEqual({ tool: "Bash", detail: "Bash: npm test", suggestions: [SUGGESTION] });
    });

    it("is null for any other event", () => {
        expect(readPermissionRequest({ hook_event_name: "PreToolUse", tool_name: "Bash" })).toBeNull();
        expect(readPermissionRequest("nonsense")).toBeNull();
    });
});

describe("hookDecision", () => {
    it("says nothing for an unanswered prompt, so the terminal asks", () => {
        expect(hookDecision("pending", "Bash", null)).toEqual({});
        expect(hookDecision("expired", "Bash", null)).toEqual({});
    });

    it("allows and denies in Claude Code's shape", () => {
        expect(hookDecision("allow", "Bash", null)).toEqual({
            hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } }
        });
        const denied = hookDecision("deny", "Bash", null) as {
            hookSpecificOutput: { decision: { behavior: string } };
        };
        expect(denied.hookSpecificOutput.decision.behavior).toBe("deny");
    });

    it("always allows for this session only, never a mode change", () => {
        const always = hookDecision("always", "Bash", [
            SUGGESTION,
            { type: "setMode", mode: "bypassPermissions", destination: "session" }
        ]) as { hookSpecificOutput: { decision: { updatedPermissions: unknown[] } } };
        expect(always.hookSpecificOutput.decision.updatedPermissions).toEqual([
            { ...SUGGESTION, destination: "session" }
        ]);
    });

    it("always allows the whole tool when nothing usable was suggested", () => {
        const always = hookDecision("always", "Edit", []) as {
            hookSpecificOutput: { decision: { updatedPermissions: unknown[] } };
        };
        expect(always.hookSpecificOutput.decision.updatedPermissions).toEqual([
            { type: "addRules", rules: [{ toolName: "Edit" }], behavior: "allow", destination: "session" }
        ]);
    });
});

describe("the permission hook", () => {
    it("asks Polaris only for a permission prompt, with a longer timeout", () => {
        const script = hookScript("https://p.example/events", "tok", "https://p.example/permission");
        expect(script).toContain("PermissionRequest");
        expect(script).toContain("'https://p.example/permission'");
        expect(script).toContain("curl -sf -m 125");
        expect(hookScript("https://p.example/events", "tok")).not.toContain("permission'");
        const settings = claudeHookSettings("/s/hook.sh") as {
            hooks: Record<string, { hooks: { timeout: number }[] }[]>;
        };
        expect(settings.hooks.PermissionRequest![0]!.hooks[0]!.timeout).toBe(PERMISSION_HOOK_TIMEOUT_SECONDS);
        expect(settings.hooks.PreToolUse![0]!.hooks[0]!.timeout).toBe(5);
    });

    it("settles on turn-level events only", () => {
        expect(settlesPermissions("turn.end")).toBe(true);
        expect(settlesPermissions("tool.start")).toBe(false);
        expect(settlesPermissions("permission")).toBe(false);
    });
});

describe("pushBody", () => {
    it("trims to fit a push and keeps three actions", () => {
        const body = JSON.parse(
            pushBody({
                title: "x".repeat(500),
                href: "/apps/agents/sessions/1",
                actions: [
                    { action: "allow", title: "Allow" },
                    { action: "deny", title: "Deny" },
                    { action: "always", title: "Always allow" },
                    { action: "other", title: "Other" }
                ]
            })
        );
        expect(body.title.length).toBe(120);
        expect(body.actions).toHaveLength(3);
    });
});

describe("desktop notices", () => {
    it("include agent sessions that need you or ended", () => {
        const rows = [
            { id: "1", type: "agent.waiting", read: false },
            { id: "2", type: "agent.ended", read: false },
            { id: "3", type: "chat.message", read: false }
        ];
        expect(arrivedDeployResults(new Set(), rows).map((row) => row.id)).toEqual(["1", "2"]);
    });
});

describe("vapidSubject", () => {
    it("is always an https address the push library accepts", () => {
        expect(vapidSubject("https://polaris.example.test/")).toBe("https://polaris.example.test");
        expect(vapidSubject("http://192.168.1.10:3000")).toBe("https://192.168.1.10:3000");
        expect(vapidSubject("not a url")).toBe("https://localhost");
    });
});
