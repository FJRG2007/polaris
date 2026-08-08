/**
 * What creating a game server takes, shared by the dialog and the action so the
 * two can never disagree about it. The manager asks for what decides the shape of
 * the server - who it is for, how many of them, and what game it runs - and works
 * the rest out: which image, how much memory, which plugins, what address.
 */

import { z } from "zod";

export const createGameServerSchema = z
    .object({
        name: z.string().trim().min(1, "Name the server").max(48),
        /** Which client it is for. Crossplay makes a Java server Bedrock can also join. */
        edition: z.enum(["java", "bedrock"]),
        crossplay: z.boolean().default(false),
        blueprintId: z.string().trim().min(1).max(48).default("survival"),
        /** Java only: PAPER, FABRIC, ... The blueprint may pin it. */
        software: z.string().trim().max(32).optional(),
        version: z.string().trim().max(32).default("LATEST"),
        /** "local" or a connected server's id. */
        serverId: z.string().trim().min(1),
        /** Slots. What the server refuses past, not what it plans for. */
        maxPlayers: z.number().int().min(1).max(1000).default(20),
        /** How many are realistically on at once, which is what memory follows. */
        concurrentPlayers: z.number().int().min(1).max(1000).default(8),
        /** Subdomain to take, when a domain is configured. Blank derives it from the name. */
        subdomain: z.string().trim().max(63).optional()
    })
    .superRefine((value, ctx) => {
        if (value.concurrentPlayers > value.maxPlayers) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["concurrentPlayers"],
                message: "There cannot be more players at once than there are slots"
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

export type CreateGameServerInput = z.infer<typeof createGameServerSchema>;
