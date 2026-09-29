/**
 * The app catalogue's words in the reader's language.
 *
 * A manifest stays English - it is what gets installed - and what a screen draws
 * from it is translated on the way out. Pinned here: a Spanish reader gets the
 * setting, its help and its choices in Spanish, a product's own name is left as
 * it is, and the section a setting belongs to keeps the identifier screens
 * compare while gaining a heading to draw.
 */

import { findApp } from "@/lib/apps/catalog";
import { describe, expect, it } from "vitest";
import { translatorFor } from "@/lib/i18n/translate";
import { categoryLabel, localizeApp, localizeSetting } from "@/lib/apps/app-words";

const es = translatorFor("es-ES", "catalog");
const en = translatorFor("en-US", "catalog");

describe("a server setting", () => {
    const setting = {
        key: "DIFFICULTY",
        label: "Difficulty",
        group: "World",
        value: "normal",
        options: [
            { value: "peaceful", label: "Peaceful" },
            { value: "hard", label: "Hard" }
        ]
    };

    it("reads in Spanish, choices included", () => {
        const read = localizeSetting(es, "minecraft", setting);
        expect(read.label).toBe("Dificultad");
        expect(read.options?.map((option) => option.label)).toEqual(["Pacífico", "Difícil"]);
        expect(read.options?.map((option) => option.value)).toEqual(["peaceful", "hard"]);
    });

    it("keeps the group it is compared by, and gives it a heading", () => {
        const read = localizeSetting(es, "minecraft", setting);
        expect(read.group).toBe("World");
        expect(read.groupLabel).toBe("Mundo");
    });

    it("says its help in Spanish", () => {
        const read = localizeSetting(es, "minecraft", {
            key: "MOTD",
            label: "Message of the day",
            help: "The line under the server name in the multiplayer list.",
            value: ""
        });
        expect(read.help).toBe("La línea bajo el nombre del servidor en la lista multijugador.");
    });

    it("leaves a product's own name alone", () => {
        const read = localizeSetting(es, "minecraft", {
            key: "TYPE",
            label: "Server software",
            value: "PAPER",
            options: [{ value: "PAPER", label: "Paper" }]
        });
        expect(read.options?.[0]?.label).toBe("Paper");
    });

    it("is unchanged in English", () => {
        expect(localizeSetting(en, "minecraft", setting)).toEqual({ ...setting, groupLabel: "World" });
    });
});

describe("an app in the marketplace", () => {
    it("reads in Spanish without changing what is installed", () => {
        const app = findApp("messaging-bridge");
        expect(app).toBeDefined();
        const read = localizeApp(es, app!);
        expect(read.name).toBe("Puente de mensajería");
        expect(read.summary).toContain("WhatsApp");
        expect(read.summary).not.toBe(app!.summary);
        expect(read.id).toBe(app!.id);
        expect(read.template?.volumes?.[0]?.name).toBe("sessions");
        expect(read.template?.volumes?.[0]?.label).toBe("Sesiones de canales");
    });

    it("names a category, or hands it to the fallback when this catalog has none", () => {
        expect(categoryLabel(es, "Messaging")).toBe("Mensajería");
        expect(categoryLabel(es, "Tools", (english) => `nav:${english}`)).toBe("nav:Tools");
    });
});
