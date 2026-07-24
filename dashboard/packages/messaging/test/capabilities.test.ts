import { describe, expect, it } from "vitest";
import { capabilitiesFor } from "../src/capabilities.js";

describe("capabilitiesFor - Discord/Slack webhook variants (send-only)", () => {
    it("keeps the Discord bot interactive", () => {
        const bot = capabilitiesFor("discord");
        expect(bot.nativeButtons).toBe(true);
        expect(bot.nativeSelects).toBe(true);
        expect(bot.media).toBe(true);
        expect(bot.onboarding).toBe("token");
    });

    it("marks the Discord webhook as send-only (no bot, no interactivity)", () => {
        const hook = capabilitiesFor("discord", "discord-webhook");
        expect(hook.nativeButtons).toBe(false);
        expect(hook.nativeSelects).toBe(false);
        expect(hook.media).toBe(false);
        expect(hook.polls).toBe(false);
        expect(hook.needsBrowser).toBe(false);
        expect(hook.onboarding).toBe("token");
    });

    it("keeps the Slack bot interactive via OAuth", () => {
        const bot = capabilitiesFor("slack");
        expect(bot.nativeButtons).toBe(true);
        expect(bot.nativeSelects).toBe(true);
        expect(bot.onboarding).toBe("oauth");
    });

    it("marks the Slack webhook as send-only with a plain URL/token onboarding", () => {
        const hook = capabilitiesFor("slack", "slack-webhook");
        expect(hook.nativeButtons).toBe(false);
        expect(hook.nativeSelects).toBe(false);
        expect(hook.media).toBe(false);
        expect(hook.onboarding).toBe("token");
    });

    it("does not degrade a platform when an unrelated provider hint is passed", () => {
        // A Discord bot with no provider (null) stays fully interactive - only the
        // explicit "-webhook" provider flips it to send-only.
        expect(capabilitiesFor("discord", null).nativeButtons).toBe(true);
        expect(capabilitiesFor("slack", undefined).nativeButtons).toBe(true);
    });
});
