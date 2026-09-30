/**
 * No screen sends the operator to a terminal, a configuration file or a log.
 *
 * An installed Polaris is run from its interface, and the person running it does not
 * open `.env` or type a command on the host (see the repo's CLAUDE.md). Two screens
 * did exactly that - the certificate warning asked for POLARIS_ACME_EMAIL in `.env`,
 * and a failed update suggested `polaris update` on the host - so every catalog is
 * held to it here rather than each screen being trusted to remember.
 *
 * What is matched is an instruction aimed at the operator's own installation: an
 * environment variable by name, one of Polaris's own commands, the deployment's
 * `.env`. Copy about a `.env` a user pastes into Deploy, or a command a server one is
 * enrolling runs, is about the reader's own things and is not matched.
 */

import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { flattenCatalog, LOCALES, type Catalog } from "@polaris/core";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

const APPS = resolve(__dirname, "../../..");

const FORBIDDEN: readonly RegExp[] = [
    // A variable of Polaris's own configuration, by name.
    /\bPOLARIS_[A-Z_]+\b/,
    // Polaris's own command line.
    // Lower case, as it is typed: "A Polaris update is ready" is not one.
    /\bpolaris (update|doctor|restart|logs|status)\b/,
    // Its compose stack, driven by hand.
    /\bdocker (compose|logs|restart|exec)\b/i,
    // The deployment's own settings file.
    /(deployment|deployment's|despliegue)[^.]{0,20}\.env\b|\.env (of|del) (the )?(deployment|despliegue)/i
];

/**
 * Where a command is still the honest answer, and why.
 *
 * - The sign-in screen of an instance that has no administrator yet: that is still
 *   the install, and the link that creates the first administrator is a secret the
 *   installer prints on the host. Showing it on a page anyone can open would hand
 *   the instance to whoever loads it first.
 */
const ALLOWED = new Set([
    "web/auth:login.awaitingSetup",
    // - A player installing a server's mods on their own computer, with a line the
    //   page gives them: the variable is one of that line's, on their machine, not
    //   part of this installation.
    "game-servers/minecraft:clientMods.aLauncherThatKeepsIts"
]);

function offending(): string[] {
    const found: string[] = [];
    for (const app of readdirSync(APPS).sort()) {
        const root = join(APPS, app, "messages");
        if (!existsSync(root) || !statSync(root).isDirectory()) continue;
        for (const locale of LOCALES) {
            const dir = join(root, locale);
            if (!existsSync(dir)) continue;
            for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
                const namespace = file.slice(0, -".json".length);
                const catalog = JSON.parse(readFileSync(join(dir, file), "utf8")) as Catalog;
                for (const [key, text] of flattenCatalog(catalog)) {
                    const id = `${app}/${namespace}:${key}`;
                    if (ALLOWED.has(id)) continue;
                    if (FORBIDDEN.some((pattern) => pattern.test(text))) found.push(`${id} (${locale})`);
                }
            }
        }
    }
    return found;
}

describe("copy that would send the operator to a terminal", () => {
    it("is nowhere in the catalogs", () => {
        expect(offending()).toEqual([]);
    });

    it("is caught in the shapes it used to take", () => {
        const samples = [
            "set POLARIS_ACME_EMAIL in the deployment's .env and restart the edge.",
            'or with "polaris update" on the host.',
            "Run docker compose restart on the host."
        ];
        for (const sample of samples) expect(FORBIDDEN.some((pattern) => pattern.test(sample))).toBe(true);
        expect(FORBIDDEN.some((pattern) => pattern.test("Paste a .env - KEY=value per line."))).toBe(false);
    });
});
