/**
 * The door: a small resource Polaris installs into every FiveM server it creates,
 * and the file it reads.
 *
 * FiveM has no whitelist and no ban list. The console can throw somebody off and
 * they are back before the door has shut, so a server whose access is only
 * enforced from the dashboard is a server with no access control at all. The only
 * place a connection can actually be refused is inside the server, in the
 * `playerConnecting` event, which means a resource - the same conclusion txAdmin
 * reached and for the same reason.
 *
 * So this is deliberately the smallest resource that can do the job. It reads one
 * JSON file that Polaris writes, on each connection rather than on a signal, so
 * there is no reload to go wrong and no state to get out of step: whatever the
 * file says at the moment somebody knocks is what happens to them. A file it
 * cannot read lets everybody in - a server that refuses the whole world because a
 * write was interrupted is a far worse failure than one that is briefly open, and
 * the one it would refuse first is the owner trying to fix it.
 *
 * The operator never installs it, never enables it and is never told about it.
 * It is written when the server is created and rewritten whenever the list
 * changes, which is what "a feature is not shipped until it works with no setup"
 * means here.
 */

import { RESOURCES_ROOT } from "@/lib/apps/fivem/config";
import { activeBans, DEFAULT_BAN_REASON, type FivemAccess } from "@/lib/apps/fivem/access";

/** What the resource is called, which is what `ensure` in the config names. */
export const GUARD_RESOURCE = "polaris";

/** Where its files live inside the container. */
export const GUARD_ROOT = `${RESOURCES_ROOT}/${GUARD_RESOURCE}`;

/** The file Polaris writes and the resource reads. */
export const GUARD_ACCESS_FILE = `${GUARD_ROOT}/access.json`;

/** The name of the block in `server.cfg` that starts it. */
export const GUARD_BLOCK = "Polaris resources";

/** What somebody is told when the server is closed and they are not on the list. */
export const CLOSED_MESSAGE = "This server only lets in players its owner has added.";

/** The console command the resource adds so one player can be spoken to. FiveM's
 *  own `say` reaches the whole room and there is nothing that reaches one person. */
export const DM_COMMAND = "polaris_dm";

/** Who a direct message is from, as the player sees it. */
export const DM_SENDER = "Server";

/**
 * The resource manifest.
 *
 * `cerulean` because it is the manifest version every current build reads, and a
 * server script and nothing else: this resource has no client half, sends nothing
 * to anybody's game, and would be a strange thing to be downloading files from.
 */
export const GUARD_MANIFEST = `fx_version "cerulean"
game "gta5"

name "polaris"
description "Who may join this server, kept in step with Polaris."
author "Polaris"
version "1.0.0"

server_script "server.lua"
`;

/**
 * The resource itself.
 *
 * Written out here rather than kept as a file on disk beside the dashboard: it
 * has to reach the inside of a container on a machine that may not be this one,
 * and the transport that gets it there carries text. It is short enough to read
 * in one sitting, which is the only real defence a piece of code with this much
 * authority has.
 */
export const GUARD_SCRIPT = `-- Managed by Polaris. Edits here are replaced whenever the player list changes.
--
-- Deliberately plain Lua 5.3: FiveM only runs a resource as 5.4 when its manifest
-- asks for it, and a 5.4-only spelling in a 5.3 resource is a syntax error - which
-- here means a door that never loads and a closed server that lets everybody in.
local RESOURCE = GetCurrentResourceName()

--- Whatever Polaris last wrote, or nil when there is nothing readable there.
local function readAccess()
    local raw = LoadResourceFile(RESOURCE, "access.json")
    if not raw then return nil end
    local ok, parsed = pcall(json.decode, raw)
    if not ok or type(parsed) ~= "table" then return nil end
    return parsed
end

--- Everything this client presented, lowercased, so a rule can be matched
--- against it whichever way it was typed.
local function identifiersOf(player)
    local held = {}
    for index = 0, GetNumPlayerIdentifiers(player) - 1 do
        held[#held + 1] = string.lower(GetPlayerIdentifier(player, index))
    end
    return held
end

--- The first row of a list this client matches, or nil.
local function firstMatch(rows, held)
    if type(rows) ~= "table" then return nil end
    for _, row in ipairs(rows) do
        local wanted = string.lower(row.identifier or "")
        if wanted ~= "" then
            for _, mine in ipairs(held) do
                if mine == wanted then return row end
            end
        end
    end
    return nil
end

AddEventHandler("playerConnecting", function(_name, _setKickReason, deferrals)
    local player = source
    deferrals.defer()
    Wait(0)

    local access = readAccess()
    if access == nil then
        -- Nothing readable to enforce. Open rather than shut, deliberately.
        deferrals.done()
        return
    end

    local held = identifiersOf(player)

    local ban = firstMatch(access.bans, held)
    if ban ~= nil then
        local reason = ban.reason
        if reason == nil or reason == "" then reason = ${JSON.stringify(DEFAULT_BAN_REASON)} end
        deferrals.done(reason)
        return
    end

    if access.exclusiveJoin == true and firstMatch(access.allowList, held) == nil then
        deferrals.done(access.closedMessage or ${JSON.stringify(CLOSED_MESSAGE)})
        return
    end

    deferrals.done()
end)

--- Say something to one player rather than to the room.
---
--- The console can broadcast and cannot address anybody, so this is the other
--- half. Restricted, which means the console and an administrator and nobody
--- else: a player who could run it could put words in the server's mouth.
RegisterCommand("${DM_COMMAND}", function(caller, args)
    local target = tonumber(args[1])
    if target == nil then return end
    local message = table.concat(args, " ", 2)
    if message == "" then return end
    TriggerClientEvent("chat:addMessage", target, {
        color = { 236, 120, 61 },
        multiline = true,
        args = { ${JSON.stringify(DM_SENDER)}, message }
    })
end, true)
`;

/** What the file the resource reads holds. Only what a decision at the door needs:
 *  no labels, no dates, nothing a moderator reads on a screen. */
export interface GuardAccessFile {
    readonly exclusiveJoin: boolean;
    readonly allowList: readonly { readonly identifier: string }[];
    readonly bans: readonly { readonly identifier: string; readonly reason: string }[];
    readonly closedMessage: string;
}

/**
 * The file, from the lists as Polaris holds them.
 *
 * Bans that have run out are left out rather than sent with an end date for the
 * resource to compare: a container's clock is not necessarily this one's, and a
 * timeout that outlives itself by an hour because of it is a moderator's word
 * being broken by arithmetic nobody can see.
 */
export function guardAccessFile(access: FivemAccess, now: Date = new Date()): GuardAccessFile {
    return {
        exclusiveJoin: access.exclusiveJoin,
        allowList: access.allowList.map((entry) => ({ identifier: entry.identifier })),
        bans: activeBans(access.bans, now).map((entry) => ({
            identifier: entry.identifier,
            reason: entry.reason || DEFAULT_BAN_REASON
        })),
        closedMessage: CLOSED_MESSAGE
    };
}

/** The `server.cfg` lines that start it. */
export function guardCfgLines(): string[] {
    return [`ensure ${GUARD_RESOURCE}`];
}
