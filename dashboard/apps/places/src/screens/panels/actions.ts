"use server";

/**
 * Wall panels, from their screen. Reading a panel is `home.read`, as every
 * other screen of the house is; building and arranging one is `home.manage`,
 * the standing that decides what the house shows and what its link reaches.
 */

import { revalidatePath } from "next/cache";
import { host } from "@polaris/app-host";
import * as panels from "../../lib/panels";
import { guard } from "../../lib/action-guard";
import { requireHome } from "../../lib/access";
import { currentPlace } from "../../lib/current-place";
import { placesT } from "../../lib/i18n";
import { placesRefusalText } from "../../lib/refusal-text";
import {
    normalizePanelName,
    panelCardsSchema,
    panelNameSchema,
    type PanelView
} from "../../lib/panel-layout";

const PATH = "/places/panels";

/** A schema's first complaint in the reader's words. */
async function schemaSay(message: string | undefined): Promise<string> {
    const t = await placesT();
    return message ? placesRefusalText(t, message) : t("actions.someWrong");
}

export async function listPanelsAction(): Promise<{ panels?: PanelView[]; error?: string }> {
    const { install } = await requireHome("home.read");
    const result = await guard(async () =>
        panels.listPanels(install.id, (await currentPlace(install.id)).current.id)
    );
    return result.error ? { error: result.error } : { panels: result.value };
}

/** A new, empty panel at the place being looked at. */
export async function createPanelAction(
    name: unknown
): Promise<{ panel?: PanelView; error?: string }> {
    const { user, install } = await requireHome("home.manage");
    const parsed = panelNameSchema.safeParse(normalizePanelName(name));
    if (!parsed.success) return { error: await schemaSay(parsed.error.issues[0]?.message) };
    const result = await guard(async () =>
        panels.createPanel(install.id, (await currentPlace(install.id)).current.id, parsed.data)
    );
    if (result.error || !result.value) return { error: result.error };
    await host.auditService.recordAudit({
        actorId: user.id,
        action: "places.panel.create",
        targetType: "placePanel",
        targetId: result.value.id,
        metadata: { name: parsed.data }
    });
    revalidatePath(PATH);
    return { panel: result.value };
}

export async function renamePanelAction(
    id: string,
    name: unknown
): Promise<{ panel?: PanelView; error?: string }> {
    const { install } = await requireHome("home.manage");
    const parsed = panelNameSchema.safeParse(normalizePanelName(name));
    if (!parsed.success) return { error: await schemaSay(parsed.error.issues[0]?.message) };
    const result = await guard(() => panels.renamePanel(install.id, String(id), parsed.data));
    if (result.error) return { error: result.error };
    revalidatePath(PATH);
    return { panel: result.value };
}

/** A panel's cards and where each sits, saved whole. */
export async function savePanelCardsAction(
    id: string,
    cards: unknown
): Promise<{ panel?: PanelView; error?: string }> {
    const { user, install } = await requireHome("home.manage");
    const parsed = panelCardsSchema.safeParse(cards);
    if (!parsed.success) return { error: await schemaSay(parsed.error.issues[0]?.message) };
    const result = await guard(() => panels.savePanelCards(install.id, String(id), parsed.data));
    if (result.error) return { error: result.error };
    await host.auditService.recordAudit({
        actorId: user.id,
        action: "places.panel.arrange",
        targetType: "placePanel",
        targetId: String(id),
        metadata: { cards: parsed.data.length }
    });
    return { panel: result.value };
}

export async function deletePanelAction(id: string): Promise<{ error?: string }> {
    const { user, install } = await requireHome("home.manage");
    const result = await guard(() => panels.deletePanel(install.id, String(id)));
    if (result.error) return { error: result.error };
    await host.auditService.recordAudit({
        actorId: user.id,
        action: "places.panel.delete",
        targetType: "placePanel",
        targetId: String(id)
    });
    revalidatePath(PATH);
    return {};
}
