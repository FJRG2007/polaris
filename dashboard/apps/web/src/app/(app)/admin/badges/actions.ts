"use server";

/**
 * Custom badges (/admin/badges). Every action requires an administrator here,
 * and the service checks the actor again, so neither check alone is the guard.
 */

import { requireAdmin } from "@/lib/session";
import { findPeople } from "@/lib/people-search";
import { getTranslations } from "@/lib/i18n/request";
import * as badges from "@/lib/badges/badge-service";
import * as nameTags from "@/lib/name-tags/name-tag-service";

type Answer<T = object> = (T & { error?: undefined }) | { error: string };

/** The administrator acting; every action below starts here. */
async function scope(): Promise<badges.BadgeActor> {
    const user = await requireAdmin();
    return { id: user.id, isAdmin: user.isAdmin };
}

async function guard<T extends object>(
    actor: badges.BadgeActor,
    run: (actor: badges.BadgeActor) => Promise<T>
): Promise<Answer<T>> {
    try {
        return await run(actor);
    } catch (caught) {
        if (caught instanceof badges.BadgeError) {
            // The service's sentences are English; the screen says the localized one.
            console.warn("polaris: badge action refused:", caught.message);
            return { error: (await getTranslations("badges"))("admin.failed") };
        }
        throw caught;
    }
}

/** The instance's own name tag, which only administrators set. */
export async function setInstanceNameTagAction(input: unknown): Promise<{ error?: string }> {
    const actor = await scope();
    try {
        await nameTags.setInstanceTag(actor, input);
        return {};
    } catch (caught) {
        if (caught instanceof nameTags.NameTagError) return { error: caught.code };
        throw caught;
    }
}

export async function listBadgeDefinitionsAction(): Promise<
    Answer<{ definitions: badges.BadgeDefinitionView[] }>
> {
    return guard(await scope(), async (actor) => ({
        definitions: await badges.listDefinitions(actor)
    }));
}

export async function createBadgeDefinitionAction(input: unknown): Promise<Answer<{ id: string }>> {
    return guard(await scope(), async (actor) => ({
        id: await badges.createDefinition(actor, input)
    }));
}

export async function updateBadgeDefinitionAction(id: unknown, input: unknown): Promise<Answer> {
    return guard(await scope(), async (actor) => {
        await badges.updateDefinition(actor, id, input);
        return {};
    });
}

export async function deleteBadgeDefinitionAction(id: unknown): Promise<Answer> {
    return guard(await scope(), async (actor) => {
        await badges.deleteDefinition(actor, id);
        return {};
    });
}

export async function badgeHoldersAction(
    id: unknown,
    options?: unknown
): Promise<Answer<badges.BadgeHoldersPage>> {
    return guard(await scope(), (actor) => badges.holdersOf(actor, id, options));
}

export async function grantBadgeAction(
    id: unknown,
    userId: unknown
): Promise<Answer<{ created: boolean }>> {
    return guard(await scope(), async (actor) => ({
        created: await badges.grantBadge(actor, id, userId)
    }));
}

export async function revokeBadgeAction(id: unknown, userId: unknown): Promise<Answer> {
    return guard(await scope(), async (actor) => {
        await badges.revokeBadge(actor, id, userId);
        return {};
    });
}

/** Anybody on the instance may be given a badge, so the search is not narrowed. */
export async function searchBadgePeopleAction(
    query: string
): Promise<{ results?: { id: string; name: string }[] }> {
    const user = await requireAdmin();
    const found = await findPeople(user, String(query ?? ""), { reachableOnly: false });
    return { results: found.people };
}
