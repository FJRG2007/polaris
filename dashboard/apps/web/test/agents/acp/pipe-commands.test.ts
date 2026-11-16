import { describe, expect, it } from "vitest";
import {
    ACP_LAUNCH_SCRIPT,
    ACP_READ_BYTES,
    ACP_WINDOW,
    ACP_WRITE_BYTES,
    acpLaunchCommand,
    acpReadCommand,
    acpWriteCommand,
    conversationHandBackCommand,
    HAND_BACK_INTERACTIVE,
    parseAcpRead,
    terminalAgentStopCommand
} from "@/lib/agents/acp/pipe-commands";
import { CAPTURE_BYTES, INTERFACE_WINDOW, RUNNER_READY_FILE, RUNNER_WINDOW } from "@/lib/agents/session-commands";

const STATE = "/session/polaris";

function decoded(command: string, file: string): string {
    const match = new RegExp(`printf %s ([A-Za-z0-9+/=]+) \\| base64 -d > "\\$a/${file}"`).exec(command);
    expect(match).not.toBeNull();
    return Buffer.from(match![1]!, "base64").toString("utf8");
}

describe("acpLaunchCommand", () => {
    it("writes the launch script and the quoted argv, then opens the window", () => {
        const command = acpLaunchCommand(STATE, ["npx", "it's", "--flag=$HOME"]);
        expect(decoded(command, "launch.sh")).toBe(ACP_LAUNCH_SCRIPT);
        expect(decoded(command, "argv")).toBe("'npx' 'it'\\''s' '--flag=$HOME'");
        expect(command).toContain(`-n ${ACP_WINDOW}`);
        // The old generation goes before the window is replaced.
        expect(command.indexOf('rm -f "$a/generation"')).toBeLessThan(command.indexOf("tmux kill-window"));
    });

    it("refuses an empty, unprintable or overlong launch line", () => {
        expect(() => acpLaunchCommand(STATE, [])).toThrow();
        expect(() => acpLaunchCommand(STATE, ["agent", "a\nb"])).toThrow();
        expect(() => acpLaunchCommand(STATE, ["agent", ""])).toThrow();
        expect(() => acpLaunchCommand(STATE, ["x".repeat(5000)])).toThrow();
        expect(() => acpLaunchCommand(STATE, Array.from({ length: 65 }, () => "a"))).toThrow();
    });

    it("drops root and clears what the setup cleared, as the interface window does", () => {
        expect(ACP_LAUNCH_SCRIPT).toContain('su -p "$POLARIS_RUNAS"');
        expect(ACP_LAUNCH_SCRIPT).toContain("unset GIT_AUTH_HEADER");
        expect(ACP_LAUNCH_SCRIPT).toContain('printf %s "$rc" > "$a/rc"');
    });
});

describe("acpReadCommand", () => {
    it("reads after the offset, bounded under what a command answers", () => {
        const command = acpReadCommand(STATE, 99);
        expect(command).toContain("tail -c +100");
        expect(command).toContain(`head -c ${ACP_READ_BYTES}`);
        expect(Math.ceil(ACP_READ_BYTES / 3) * 4).toBeLessThan(CAPTURE_BYTES);
    });
});

describe("acpWriteCommand", () => {
    it("writes only to the generation it was given", () => {
        const command = acpWriteCommand(STATE, "17-1", new TextEncoder().encode('{"a":1}\n'));
        expect(command).toContain("= '17-1' ]");
        expect(command).toContain(Buffer.from('{"a":1}\n').toString("base64"));
    });

    it("refuses more than one write carries", () => {
        expect(() => acpWriteCommand(STATE, "17-1", new Uint8Array(ACP_WRITE_BYTES + 1))).toThrow();
        // base64 of a full write stays under Linux's 128 KiB per argument.
        expect(Math.ceil(ACP_WRITE_BYTES / 3) * 4).toBeLessThan(128 * 1024 - 1024);
    });
});

describe("parseAcpRead", () => {
    it("reads the generation, a running agent and its bytes", () => {
        const data = Buffer.from('{"jsonrpc":"2.0"}\n').toString("base64");
        const read = parseAcpRead(`1700000000000000000-42\n-\n${data}\n`);
        expect(read?.generation).toBe("1700000000000000000-42");
        expect(read?.exitCode).toBeNull();
        expect(Buffer.from(read!.bytes).toString("utf8")).toBe('{"jsonrpc":"2.0"}\n');
    });

    it("reads an exited agent with nothing left", () => {
        expect(parseAcpRead("17-1\r\n0\r\n\r\n")).toMatchObject({ exitCode: 0, bytes: new Uint8Array() });
    });

    it("refuses anything else", () => {
        expect(parseAcpRead("")).toBeNull();
        expect(parseAcpRead("not a generation\n-\n")).toBeNull();
        expect(parseAcpRead("17-1\nmaybe\n")).toBeNull();
        expect(parseAcpRead("17-1\n-\n***\n")).toBeNull();
    });
});

describe("terminalAgentStopCommand", () => {
    const command = terminalAgentStopCommand(STATE);

    it("stops a runner's turn the way Stop does, then closes the interface window", () => {
        const runner = command.indexOf(`[ -f "${STATE}/${RUNNER_READY_FILE}" ]`);
        const interrupted = command.indexOf(`: > "${STATE}/interrupted"`);
        const ctrlC = command.indexOf(`:${RUNNER_WINDOW}' C-c`);
        const closed = command.indexOf(`kill-window -t 'polaris-agent:${INTERFACE_WINDOW}'`);
        expect(runner).toBeGreaterThanOrEqual(0);
        expect(runner).toBeLessThan(interrupted);
        // The marker before the keystroke, so the runner reports a stop, not a failure.
        expect(interrupted).toBeLessThan(ctrlC);
        expect(ctrlC).toBeLessThan(closed);
        // A runner session never reaches the process sweep.
        expect(closed).toBeLessThan(command.indexOf("exit 0"));
        expect(command.indexOf("exit 0")).toBeLessThan(command.indexOf("kill -TERM"));
    });

    it("ends the processes under the main window, never the protocol agent's", () => {
        expect(command).toContain(`grep -v '^${ACP_WINDOW} '`);
        expect(command).toContain('case "$p" in ""|*[!0-9]*) exit 0 ;; esac');
        expect(command).toContain('kill -TERM $kids');
        expect(command).not.toContain("kill -TERM $p");
    });
});

describe("conversationHandBackCommand", () => {
    it("writes the id where the runner reads it, and tells an interactive terminal apart", () => {
        const command = conversationHandBackCommand(STATE, "abc-123_X");
        expect(command.indexOf(`exit ${HAND_BACK_INTERACTIVE}`)).toBeLessThan(command.indexOf("agent-session-id"));
        expect(command).toContain(`printf %s 'abc-123_X' > "${STATE}/agent-session-id"`);
    });

    it("refuses an id that is not one a launch line may read", () => {
        expect(() => conversationHandBackCommand(STATE, "a; rm -rf /")).toThrow();
        expect(() => conversationHandBackCommand(STATE, "")).toThrow();
    });
});
