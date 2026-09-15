/**
 * The player list a game server is actually closed by: a username, and the
 * address that username may arrive from.
 *
 * The game gives half of this and no more. Java's whitelist knows usernames and
 * nothing about where they connect from, Bedrock's allow list wants an XUID that
 * does not exist until a player has already been in, and neither has any notion of
 * an account being tied to a line. So Polaris keeps the pairs and enforces the
 * address half itself, on the join - the first moment a player has an address at
 * all. A player whose name is not listed, or who arrives from somewhere their name
 * is not registered to, is kicked with the reason said plainly rather than left
 * staring at a generic refusal.
 *
 * Enforcement is therefore after the connection rather than before it, and it is
 * worth being honest about what that buys: a stolen account gets as far as the
 * login screen and no further, and a server whose address leaked is not open to
 * whoever found it. What it is not is a network-level block - the port is still
 * open, and the firewall's own blocklist is what closes that (see
 * `applyFirewallBans`).
 *
 * Bedrock prints no address in its log, so there the username half is enforced and
 * the address half is reported as unavailable rather than silently ignored.
 */

import { prisma } from "@polaris/db";
import { readAppRuntimeLog } from "@/lib/deploy-service";
import { noteReachedFrom } from "@/lib/apps/minecraft/reach";
import { patchInstallConfig, readInstallConfig } from "@/lib/apps/install-config";
import { readContainerFile, writeContainerFile } from "@/lib/apps/container-files";
import { parseJoinAddresses, parseProperties, parseWhitelistRefusal } from "@/lib/apps/minecraft/parse";
import { withOfflineIdentities, withOfflineNames, withoutName } from "@/lib/apps/minecraft/offline-identity";
import {
    editionOf,
    getServerPlayers,
    runServerCommand,
    withServerContainer,
    type MinecraftEdition,
    type ServerContainer
} from "@/lib/apps/minecraft/service";
import { accessRefusal, isAddressRule, isPlayerName, missingWhitelistNames, parseWhitelistNames, type PlayerAccess } from "@/lib/apps/minecraft/access";

/** How much log to read back when matching joins. A join line per player is all
 *  that is wanted, and a busy server prints a lot between them. */
const JOIN_LOG_TAIL = 400;

export interface PlayerAccessRule extends PlayerAccess {
    readonly id: string;
    readonly note: string | null;
    readonly createdAt: string;
}

export interface PlayerAccessView {
    readonly rules: readonly PlayerAccessRule[];
    /** Whether the address half is enforced. Usernames always are. */
    readonly bindAddresses: boolean;
    /** False on Bedrock, whose log carries no address to check against. */
    readonly addressesAvailable: boolean;
    readonly edition: MinecraftEdition;
}

interface AccessInstall {
    readonly id: string;
    readonly applicationId: string | null;
    readonly edition: MinecraftEdition;
    readonly bindAddresses: boolean;
}

/** The install, asserting the caller owns it, with the access flag off its config. */
async function resolve(ownerId: string, installedAppId: string): Promise<AccessInstall> {
    const row = await prisma.installedApp.findFirst({
        where: { id: installedAppId, ownerId, status: { not: "removed" } },
        select: { id: true, applicationId: true, catalogId: true, config: true }
    });
    if (!row) throw new Error("Installed app not found");
    return {
        id: row.id,
        applicationId: row.applicationId,
        edition: editionOf(row.catalogId),
        // Absent means on: a server created before this existed is closed too, and
        // a config that cannot be read is never a reason to stop enforcing.
        bindAddresses: readInstallConfig(row.config).bindAddresses !== false
    };
}

/** Who may connect to this server. */
export async function listPlayerAccess(ownerId: string, installedAppId: string): Promise<PlayerAccessView> {
    const install = await resolve(ownerId, installedAppId);
    const rows = await prisma.gamePlayerAccess.findMany({
        where: { installedAppId },
        orderBy: { createdAt: "asc" }
    });
    return {
        rules: rows.map((row) => ({
            id: row.id,
            username: row.username,
            address: row.address,
            note: row.note,
            createdAt: row.createdAt.toISOString()
        })),
        bindAddresses: install.bindAddresses,
        addressesAvailable: install.edition === "java",
        edition: install.edition
    };
}

