"use client";

/**
 * Whether this account shows what it is doing, from where, and which games
 * never.
 *
 * Who sees it is not here: that is the "What you are playing or listening to"
 * row above, in the same vocabulary as every other "who". This card is only the
 * what - one switch for all of it, one per source, and one per game.
 *
 * Every switch saves as it is flipped, drawn at once and put back if the save
 * is refused: these are on/off answers with nothing to review, and a Save button
 * under a column of switches is a step people forget.
 */

import { useRef, useState } from "react";
import * as core from "@polaris/core";
import { runAction } from "@/lib/run-action";
import { Card, CardBody, Switch } from "@polaris/ui";
import { saveActivitySettingsAction } from "./actions";

/** A source's row: what it is and what it needs to work. */
const SOURCES: readonly { id: "games" | "minecraft"; label: string; hint: string }[] = [
    {
        id: "games",
        label: "Games on your computer",
        hint: "Seen by the Polaris desktop app on Windows, macOS and Linux. A browser cannot see what else is running, so this only works while the desktop app is open."
    },
    {
        id: "minecraft",
        label: "Minecraft servers here",
        hint: "When you play on one of this Polaris's Minecraft servers as a player linked to your account."
    }
];

/** One flip of a switch, applied to whatever state it lands on. */
type Change = (state: core.ActivitySettings) => core.ActivitySettings;

function same(a: core.ActivitySettings, b: core.ActivitySettings): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

export function ActivitySharingCard({
    settings,
    seenGames
}: {
    settings: core.ActivitySettings;
    /** Games the desktop app has seen, newest first. */
    seenGames: readonly core.SeenGame[];
}) {
    const [saved, setSaved] = useState(settings);
    const [pending, setPending] = useState<readonly { id: number; change: Change }[]>([]);
    const [error, setError] = useState("");
    const savedRef = useRef(settings);
    const queue = useRef<Promise<void>>(Promise.resolve());
    const nextId = useRef(0);
    const draft = pending.reduce((state, entry) => entry.change(state), saved);

    /** Draw it now, save it after any earlier switch, and drop only this one if the save is refused. */
    const commit = (change: Change) => {
        if (same(change(draft), draft)) return;
        const id = nextId.current++;
        setPending((current) => [...current, { id, change }]);
        setError("");
        queue.current = queue.current.then(async () => {
            const next = change(savedRef.current);
            if (!same(next, savedRef.current)) {
                const result = await runAction(() => saveActivitySettingsAction(next), setError);
                if (result && !result.error) {
                    savedRef.current = next;
                    setSaved(next);
                } else if (result?.error) setError(result.error);
            }
            setPending((current) => current.filter((entry) => entry.id !== id));
        });
    };

    // Every game this account could want to hide: the ones seen, and the ones
    // already hidden even if they have since dropped off the seen list.
    const games = new Map<string, string>();
    for (const game of seenGames) games.set(game.key, game.name);
    for (const game of draft.customGames) if (!games.has(game.executable)) games.set(game.executable, game.name);
    for (const key of draft.hiddenGames) if (!games.has(key)) games.set(key, key);

    const off = !draft.share;

    return (
        <Card>
            <CardBody className="flex flex-col gap-3 p-3">
                <div>
                    <h2 className="text-sm font-medium">Activity</h2>
                    <p className="text-[0.6875rem] leading-snug text-foreground-subtle">
                        What you are playing, shown beside your name. Only people who can see that
                        you are here see it, and nobody sees it while you appear offline.
                    </p>
                </div>

                <label className="flex items-center gap-3 rounded-md border border-border px-3 py-2">
                    <span className="min-w-0 flex-1">
                        <span className="block text-[0.8125rem]">Share my activity</span>
                        <span className="block text-[0.6875rem] leading-snug text-foreground-subtle">
                            Off hides all of it, from everybody.
                        </span>
                    </span>
                    <Switch
                        checked={draft.share}
                        onChange={(share) => commit((state) => ({ ...state, share }))}
                        aria-label="Share my activity"
                    />
                </label>

                <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border">
                    {SOURCES.map((source) => (
                        <li key={source.id} className="flex items-center gap-3 px-3 py-2">
                            <span className="min-w-0 flex-1">
                                <span className="block text-[0.8125rem]">{source.label}</span>
                                <span className="block text-[0.6875rem] leading-snug text-foreground-subtle">
                                    {source.hint}
                                </span>
                            </span>
                            <Switch
                                checked={!off && draft[source.id]}
                                disabled={off}
                                onChange={(on) => commit((state) => ({ ...state, [source.id]: on }))}
                                aria-label={source.label}
                            />
                        </li>
                    ))}
                </ul>

                <section className="flex flex-col gap-1.5">
                    <h3 className="text-[0.6875rem] font-medium uppercase tracking-[0.04em] text-foreground-subtle">
                        Games
                    </h3>
                    {games.size === 0 ? (
                        <p className="rounded-md border border-dashed border-border px-3 py-3 text-[0.6875rem] text-muted-foreground">
                            None yet. A game shows up here the first time the desktop app sees it
                            running, and you can hide it from then on.
                        </p>
                    ) : (
                        <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border">
                            {[...games].map(([key, name]) => {
                                const hidden = draft.hiddenGames.includes(key);
                                return (
                                    <li key={key} className="flex items-center gap-3 px-3 py-2">
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate text-[0.8125rem]" title={name}>
                                                {name}
                                            </span>
                                            <span
                                                className="block truncate text-[0.6875rem] text-foreground-subtle"
                                                title={key}
                                            >
                                                {hidden ? "Never shown" : key}
                                            </span>
                                        </span>
                                        <Switch
                                            checked={!hidden}
                                            disabled={off || !draft.games}
                                            onChange={(shown) =>
                                                commit((state) => ({
                                                    ...state,
                                                    hiddenGames: shown
                                                        ? state.hiddenGames.filter((entry) => entry !== key)
                                                        : state.hiddenGames.includes(key)
                                                          ? state.hiddenGames
                                                          : [...state.hiddenGames, key]
                                                }))
                                            }
                                            aria-label={`Show ${name}`}
                                        />
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </section>

                {error && (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                )}
            </CardBody>
        </Card>
    );
}
