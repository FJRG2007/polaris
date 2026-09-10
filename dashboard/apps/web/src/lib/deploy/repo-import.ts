/**
 * Turning what a repository's deploy files say into a new service's settings.
 *
 * The reading is `importDeployConfig` in the deploy package; this decides where
 * each piece lands. Everything the person creating the service typed wins over
 * the file - a root directory they set is kept, a Dockerfile path they changed is
 * kept - so the file only fills what was left to defaults.
 */

import { prisma } from "@polaris/db";
import { randomBytes } from "node:crypto";
import { normalizeRoot } from "@polaris/deploy";
import { edgeBalancingSchema, parseAppEdgeConfig } from "@polaris/core";
import { setEnvVar, setEnvVars } from "@/lib/env-var-service";
import type { ImportedConfig, PickedSetting } from "@polaris/deploy";

/** The most copies a config file can ask a new service for. */
const MAX_IMPORTED_REPLICAS = 10;

function setting(imported: ImportedConfig, name: PickedSetting["setting"]): string | undefined {
    return imported.settings.find((entry) => entry.setting === name)?.value;
}

/** What goes into the service as it is created. */
export interface ImportedCreate {
    readonly rootDirectory?: string;
    readonly dockerfilePath?: string;
    readonly buildConfig: Record<string, unknown>;
    readonly replicas?: number;
}

/**
 * The creation-time half: directories, commands and the copy count. `typed` is
 * what the form already carries, which the file never overrides.
 */
export function importedCreate(
    imported: ImportedConfig | null,
    typed: { rootDirectory?: string; dockerfilePath?: string; builder: "dockerfile" | "nixpacks" }
): ImportedCreate {
    const buildConfig: Record<string, unknown> = {};
    // Every service created from here on may be built from a generated image for
    // its language (see `BuildCommands.languages`).
    if (typed.builder === "nixpacks") buildConfig.languageImages = true;
    if (!imported) return { buildConfig };
    for (const key of ["installCommand", "buildCommand", "startCommand"] as const) {
        const value = setting(imported, key);
        if (value) buildConfig[key] = value;
    }
    const output = normalizeRoot(setting(imported, "outputDirectory"));
    if (output) buildConfig.outputDirectory = output;
    const root = typed.rootDirectory?.trim() ? undefined : normalizeRoot(setting(imported, "rootDirectory"));
    const dockerfile = setting(imported, "dockerfilePath");
    const copies = Number(setting(imported, "replicas"));
    return {
        buildConfig,
        ...(root ? { rootDirectory: root } : {}),
        // Only onto a Dockerfile build whose path was left as the default.
        ...(dockerfile && typed.builder === "dockerfile" && (!typed.dockerfilePath || typed.dockerfilePath === "Dockerfile")
            ? { dockerfilePath: dockerfile }
            : {}),
        ...(Number.isInteger(copies) && copies > 1 ? { replicas: Math.min(MAX_IMPORTED_REPLICAS, copies) } : {})
    };
}

/**
 * The after-creation half: variables, generated secrets and the health path.
 * Answers the variables still waiting for a value, for the creator to be told.
 */
export async function applyImportedAfterCreate(
    applicationId: string,
    ownerId: string,
    imported: ImportedConfig | null
): Promise<string[]> {
    if (!imported) return [];
    const plain = Object.entries(imported.variables).map(([key, value]) => ({ key, value, isSecret: false }));
    if (plain.length > 0) await setEnvVars("application", applicationId, ownerId, plain);
    for (const key of imported.generate) {
        // 32 random bytes, which is what every framework asking for one accepts.
        await setEnvVar("application", applicationId, ownerId, {
            key,
            value: randomBytes(32).toString("base64url"),
            isSecret: true
        }).catch(() => undefined);
    }
    const healthPath = setting(imported, "healthPath");
    if (healthPath) {
        const app = await prisma.application.findUnique({ where: { id: applicationId }, select: { edgeConfig: true } });
        const edge = parseAppEdgeConfig(app?.edgeConfig);
        // Held to the same rule the Scaling settings apply to a typed one.
        const balancing = edgeBalancingSchema.safeParse({ ...edge.balancing, healthPath });
        if (balancing.success) {
            await prisma.application.update({
                where: { id: applicationId },
                data: { edgeConfig: JSON.stringify({ ...edge, balancing: balancing.data }) }
            });
        }
    }
    return [...imported.needs];
}
