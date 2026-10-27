"use client";

/**
 * The installed apps' cards on the Overview: which are on it, what each shows,
 * and everything that changes them.
 *
 * Held apart from the Overview's own cards because they are a different kind of
 * thing - an app's, watching what the reader picked - and saved on their own,
 * so arranging the Overview never writes them away and adding one never races a
 * card being moved. Drawn in the same grid, in the same frame, and arranged with
 * the Overview's own cards in one order: the grid gives each the same handle,
 * drop target and menu (see `overview-grid`).
 *
 * What they show is read stale-while-revalidate: the last answer this tab had
 * paints at once, the request behind it replaces it when it lands, and the
 * cards are read again every half minute while the page is in front - a
 * thermostat's reading is only worth showing while it is current.
 */

import { WidgetCard } from "./widget-card";
import { AppWidgetBody, withPressed } from "./app-widget-card";
import type { AppWidgetInput } from "@/lib/app-extensions/types";
import { useCallback, useEffect, useRef, useState } from "react";
import * as polls from "./home-polls";
import { useUnmountSignal } from "@/lib/poll-fetch";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { AppWidgetSetup, type AppWidgetSetupSubject } from "./app-widget-setup";
import type { AppWidgetKind, AppWidgetReadout } from "@/lib/overview/app-widgets";
import { Blocks } from "lucide-react";
import { MAX_APP_WIDGETS, type AppWidgetPreference, type OverviewWidgetSize } from "@polaris/core";
import { actOnAppWidgetAction, saveAppWidgetsAction } from "./app-widget-actions";
import { useToast } from "@polaris/ui";

/** How often the cards are read again while the page is in front. */
export const APP_WIDGET_REFRESH_MS = 30_000;

/** What this tab last read, painted first on a return to the Overview. */
let kept: { at: number; cards: Record<string, AppWidgetReadout> } | null = null;

