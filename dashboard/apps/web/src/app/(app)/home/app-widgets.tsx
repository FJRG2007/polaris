"use client";

/**
 * The installed apps' cards on the Overview: which are on it, what each shows,
 * and everything that changes them.
 *
 * Held apart from the Overview's own cards because they are a different kind of
 * thing - an app's, watching what the reader picked - and saved on their own,
 * so arranging the Overview never writes them away and adding one never races a
 * card being moved. Drawn in the same grid, in the same frame.
 *
 * What they show is read stale-while-revalidate: the last answer this tab had
 * paints at once, the request behind it replaces it when it lands, and the
 * cards are read again every half minute while the page is in front - a
 * thermostat's reading is only worth showing while it is current.
 */

import { WidgetCard } from "./widget-card";
import { sizeLabel } from "./widget-names";
import { AppWidgetBody, withPressed } from "./app-widget-card";
import type { AppWidgetInput } from "@/lib/app-extensions/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { AppWidgetSetup, type AppWidgetSetupSubject } from "./app-widget-setup";
import type { AppWidgetKind, AppWidgetReadout } from "@/lib/overview/app-widgets";
import { Blocks, MoreVertical, Settings2, Trash2, ArrowUp, ArrowDown } from "lucide-react";
import {
    OVERVIEW_WIDGET_SIZES,
    MAX_APP_WIDGETS,
    type AppWidgetPreference,
    type OverviewWidgetSize
} from "@polaris/core";
import {
    actOnAppWidgetAction,
    readAppWidgetsAction,
    saveAppWidgetsAction
} from "./app-widget-actions";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    cn,
    useToast
} from "@polaris/ui";

/** How often the cards are read again while the page is in front. */
export const APP_WIDGET_REFRESH_MS = 30_000;

/** What this tab last read, painted first on a return to the Overview. */
let kept: { at: number; cards: Record<string, AppWidgetReadout> } | null = null;

