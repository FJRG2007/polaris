/**
 * Polaris login greets a player by the name of the Polaris account they are -
 * only where that account agrees with the link - in its language, with the
 * name made safe for the game's text.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    link: null as null | { userId: string; player: string; followSignIns: boolean },
    user: null as null | { firstName: string | null; name: string },
    connected: [] as { userId: string; label: string }[],
    fail: false,
    config: {} as Record<string, unknown>
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        gamePlayerLink: {
            findFirst: vi.fn(async () => {
                if (db.fail) throw new Error("database down");
                return db.link;
            })
        },
        userConnection: { findMany: vi.fn(async () => db.connected) },
        user: { findUnique: vi.fn(async () => db.user) },
        installedApp: { findUnique: vi.fn(async () => ({ config: db.config })) }
    }
}));

const locale = vi.hoisted(() => ({ value: "en-US" as string | null }));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/speech-service", () => ({
    homeLanguage: vi.fn(async (_ownerId: string, chosen: string | null) => chosen ?? "en"),
    accountLanguage: vi.fn(async (_userId: string, home: string) =>
        locale.value ? (/^es/.test(locale.value) ? "es" : "en") : home
    )
}));

const welcome = await import("@polaris-app/game-servers/src/lib/minecraft/login-welcome");
const SERVER = { installedAppId: "server-1", ownerId: "owner-1" };

beforeEach(() => {
    db.link = { userId: "user-1", player: "Javi", followSignIns: false };
    db.user = { firstName: "Javier", name: "Javier Ruiz" };
    db.connected = [{ userId: "user-1", label: "Javi" }];
    db.fail = false;
    db.config = {};
    locale.value = "en-US";
});

describe("the name a player is greeted by", () => {
    it("is the first name, or the account's name when there is none", () => {
        expect(welcome.greetingName({ firstName: "Javier", name: "Javier Ruiz" })).toBe("Javier");
        expect(welcome.greetingName({ firstName: null, name: "Javi R." })).toBe("Javi R.");
        expect(welcome.greetingName({ firstName: "  ", name: "Ana" })).toBe("Ana");
    });

    it("carries no formatting codes, control characters or more than its share of letters", () => {
        expect(welcome.cleanName("§cJa§lvier")).toBe("Javier");
        const nul = String.fromCharCode(0);
        const zwsp = String.fromCharCode(0x200b);
        expect(welcome.cleanName(`Ja${nul}vi${String.fromCharCode(10)}er${zwsp}`)).toBe("Javier");
        expect(welcome.cleanName("  Javi   Ruiz ")).toBe("Javi Ruiz");
        expect(welcome.cleanName('Ana"}],{"text":"x')).toBe('Ana"}],{"text":"x');
        expect(welcome.cleanName("x".repeat(80))).toHaveLength(welcome.NAME_MAX);
        expect(welcome.cleanName("§§§")).toBeNull();
    });
});

describe("the greeting", () => {
    it("says welcome back by name in English, and in Spanish for a Spanish account", async () => {
        expect(await welcome.welcomeFor(SERVER, "Javi", "login")).toBe(
            "Logged in. Welcome back, Javier!"
        );
        locale.value = "es-ES";
        expect(await welcome.welcomeFor(SERVER, "javi", "login")).toBe(
            "Sesión iniciada. ¡Hola de nuevo, Javier!"
        );
        expect(await welcome.welcomeFor(SERVER, "Javi", "register")).toBe(
            "Contraseña guardada. ¡Hola, Javier!"
        );
    });

    it("is in the server's language for an account that has none of its own", async () => {
        locale.value = null;
        expect(await welcome.welcomeFor(SERVER, "Javi", "login")).toBe(
            "Logged in. Welcome back, Javier!"
        );
        db.config = { events: { settings: { language: "es" } } };
        expect(await welcome.welcomeFor(SERVER, "Javi", "login")).toBe(
            "Sesión iniciada. ¡Hola de nuevo, Javier!"
        );
    });

    it("is nothing for a player nobody is linked to, and the mod keeps its own line", async () => {
        db.link = null;
        expect(await welcome.welcomeFor(SERVER, "Javi", "login")).toBeNull();
    });

    it("is nothing for a link the account does not agree with", async () => {
        db.connected = [];
        expect(await welcome.welcomeFor(SERVER, "Javi", "login")).toBeNull();
        // Its own server, or a link that follows its sign-ins, agrees.
        expect(
            await welcome.welcomeFor({ ...SERVER, ownerId: "user-1" }, "Javi", "login")
        ).toBe("Logged in. Welcome back, Javier!");
        db.link = { userId: "user-1", player: "Javi", followSignIns: true };
        expect(await welcome.welcomeFor(SERVER, "Javi", "login")).not.toBeNull();
    });

    it("never stands in the way of the login when something could not be read", async () => {
        db.fail = true;
        expect(await welcome.welcomeFor(SERVER, "Javi", "login")).toBeNull();
    });
});
