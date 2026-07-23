/**
 * Install-wizard input, shared by the marketplace client form and the server
 * action so they never disagree. The manifest (lib/apps/catalog.ts) declares
 * which volumes and env vars an app needs; this validates the operator's choices
 * for a specific install: the server it runs on and where each volume is stored.
 */

import { z } from "zod";

/** Where an app's volume lives: a server-local docker volume, or a NAS mount. */
export const appStorageChoiceSchema = z
    .object({
        volumeName: z.string().trim().min(1).max(64),
        backing: z.enum(["local", "nas"]),
        // Required for "nas": the storage connection the volume is mounted from.
        connectionId: z.string().uuid().optional()
    })
    .superRefine((value, ctx) => {
        if (value.backing === "nas" && !value.connectionId) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["connectionId"],
                message: "Choose a NAS connection for this volume"
            });
        }
    });

export const appInstallInputSchema = z.object({
    /** Catalog manifest id, e.g. "minecraft". */
    catalogId: z.string().trim().min(1).max(64),
    /** Instance name, e.g. "Survival server". */
    name: z.string().trim().min(1).max(64),
    /** The chosen server: "local" or a connected host id. */
    serverId: z.string().trim().min(1),
    /** One choice per template volume. */
    storage: z.array(appStorageChoiceSchema).max(16).default([]),
    /** Operator-set values for the manifest's declared env vars. */
    env: z
        .array(z.object({ key: z.string().trim().min(1).max(128), value: z.string().max(4096) }))
        .max(64)
        .default([])
});

export type AppStorageChoice = z.infer<typeof appStorageChoiceSchema>;
export type AppInstallInput = z.infer<typeof appInstallInputSchema>;
