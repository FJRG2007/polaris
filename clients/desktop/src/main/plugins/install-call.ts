/**
 * The answer to the page's Install / Update (`CHANNELS.pluginsInstall`, and the
 * `desktop:addons-install` name older dashboards call). Every path answers: a
 * refused call, a failed or stuck install and a throw each come back as
 * `{ ok: false, reason }`, which every dashboard version reads and says. Pure of
 * Electron, for the tests; `electron.ts` gives it the manager.
 */

import { z } from "zod";
import type { InstallCallResult } from "./manager";
import { PLUGIN_PERMISSIONS, type PluginPermission } from "@polaris/core/device-plugins";

export const pluginIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,47}$/);
export const requirementKeySchema = z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/);

/** How long keeping the consent for what it sets up may take; past it the install still answers as done. */
export const AFTER_INSTALL_LIMIT_MS = 15_000;

export type InstallAnswer = InstallCallResult | { ok: false; reason: "refused"; };

export interface InstallCallDeps {
    /** The asking page is the Polaris one. */
    readonly allowed: boolean;
    readonly install: (id: string, accepted: readonly PluginPermission[]) => Promise<InstallCallResult>;
    /** After an install whose consent listed `requires`: keep the consent and set them up. */
    readonly installedWith: (id: string, requires: readonly string[]) => Promise<void>;
    readonly log: (text: string) => void;
    readonly afterInstallLimitMs?: number;
}

export async function answerInstall(deps: InstallCallDeps, id: unknown, accepted: unknown, requires: unknown): Promise<InstallAnswer> {
    const parsedId = pluginIdSchema.safeParse(id);
    const parsedAccepted = z.array(z.enum(PLUGIN_PERMISSIONS)).max(PLUGIN_PERMISSIONS.length).safeParse(accepted);
    // A page older than requirements sends none: nothing is consented to, and the plugin's page offers it instead.
    const parsedRequires = z.array(requirementKeySchema).max(8).safeParse(requires ?? []);
    if (!deps.allowed || !parsedId.success || !parsedAccepted.success || !parsedRequires.success) return { ok: false, reason: "refused" };
    let result: InstallCallResult;
    try {
        result = await deps.install(parsedId.data, parsedAccepted.data);
    } catch (error) {
        deps.log(`install of ${parsedId.data} threw: ${error instanceof Error ? error.message : String(error)}`);
        return { ok: false, reason: "failed" };
    }
    if (!result.ok) return result;
    // The plugin is in: what it sets up afterwards never turns that into a failure, nor holds the answer.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const after = deps.installedWith(parsedId.data, parsedRequires.data).catch((error: unknown) => {
        deps.log(`setting up ${parsedId.data} after its install failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    const limit = new Promise<void>((done) => {
        timer = setTimeout(() => {
            deps.log(`setting up ${parsedId.data} after its install is still running; answering now`);
            done();
        }, deps.afterInstallLimitMs ?? AFTER_INSTALL_LIMIT_MS);
    });
    await Promise.race([after, limit]);
    clearTimeout(timer);
    return result;
}
