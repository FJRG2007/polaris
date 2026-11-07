/**
 * The shape of the "Does it work on my TV?" data: the models people ran a
 * launcher on, the quirks they hit, and the privacy switches each brand hides.
 * The JSON files beside this one are the only place a tier is decided; the
 * screens read it from there and never from code.
 */

import { z } from "zod";

export const TV_PLATFORMS = [
    "android-tv",
    "google-tv",
    "android",
    "fire-os",
    "webos",
    "tizen",
    "roku",
    "vizio",
    "vidaa",
    "other"
] as const;
export type TvPlatform = (typeof TV_PLATFORMS)[number];

/** Full: Polaris TV is the Home screen. App: it opens beside the TV's own Home.
 *  Network: no app, ad and tracker blocking through the Network filter only. */
export const TV_TIERS = ["full", "app", "network"] as const;
export type TvTier = (typeof TV_TIERS)[number];

export const TV_QUIRKS = [
    "tcl-autostart",
    "google-pairing",
    "tcl-private-dns-prime",
    "fire-home-amazon",
    "samsung-2023-signing",
    "samsung-dev-refused",
    "huawei-refusal",
    "android-check",
    "android-too-old",
    "app-coming"
] as const;
export type TvQuirkId = (typeof TV_QUIRKS)[number];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const tvModelSchema = z
    .object({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
        brand: z.string().trim().min(1),
        model: z.string().trim().min(1),
        aliases: z.array(z.string().trim().min(1)),
        platform: z.enum(TV_PLATFORMS),
        /** The version as the source wrote it, null when it gave none. */
        osVersion: z.string().trim().min(1).nullable(),
        tier: z.enum(TV_TIERS),
        launcher: z.enum(["home", "app", "none"]),
        install: z.enum(["desktop-network", "desktop-usb", "desktop-pairing", "none"]),
        blocking: z.object({ privateDns: z.boolean().nullable(), routerDns: z.literal(true) }),
        quirks: z.array(z.enum(TV_QUIRKS)),
        tested: z.object({
            /** upstream-community: run with the upstream launcher by its owner, not
             *  with Polaris TV. community: reported to another open project. */
            by: z.enum(["polaris", "upstream-community", "community"]),
            date: isoDate,
            launcherVersion: z.string().optional()
        }),
        source: z.string().url()
    })
    .strict()
    .superRefine((model, ctx) => {
        const launcher = { full: "home", app: "app", network: "none" }[model.tier];
        if (model.launcher !== launcher)
            ctx.addIssue({
                code: "custom",
                message: `a ${model.tier} model has launcher ${launcher}`
            });
        if ((model.tier === "network") !== (model.install === "none"))
            ctx.addIssue({ code: "custom", message: "only a network model installs nothing" });
    });
export type TvModel = z.infer<typeof tvModelSchema>;

export const tvModelsSchema = z.array(tvModelSchema).superRefine((models, ctx) => {
    const seen = new Set<string>();
    for (const model of models) {
        if (seen.has(model.id))
            ctx.addIssue({ code: "custom", message: `duplicate id ${model.id}` });
        seen.add(model.id);
    }
});

export const tvQuirkSchema = z.object({ id: z.enum(TV_QUIRKS), source: z.string().url() }).strict();
export type TvQuirk = z.infer<typeof tvQuirkSchema>;

export const tvPrivacySchema = z
    .object({
        /** When the paths were read from their sources. */
        read: isoDate,
        brands: z.array(
            z
                .object({
                    id: z.string().regex(/^[a-z0-9-]+$/),
                    brand: z.string().min(1),
                    /** Which brands of the model list this applies to, lowercase. */
                    matches: z.array(z.string().min(1)),
                    platforms: z.array(z.enum(TV_PLATFORMS)),
                    source: z.string().url(),
                    /** Each step's id names its action in the `tvCompat.privacy.steps` catalog. */
                    steps: z.array(
                        z
                            .object({
                                id: z.string().regex(/^[a-z0-9-]+$/),
                                path: z.string().min(1)
                            })
                            .strict()
                    )
                })
                .strict()
        )
    })
    .strict();
export type TvPrivacy = z.infer<typeof tvPrivacySchema>;
export type TvPrivacyBrand = TvPrivacy["brands"][number];

/** Where each platform hides "turn on debugging": the one thing left for the
 *  person to do on the TV, shown as a single instruction while the installer waits. */
export const tvDebuggingSchema = z
    .object({
        platforms: z.array(
            z
                .object({
                    id: z.string().regex(/^[a-z0-9-]+$/),
                    platforms: z.array(z.enum(TV_PLATFORMS)).min(1),
                    /** The screen that holds the item pressed to become a developer. */
                    about: z.string().min(1),
                    press: z.string().min(1),
                    presses: z.number().int().min(1).max(10),
                    developer: z.string().min(1),
                    /** The switches to turn on there, by the name the TV shows. */
                    switches: z.array(z.string().min(1)).min(1),
                    source: z.string().url(),
                    /** The same menus as the TV shows them in another language, by locale; English is the default above. */
                    localized: z
                        .object({
                            "es-ES": z
                                .object({
                                    about: z.string().min(1),
                                    press: z.string().min(1),
                                    developer: z.string().min(1),
                                    switches: z.array(z.string().min(1)).min(1)
                                })
                                .strict()
                        })
                        .partial()
                        .strict()
                        .optional()
                })
                .strict()
        )
    })
    .strict();
export type TvDebugging = z.infer<typeof tvDebuggingSchema>;
export type TvDebuggingSteps = TvDebugging["platforms"][number];
