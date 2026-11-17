import { describe, expect, it } from "vitest";
import {
    PREVIEW_COMMAND_MAX,
    PREVIEW_STATE,
    previewCommandSchema,
    previewStartScript
} from "@/lib/agents/session-preview-command";

describe("previewCommandSchema", () => {
    it("keeps one trimmed line", () => {
        expect(previewCommandSchema.parse("  npm run dev -- --port 3000 ")).toBe("npm run dev -- --port 3000");
        expect(previewCommandSchema.parse("")).toBe("");
    });

    it("refuses a second line, a control character and an endless command", () => {
        expect(previewCommandSchema.safeParse("npm run dev\nrm -rf /").success).toBe(false);
        expect(previewCommandSchema.safeParse("npm\u0007run").success).toBe(false);
        expect(previewCommandSchema.safeParse("a".repeat(PREVIEW_COMMAND_MAX + 1)).success).toBe(false);
    });
});

describe("previewStartScript", () => {
    const command = "PORT=3000 npm run dev -- --host '0.0.0.0' && echo \"$HOME\"";
    const script = previewStartScript(command);

    it("carries the command encoded, so this shell never reads it", () => {
        expect(script).not.toContain("npm run dev");
        expect(script).toContain(`printf %s '${Buffer.from(command).toString("base64")}' | base64 -d > ${PREVIEW_STATE}.sh`);
    });

    it("starts at most once, in the background, in the checkout, as the agent's account", () => {
        expect(script.split("\n")[0]).toContain(`kill -0 "$(cat ${PREVIEW_STATE}.pid)"`);
        expect(script).toContain('cd "$w"');
        expect(script).toContain('nohup su -p "$a"');
        expect(script).toContain(`echo $! > ${PREVIEW_STATE}.pid`);
    });
});
