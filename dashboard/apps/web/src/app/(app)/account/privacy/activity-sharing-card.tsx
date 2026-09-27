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

import { useState } from "react";
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

export function ActivitySharingCard({
    settings,
    seenGames
}: {
    settings: core.ActivitySettings;
    /** Games the desktop app has seen, newest first. */
    seenGames: readonly core.SeenGame[];
}) {
    const [draft, setDraft] = useState(settings);
    const [error, setError] = useState("");

    /** Draw it now, save it, and put it back if the save is refused. */
    const commit = async (next: core.ActivitySettings) => {
        const before = draft;
        if (JSON.stringify(next) === JSON.stringify(before)) return;
        setDraft(next);
        setError("");
        const result = await runAction(() => saveActivitySettingsAction(next), setError);
        if (!result || result.error) {
            setDraft(before);
            if (result?.error) setError(result.error);
        }
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
                        onChange={(share) => void commit({ ...draft, share })}
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
                                onChange={(on) => void commit({ ...draft, [source.id]: on })}
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
                                                void commit({
                                                    ...draft,
                                                    hiddenGames: shown
                                                        ? draft.hiddenGames.filter((entry) => entry !== key)
                                                        : [...draft.hiddenGames, key]
                                                })
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
