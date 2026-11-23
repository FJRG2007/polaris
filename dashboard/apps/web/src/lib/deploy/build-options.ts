/**
 * A service's Dockerfile build options: the stage to stop at and the ARG values
 * the build is given. Kept on the build config, read by every deploy, and empty
 * by default - which is how every service built before the setting existed.
 */

import { prisma } from "@polaris/db";
import { buildOptionsView, type BuildOptionsInput } from "./build-options-schema";

function parseBuild(raw: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(raw || "{}") as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

export async function readBuildOptions(
    applicationId: string,
    ownerId: string
): Promise<BuildOptionsInput & { readonly sourceType: string }> {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        select: { buildConfig: true, sourceType: true }
    });
    if (!app) throw new Error("Application not found");
    return { ...buildOptionsView(parseBuild(app.buildConfig)), sourceType: app.sourceType };
}

/** Store validated options; the next deploy builds with them. False when nothing
 *  changed. */
export async function setBuildOptions(
    applicationId: string,
    ownerId: string,
    next: BuildOptionsInput
): Promise<boolean> {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        select: { id: true, buildConfig: true }
    });
    if (!app) throw new Error("Application not found");
    const build = parseBuild(app.buildConfig);
    const current = buildOptionsView(build);
    if (JSON.stringify(current) === JSON.stringify(next)) return false;
    build.targetStage = next.targetStage || undefined;
    build.buildArgs = next.args.length > 0 ? Object.fromEntries(next.args.map((row) => [row.key, row.value])) : undefined;
    await prisma.application.update({ where: { id: app.id }, data: { buildConfig: JSON.stringify(build) } });
    return true;
}