/** Where the image keeps the server's own files. */
const DATA_DIR = "/data";
const WHITELIST_FILE = `${DATA_DIR}/whitelist.json`;
const OPS_FILE = `${DATA_DIR}/ops.json`;
const BANS_FILE = `${DATA_DIR}/banned-players.json`;
const PROPERTIES_FILE = `${DATA_DIR}/server.properties`;

/**
 * A roster file the server keys by an identity rather than by a name.
 *
 * All three are the same file format and carry the same defect on a server that
 * invents identities, but they fail in opposite directions, and the ban list is
 * the one that matters most: a whitelist entry nothing matches keeps a welcome
 * player out, where a ban entry nothing matches lets a banned one back in.
 */
export type RosterFile = "whitelist" | "ops" | "bans";

const ROSTER_PATHS: Readonly<Record<RosterFile, string>> = {
    whitelist: WHITELIST_FILE,
    ops: OPS_FILE,
    bans: BANS_FILE
};

/**
 * The server answered and said no.
 *
 * Told apart from a server that did not answer at all, because the two deserve
 * opposite treatment: a refusal is news the operator has to see, and silence is
 * the ordinary case of a server that is stopped or still booting, which the
 * enforcement pass settles by itself later.
 */
class WhitelistRefused extends Error {}

/**
 * Whether this server invents its players' identities instead of asking Mojang.
 *
 * A file that cannot be read counts as authenticating, because that is the
 * game's own default and the command path is the right one for it. The mistake
 * that direction is a grant that has to be retried; the other direction would
 * rewrite a correct roster with identities the login will never compute.
 */
async function inventsIdentities(server: ServerContainer): Promise<boolean> {
    // Bedrock is not this. It keeps an allow list keyed by a number Microsoft
    // issues, in a different file, and none of the reasoning below applies to it -
    // so every path that would write a Java roster file stops here.
    if (server.edition !== "java") return false;
    const properties = await readContainerFile(server, PROPERTIES_FILE);
    if (properties === null) return false;
    return parseProperties(properties)["online-mode"] === "false";
}

/**
 * Put names on the game's own whitelist, in a way it will still honour after a
 * restart.
 *
 * On a server with authentication off this does not ask the game to add anybody.
 * `whitelist add` resolves the name the only way it knows - the user cache, then
 * Mojang - and writes whichever identity that returned, which is not the one an
 * unauthenticated login computes. The entry then names the player, lists them on
 * every screen, and matches nobody. So the file is written here instead, from the
 * identity the server itself will compute, and the server is told to read it
 * again - which is what makes the player able to join without a restart.
 */
async function putOnWhitelist(server: ServerContainer, names: readonly string[]): Promise<string> {
    if (names.length === 0) return "";
    if (!(await inventsIdentities(server))) {
        for (const name of names) {
            const refusal = parseWhitelistRefusal(await server.say(["whitelist", "add", name]));
            if (refusal !== null) throw new WhitelistRefused(refusal);
        }
        return `Added to the whitelist: ${names.join(", ")}.`;
    }
    const current = (await readContainerFile(server, WHITELIST_FILE)) ?? "";
    const written = withOfflineNames(current, names);
    if (written !== null) {
        try {
            await writeContainerFile(server, WHITELIST_FILE, written);
        } catch (caught) {
            throw new WhitelistRefused(caught instanceof Error ? caught.message : "The whitelist could not be written");
        }
    }
    await server.say(["whitelist", "reload"]);
    return `Added to the whitelist: ${names.join(", ")}.`;
}

/** Take a name off the game's own whitelist. Same split: the file is the truth on
 *  a server that invents identities, and the command is on one that does not. */
