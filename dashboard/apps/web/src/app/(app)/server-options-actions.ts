"use server";

/**
 * The page of servers a server picker shows, for whoever is signed in.
 */

import { localServerName } from "@/lib/local-server";
import { requirePermission, requireUser, sessionCan, type SessionUser } from "@/lib/session";
import { requireEnvironmentAccess } from "@/lib/deploy-project-access";
import { getTranslations } from "@/lib/i18n/request";
import {
    LOCAL_SERVER_OPTION,
    serverOptionsRequestSchema,
    type ServerOption
} from "@/lib/server-options-schema";
import { readServerOptions, type ServerOptionsPage } from "@/lib/server-options";

/** The screens that pick among one's own servers: databases read under
 *  `deploy.read`, runners and the rest of the server tools under `system.manage`. */
async function mayPickServers(user: SessionUser): Promise<boolean> {
    return (await sessionCan(user, "deploy.read")) || sessionCan(user, "system.manage");
}

export async function listServerOptionsAction(
    input: unknown
): Promise<ServerOptionsPage | { error: string }> {
    const parsed = serverOptionsRequestSchema.safeParse(input);
    const environmentId = parsed.success ? parsed.data.environmentId : undefined;
    // The same gate as deploying there: a project's servers are its owner's, and
    // are read under the grant to read the project.
    const user = environmentId ? await requirePermission("deploy.manage") : await requireUser();
    const t = await getTranslations("components");
    if (!parsed.success) return { error: t("asyncSelect.failed") };
    if (!environmentId && !(await mayPickServers(user))) return { error: t("asyncSelect.failed") };
    const request = parsed.data;
    try {
        const ownerId = environmentId
            ? (await requireEnvironmentAccess(environmentId, user.id, "project.read")).ownerId
            : user.id;
        const ids = request.ids?.filter((id) => id !== LOCAL_SERVER_OPTION);
        const wantsLocal =
            request.includeLocal === true &&
            request.cursor === null &&
            (!request.ids || request.ids.includes(LOCAL_SERVER_OPTION));
        const page =
            ids && ids.length === 0
                ? { items: [], next: null }
                : await readServerOptions(ownerId, { ...request, ids });
        if (!wantsLocal) return page;
        const name = await localServerName();
        const local: ServerOption = {
            id: LOCAL_SERVER_OPTION,
            name,
            address: "",
            os: null,
            environment: "local",
            root: true,
            online: true
        };
        const matches = name.toLowerCase().includes(request.query.toLowerCase());
        return matches ? { ...page, items: [local, ...page.items] } : page;
    } catch (error) {
        console.error("[server-options] read failed", error);
        return { error: t("asyncSelect.failed") };
    }
}
