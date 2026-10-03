/**
 * What Polaris login says to a player it has just let in: by the name of the
 * Polaris account the player is linked to, in that account's language - "Welcome
 * back, Javier" - and nothing of the kind for a player no account agrees with,
 * who keeps the mod's own line.
 *
 * The link is the operator's word, so it counts here only where the account
 * agrees with it (`link-agreement`): a link made by mistake must not greet a
 * stranger by somebody else's name.
 */

import { prisma } from "@polaris/db";
import type { Language } from "./speech";
import * as speechService from "./speech-service";
import { chosenLanguage } from "./events/catalog";
import { accountAgrees, connectedMinecraftNames } from "../link-agreement";

/** The most of a name a greeting carries. */
export const NAME_MAX = 24;

/**
 * A name as the game may show it: no section-sign formatting (`§c`), no
 * control or invisible characters, single spaces, at most `NAME_MAX` characters.
 * Sent as plain text inside the mod's own message, so nothing in it is ever
 * read as a command or a JSON component either.
 */
export function cleanName(raw: string | null | undefined): string | null {
    if (typeof raw !== "string") return null;
    const cleaned = raw
        .replace(/§./gu, "")
        .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}§]/gu, "")
        .replace(/\s+/g, " ")
        .trim();
    if (!cleaned) return null;
    return [...cleaned].slice(0, NAME_MAX).join("").trim();
}

/** The name to greet somebody by: their first name, or the account's name. */
export function greetingName(user: { firstName: string | null; name: string }): string | null {
    return cleanName(user.firstName) ?? cleanName(user.name);
}

export type WelcomeKind = "login" | "register";

/** The greeting, in one language. */
export function welcomeLine(kind: WelcomeKind, name: string, language: Language): string {
    if (kind === "register")
        return language === "es"
            ? `Contraseña guardada. ¡Hola, ${name}!`
            : `Password set. Welcome, ${name}!`;
    return language === "es"
        ? `Sesión iniciada. ¡Hola de nuevo, ${name}!`
        : `Logged in. Welcome back, ${name}!`;
}

/**
 * The greeting for a player just let in on a server, or null when no account
 * the player is linked to agrees with the link - or anything about it could not
 * be read, which must never stand in the way of the login itself.
 */
export async function welcomeFor(
    server: { readonly installedAppId: string; readonly ownerId: string },
    player: string,
    kind: WelcomeKind
): Promise<string | null> {
    try {
        const link = await prisma.gamePlayerLink.findFirst({
            where: {
                installedAppId: server.installedAppId,
                player: { equals: player, mode: "insensitive" }
            },
            select: { userId: true, player: true, followSignIns: true }
        });
        if (!link) return null;
        const names = await connectedMinecraftNames([link.userId]);
        if (!accountAgrees(link, { ownerId: server.ownerId, minecraft: true }, names)) return null;
        const user = await prisma.user.findUnique({
            where: { id: link.userId },
            select: { firstName: true, name: true }
        });
        const name = user ? greetingName(user) : null;
        if (!name) return null;
        const install = await prisma.installedApp.findUnique({
            where: { id: server.installedAppId },
            select: { config: true }
        });
        const home = await speechService.homeLanguage(
            server.ownerId,
            chosenLanguage((install?.config ?? {}) as Record<string, unknown>)
        );
        const language = await speechService.accountLanguage(link.userId, home);
        return welcomeLine(kind, name, language);
    } catch (error) {
        console.warn("polaris: the login welcome could not be read", server.installedAppId, String(error));
        return null;
    }
}
