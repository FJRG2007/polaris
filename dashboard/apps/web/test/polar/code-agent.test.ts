import { describe, expect, it } from "vitest";
import { preferredAgent } from "../../src/lib/polar/code-agent";

type Row = { key: string; cli: string; readiness: "ready" | "missing" | "unknown"; machine: boolean };

const machineClaude: Row = { key: "claude:machine", cli: "claude", readiness: "unknown", machine: true };
const claude: Row = { key: "claude", cli: "claude", readiness: "missing", machine: false };
const opencode: Row = { key: "opencode", cli: "opencode", readiness: "unknown", machine: false };
const codexLinked: Row = { key: "codex:acct", cli: "codex", readiness: "ready", machine: false };
const goose: Row = { key: "goose", cli: "goose", readiness: "unknown", machine: false };

describe("the agent a new Code task starts with", () => {
    it("is never the machine's own login when something Polaris can vouch for is offered", () => {
        // The order the catalogue lists them in, which is what picked Claude's
        // machine row before.
        expect(preferredAgent([machineClaude, claude, opencode])?.key).toBe("opencode");
    });

    it("is an agent with an account linked, first", () => {
        expect(preferredAgent([machineClaude, opencode, codexLinked])?.key).toBe("codex:acct");
    });

    it("falls back to any agent not known to be missing, then the machine row", () => {
        expect(preferredAgent([machineClaude, claude, goose])?.key).toBe("goose");
        expect(preferredAgent([claude, machineClaude])?.key).toBe("claude:machine");
    });

    it("is the first agent when every one is missing, and none when there are none", () => {
        expect(preferredAgent([claude])?.key).toBe("claude");
        expect(preferredAgent([])).toBeNull();
    });
});