/** A new card's id: what the layout schema stores, lowercase letters and digits. */
function newCardId(): string {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

/**
 * The cards, their arrangement and saving it. Saved on its own action; a save
 * the server refuses puts the list back as it was and says why.
 */
export function useAppWidgets(initial: readonly AppWidgetPreference[]) {
    const t = useTranslations("home");
    const toast = useToast();
    const [cards, setCards] = useState<AppWidgetPreference[]>([...initial]);
    const accepted = useRef<AppWidgetPreference[]>([...initial]);
    // What the server has stored. The cards are read from the stored layout, so
    // a card is read once its save is in, not when it is drawn: read sooner and
    // a new card comes back empty and stays that way until the next pass.
    const [stored, setStored] = useState<readonly AppWidgetPreference[]>(accepted.current);

    const save = useCallback(
        (next: AppWidgetPreference[]) => {
            setCards(next);
            void saveAppWidgetsAction(next).then(
                (answer) => {
                    if (!answer.error) {
                        accepted.current = next;
                        setStored(next);
                        return;
                    }
                    setCards(accepted.current);
                    toast.show({ title: answer.error });
                },
                () => {
                    setCards(accepted.current);
                    toast.show({ title: t("errors.changeNotSaved") });
                }
            );
        },
        [t, toast]
    );

    return {
        cards,
        stored,
        add: (kind: AppWidgetKind, targets: string[]) => {
            if (cards.length >= MAX_APP_WIDGETS) return;
            save([
                ...cards,
                {
                    id: newCardId(),
                    app: kind.app,
                    kind: kind.kind,
                    size: kind.defaultSize,
                    targets,
                    hidden: false
                }
            ]);
        },
        retarget: (id: string, targets: string[]) =>
            save(cards.map((card) => (card.id === id ? { ...card, targets } : card))),
        resize: (id: string, size: OverviewWidgetSize) =>
            save(cards.map((card) => (card.id === id ? { ...card, size } : card))),
        remove: (id: string) => save(cards.filter((card) => card.id !== id)),
        hide: (id: string, hidden: boolean) =>
            save(cards.map((card) => (card.id === id ? { ...card, hidden } : card))),
        reset: (kinds: readonly AppWidgetKind[]) => {
            const shipped = (card: AppWidgetPreference) =>
                appWidgetKindOf(card, kinds)?.defaultSize ?? card.size;
            if (cards.every((card) => !card.hidden && card.size === shipped(card))) return;
            save(cards.map((card) => ({ ...card, size: shipped(card), hidden: false })));
        },
        full: cards.length >= MAX_APP_WIDGETS
    };
}

export type AppWidgetsState = ReturnType<typeof useAppWidgets>;

/** The kind an app card is, when its app still offers it. A card whose app no
 *  longer does is not drawn - it is kept in the layout for when the app is
 *  back, like an Overview card the reader cannot see this week. */
export function appWidgetKindOf(
    card: AppWidgetPreference,
    kinds: readonly AppWidgetKind[]
): AppWidgetKind | undefined {
    return kinds.find((kind) => kind.app === card.app && kind.kind === card.kind);
}

/**
 * What the cards on the grid show, and pressing their controls: read once the
 * stored cards change and every half minute while the page is in front.
 */
export function useAppWidgetLive(state: AppWidgetsState, kinds: readonly AppWidgetKind[]) {
    const t = useTranslations("home");
    const toast = useToast();
    const [readouts, setReadouts] = useState<Record<string, AppWidgetReadout>>(
        () => kept?.cards ?? {}
    );
    const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
    const [setup, setSetup] = useState<(AppWidgetSetupSubject & { id: string }) | null>(null);

    // Read again whenever what the stored cards watch changes, not on every
    // render and not before the server has the change. A hidden card is not
    // read: nothing on screen would show the answer.
    const watching = state.stored
        .filter((card) => !card.hidden && appWidgetKindOf(card, kinds))
        .map((card) => `${card.id}=${card.targets.join(",")}`)
        .join("|");

    const signal = useUnmountSignal();
    const read = useCallback(async () => {
        try {
            const answer = await polls.appWidgets(signal());
            kept = { at: Date.now(), cards: answer.cards };
            setReadouts(answer.cards);
        } catch {
            // What is on screen stays, which is the last thing that was true; the
            // next pass asks again.
        }
    }, []);

    useEffect(() => {
        if (!watching) return;
        void read();
        const timer = window.setInterval(() => {
            if (document.visibilityState === "visible") void read();
        }, APP_WIDGET_REFRESH_MS);
        return () => window.clearInterval(timer);
    }, [watching, read]);

    async function act(cardId: string, input: AppWidgetInput): Promise<void> {
        const key = `${input.item}:${input.control}`;
        const before = readouts[cardId];
        if (before)
            setReadouts((current) => ({ ...current, [cardId]: withPressed(before, input) }));
        setBusy((current) => new Set(current).add(key));
        let error: string | undefined;
        try {
            error = (await actOnAppWidgetAction(cardId, input)).error;
        } catch {
            error = t("appCards.cannotDo");
        }
        setBusy((current) => {
            const next = new Set(current);
            next.delete(key);
            return next;
        });
        if (error) {
            // Back to what it was, with the app's own reason.
            if (before) setReadouts((current) => ({ ...current, [cardId]: before }));
            toast.show({ title: error });
            return;
        }
        // The app's answer is what the device now says.
        void read();
    }

    return {
        readouts,
        busy,
        act,
        /** Ask what one card should watch. */
        configure: (card: AppWidgetPreference, kind: AppWidgetKind) =>
            setSetup({
                id: card.id,
                app: card.app,
                kind: card.kind,
                label: kind.label,
                targets: card.targets
            }),
        /** The dialog that asks it, drawn once beside the grid. */
        setupDialog: (
            <AppWidgetSetup
                subject={setup}
                onCancel={() => setSetup(null)}
                onSave={(targets) => {
                    if (setup) state.retarget(setup.id, targets);
                    setSetup(null);
                }}
            />
        )
    };
}

export type AppWidgetLive = ReturnType<typeof useAppWidgetLive>;

/** One app card, in the frame every Overview card is drawn in. The grid gives
 *  it the handle and menu every card has. */
export function AppWidgetItem({
    card,
    kind,
    live,
    grip,
    menu
}: {
    card: AppWidgetPreference;
    kind: AppWidgetKind;
    live: AppWidgetLive;
    grip?: React.ReactNode;
    menu?: React.ReactNode;
}) {
    return (
        <WidgetCard title={kind.label} icon={Blocks} grip={grip} menu={menu}>
            <AppWidgetBody
                readout={live.readouts[card.id]}
                busy={live.busy}
                onAct={(input) => void live.act(card.id, input)}
                onConfigure={() => live.configure(card, kind)}
            />
        </WidgetCard>
    );
}

/** The Customize panel's part: the kinds of card the installed apps offer, and
 *  adding one - which asks what it should watch first. */
export function AppWidgetCatalog({
    kinds,
    state
}: {
    kinds: readonly AppWidgetKind[];
    state: AppWidgetsState;
}) {
    const t = useTranslations("home");
    const [adding, setAdding] = useState<AppWidgetKind | null>(null);
    if (kinds.length === 0) return null;
    return (
        <section className="flex flex-col gap-2 border-t border-border pt-3">
            <h3 className="text-sm font-medium">{t("appCards.section")}</h3>
            <ul className="flex flex-col">
                {kinds.map((kind) => (
                    <li key={`${kind.app}:${kind.kind}`} className="flex items-center gap-3 py-2">
                        <Blocks
                            className="size-4 shrink-0 text-muted-foreground"
                            aria-hidden="true"
                        />
                        <div className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate text-sm font-medium" title={kind.label}>
                                {kind.label}
                            </span>
                            <span
                                className="truncate text-xs text-muted-foreground"
                                title={kind.hint}
                            >
                                {kind.hint}
                            </span>
                        </div>
                        <button
                            type="button"
                            disabled={state.full}
                            title={
                                state.full
                                    ? t("appCards.full", { count: MAX_APP_WIDGETS })
                                    : undefined
                            }
                            onClick={() => setAdding(kind)}
                            className="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
                        >
                            {t("appCards.add")}
                        </button>
                    </li>
                ))}
            </ul>
            <AppWidgetSetup
                subject={
                    adding
                        ? { app: adding.app, kind: adding.kind, label: adding.label, targets: [] }
                        : null
                }
                onCancel={() => setAdding(null)}
                onSave={(targets) => {
                    if (adding) state.add(adding, targets);
                    setAdding(null);
                }}
            />
        </section>
    );
}
