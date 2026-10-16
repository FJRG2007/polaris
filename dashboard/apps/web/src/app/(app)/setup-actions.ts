"use server";

/**
 * The first-run setup: whether it opens, installing what it recommends, and
 * remembering that it was finished or skipped.
 *
 * Installing is an administrator's call and is refused here, on the server, for
 * anybody else - the screen not offering it is a courtesy, not the check. Every
 * install goes through the marketplace's own path with the marketplace's own
 * one-click defaults, so the setup never installs something differently from
 * the button in Apps.
 */

import { prisma } from "@polaris/db";
import { revalidatePath } from "next/cache";
import { recordAudit } from "@/lib/audit-service";
import { getTranslations } from "@/lib/i18n/request";
import { backgroundUser, requireUser } from "@/lib/session";
import { findApp } from "@/lib/apps/catalog";
import { installApp } from "@/lib/apps/install-service";
import { isAppInstalled } from "@/lib/apps/install-presence";
import { defaultInstallInput } from "@/lib/apps/install-defaults";
import {
    SETUP_APPS,
    SETUP_MARK_KEY,
    setupAppSchema,
    setupOutcomeSchema,
    shouldOfferSetup,
    type SetupApp
} from "@/lib/setup/setup-wizard";

export interface SetupState {
    /** Whether the setup should open by itself for this viewer. */
    readonly offer: boolean;
    /** The setup's apps this Polaris already has. */
    readonly installed: readonly SetupApp[];
}

const NOTHING: SetupState = { offer: false, installed: [] };

async function readMark(): Promise<string | null> {
    const row = await prisma.setting.findUnique({
        where: { key: SETUP_MARK_KEY },
        select: { value: true }
    });
    return row?.value ?? null;
}

/** The setup apps already installed; an answer that fails counts as not. */
async function installedSetupApps(): Promise<SetupApp[]> {
    const verdicts = await Promise.all(
        SETUP_APPS.map(async (app) => [app, await isAppInstalled(app).catch(() => false)] as const)
    );
    return verdicts.filter(([, present]) => present).map(([app]) => app);
}

/** How established this Polaris is: up to two accounts (two is already "more
 *  than the viewer"), and whether any app is installed. A failed answer counts
 *  as established, so an error never opens the setup on somebody. */
async function establishment(): Promise<{ accounts: number; appsInstalled: boolean }> {
    try {
        const [accounts, app] = await Promise.all([
            prisma.user.findMany({ take: 2, select: { id: true } }),
            prisma.installedApp.findFirst({
                where: { status: { not: "removed" } },
                select: { id: true }
            })
        ]);
        return { accounts: accounts.length, appsInstalled: app !== null };
    } catch {
        return { accounts: 2, appsInstalled: true };
    }
}

/** Whether to open the setup, and what it would find installed. Silent for
 *  anybody who may not install: they are never offered it. Once the setup was
 *  finished or skipped - every Polaris after its first day - the mark is all
 *  this reads. */
export async function setupStateAction(): Promise<SetupState> {
    const user = await backgroundUser();
    if (!user || !user.isAdmin || user.viewingAs) return NOTHING;
    const mark = await readMark().catch(() => "unknown");
    if (mark !== null) return NOTHING;
    const established = await establishment();
    if (!shouldOfferSetup({ isAdmin: user.isAdmin, viewingAs: false, mark, ...established }))
        return NOTHING;
    return { offer: true, installed: await installedSetupApps() };
}

/** The setup's apps this Polaris already has, for the setup opened again on
 *  purpose. Nothing for anybody who may not install. */
export async function setupInstalledAction(): Promise<readonly SetupApp[]> {
    const user = await backgroundUser();
    if (!user || !user.isAdmin || user.viewingAs) return [];
    return installedSetupApps();
}

/** Install one of the setup's apps with the marketplace's one-click defaults. */
export async function installSetupAppAction(input: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const t = await getTranslations("setup");
    if (!user.isAdmin || user.viewingAs) return { error: t("errors.adminOnly") };
    const parsed = setupAppSchema.safeParse(input);
    const manifest = parsed.success ? findApp(parsed.data) : undefined;
    if (!parsed.success || !manifest) return { error: t("errors.unknownApp") };
    // Installed meanwhile - by another tab, or another administrator - is the
    // outcome that was asked for.
    if (await isAppInstalled(parsed.data).catch(() => false)) return {};
    try {
        const result = await installApp(user.id, user.id, defaultInstallInput(manifest));
        await recordAudit({
            actorId: user.id,
            action: "apps.install",
            targetType: "installedApp",
            targetId: result.installedAppId
        });
        revalidatePath("/", "layout");
        return {};
    } catch (caught) {
        const message = caught instanceof Error ? caught.message : "";
        if (message === "This app is already installed") return {};
        console.error(`[setup] ${parsed.data} install failed`, caught);
        // The cause names internals; the reader gets what they can do about it.
        return { error: t("errors.install", { app: manifest.name }) };
    }
}

/** Remember that the setup was finished or skipped, for every administrator. */
export async function finishSetupAction(outcome: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    if (!user.isAdmin || user.viewingAs)
        return { error: (await getTranslations("setup"))("errors.adminOnly") };
    const parsed = setupOutcomeSchema.safeParse(outcome);
    if (!parsed.success) return {};
    await prisma.setting
        .upsert({
            where: { key: SETUP_MARK_KEY },
            update: { value: parsed.data },
            create: { key: SETUP_MARK_KEY, value: parsed.data, scope: "global" }
        })
        .catch((caught: unknown) => console.error("[setup] mark failed", caught));
    return {};
}
