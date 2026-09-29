"use client";

/**
 * Whether this account shows what it is doing, from where, which games never,
 * and which programs beyond the desktop app's own list count as one.
 *
 * Who sees it is not here: that is the "What you are playing or listening to"
 * row above, in the same vocabulary as every other "who". This card is only the
 * what - one switch for all of it, one per source, one per game, and the list
 * of programs this account calls a game on its own (`OwnGames` below).
 *
 * Every switch saves as it is flipped, drawn at once and put back if the save
 * is refused: these are on/off answers with nothing to review, and a Save button
 * under a column of switches is a step people forget.
 */

import Link from "next/link";
import * as core from "@polaris/core";
import { Plus, X } from "lucide-react";
import { useRef, useState } from "react";
import { runAction } from "@/lib/run-action";
import { saveActivitySettingsAction } from "./actions";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useDesktopBridge } from "@/components/desktop-app";
import { Button, Card, CardBody, Input, Switch } from "@polaris/ui";

/** Whether Spotify can be shown for this account, and what is missing if not. */
export type SpotifyReadiness = "linked" | "unlinked" | "unavailable";

/** A source's row: what it is and what it needs to work. */
const SOURCES = ["games", "minecraft"] as const;

/** One flip of a switch, applied to whatever state it lands on. */
type Change = (state: core.ActivitySettings) => core.ActivitySettings;

function same(a: core.ActivitySettings, b: core.ActivitySettings): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

