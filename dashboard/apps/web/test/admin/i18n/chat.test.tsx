// @vitest-environment jsdom

/**
 * The chat rules and the call server card, drawn in Spanish.
 *
 * The parts asserted are the ones a migration gets wrong without noticing: the
 * scope picker's labels (they used to come from a constant in core), a sentence
 * with a link in the middle, and a status line that chooses its ending.
 */

import { withMessages } from "../../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ChatRulesView } from "@/app/(app)/admin/chat/chat-rules-view";
import { CallServerView } from "@/app/(app)/admin/chat/call-server-view";
import { DEFAULT_CHAT_RULES, type ChatRuleScope, type ChatRules } from "@polaris/core";

let settings: Record<string, unknown> = {};

vi.mock("@/app/(app)/admin/chat/actions", () => ({
    callServerSettingsAction: async () => ({ settings, error: null }),
    setCallServerAction: async () => ({}),
    setChatRulesAction: async () => ({})
}));

afterEach(cleanup);

const RULES: Record<ChatRuleScope, ChatRules> = {
    space: DEFAULT_CHAT_RULES,
    group: DEFAULT_CHAT_RULES,
    dm: DEFAULT_CHAT_RULES
};

describe("admin chat in Spanish", () => {
    it("draws the rules in Spanish", () => {
        render(withMessages(<ChatRulesView initial={RULES} />, "es-ES"));

        expect(screen.getByText("Chats de grupo")).toBeTruthy();
        expect(screen.getByText("Mensajes directos")).toBeTruthy();
        expect(screen.getByText("Archivo más grande")).toBeTruthy();
        expect(screen.getByText("Guardar espacios")).toBeTruthy();
        expect(screen.queryByText("Biggest single file")).toBeNull();
        expect(screen.queryByText("Group chats")).toBeNull();
    });

    it("keeps the link inside the translated sentence", async () => {
        settings = { url: "", key: "", hasSecret: false, shipped: true, ready: true, answering: false, unused: null, container: "stopped" };
        render(withMessages(<CallServerView />, "es-ES"));

        const link = await screen.findByRole("link", { name: "Contenedores" });
        expect(link.getAttribute("href")).toBe("/apps/containers");
        expect(screen.getByText("Dónde se hacen las llamadas")).toBeTruthy();
        expect(screen.getByText("El servidor de llamadas está detenido.")).toBeTruthy();
        expect(screen.queryByText("Where calls run")).toBeNull();
    });

    it("chooses where a running server is in Spanish", async () => {
        settings = { url: "", key: "", hasSecret: false, shipped: true, ready: true, answering: true, unused: null, container: "running" };
        render(withMessages(<CallServerView />, "es-ES"));

        expect(await screen.findByText("En marcha en este servidor.")).toBeTruthy();
        expect(screen.getByRole("link", { name: "Dominios" })).toBeTruthy();
    });
});