async function takeOffWhitelist(server: ServerContainer, name: string): Promise<string> {
    if (!(await inventsIdentities(server))) {
        await server.say(["whitelist", "remove", name]);
        return `Removed ${name} from the whitelist.`;
    }
    const current = (await readContainerFile(server, WHITELIST_FILE)) ?? "";
    const written = withoutName(current, name);
    if (written !== null) await writeContainerFile(server, WHITELIST_FILE, written);
    await server.say(["whitelist", "reload"]);
    return `Removed ${name} from the whitelist.`;
}

/**
 * Correct the identities in one of the server's roster files.
 *
 * The repair pass for a file Polaris did not write: a list built by the game's
 * own command holds the identity Mojang answered with, which on this server
 * matches nobody, and a list that was half-corrected holds the same player twice.
 * Both are rewritten from the names, the only part of those files that was ever
 * true.
 *
 * Does nothing at all on a server that authenticates - there the identities in
 * those files are the ones the login uses, and rewriting them is how a whole
 * server loses its operators.
 *
 * The whitelist is reloaded afterwards because the game holds it in memory; the
 * operator list is not, because there is no command that re-reads it and the
 * running server already has the right people opped. That file matters at the
 * next start, which is exactly when the wrong identity would have taken their
 * status away.
 */
export async function repairRosterIdentity(
    ownerId: string,
    installedAppId: string,
    file: RosterFile
): Promise<boolean> {
    return withServerContainer(ownerId, installedAppId, async (server) => {
        if (!(await inventsIdentities(server))) return false;
        const path = ROSTER_PATHS[file];
        const current = await readContainerFile(server, path);
        if (current === null) return false;
        const written = withOfflineIdentities(current);
        if (written === null) return false;
        await writeContainerFile(server, path, written);
        if (file === "whitelist") await server.say(["whitelist", "reload"]);
        return true;
    });
}

/** Put one player on the game's own whitelist, opening the server once for it. */
export async function whitelistPlayer(ownerId: string, installedAppId: string, username: string): Promise<string> {
    return withServerContainer(ownerId, installedAppId, (server) => putOnWhitelist(server, [username]));
}

/** Take one player off it. */
export async function unwhitelistPlayer(ownerId: string, installedAppId: string, username: string): Promise<string> {
    return withServerContainer(ownerId, installedAppId, (server) => takeOffWhitelist(server, username));
}

/**
 * Put the granted players onto the game's own whitelist.
 *
 * `grantPlayerAccess` tells the server in the same breath, but only when it is
 * answering - and a server that is stopped, booting, or restarting on a crash is
 * exactly when somebody adds the friend who cannot get in. That grant was then
 * recorded here, drawn on the screen as allowed, and never reached the game: the
 * player stayed refused with both halves insisting they were let in.
 *
 * On a server that invents its players' identities the list is compared against
 * the file rather than against `whitelist list`, because that command answers
 * with the names in the file and a name is exactly the part that was never
 * wrong - the whole defect is a listed name under an identity nothing will look
 * up. Comparing names would find nothing missing and repair nothing.
 *
 * Only ever adds. A name on the game's list that Polaris does not know about was
 * put there by somebody, and taking it away would be this quietly locking a
 * player out rather than letting one in.
 */
export async function reconcileWhitelist(
    ownerId: string,
    installedAppId: string,
    rules: readonly PlayerAccess[]
): Promise<string[]> {
    if (rules.length === 0) return [];
    // Against nothing listed, this is every granted name once - one player who
    // plays from two places is two rules and one entry.
    const names = missingWhitelistNames(rules, []);
    return withServerContainer(ownerId, installedAppId, async (server) => {
        if (await inventsIdentities(server)) {
            const current = (await readContainerFile(server, WHITELIST_FILE)) ?? "";
            const written = withOfflineNames(current, names);
            if (written === null) return [];
            await writeContainerFile(server, WHITELIST_FILE, written);
            await server.say(["whitelist", "reload"]);
            return names;
        }
        const answer = await server.say(["whitelist", "list"]).catch(() => null);
        // A reply that never came is not an empty list: adding everybody back on
        // the strength of it would fight a server that is simply not answering yet.
        if (answer === null) return [];
        const missing = missingWhitelistNames(rules, parseWhitelistNames(answer));
        for (const username of missing) {
            await server.say(["whitelist", "add", username]).catch(() => null);
        }
        return missing;
    });
}

