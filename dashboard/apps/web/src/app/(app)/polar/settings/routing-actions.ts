"use server";

/**
 * The Routing section of Polar's settings: a person's own fallback list and
 * coding-tool models, or the deployment's when they set none.
 *
 * The gate, and nothing else: every action establishes the signed-in person and
 * their Polar access before it reads or writes their own routing. Somebody
 * viewing as another account reads, and never writes.
 */

import { requireUser } from "@/lib/session";
import { polarAccessFor } from "@/lib/polar/access";
import { getTranslations } from "@/lib/i18n/request";
import { setOwnRouting } from "@/lib/polar/router/store";
import { checkRouting, pinnedKeyIds } from "@/lib/polar/routing-keys";
import {
    routingScreenFor,
    routingUsageFor,
    type RoutingScreen,
    type RoutingUsage
} from "@/lib/polar/routing-screen";

async function caller() {
    const user = await requireUser();
    const access = await polarAccessFor(user.id);
    return access.use ? { user, access } : null;
}

export async function loadRoutingAction(): Promise<{ screen?: RoutingScreen; error?: string }> {
    const found = await caller();
    if (!found) return { error: (await getTranslations("polar"))("routing.errors.noAccess") };
    return { screen: await routingScreenFor(found.user.id, found.access) };
}

export async function loadRoutingUsageAction(): Promise<{ usage?: RoutingUsage; error?: string }> {
    const found = await caller();
    if (!found) return { error: (await getTranslations("polar"))("routing.errors.noAccess") };
    return { usage: await routingUsageFor(found.user.id) };
}

/** Save this person's own routing, held to the keys they may spend. */
export async function saveRoutingAction(input: unknown): Promise<{ error?: string }> {
    const t = await getTranslations("polar");
    const found = await caller();
    if (!found) return { error: t("routing.errors.noAccess") };
    if (found.user.viewingAs) return { error: t("routing.errors.viewingAs") };
    const screen = await routingScreenFor(found.user.id, found.access);
    const checked = checkRouting(input, screen.keys, pinnedKeyIds(screen.own ?? screen.deployment));
    if (!checked.ok) return { error: t(`routing.errors.${checked.refusal}`) };
    await setOwnRouting(found.user.id, checked.routing);
    return {};
}

/** Go back to the deployment's routing. */
export async function resetRoutingAction(): Promise<{ error?: string }> {
    const t = await getTranslations("polar");
    const found = await caller();
    if (!found) return { error: t("routing.errors.noAccess") };
    if (found.user.viewingAs) return { error: t("routing.errors.viewingAs") };
    await setOwnRouting(found.user.id, null);
    return {};
}
