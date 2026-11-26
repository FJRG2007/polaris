import { describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ prisma: {} as Record<string, unknown> }));
const touched = vi.hoisted(() => [] as string[]);
vi.mock("@polaris/db", () => db);
vi.mock("@/lib/agents/session-live", () => ({
    touchSession: (id: string) => touched.push(id),
    subscribeSession: () => () => undefined
}));

import {
    DENIAL_REASON_MAX,
    denialMessage,
    denyPendingFor,
    hookDecision,
    readPermissionRequest,
    settlesPermissions
} from "@/lib/agents/session-permissions";
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

describe("a request denied by a message", () => {
    const messageOf = (answer: unknown) =>
        (hookDecision("deny", "Bash", null, answer) as { hookSpecificOutput: { decision: { message: string } } })
            .hookSpecificOutput.decision.message;

    it("tells the agent the person's own words as the reason", () => {
        expect(denialMessage({ feedback: "  use pnpm instead  " })).toBe(
            "The user declined this and said instead: use pnpm instead"
        );
        expect(messageOf({ feedback: "use pnpm instead" })).toContain("use pnpm instead");
    });

    it("says a new message follows when the words go as one", () => {
        expect(denialMessage({ byMessage: true })).toBe("The user declined this and sent a new message instead.");
        expect(messageOf({ byMessage: true })).toBe("The user declined this and sent a new message instead.");
    });

    it("keeps the plain refusal for a Deny pressed with nothing typed", () => {
        expect(denialMessage(null)).toBe("Denied from Polaris by the session owner.");
        expect(denialMessage({ feedback: "   " })).toBe("Denied from Polaris by the session owner.");
        expect(denialMessage("junk")).toBe("Denied from Polaris by the session owner.");
        expect(messageOf(undefined)).toBe("Denied from Polaris by the session owner.");
    });
});

describe("denyPendingFor", () => {
    type Write = { where: Record<string, unknown>; data: Record<string, unknown> };

    function fakeRequests(counts: { carrying: number; plain: number }) {
        const writes: Write[] = [];
        db.prisma = {
            agentPermissionRequest: {
                updateMany: (write: Write) => {
                    writes.push(write);
                    return { count: write.where.carriesReason ? counts.carrying : counts.plain };
                }
            },
            $transaction: async (ops: unknown[]) => Promise.all(ops)
        };
        touched.length = 0;
        return writes;
    }

    it("gives the words to a request that carries a reason, and tells the rest a message follows", async () => {
        const writes = fakeRequests({ carrying: 1, plain: 2 });
        expect(await denyPendingFor("s1", "u1", "  use pnpm  ")).toEqual({ denied: 3, carried: 1 });
        expect(writes[0]?.where).toEqual({ sessionId: "s1", status: "pending", carriesReason: true });
        expect(writes[0]?.data).toMatchObject({ status: "deny", answeredById: "u1", answer: { feedback: "use pnpm" } });
        expect(writes[1]?.where).toEqual({ sessionId: "s1", status: "pending" });
        expect(writes[1]?.data).toMatchObject({ status: "deny", answer: { byMessage: true } });
        expect(touched).toEqual(["s1"]);
    });

    it("carries nothing when the message has files, so the message itself goes", async () => {
        const writes = fakeRequests({ carrying: 1, plain: 0 });
        expect(await denyPendingFor("s1", "u1", "look at this", { withFiles: true })).toEqual({ denied: 1, carried: 0 });
        expect(writes[0]?.data.answer).toEqual({ byMessage: true });
    });

    it("carries nothing for an empty message", async () => {
        fakeRequests({ carrying: 1, plain: 0 });
        expect(await denyPendingFor("s1", "u1", "   ")).toEqual({ denied: 1, carried: 0 });
    });

    it("clips a long message to what a reason holds", async () => {
        const writes = fakeRequests({ carrying: 1, plain: 0 });
        await denyPendingFor("s1", "u1", "x".repeat(DENIAL_REASON_MAX + 50));
        expect((writes[0]?.data.answer as { feedback: string }).feedback).toHaveLength(DENIAL_REASON_MAX);
    });

    it("changes nothing and wakes nobody when no request is open", async () => {
        fakeRequests({ carrying: 0, plain: 0 });
        expect(await denyPendingFor("s1", "u1", "hi")).toEqual({ denied: 0, carried: 0 });
        expect(touched).toEqual([]);
    });
});

describe("the permission hook", () => {
    it("asks Polaris for a permission prompt, a question or a plan, with a longer timeout", () => {
        const script = hookScript("https://p.example/events", "tok", "https://p.example/permission");
        expect(script).toContain("PermissionRequest");
        expect(script).toContain("'https://p.example/permission'");
        expect(script).toContain("curl -sf -m 125");
        expect(hookScript("https://p.example/events", "tok")).not.toContain("permission'");
        const settings = claudeHookSettings("/s/hook.sh") as {
            hooks: Record<string, { hooks: { timeout: number }[] }[]>;
        };
        expect(settings.hooks.PermissionRequest![0]!.hooks[0]!.timeout).toBe(PERMISSION_HOOK_TIMEOUT_SECONDS);
        // PreToolUse waits on an AskUserQuestion or ExitPlanMode answer.
        expect(settings.hooks.PreToolUse![0]!.hooks[0]!.timeout).toBe(PERMISSION_HOOK_TIMEOUT_SECONDS);
        expect(settings.hooks.PostToolUse![0]!.hooks[0]!.timeout).toBe(5);
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
