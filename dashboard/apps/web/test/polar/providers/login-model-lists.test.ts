/**
 * A login provider lists only the catalogue models it can answer: GitLab's
 * gateway serves the ids its table maps, so one the catalogue carries beyond
 * it (`duo-chat-gpt-5-3-codex`) is left out instead of failing every turn.
 */

import { describe, expect, it } from "vitest";
import { DUO_MODEL_IDS } from "@/lib/agents/signin-gitlab";
import { loginListsModel } from "@/lib/polar/login-models";

describe("the models a login lists", () => {
    it("leaves out a GitLab model its table does not map", () => {
        expect(loginListsModel("gitlab", "duo-chat-gpt-5-3-codex")).toBe(false);
        expect(loginListsModel("gitlab", "duo-chat-unknown")).toBe(false);
    });

    it("keeps every GitLab model its table maps", () => {
        expect(DUO_MODEL_IDS.length).toBeGreaterThan(0);
        for (const id of DUO_MODEL_IDS) expect(loginListsModel("gitlab", id)).toBe(true);
    });

    it("leaves out Copilot's chat-only GPT-5 alias only", () => {
        expect(loginListsModel("github-copilot", "gpt-5-chat-latest")).toBe(false);
        expect(loginListsModel("github-copilot", "gpt-5")).toBe(true);
    });

    it("lists whatever the catalogue carries for any other provider", () => {
        expect(loginListsModel("openai", "duo-chat-gpt-5-3-codex")).toBe(true);
        expect(loginListsModel("openai", "gpt-5-chat-latest")).toBe(true);
    });
});
