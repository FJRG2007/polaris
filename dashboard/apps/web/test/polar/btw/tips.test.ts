/**
 * The busy tips name only commands their surface has, every one is written in
 * both languages, and every tip of a surface can be picked.
 */

import { describe, expect, it } from "vitest";
import * as polarTips from "@/lib/polar/tips";
import en from "../../../messages/en-US/polar.json";
import es from "../../../messages/es-ES/polar.json";
import { CODE_COMMANDS } from "@/lib/polar/code-commands";
import { POLAR_CONTROL_COMMANDS } from "@/lib/polar/shared";

describe("Polar busy tips", () => {
    it("point only at commands the surface has, by name", () => {
        for (const tip of polarTips.POLAR_TIPS) {
            const list: readonly string[] =
                tip.surface === "chat" ? POLAR_CONTROL_COMMANDS : CODE_COMMANDS;
            expect(list).toContain(tip.command);
            expect((en.tips as Record<string, string>)[tip.id]).toContain(`/${tip.command}`);
            expect((es.tips as Record<string, string>)[tip.id]).toContain(`/${tip.command}`);
        }
    });

    it("never offers /btw where it cannot run", () => {
        expect(polarTips.tipsFor("code").some((tip) => tip.command === "btw")).toBe(false);
        expect(polarTips.tipsFor("chat").some((tip) => tip.command === "btw")).toBe(true);
    });

    it("can reach every tip of a surface", () => {
        const list = polarTips.tipsFor("chat");
        const seen = new Set(list.map((_, at) => polarTips.pickTip("chat", at / list.length)?.id));
        expect(seen.size).toBe(list.length);
        expect(polarTips.pickTip("chat", 0.999999)?.id).toBe(list.at(-1)?.id);
    });
});
