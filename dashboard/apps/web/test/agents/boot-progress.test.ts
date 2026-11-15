/**
 * The line a starting session shows in Code, read off its terminal: the step
 * under way, with Enigma's version when the install names one, said in the
 * reader's words.
 */

import { describe, expect, it } from "vitest";
import { knownAgentText } from "@/lib/agents/words";
import { bootProgress } from "@/lib/agents/boot-progress";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { bootStepLabel } from "@/components/polar/polar-code-boot";

const t = ((key: string, params?: Record<string, unknown>) =>
    params ? `${key} ${JSON.stringify(params)}` : key) as unknown as NamespaceTranslator<"agents">;

describe("a starting session's boot line", () => {
    it("names the Enigma version being installed", () => {
        const screen = "polaris: fetching acme/web\npolaris: installing Enigma 1.73.0\n";
        expect(bootStepLabel(screen)).toBe("Installing Enigma 1.73.0");
        expect(knownAgentText(t, "Installing Enigma 1.73.0")).toBe('boot.enigmaVersion {"version":"1.73.0"}');
    });

    it("keeps the plain label when the line names no version", () => {
        expect(bootStepLabel("polaris: installing Enigma (enigma-cli@latest)")).toBe("Installing Enigma");
        expect(knownAgentText(t, "Installing Enigma")).toBe("boot.enigma");
    });

    it("moves on once the agent step is reached, and is gone once the agent starts", () => {
        const screen = "polaris: installing Enigma 1.73.0\npolaris: Enigma 1.73.0 is installed\nThis happens once";
        expect(bootStepLabel(screen)).toBe("Installing the agent");
        expect(bootProgress(`${screen}\npolaris: starting claude`)).toBeNull();
        expect(bootStepLabel(`${screen}\npolaris: starting claude`)).toBeNull();
    });
});