export function ActivitySharingCard({
    settings,
    seenGames,
    spotify
}: {
    settings: core.ActivitySettings;
    /** Games the desktop app has seen, newest first. */
    seenGames: readonly core.SeenGame[];
    /** Whether this account has a Spotify linked, or could link one here. */
    spotify: SpotifyReadiness;
}) {
    const t = useTranslations("accountPrivacy");
    const [saved, setSaved] = useState(settings);
    const [pending, setPending] = useState<readonly { id: number; change: Change }[]>([]);
    const [error, setError] = useState("");
    const savedRef = useRef(settings);
    const queue = useRef<Promise<void>>(Promise.resolve());
    const nextId = useRef(0);
    const bridge = useDesktopBridge();
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
                    // The desktop app this page is open in looks for a changed
                    // list at once, rather than the next time it is started.
                    if (!same({ ...next, customGames: savedRef.current.customGames }, next)) {
                        void bridge?.setCustomGames?.(next.customGames);
                    }
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
    for (const game of draft.customGames)
        if (!games.has(game.executable)) games.set(game.executable, game.name);
    for (const key of draft.hiddenGames) if (!games.has(key)) games.set(key, key);

    const off = !draft.share;

    return (
        <Card>
            <CardBody className="flex flex-col gap-3 p-3">
                <div>
                    <h2 className="text-sm font-medium">{t("activity.title")}</h2>
                    <p className="text-[0.6875rem] leading-snug text-foreground-subtle">{t("activity.description")}</p>
                </div>

                <label className="flex items-center gap-3 rounded-md border border-border px-3 py-2">
                    <span className="min-w-0 flex-1">
                        <span className="block text-[0.8125rem]">{t("activity.share")}</span>
                        <span className="block text-[0.6875rem] leading-snug text-foreground-subtle">
                            {t("activity.shareHint")}
                        </span>
                    </span>
                    <Switch
                        checked={draft.share}
                        onChange={(share) => commit((state) => ({ ...state, share }))}
                        aria-label={t("activity.share")}
                    />
                </label>

                <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border">
                    <li className="flex items-center gap-3 px-3 py-2">
                        <span className="min-w-0 flex-1">
                            {/* i18n-ignore: a service's own name */}
                            <span className="block text-[0.8125rem]">Spotify</span>
                            <span className="block text-[0.6875rem] leading-snug text-foreground-subtle">
                                {spotify === "linked"
                                    ? t("activity.spotify.linked")
                                    : spotify === "unlinked"
                                      ? t.rich("activity.spotify.unlinked", {
                                            link: (chunks) => (
                                                <Link
                                                    key="link"
                                                    href="/account/connections"
                                                    className="underline decoration-dotted underline-offset-2 hover:text-foreground"
                                                >
                                                    {chunks}
                                                </Link>
                                            )
                                        })
                                      : t("activity.spotify.unavailable")}
                            </span>
                        </span>
                        <Switch
                            checked={!off && draft.spotify}
                            disabled={off}
                            onChange={(on) => commit((state) => ({ ...state, spotify: on }))}
                            // i18n-ignore: a service's own name
                            aria-label="Spotify"
                        />
                    </li>
                    {SOURCES.map((source) => (
                        <li key={source} className="flex items-center gap-3 px-3 py-2">
                            <span className="min-w-0 flex-1">
                                <span className="block text-[0.8125rem]">{t(`activity.sources.${source}.label` as const)}</span>
                                <span className="block text-[0.6875rem] leading-snug text-foreground-subtle">
                                    {t(`activity.sources.${source}.hint` as const)}
                                </span>
                            </span>
                            <Switch
                                checked={!off && draft[source]}
                                disabled={off}
                                onChange={(on) =>
                                    commit((state) => ({ ...state, [source]: on }))
                                }
                                aria-label={t(`activity.sources.${source}.label` as const)}
                            />
                        </li>
                    ))}
                </ul>

                <section className="flex flex-col gap-1.5">
                    <h3 className="text-[0.6875rem] font-medium uppercase tracking-[0.04em] text-foreground-subtle">
                        {t("activity.games")}
                    </h3>
                    {games.size === 0 ? (
                        <p className="rounded-md border border-dashed border-border px-3 py-3 text-[0.6875rem] text-muted-foreground">
                            {t("activity.noGames")}
                        </p>
                    ) : (
                        <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border">
                            {[...games].map(([key, name]) => {
                                const hidden = draft.hiddenGames.includes(key);
                                return (
                                    <li key={key} className="flex items-center gap-3 px-3 py-2">
                                        <span className="min-w-0 flex-1">
                                            <span
                                                className="block truncate text-[0.8125rem]"
                                                title={name}
                                            >
                                                {name}
                                            </span>
                                            <span
                                                className="block truncate text-[0.6875rem] text-foreground-subtle"
                                                title={key}
                                            >
                                                {hidden ? t("activity.neverShown") : key}
                                            </span>
                                        </span>
                                        <Switch
                                            checked={!hidden}
                                            disabled={off || !draft.games}
                                            onChange={(shown) =>
                                                commit((state) => ({
                                                    ...state,
                                                    hiddenGames: shown
                                                        ? state.hiddenGames.filter(
                                                              (entry) => entry !== key
                                                          )
                                                        : state.hiddenGames.includes(key)
                                                          ? state.hiddenGames
                                                          : [...state.hiddenGames, key]
                                                }))
                                            }
                                            aria-label={t("activity.showGame", { name })}
                                        />
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </section>

                <OwnGames
                    games={draft.customGames}
                    disabled={off || !draft.games}
                    runningPrograms={
                        bridge?.runningPrograms ? () => bridge.runningPrograms!() : null
                    }
                    onAdd={(game) =>
                        commit((state) => ({
                            ...state,
                            customGames: [
                                ...state.customGames.filter(
                                    (entry) => entry.executable !== game.executable
                                ),
                                game
                            ]
                        }))
                    }
                    onRemove={(executable) =>
                        commit((state) => ({
                            ...state,
                            customGames: state.customGames.filter(
                                (entry) => entry.executable !== executable
                            )
                        }))
                    }
                />

                {error && (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                )}
            </CardBody>
        </Card>
    );
}

/**
 * Programs this account says are games, beyond the ones the desktop app knows.
 *
 * Keyed by the program's own name, the way the app sees it. Inside the desktop
 * app the running programs can be listed to pick from, since the name of the
 * program behind a game is rarely what anybody would guess; in a browser there
 * is no such list and the name is typed.
 */
function OwnGames({
    games,
    disabled,
    runningPrograms,
    onAdd,
    onRemove
}: {
    games: readonly core.CustomGame[];
    disabled: boolean;
    /** Lists what is running, inside the desktop app; null in a browser. */
    runningPrograms: (() => Promise<readonly string[]>) | null;
    onAdd: (game: core.CustomGame) => void;
    onRemove: (executable: string) => void;
}) {
    const t = useTranslations("accountPrivacy");
    const [program, setProgram] = useState("");
    const [name, setName] = useState("");
    const [running, setRunning] = useState<readonly string[] | null>(null);

    // Checked as it is typed, against the same rules the server keeps. An empty
    // field is not wrong yet, only unfinished.
    const candidate = core.customGameSchema.safeParse({ executable: program, name });
    const taken =
        candidate.success && games.some((game) => game.executable === candidate.data.executable);
    const full = games.length >= core.MOST_CUSTOM_GAMES;
    const problem = full
        ? t("ownGames.full", { count: core.MOST_CUSTOM_GAMES })
        : program.trim() && name.trim()
          ? taken
              ? t("ownGames.taken")
              : candidate.success
                ? ""
                : (candidate.error.issues[0]?.message ?? t("ownGames.check"))
          : "";
    const ready = candidate.success && !taken && !full;

    // Drawn on the list at once, like every switch on this card; a refused save
    // takes it off again and says why under the card.
    const add = () => {
        if (!candidate.success || !ready) return;
        onAdd(candidate.data);
        setProgram("");
        setName("");
    };

    return (
        <section className="flex flex-col gap-1.5">
            <h3 className="text-[0.6875rem] font-medium uppercase tracking-[0.04em] text-foreground-subtle">
                {t("ownGames.title")}
            </h3>
            <p className="text-[0.6875rem] leading-snug text-foreground-subtle">{t("ownGames.description")}</p>
            {games.length > 0 && (
                <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border">
                    {games.map((game) => (
                        <li key={game.executable} className="flex items-center gap-3 px-3 py-2">
                            <span className="min-w-0 flex-1">
                                <span className="block truncate text-[0.8125rem]" title={game.name}>
                                    {game.name}
                                </span>
                                <span
                                    className="block truncate text-[0.6875rem] text-foreground-subtle"
                                    title={game.executable}
                                >
                                    {game.executable}
                                </span>
                            </span>
                            <button
                                type="button"
                                disabled={disabled}
                                aria-label={t("ownGames.remove", { name: game.name })}
                                title={t("ownGames.remove", { name: game.name })}
                                onClick={() => onRemove(game.executable)}
                                className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                            >
                                <X className="size-3.5 shrink-0" />
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            <div className="flex flex-wrap items-end gap-2">
                <label className="flex min-w-[10rem] flex-1 flex-col gap-1 text-[0.6875rem] text-muted-foreground">
                    {t("ownGames.program")}
                    <Input
                        value={program}
                        onChange={(event) => setProgram(event.target.value)}
                        placeholder="mygame.exe"
                        disabled={disabled}
                        className="h-8 text-xs"
                    />
                </label>
                <label className="flex min-w-[10rem] flex-1 flex-col gap-1 text-[0.6875rem] text-muted-foreground">
                    {t("ownGames.name")}
                    <Input
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        placeholder={t("ownGames.namePlaceholder")}
                        disabled={disabled}
                        className="h-8 text-xs"
                    />
                </label>
                <Button size="sm" onClick={add} disabled={disabled || !ready}>
                    <Plus className="size-4 shrink-0" />
                    {t("ownGames.add")}
                </Button>
            </div>
            {problem ? <p className="text-[0.6875rem] text-danger">{problem}</p> : null}
            {runningPrograms ? (
                running ? (
                    <div className="flex max-h-40 flex-wrap gap-1 overflow-y-auto overscroll-contain rounded-md border border-border p-2">
                        {running.length === 0 ? (
                            <span className="text-[0.6875rem] text-muted-foreground">
                                {t("ownGames.nothingListed")}
                            </span>
                        ) : (
                            running.map((entry) => (
                                <button
                                    key={entry}
                                    type="button"
                                    onClick={() => setProgram(entry)}
                                    className="max-w-[14rem] truncate rounded-full bg-muted px-2 py-0.5 text-[0.6875rem] transition-colors hover:bg-card-hover"
                                    title={entry}
                                >
                                    {entry}
                                </button>
                            ))
                        )}
                    </div>
                ) : (
                    <button
                        type="button"
                        disabled={disabled}
                        onClick={() =>
                            void runningPrograms()
                                .then(setRunning)
                                .catch(() => setRunning([]))
                        }
                        className="self-start rounded text-[0.6875rem] text-muted-foreground underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground disabled:opacity-50"
                    >
                        {t("ownGames.chooseRunning")}
                    </button>
                )
            ) : null}
        </section>
    );
}
