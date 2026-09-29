/**
 * Chat in Spanish: what a reader sees on a chat screen, and what the chat
 * service refuses with, comes from the catalogs in their language - plurals and
 * arguments included - while the English stays what it was.
 */

import { chatText } from "@/lib/chat/text";
import { describe, expect, it } from "vitest";
import { withMessages } from "../../setup/i18n";
import { webCatalogs } from "../../../messages";
import { spokenWait } from "@/lib/chat/durations";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveBadge } from "@/app/(app)/chat/call-roster";
import { SendButton } from "@/app/(app)/chat/send-button";
import { gameLinkLabel } from "@/app/(app)/chat/game-link-badge";

describe("Chat in Spanish", () => {
    it("labels the controls a reader presses", () => {
        const badge = renderToStaticMarkup(withMessages(<LiveBadge />, "es-ES"));
        expect(badge).toContain("Directo");
        expect(badge).toContain('aria-label="Comparte pantalla"');

        const send = renderToStaticMarkup(
            withMessages(<SendButton disabled={false} onSend={() => undefined} onSchedule={() => undefined} />, "es-ES")
        );
        expect(send).toContain("Enviar");
        expect(send).toContain('aria-label="Más formas de enviar"');
    });

    it("keeps the English labels as they were", () => {
        const badge = renderToStaticMarkup(withMessages(<LiveBadge />, "en-US"));
        expect(badge).toContain("Live");
        expect(badge).toContain('aria-label="Sharing a screen"');
    });

    it("counts with the plural in place", () => {
        const t = webCatalogs.translator("es-ES", "chat");
        expect(t("messageList.replies", { count: 1 })).toBe("1 respuesta");
        expect(t("messageList.replies", { count: 4 })).toBe("4 respuestas");
        expect(t("channelView.newMessages", { count: 3 })).toBe("3 mensajes nuevos");
        expect(t("pollCard.votes", { count: 2 })).toBe("2 votos");

        const en = webCatalogs.translator("en-US", "chat");
        expect(en("messageList.replies", { count: 1 })).toBe("1 reply");
        expect(en("channelView.roomCount", { count: 0 })).toBe(" - nobody is in here");
        expect(en("channelView.roomCount", { count: 5 })).toBe(" - 5 people are in here");
    });

    it("says a slow-mode wait in the reader's words", () => {
        const t = webCatalogs.translator("es-ES", "chat");
        const wait = spokenWait(120);
        expect(t("channelView.slowMode", { wait: t(wait.key, wait.params) })).toBe(
            "Aquí está activo el modo lento. Podrás volver a enviar en 2 minutos."
        );
    });

    it("refuses in the reader's language, a length of time included", () => {
        expect(chatText("es-ES", { key: "errors.pollClosed" })).toBe("La encuesta está cerrada");
        expect(chatText("en-US", { key: "errors.pollClosed" })).toBe("That poll has closed");
        expect(chatText("es-ES", { key: "errors.slowMode", params: { wait: spokenWait(40) } })).toContain("40 segundos");
    });

    it("names a linked game server in Spanish", () => {
        const t = webCatalogs.translator("es-ES", "chat");
        const link = { installedAppId: "a", game: "Minecraft", name: "Survival", href: null, logo: null };
        expect(gameLinkLabel([link] as never, t)).toBe("Vinculado al servidor de Minecraft Survival");
    });
});
