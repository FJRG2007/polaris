/**
 * Symbiote on one server: whether it is on the list, and the edit that puts it
 * there or takes it off.
 *
 * The decisions are `symbiote`'s; this reads and writes the server's
 * environment. Nothing is restarted: the server downloads the jar when it next
 * starts, which the screen says.
 */

import * as symbiote from "./symbiote";
import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { MODS_KEY } from "./polaris-login";
import { SOFTWARE_KEY } from "./join-guard";
import { gameMessage } from "../game-message";
import { packUrl } from "./client-pack";
import { jarBundled } from "./polaris-mod-files";

const { publicAppUrl } = host.domainService;
const { listEnvVars, setEnvVars } = host.envVarService;

export interface SymbioteState {
    /** Whether the server's list carries it. */
    readonly installed: boolean;
    readonly fit: symbiote.SymbioteFit;
    /** Whether this Polaris has an address the server can download it from. */
    readonly reachable: boolean;
    /** Whether this Polaris was built with the jar. */
    readonly bundled: boolean;
}

async function readEnv(applicationId: string, ownerId: string): Promise<Map<string, string>> {
    const vars = await listEnvVars("application", applicationId, ownerId);
    return new Map(vars.map((entry) => [entry.key, entry.value ?? ""]));
}

/** The address a server downloads it from: its own pack link. */
function jarUrl(baseUrl: string, installedAppId: string): string {
    return packUrl(baseUrl, installedAppId, symbiote.SYMBIOTE_FILE);
}

export async function symbioteState(
    applicationId: string,
    ownerId: string,
    installedAppId: string
): Promise<SymbioteState> {
    const [env, publicUrl, bundled] = await Promise.all([
        readEnv(applicationId, ownerId),
        publicAppUrl().catch(() => null),
        jarBundled(symbiote.SYMBIOTE_FILE)
    ]);
    const mods = env.get(MODS_KEY) ?? "";
    return {
        installed: symbiote.hasSymbiote(mods),
        fit: symbiote.symbioteFit(env.get(SOFTWARE_KEY) ?? "", env.get("VERSION") ?? ""),
        reachable: publicUrl !== null,
        bundled
    };
}

/** Put it on the server's list, or take it off. Taking it off always works, so
 *  a server that moved never keeps a jar it cannot boot with. */
export async function setSymbiote(
    applicationId: string,
    ownerId: string,
    installedAppId: string,
    on: boolean
): Promise<void> {
    const env = await readEnv(applicationId, ownerId);
    const mods = env.get(MODS_KEY) ?? "";
    let next: string;
    if (on) {
        const fit = symbiote.symbioteFit(env.get(SOFTWARE_KEY) ?? "", env.get("VERSION") ?? "");
        if (fit !== "fits") throw new Error(gameMessage("games", "lib.symbioteUnsupported"));
        // The server downloads it from this address when it boots, and a
        // LAN-only name does not resolve inside a container.
        const baseUrl = await publicAppUrl();
        if (baseUrl === null) throw new Error(gameMessage("games", "lib.symbioteNeedsAddress"));
        if (!(await jarBundled(symbiote.SYMBIOTE_FILE))) {
            throw new Error(gameMessage("games", "lib.noSymbiote"));
        }
        next = symbiote.withSymbiote(mods, jarUrl(baseUrl, installedAppId));
    } else {
        next = symbiote.withoutSymbiote(mods);
    }
    if (next === mods) return;
    await setEnvVars("application", applicationId, ownerId, [
        { key: MODS_KEY, value: next, isSecret: false }
    ]);
}

/**
 * Every server that took it on while the jar was still on the public route,
 * moved onto its own pack link: the public route no longer answers it, so a
 * server booting with the old address would not start. Run when the dashboard
 * boots, before anybody has to open the server's Mods tab.
 */
export async function moveSymbioteLinks(): Promise<void> {
    const baseUrl = await publicAppUrl().catch(() => null);
    if (baseUrl === null) return;
    const listed = await prisma.envVar.findMany({
        where: {
            scopeType: "application",
            key: MODS_KEY,
            value: { contains: symbiote.SYMBIOTE_FILE }
        },
        select: { scopeId: true, value: true }
    });
    for (const entry of listed) {
        const install = await prisma.installedApp.findFirst({
            where: { applicationId: entry.scopeId, status: { not: "removed" } },
            select: { id: true, ownerId: true }
        });
        if (!install) continue;
        const mods = entry.value ?? "";
        const url = jarUrl(baseUrl, install.id);
        if (!symbiote.symbioteElsewhere(mods, url)) continue;
        await setEnvVars("application", entry.scopeId, install.ownerId, [
            { key: MODS_KEY, value: symbiote.withSymbiote(mods, url), isSecret: false }
        ]).catch((error) =>
            console.error("polaris: a server's Symbiote link could not be moved:", error)
        );
    }
}
