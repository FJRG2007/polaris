"use client";

/**
 * The desktop app's device add-ons as the page holds them: the snapshot the
 * app answers (`polarisDesktop.addons.get()`), read through the core schema,
 * fetched again whenever the app says something changed.
 *
 * The last snapshot is kept for the tab's lifetime, so going back to the store
 * from an add-on's page draws at once instead of waiting on the app again.
 */

import { z } from "zod";
import { useCallback, useEffect, useState } from "react";
import type { PolarisDesktop } from "@/lib/desktop-bridge";
import { useDesktopBridge } from "@/components/desktop-app";
import {
    addonInstallResultSchema,
    compareAddonVersions,
    readAddonsSnapshot,
    type AddonEntry,
    type AddonPermission,
    type AddonsSnapshot,
    type InstalledAddon
} from "@polaris/core/device-addons";

export type AddonsBridge = NonNullable<PolarisDesktop["addons"]>;

/** Each permission's key under `addons.permission.*`. */
export const PERMISSION_KEY: Record<AddonPermission, string> = {
    usb: "usb",
    "audio-sessions": "audioSessions",
    display: "display",
    "polaris-actions": "polarisActions",
    network: "network"
};

/** The status sentences an add-on names (`code`) that the page says in its own language (`addons.statusDetail.*`). */
export const ADDON_STATUS_SENTENCES = ["otherProgram", "noAccess", "unsupported", "stopped", "unplugged", "herculesApp", "herculesDriver", "noControls"] as const;

/** The key of the page's own sentence for an add-on's status code, or null to show the add-on's words. */
export function statusSentence(code: string | undefined): string | null {
    return code && (ADDON_STATUS_SENTENCES as readonly string[]).includes(code) ? `statusDetail.${code}` : null;
}

/** Where the page stands: no desktop app, an app older than add-ons, waiting on it, or its answer. */
export type AddonsState =
    | { readonly kind: "browser" }
    | { readonly kind: "old-app" }
    | { readonly kind: "loading"; readonly bridge: AddonsBridge }
    | { readonly kind: "ready"; readonly bridge: AddonsBridge; readonly snapshot: AddonsSnapshot };

let lastSnapshot: AddonsSnapshot | null = null;

/** Forget the kept snapshot. For tests. */
export function resetAddonsCache(): void {
    lastSnapshot = null;
}

export function useAddons(): AddonsState {
    const desktop = useDesktopBridge();
    const bridge = desktop?.addons ?? null;
    const [snapshot, setSnapshot] = useState<AddonsSnapshot | null>(lastSnapshot);

    useEffect(() => {
        if (!bridge) return;
        let live = true;
        const load = () => {
            void bridge
                .get()
                .then((value) => {
                    const read = readAddonsSnapshot(value);
                    if (!live || !read) return;
                    lastSnapshot = read;
                    setSnapshot(read);
                })
                .catch(() => undefined);
        };
        load();
        const stop = bridge.onChange(load);
        return () => {
            live = false;
            stop();
        };
    }, [bridge]);

    if (!desktop) return { kind: "browser" };
    if (!bridge) return { kind: "old-app" };
    return snapshot ? { kind: "ready", bridge, snapshot } : { kind: "loading", bridge };
}

/** What a card or a page offers first for one add-on. */
export type AddonOffer =
    | { readonly kind: "install" }
    | { readonly kind: "installing"; readonly percent: number | null }
    | { readonly kind: "update"; readonly version: string }
    | { readonly kind: "installed" }
    | { readonly kind: "unavailable"; readonly reason: "platform" | "app-version"; readonly needs: string };

export function addonOffer(snapshot: AddonsSnapshot, id: string, entry: AddonEntry | null): AddonOffer {
    const progress = snapshot.installing[id];
    if (progress) return { kind: "installing", percent: progress.total > 0 ? Math.round((progress.received / progress.total) * 100) : null };
    const installed = snapshot.installed.find((item) => item.id === id);
    if (installed?.update) return { kind: "update", version: installed.update };
    if (installed) return { kind: "installed" };
    if (!entry || !snapshot.platform || !entry.packages[snapshot.platform]) return { kind: "unavailable", reason: "platform", needs: "" };
    if (compareAddonVersions(snapshot.appVersion, entry.minAppVersion) < 0) return { kind: "unavailable", reason: "app-version", needs: entry.minAppVersion };
    return { kind: "install" };
}

/** Every add-on the store lists: the catalog's, then any installed one the catalog no longer has. */
export interface AddonListing {
    readonly id: string;
    readonly entry: AddonEntry | null;
    readonly installed: InstalledAddon | null;
}

export function addonListings(snapshot: AddonsSnapshot): AddonListing[] {
    const installed = new Map(snapshot.installed.map((item) => [item.id, item]));
    const listed: AddonListing[] = (snapshot.catalog?.addons ?? []).map((entry) => ({
        id: entry.id,
        entry,
        installed: installed.get(entry.id) ?? null
    }));
    const known = new Set(listed.map((item) => item.id));
    for (const item of snapshot.installed) if (!known.has(item.id)) listed.push({ id: item.id, entry: null, installed: item });
    return listed;
}