/** A new card's id: what the layout schema stores, lowercase letters and digits. */
function newCardId(): string {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

const SPAN: Record<OverviewWidgetSize, string> = {
    sm: "overview-card",
    md: "overview-card overview-card-md",
    lg: "overview-card overview-card-lg",
    xl: "overview-card overview-card-xl"
};

/**
 * The cards, their arrangement and saving it. Saved on its own action; a save
 * the server refuses puts the list back as it was and says why.
 */
export function useAppWidgets(initial: readonly AppWidgetPreference[]) {
    const t = useTranslations("home");
    const toast = useToast();
    const [cards, setCards] = useState<AppWidgetPreference[]>([...initial]);
    const accepted = useRef<AppWidgetPreference[]>([...initial]);

    const save = useCallback(
        (next: AppWidgetPreference[]) => {
            setCards(next);
            void saveAppWidgetsAction(next).then(
                (answer) => {
                    if (!answer.error) {
                        accepted.current = next;
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
        add: (kind: AppWidgetKind, targets: string[]) => {
            if (cards.length >= MAX_APP_WIDGETS) return;
            save([
                ...cards,
                { id: newCardId(), app: kind.app, kind: kind.kind, size: kind.defaultSize, targets }
            ]);
        },
        retarget: (id: string, targets: string[]) =>
            save(cards.map((card) => (card.id === id ? { ...card, targets } : card))),
        resize: (id: string, size: OverviewWidgetSize) =>
            save(cards.map((card) => (card.id === id ? { ...card, size } : card))),
        remove: (id: string) => save(cards.filter((card) => card.id !== id)),
        move: (id: string, by: -1 | 1) => {
            const from = cards.findIndex((card) => card.id === id);
            const to = from + by;
            if (from < 0 || to < 0 || to >= cards.length) return;
            const next = [...cards];
            const [held] = next.splice(from, 1);
            next.splice(to, 0, held!);
            save(next);
        },
        full: cards.length >= MAX_APP_WIDGETS
    };
}

export type AppWidgetsState = ReturnType<typeof useAppWidgets>;

/**
 * The cards themselves, as items of the Overview's grid. Renders nothing for a
 * card whose app no longer offers it - it is kept in the layout for when the app
 * is back, like an Overview card the reader cannot see this week.
 */
export function AppWidgetGridItems({
    state,
    kinds
}: {
    state: AppWidgetsState;
    kinds: readonly AppWidgetKind[];
}) {
    const t = useTranslations("home");
    const toast = useToast();
    const [readouts, setReadouts] = useState<Record<string, AppWidgetReadout>>(
        () => kept?.cards ?? {}
    );
    const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
    const [setup, setSetup] = useState<(AppWidgetSetupSubject & { id: string }) | null>(null);

    const shown = state.cards.filter((card) =>
        kinds.some((kind) => kind.app === card.app && kind.kind === card.kind)
    );
    // Read again whenever what the cards watch changes, not on every render.
    const watching = shown.map((card) => `${card.id}=${card.targets.join(",")}`).join("|");

    const read = useCallback(async () => {
        try {
            const answer = await readAppWidgetsAction();
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

    return (
        <>
            {shown.map((card, index) => {
                const kind = kinds.find((one) => one.app === card.app && one.kind === card.kind)!;
                return (
                    <div
                        key={card.id}
                        data-app-widget={card.id}
                        className={cn("min-w-0", SPAN[card.size])}
                    >
                        <WidgetCard
                            title={kind.label}
                            icon={Blocks}
                            menu={
                                <AppWidgetMenu
                                    label={kind.label}
                                    size={card.size}
                                    first={index === 0}
                                    last={index === shown.length - 1}
                                    onConfigure={() =>
                                        setSetup({
                                            id: card.id,
                                            app: card.app,
                                            kind: card.kind,
                                            label: kind.label,
                                            targets: card.targets
                                        })
                                    }
                                    onMove={(by) => state.move(card.id, by)}
                                    onResize={(size) => state.resize(card.id, size)}
                                    onRemove={() => state.remove(card.id)}
                                />
                            }
                        >
                            <AppWidgetBody
                                readout={readouts[card.id]}
                                busy={busy}
                                onAct={(input) => void act(card.id, input)}
                                onConfigure={() =>
                                    setSetup({
                                        id: card.id,
                                        app: card.app,
                                        kind: card.kind,
                                        label: kind.label,
                                        targets: card.targets
                                    })
                                }
                            />
                        </WidgetCard>
                    </div>
                );
            })}
            <AppWidgetSetup
                subject={setup}
                onCancel={() => setSetup(null)}
                onSave={(targets) => {
                    if (setup) state.retarget(setup.id, targets);
                    setSetup(null);
                }}
            />
        </>
    );
}

function AppWidgetMenu({
    label,
    size,
    first,
    last,
    onConfigure,
    onMove,
    onResize,
    onRemove
}: {
    label: string;
    size: OverviewWidgetSize;
    first: boolean;
    last: boolean;
    onConfigure: () => void;
    onMove: (by: -1 | 1) => void;
    onResize: (size: OverviewWidgetSize) => void;
    onRemove: () => void;
}) {
    const t = useTranslations("home");
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    title={t("card.arrange", { name: label })}
                    aria-label={t("card.arrange", { name: label })}
                    className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    <MoreVertical className="size-4" aria-hidden="true" />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onSelect={onConfigure}>
                    <Settings2 className="size-4" aria-hidden="true" />
                    {t("appCards.change")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={first} onSelect={() => onMove(-1)}>
                    <ArrowUp className="size-4" aria-hidden="true" />
                    {t("card.moveUp")}
                </DropdownMenuItem>
                <DropdownMenuItem disabled={last} onSelect={() => onMove(1)}>
                    <ArrowDown className="size-4" aria-hidden="true" />
                    {t("card.moveDown")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{t("card.width")}</DropdownMenuLabel>
                {OVERVIEW_WIDGET_SIZES.map((option) => (
                    <DropdownMenuItem
                        key={option}
                        onSelect={() => onResize(option)}
                        className={cn(option === size && "text-primary")}
                    >
                        {sizeLabel(t, option)}
                    </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="danger" onSelect={onRemove}>
                    <Trash2 className="size-4" aria-hidden="true" />
                    {t("appCards.remove")}
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
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
