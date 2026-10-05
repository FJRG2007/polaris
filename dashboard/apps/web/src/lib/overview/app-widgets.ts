/**
 * The Overview's cards from installed apps.
 *
 * An app offers card kinds (`AppWidgetDefinition`); somebody adds one to their
 * Overview, picks what it watches, and the card is stored in their layout as
 * the app, the kind and the ids they picked. This is the dashboard's half:
 * which kinds are on offer, reading every card on one screen at once, and
 * passing a press through to the app that owns the card.
 *
 * The stored layout is never taken as permission. What a card shows and what
 * it lets somebody press is the app's to decide on every read and every press,
 * through the same checks its own screens use; and a press names a card by id,
 * so what it acts on is read from the account's own stored layout, never from
 * what the browser said the card watches.
 *
 * Server-only.
 */

import { z } from "zod";
import type * as core from "@polaris/core";
import { appWidgetDefinitions } from "@/lib/app-extensions/registry";
import type { AppWidgetInput, AppWidgetView } from "@/lib/app-extensions/types";

/** A kind of card on offer, as the Customize panel lists it. */
export interface AppWidgetKind {
    readonly app: string;
    readonly kind: string;
    readonly label: string;
    readonly hint: string;
    readonly defaultSize: core.OverviewWidgetSize;
}

/** What one card reads as: its view, or the reason it could not be read. */
export type AppWidgetReadout =
    | { readonly ok: true; readonly view: AppWidgetView }
    | { readonly ok: false; readonly reason: "gone" | "failed" };

/** Every kind the installed apps offer, named in the reader's language. One
 *  app failing to describe itself leaves the others on offer. */
export async function availableAppWidgetKinds(): Promise<AppWidgetKind[]> {
    const offered = await appWidgetDefinitions();
    const described = await Promise.all(
        offered.map(async ({ app, definition }) => {
            try {
                const words = await definition.describe();
                return {
                    app,
                    kind: definition.kind,
                    label: words.label,
                    hint: words.hint,
                    defaultSize: definition.defaultSize
                };
            } catch (caught) {
                console.error(
                    `polaris: ${app} could not describe its ${definition.kind} card:`,
                    caught
                );
                return null;
            }
        })
    );
    return described.filter((kind): kind is AppWidgetKind => kind !== null);
}

async function definitionOf(app: string, kind: string) {
    return (await appWidgetDefinitions()).find(
        (offered) => offered.app === app && offered.definition.kind === kind
    )?.definition;
}

/** What one kind can watch, for the picker. Nothing for a kind not on offer. */
export async function appWidgetTargets(app: string, kind: string) {
    const definition = await definitionOf(app, kind);
    return definition ? [...(await definition.targets())] : [];
}

/**
 * Every card on one Overview, read at once.
 *
 * In parallel, one call per card - each app reads what it watches in one go -
 * and one card failing says so on that card alone. A card whose app is no
 * longer installed, or no longer offers that kind, says it is gone rather than
 * drawing an empty card.
 */
export async function readAppWidgets(
    cards: readonly core.AppWidgetPreference[]
): Promise<Record<string, AppWidgetReadout>> {
    const offered = await appWidgetDefinitions();
    const entries = await Promise.all(
        cards.map(async (card): Promise<[string, AppWidgetReadout]> => {
            const definition = offered.find(
                (one) => one.app === card.app && one.definition.kind === card.kind
            )?.definition;
            if (!definition) return [card.id, { ok: false, reason: "gone" }];
            try {
                return [card.id, { ok: true, view: await definition.read(card.targets) }];
            } catch (caught) {
                console.error(
                    `polaris: the ${card.app} ${card.kind} card could not be read:`,
                    caught
                );
                return [card.id, { ok: false, reason: "failed" }];
            }
        })
    );
    return Object.fromEntries(entries);
}

/** A press as it arrives from a browser. */
export const appWidgetInputSchema = z.object({
    item: z.string().trim().min(1).max(64),
    control: z.string().trim().min(1).max(64),
    value: z.union([z.boolean(), z.number().finite()])
});

/**
 * Pass a press on one card to the app it is from.
 *
 * `card` is the account's own stored card, found by id by the caller - so the
 * targets handed to the app are the ones this reader picked, and an item the
 * press names that is not among them is refused here before the app is asked.
 */
export async function actOnAppWidget(
    card: core.AppWidgetPreference,
    input: AppWidgetInput
): Promise<{ error?: "gone" | "unknown" | string }> {
    const definition = await definitionOf(card.app, card.kind);
    if (!definition?.act) return { error: "gone" };
    if (!card.targets.includes(input.item)) return { error: "unknown" };
    const answer = await definition.act(card.targets, input);
    return answer.error ? { error: answer.error } : {};
}