/** The rules alone, for the enforcement pass and for anything deciding a join. */
export async function playerAccessRules(installedAppId: string): Promise<PlayerAccess[]> {
    const rows = await prisma.gamePlayerAccess.findMany({
        where: { installedAppId },
        select: { username: true, address: true }
    });
    return rows.map((row) => ({ username: row.username, address: row.address }));
}

/**
 * Let a player in from an address.
 *
 * One row per address, not per player. Somebody who plays from home and from a
 * laptop on the road is one person and two addresses, and keying this on the name
 * alone meant registering the second silently replaced the first - the rule read
 * as if it had been edited, and the player was locked out of wherever they were
 * not sitting at the time.
 *
 * Adding an address a player already has is not an error, it is nothing: the same
 * permission written twice.
 *
 * The game's own list is updated in the same breath when the server is up, so a
 * player added here can join without a restart; a server still booting takes the
 * name from its environment instead, and one that is stopped picks it up from this
 * table the next time the pass runs.
 */
export async function grantPlayerAccess(
    ownerId: string,
    installedAppId: string,
    actorId: string,
    input: { username: string; address: string; note?: string }
): Promise<void> {
    const install = await resolve(ownerId, installedAppId);
    const username = input.username.trim();
    const address = input.address.trim().toLowerCase();
    if (!isPlayerName(install.edition, username)) throw new Error("That is not a username this edition accepts");
    if (!isAddressRule(address)) throw new Error("Give one address, a range like 203.0.113.0/24, or \"any\"");

    await prisma.gamePlayerAccess.upsert({
        where: { installedAppId_username_address: { installedAppId, username, address } },
        create: {
            installedAppId,
            username,
            address,
            note: input.note?.trim() || null,
            createdById: actorId
        },
        // A note given the second time replaces the first; an empty one leaves
        // whatever was written there, since blank is what the form sends when
        // somebody is only adding an address.
        update: input.note?.trim() ? { note: input.note.trim() } : {}
    });
    if (install.edition !== "java") return;
    // A server that is not answering must not fail the grant: the row is the
    // record, and `reconcileWhitelist` hands it over the next time the server is
    // up. A server that answered and refused is the opposite - the player has
    // been told they are on the list and the game disagrees, so that is said out
    // loud, naming the part that did work so nobody adds them twice.
    await whitelistPlayer(ownerId, installedAppId, username).catch((caught: unknown) => {
        if (!(caught instanceof WhitelistRefused)) return null;
        throw new Error(`${username} is on this server's player list, but the game would not take them: ${caught.message}`);
    });
}

/**
 * Take one address off a player, leaving the rest.
 *
 * Removing their last one is removing them, and it says so rather than leaving a
 * name on the list with nowhere to connect from - which would read as allowed and
 * behave as refused.
 */
export async function revokePlayerAddress(
    ownerId: string,
    installedAppId: string,
    username: string,
    address: string
): Promise<void> {
    await resolve(ownerId, installedAppId);
    await prisma.gamePlayerAccess.deleteMany({ where: { installedAppId, username, address } });
    const left = await prisma.gamePlayerAccess.count({ where: { installedAppId, username } });
    if (left === 0) {
        await revokePlayerAccess(ownerId, installedAppId, username);
        return;
    }
    // They still have a way in, so they are not thrown off - but the pass that
    // checks who is on will kick them if they are sitting on the one just removed.
    await enforcePlayerAddresses(ownerId, installedAppId).catch(() => null);
}

/** Take a player off the list entirely and, if they are on right now, off the
 *  server. Every address they had goes with them. */
