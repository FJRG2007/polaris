/**
 * What creating a game server takes, shared by the dialog and the action so the
 * two can never disagree about it. The manager asks for what decides the shape of
 * the server - who it is for, how many of them, and what game it runs - and works
 * the rest out: which image, how much memory, which plugins, what address.
 *
 * One schema per game, joined on the game itself. The questions genuinely differ -
 * a Minecraft server has an edition and a world seed, an ARK server has a map and
 * a Steam id - and a single flat object with half its fields optional is a schema
 * that cannot refuse anything: it would accept a seed for ARK and an ARK map for
 * Bedrock, and the refusal would land at the container instead of at the form.
 */

import { z } from "zod";
import { isArkMap } from "@/lib/apps/ark/maps";
import { isBiome, isLevelType, isSeed } from "@/lib/apps/minecraft/world";
import { isAddressRule, isPlayerName } from "@/lib/apps/minecraft/access";
import { isJoinPassword, isSteamId, JOIN_PASSWORD_HINT } from "@/lib/apps/ark/access";

/** What every server is asked, whatever it plays: what it is called, where it
 *  runs, how big it is and what it answers to. */
const commonFields = {
    name: z.string().trim().min(1, "Name the server").max(48),
    /** "local" or a connected server's id. */
    serverId: z.string().trim().min(1),
    /** Slots. What the server refuses past, not what it plans for. */
    maxPlayers: z.number().int().min(1).max(1000).default(20),
    /** How many are realistically on at once, which is what memory follows. */
    concurrentPlayers: z.number().int().min(1).max(1000).default(8),
    /** Subdomain to take, when a domain is configured. Blank derives it from the name. */
    subdomain: z.string().trim().max(63).optional()
};

const minecraftServerSchema = z.object({
    game: z.literal("minecraft"),
    ...commonFields,
    /** The player the server is created for. Required: both images enforce a
     *  list, and a server created without a name on it is one nobody can join. */
    ownerPlayer: z.string().trim().min(1, "Give the username that will run the server").max(16),
    /** Where that player connects from - one address, a CIDR range, or "any". */
    ownerAddress: z.string().trim().min(1, "Give the address that player connects from").max(43),
    /** Which client it is for. Crossplay makes a Java server Bedrock can also join. */
    edition: z.enum(["java", "bedrock"]),
    crossplay: z.boolean().default(false),
    blueprintId: z.string().trim().min(1).max(48).default("survival"),
    /** Java only: PAPER, FABRIC, ... The blueprint may pin it. */
    software: z.string().trim().max(32).optional(),
    version: z.string().trim().max(32).default("LATEST"),
    /** The world to generate. Any text: a number is used as itself, anything
     *  else is hashed. Blank is a random world. */
    seed: z.string().trim().max(64).optional(),
    /** The shape of the world. Java only; Bedrock names its own differently. */
    levelType: z.string().trim().max(64).refine(isLevelType, "That is not a world type").optional(),
    /** Which biome the whole overworld is, when the type is the one-biome one. */
    biome: z.string().trim().max(64).refine(isBiome, "That is not a biome").optional()
});

const arkServerSchema = z.object({
    game: z.literal("ark"),
    ...commonFields,
    /** The map its world is generated on. A closed set: the level names are case
     *  sensitive and four of them are not what the map is called. */
    map: z.string().trim().min(1).max(64).refine(isArkMap, "That is not a map this server can run"),
    /** The name the server shows in the in-game browser, which is not the name
     *  Polaris files it under. */
    sessionName: z.string().trim().min(1, "Name the server as players will see it").max(64),
    /** What a player types to get in. Always set: the image's own default is
     *  published in its documentation. */
    joinPassword: z.string().trim().min(1, "Give a join password"),
    /** The SteamID64 of whoever is creating it, so a closed server has somebody
     *  who can actually get into it. */
    ownerSteamId: z.string().trim().min(1, "Give your Steam id"),
    /** How the owner is listed on the allow list, since a 17-digit number
     *  identifies nobody on sight. */
    ownerLabel: z.string().trim().max(48).optional(),
    /** Whether only the players on the allow list may join. On unless somebody
     *  deliberately opens it. */
    exclusiveJoin: z.boolean().default(true),
    /** Steam Workshop ids, comma separated. */
    mods: z.string().trim().max(512).optional()
});

export const createGameServerSchema = z
    .discriminatedUnion("game", [minecraftServerSchema, arkServerSchema])
    .superRefine((value, ctx) => {
        if (value.concurrentPlayers > value.maxPlayers) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["concurrentPlayers"],
                message: "There cannot be more players at once than there are slots"
            });
        }
        if (value.game === "ark") {
            if (!isSteamId(value.ownerSteamId)) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ["ownerSteamId"],
                    message: "A Steam id is the 17-digit number from your profile, starting 7656119"
                });
            }
            if (!isJoinPassword(value.joinPassword)) {
                ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["joinPassword"], message: JOIN_PASSWORD_HINT });
            }
            if (value.mods !== undefined && value.mods.length > 0 && !isModIdList(value.mods)) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ["mods"],
                    message: "Workshop ids are numbers, comma separated"
                });
            }
            return;
        }
        if (!isPlayerName(value.edition, value.ownerPlayer)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["ownerPlayer"],
                message:
                    value.edition === "bedrock"
                        ? "That is not an Xbox gamertag"
                        : "A Minecraft username is 3 to 16 letters, digits or underscores"
            });
        }
        if (!isAddressRule(value.ownerAddress)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["ownerAddress"],
                message: "Give one address, a range like 203.0.113.0/24, or \"any\""
            });
        }
        if (value.seed !== undefined && value.seed.length > 0 && !isSeed(value.seed)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["seed"],
                message: "A seed is up to 64 characters of ordinary text"
            });
        }
        if (value.crossplay && value.edition !== "java") {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["crossplay"],
                message: "Crossplay is a Java server that Bedrock players can also join"
            });
        }
    });

/** Workshop ids as the image wants them: numbers separated by commas, and
 *  nothing else - the value is passed to steamcmd, so a stray word in it is a
 *  mod install that fails on every start. */
export function isModIdList(value: string): boolean {
    return value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .every((entry) => /^\d{1,12}$/.test(entry));
}

export type CreateGameServerInput = z.infer<typeof createGameServerSchema>;
export type CreateMinecraftServerInput = z.infer<typeof minecraftServerSchema>;
export type CreateArkServerInput = z.infer<typeof arkServerSchema>;
