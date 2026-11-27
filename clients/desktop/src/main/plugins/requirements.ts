/**
 * What a plugin's manifest has this platform set up for it (`requires`, a
 * driver say). The install consent lists each one, so installing is the
 * consent: it is set up right after the install, and set up again by itself
 * when something else undoes it (the device plugged in later with another
 * driver on it). One that was never consented to (an install from before the
 * plugin needed it, or a declined or failed setup) is offered on the plugin's
 * page as a host action, in the plugin's own words, until it is set up.
 *
 * Nothing here knows any one plugin: `runnerFor` answers what can set a
 * requirement up on this machine, and null leaves it unknown and unoffered.
 */

import { z } from "zod";
import { pluginRequirements, type PluginHostAction, type PluginManifest, type PluginPlatform, type PluginRequirement } from "@polaris/core/device-plugins";

/** Where a requirement stands: set up, missing, or not checkable now (the device is away). `before`: it was set up by Polaris once. */
export interface RequirementLook {
    readonly state: "met" | "missing" | "away";
    readonly before: boolean;
}

export type RequirementOutcome = { readonly ok: true; } | { readonly ok: false; readonly reason: string; };

export interface RequirementRunner {
    look(): Promise<RequirementLook>;
    setUp(): Promise<RequirementOutcome>;
}

export interface RequirementsDeps {
    readonly platform: PluginPlatform | null;
    runnerFor(id: string, key: string): RequirementRunner | null;
    /** The consents kept on disk: read whole, written whole. */
    read(): Promise<unknown>;
    write(value: Record<string, string[]>): Promise<void>;
    /** Something the snapshot answers changed (an action came or went). */
    changed(): void;
    /** It was set up again by itself, after something else undid it. */
    restored(id: string, requirement: PluginRequirement): void;
}

const consentsSchema = z.record(z.string().max(48), z.array(z.string().max(40)).max(8));

/** Why an automatic setup is attempted; only `asked` follows a person's click. */
export type EnsureReason = "install" | "start" | "plugged" | "asked";

export function createRequirements(deps: RequirementsDeps) {
    let consents: Record<string, string[]> | null = null;
    const looks = new Map<string, RequirementLook>();
    /** The last setup that did not go through: an automatic one does not ask again until the person does. */
    const failures = new Map<string, string>();
    const busy = new Set<string>();
    const slot = (id: string, key: string) => `${id}\u0000${key}`;

    async function kept(): Promise<Record<string, string[]>> {
        if (consents) return consents;
        const parsed = consentsSchema.safeParse(await deps.read().catch(() => null));
        consents = parsed.success ? { ...parsed.data } : {};
        return consents;
    }

    async function consent(id: string, keys: readonly string[]): Promise<void> {
        if (keys.length === 0) return;
        const all = await kept();
        const next = [...new Set([...(all[id] ?? []), ...keys])].slice(0, 8);
        if (next.length === (all[id]?.length ?? 0)) return;
        all[id] = next;
        await deps.write(all);
    }

    async function lookAt(id: string, requirement: PluginRequirement): Promise<RequirementLook | null> {
        const runner = deps.runnerFor(id, requirement.key);
        if (!runner) return null;
        const seen = await runner.look().catch(() => null);
        if (seen) looks.set(slot(id, requirement.key), seen);
        return seen;
    }

    /** Consented to with the install, or set up by Polaris before (an install from before the consent was kept). */
    async function consented(id: string, key: string, seen: RequirementLook | null): Promise<boolean> {
        return Boolean(seen?.before) || ((await kept())[id] ?? []).includes(key);
    }

    async function setUp(id: string, requirement: PluginRequirement, reason: EnsureReason): Promise<boolean> {
        const runner = deps.runnerFor(id, requirement.key);
        const at = slot(id, requirement.key);
        if (!runner || busy.has(at)) return false;
        busy.add(at);
        try {
            const outcome = await runner.setUp().catch((): RequirementOutcome => ({ ok: false, reason: "failed" }));
            // An absent device is not a refusal: it is set up when the device comes back.
            if (outcome.ok) failures.delete(at);
            else if (outcome.reason !== "unplugged") failures.set(at, outcome.reason);
            const seen = await lookAt(id, requirement);
            if (outcome.ok && seen?.state !== "missing" && (reason === "start" || reason === "plugged")) deps.restored(id, requirement);
            return outcome.ok;
        } finally {
            busy.delete(at);
            deps.changed();
        }
    }

    return {
        consent,

        /** Drop what an uninstalled plugin was consented to. */
        async forget(id: string): Promise<void> {
            const all = await kept();
            for (const key of [...looks.keys(), ...failures.keys()]) {
                if (!key.startsWith(`${id}\u0000`)) continue;
                looks.delete(key);
                failures.delete(key);
            }
            if (!(id in all)) return;
            delete all[id];
            await deps.write(all);
        },

        /**
         * Set up whatever is consented to and missing, one at a time. A setup
         * the person declined is not asked again by itself; the page's action
         * asks again.
         */
        async ensure(id: string, manifest: Pick<PluginManifest, "requires">, reason: EnsureReason): Promise<void> {
            let moved = false;
            for (const requirement of pluginRequirements(manifest, deps.platform)) {
                const before = looks.get(slot(id, requirement.key));
                const seen = await lookAt(id, requirement);
                if (before?.state !== seen?.state) moved = true;
                if (!seen || seen.state !== "missing" || failures.has(slot(id, requirement.key))) continue;
                if (!(await consented(id, requirement.key, seen))) continue;
                await setUp(id, requirement, reason);
            }
            if (moved) deps.changed();
        },

        /** The person's click on the page: consent and set it up now. */
        async run(id: string, manifest: Pick<PluginManifest, "requires">, key: string): Promise<boolean> {
            const requirement = pluginRequirements(manifest, deps.platform).find((item) => item.key === key);
            if (!requirement || !deps.runnerFor(id, key)) return false;
            await consent(id, [key]);
            failures.delete(slot(id, key));
            return setUp(id, requirement, "asked");
        },

        /**
         * What the page offers: each requirement that is not set up and will not
         * be set up by itself (never consented to, or its last setup failed).
         * Read from the last look, so a snapshot never waits on the machine.
         */
        async actions(id: string, manifest: Pick<PluginManifest, "requires">): Promise<PluginHostAction[]> {
            const offered: PluginHostAction[] = [];
            for (const requirement of pluginRequirements(manifest, deps.platform)) {
                const at = slot(id, requirement.key);
                const seen = looks.get(at) ?? null;
                if (!seen || seen.state === "met" || busy.has(at)) continue;
                if (!failures.has(at) && (await consented(id, requirement.key, seen))) continue;
                offered.push({ id: requirement.key, label: requirement.label, ...(requirement.missing ? { detail: requirement.missing } : {}) });
            }
            return offered;
        },

        /** Why the last setup did not go through, or null. */
        failure: (id: string, key: string): string | null => failures.get(slot(id, key)) ?? null
    };
}

export type Requirements = ReturnType<typeof createRequirements>;
