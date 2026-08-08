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
import { parseJoinAddresses } from "@/lib/apps/minecraft/parse";
import { patchInstallConfig, readInstallConfig } from "@/lib/apps/install-config";
import { accessRefusal, isAddressRule, isPlayerName, type PlayerAccess } from "@/lib/apps/minecraft/access";
import { editionOf, getServerPlayers, runServerCommand, type MinecraftEdition } from "@/lib/apps/minecraft/service";

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

/** The rules alone, for the enforcement pass and for anything deciding a join. */
export async function playerAccessRules(installedAppId: string): Promise<PlayerAccess[]> {
    const rows = await prisma.gamePlayerAccess.findMany({
        where: { installedAppId },
        select: { username: true, address: true }
    });
    return rows.map((row) => ({ username: row.username, address: row.address }));
}

/**
 * Add a player, or move an existing one to a different address.
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
        where: { installedAppId_username: { installedAppId, username } },
        create: {
            installedAppId,
            username,
            address,
            note: input.note?.trim() || null,
            createdById: actorId
        },
        update: { address, note: input.note?.trim() || null }
    });
    // Best effort: the row is the record, and a server that is not answering yet
    // must not fail the grant - the next enforcement pass reconciles it.
    if (install.edition === "java") {
        await runServerCommand(ownerId, installedAppId, ["whitelist", "add", username]).catch(() => null);
    }
}

/** Take a player off the list and, if they are on right now, off the server. */
export async function revokePlayerAccess(ownerId: string, installedAppId: string, username: string): Promise<void> {
    const install = await resolve(ownerId, installedAppId);
    await prisma.gamePlayerAccess.deleteMany({ where: { installedAppId, username } });
    if (install.edition === "java") {
        await runServerCommand(ownerId, installedAppId, ["whitelist", "remove", username]).catch(() => null);
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
    if (!status.answering || status.players.players.length === 0) return nothing;

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