/** Why an install did not happen, as the store words it. */
export type InstallProblem = "platform" | "app-version" | "download" | "integrity" | "other";

/** The store's wording for why the app refused an install. */
export function installProblem(reason: string): InstallProblem {
    switch (reason) {
        case "platform":
        case "app-version":
        case "download":
            return reason;
        case "size":
        case "hash":
        case "archive":
        case "manifest":
            return "integrity";
        default:
            return "other";
    }
}

/** Install or update one add-on, accepting what it asks for; null when it went in. */
export function useInstallAddon(bridge: AddonsBridge | null): (entry: AddonEntry) => Promise<InstallProblem | null> {
    return useCallback(
        async (entry: AddonEntry) => {
            if (!bridge) return "other";
            const answer = addonInstallResultSchema.safeParse(await bridge.install(entry.id, entry.permissions).catch(() => null));
            if (!answer.success) return "other";
            return answer.data.ok ? null : installProblem(answer.data.reason);
        },
        [bridge]
    );
}

const officialEntrySchema = z.object({ displayName: z.string().max(300), version: z.string().max(100) });

/** What the app found of a device's official software (desktop `addons/official.ts`, `look`). */
export const officialLookSchema = z.object({
    found: z
        .object({
            app: officialEntrySchema.nullable(),
            drivers: officialEntrySchema.nullable(),
            autostart: z.array(z.unknown()).max(100),
            running: z.boolean()
        })
        .nullable(),
    imported: z
        .object({
            pages: z.number().int().min(0).max(100),
            controls: z
                .array(
                    z.object({
                        page: z.number().int().min(0).max(100),
                        slot: z.number().int().min(0).max(100),
                        control: z.enum(["knob", "button"]),
                        official: z.string().max(300),
                        name: z.string().max(300),
                        mapped: z.object({ key: z.string().max(100), value: z.string().max(300) }).nullable(),
                        kept: z.boolean()
                    })
                )
                .max(2_000)
        })
        .nullable(),
    backup: z.object({ choice: z.enum(["stop", "uninstall", "keep"]), at: z.string().max(100), restored: z.boolean() }).nullable()
});

export type OfficialLook = z.infer<typeof officialLookSchema>;
export type OfficialControl = NonNullable<OfficialLook["imported"]>["controls"][number];

/** Every reason the app gives for not carrying a choice out (`ExecuteResult`, or `install` when the add-on did not go in). */
export const OFFICIAL_FAILURES = ["cancelled", "uninstallerRefused", "nothingToUninstall", "stopProcess", "removeAutostart", "unsigned", "declined", "uninstaller", "install", "failed"] as const;
export type OfficialFailure = (typeof OFFICIAL_FAILURES)[number];

const officialChooseSchema = z.union([
    z.object({ ok: z.literal(true) }),
    z.object({ ok: z.literal(false), reason: z.string().max(100), install: z.string().max(100).optional() })
]);

/** What choosing answered: done, or why not in the page's words (an unknown reason reads as `failed`). */
export type OfficialChoiceResult = { readonly ok: true } | { readonly ok: false; readonly reason: OfficialFailure; readonly install: InstallProblem | null };

export function readOfficialChoice(value: unknown): OfficialChoiceResult {
    const answer = officialChooseSchema.safeParse(value);
    if (!answer.success) return { ok: false, reason: "failed", install: null };
    if (answer.data.ok) return { ok: true };
    const reason = (OFFICIAL_FAILURES as readonly string[]).includes(answer.data.reason) ? (answer.data.reason as OfficialFailure) : "failed";
    return { ok: false, reason, install: reason === "install" ? installProblem(answer.data.install ?? "") : null };
}

export const officialRestoreSchema = z.object({
    ok: z.boolean(),
    autostart: z.number().int().min(0).max(100),
    settings: z.boolean(),
    started: z.boolean(),
    missing: z.boolean(),
    declined: z.boolean()
});

/** How putting the official app back went, as one sentence's key. */
export type OfficialRestoreOutcome = "done" | "settingsOnly" | "declined" | "failed";

export function readOfficialRestore(value: unknown): OfficialRestoreOutcome {
    const answer = officialRestoreSchema.safeParse(value);
    if (!answer.success) return "failed";
    if (answer.data.declined) return "declined";
    if (!answer.data.ok) return "failed";
    return answer.data.missing ? "settingsOnly" : "done";
}

/** What the app knows of an add-on's official software, or null for none / an app older than it / no answer. */
export async function lookOfficial(bridge: AddonsBridge | null, id: string): Promise<OfficialLook | null> {
    if (!bridge?.official) return null;
    const answer = officialLookSchema.safeParse(await bridge.official(id, { kind: "look" }).catch(() => null));
    return answer.success ? answer.data : null;
}