export async function revokePlayerAccess(ownerId: string, installedAppId: string, username: string): Promise<void> {
    const install = await resolve(ownerId, installedAppId);
    await prisma.gamePlayerAccess.deleteMany({ where: { installedAppId, username } });
    if (install.edition === "java") {
        // Every entry under the name goes, including one a previous version of
        // this left behind under an identity the login never matched - a player
        // taken off the list has to be off it.
        await unwhitelistPlayer(ownerId, installedAppId, username).catch(() => null);
    }
    await runServerCommand(ownerId, installedAppId, [
        "kick",
        username,
        "You are no longer on this server's player list."
    ]).catch(() => null);
}

/** Turn the address half on or off for this server. The username half is the
 *  game's whitelist and is not affected. */
export async function setAddressBinding(ownerId: string, installedAppId: string, enabled: boolean): Promise<void> {
    await resolve(ownerId, installedAppId);
    await patchInstallConfig(installedAppId, { bindAddresses: enabled });
}

export interface AccessEnforcement {
    /** Players kicked by this pass. */
    readonly kicked: readonly string[];
    /** Players who are on but whose address the log did not carry, so nothing could
     *  be judged about them. */
    readonly unknown: readonly string[];
    /** True when this pass saw somebody arrive from outside the network, which is
     *  the only proof there is that the server's port is actually open. */
    readonly reachedFromOutside: boolean;
}

/**
 * Look at who is on and act on it: remove whoever should not be there, and note
 * whether anybody got in from outside the network.
 *
 * Both halves need the same thing - the addresses the log recorded on each join -
 * which is why one pass does them together rather than reading that log twice.
 *
 * Only Java: Bedrock's log names the player and never the address, so there is
 * nothing to compare and pretending otherwise would kick everybody. A server with
 * no rules at all is left alone rather than emptied - that is a server whose list
 * has not been set up, not one whose list says "nobody".
 */
export async function enforcePlayerAddresses(ownerId: string, installedAppId: string): Promise<AccessEnforcement> {
    const install = await resolve(ownerId, installedAppId);
    const nothing: AccessEnforcement = { kicked: [], unknown: [], reachedFromOutside: false };
    if (install.edition !== "java" || !install.applicationId) return nothing;

    const [status, rules] = await Promise.all([
        getServerPlayers(ownerId, installedAppId),
        playerAccessRules(installedAppId)
    ]);
    if (!status.answering) return nothing;

    // Before anything about who is on: a player granted while the server was down
    // is only on the game's list once somebody puts them there, and nobody does.
    // It runs whether or not the address half is enforced, because the username
    // half always is, and whether or not anybody is playing - an empty server is
    // the one somebody is trying to join.
    await reconcileWhitelist(ownerId, installedAppId, rules).catch(() => []);

    if (status.players.players.length === 0) return nothing;

    const log = await readAppRuntimeLog(install.applicationId, ownerId, JOIN_LOG_TAIL).catch(() => "");
    const addresses = parseJoinAddresses(log);

    // Reachability first, and for everyone on rather than only the allowed: a
    // player who was about to be kicked still proves the packet arrived.
    let reachedFromOutside = false;
    for (const player of status.players.players) {
        const address = addresses.get(player.toLowerCase());
        if (address && (await noteReachedFrom(installedAppId, address))) reachedFromOutside = true;
    }

    // The list is only enforced once there is a list. A server whose rules were all
    // removed is one nobody has set up, and emptying it would be a surprise.
    if (!install.bindAddresses || rules.length === 0) return { kicked: [], unknown: [], reachedFromOutside };

    const kicked: string[] = [];
    const unknown: string[] = [];
    for (const player of status.players.players) {
        const address = addresses.get(player.toLowerCase()) ?? null;
        // A player whose join line has scrolled out of the log is judged on their
        // name alone: kicking them for a line that has aged out would empty the
        // server every time somebody talked a lot.
        if (address === null) unknown.push(player);
        const refusal = accessRefusal(player, address, rules);
        if (!refusal) continue;
        await runServerCommand(ownerId, installedAppId, ["kick", player, refusal]).catch(() => null);
        kicked.push(player);
    }
    return { kicked, unknown, reachedFromOutside };
}
