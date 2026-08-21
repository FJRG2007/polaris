"use client";

/**
 * How an ARK world is played: the rates, what hurts whom, and the handful of
 * switches that decide whether the game is bearable at all.
 *
 * Nothing here is live. ARK reads every one of these when it starts, so a change
 * is a change to what the server will next be launched with - which the screen
 * says on every save rather than pretending a slider moved something. The restart
 * that applies them is offered here too, because otherwise the honest note about
 * "the next start" is a dead end.
 *
 * Each row shows one of three things, and the difference matters. A value Polaris
 * has pinned is what the server is launched with. A value it has not is whatever
 * the game's own settings file says, shown as its current reading. A setting
 * nothing has ever touched shows what the game does by itself. Unsetting a row
 * takes it back to the second or third of those, which is not the same as writing
 * the default in - the default moves between releases.
 */

import * as actions from "./ark-actions";
import { RestartPlanner } from "./restart-planner";
import { useCallback, useEffect, useState } from "react";
import type { ArkRules } from "@/lib/apps/ark/settings-service";
import { AlertTriangle, Info, Loader2, RefreshCw, RotateCcw, Search } from "lucide-react";
import { Button, Card, CardBody, Input, Skeleton, Switch, cn } from "@polaris/ui";
import {
    arkSettingGroups,
    normalizeArkValue,
    switchIsOn,
    switchValue,
    type ArkSetting
} from "@/lib/apps/ark/settings";

export function ArkRules({
    installedAppId,
    canManage,
    running
}: {
    installedAppId: string;
    /** False for somebody who may watch the server and not change it. */
    canManage: boolean;
    /** Whether the server is up. Everything here is a file inside its container,
     *  so a stopped server can be neither read nor changed. */
    running: boolean;
}) {
    const [rules, setRules] = useState<ArkRules | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    /** Whether anything has been changed since this screen was opened, which is
     *  what makes the restart worth offering rather than a button that is always
     *  there. */
    const [changed, setChanged] = useState(false);
    const [query, setQuery] = useState("");

    /**
     * The groups to draw, narrowed to what was asked for.
     *
     * The key is matched as well as the words. Somebody looking for a setting
     * here has almost always just read its name somewhere else -
     * `OverrideOfficialDifficulty`, `BabyMatureSpeedMultiplier` - and the row
     * they want says "Difficulty" and "How fast babies grow", which are the
     * right words to read and the wrong ones to search for.
     */
    const shown = arkSettingGroups()
        .map((group) => {
            const wanted = query.trim().toLowerCase();
            if (!wanted) return group;
            const matches = group.settings.filter((setting) =>
                [setting.key, setting.label, setting.hint, group.group]
                    .join(" ")
                    .toLowerCase()
                    .includes(wanted)
            );
            return { ...group, settings: matches };
        })
        .filter((group) => group.settings.length > 0);

    const load = useCallback(async () => {
        const result = await actions.readArkRulesAction(installedAppId);
        setRules(result);
        setLoading(false);
    }, [installedAppId]);

    useEffect(() => {
        void load();
    }, [load]);

    /** Pin one setting, or unpin it with null. What comes back is what the file
     *  now holds, so the row never shows something that was not written. */
    async function apply(setting: ArkSetting, value: string | null): Promise<void> {
        if (value !== null && normalizeArkValue(setting, value) === null) {
            setError(`${setting.label} does not take that value.`);
            return;
        }
        setBusy(setting.key);
        setError(null);
        const result = await actions.setArkRulesAction(installedAppId, { [setting.key]: value });
        setBusy(null);
        if (result.error || !result.rules) {
            setError(result.error ?? "That could not be saved");
            return;
        }
        setRules(result.rules);
        setChanged(true);
    }

    const reason = rules?.reason ?? null;

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm text-muted-foreground">
                    These are what the server is launched with. ARK reads them when it starts, so a
                    change takes effect the next time it does.
                </p>
                <Button
                    size="icon"
                    variant="ghost"
                    className="ml-auto"
                    aria-label="Read the settings again"
                    title="Read the settings again"
                    disabled={loading}
                    onClick={() => {
                        setLoading(true);
                        void load();
                    }}
                >
                    <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />
                </Button>
            </div>

            {error && (
                <Card>
                    <CardBody className="flex items-start gap-2 py-3 text-sm text-danger">
                        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                        <span>{error}</span>
                    </CardBody>
                </Card>
            )}

            {reason && (
                <Card>
                    <CardBody className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
                        <Info className="size-4 shrink-0" aria-hidden />
                        <span>{reason}</span>
                    </CardBody>
                </Card>
            )}

            {/* Only once something has actually been changed, or while a restart is
                already booked: a restart button that is always on screen is one
                somebody presses by accident. */}
            {canManage && (
                <RestartPlanner
                    installedAppId={installedAppId}
                    running={running}
                    changed={changed}
                    reason="a settings change"
                    onRestarted={() => {
                        setChanged(false);
                        void load();
                    }}
                />
            )}

            {/* Forty-odd rows in six groups, and somebody arriving here has
                usually just read the name of one on a wiki. Matched against the
                key as well as the words, which is the half that makes that
                arrival work. */}
            {!loading ? (
                <label className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Find a setting, by what it does or what ARK calls it"
                        aria-label="Find a setting"
                        className="pl-8"
                    />
                </label>
            ) : null}

            {loading ? (
                <div className="flex flex-col gap-2">
                    {Array.from({ length: 6 }, (_, index) => (
                        <Skeleton key={index} className="h-12 w-full" />
                    ))}
                </div>
            ) : (
                shown.map((group) => (
                    <div key={group.group} className="flex flex-col gap-1">
                        <p className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            {group.group}
                        </p>
                        <Card>
                            <CardBody className="flex flex-col gap-0 py-0">
                                {group.settings.map((setting, index) => (
                                    <SettingRow
                                        key={setting.key}
                                        setting={setting}
                                        pinned={rules?.overrides[setting.key] ?? null}
                                        live={rules?.live[setting.key] ?? null}
                                        first={index === 0}
                                        busy={busy === setting.key}
                                        disabled={!canManage || !running}
                                        onChange={(value) => void apply(setting, value)}
                                    />
                                ))}
                            </CardBody>
                        </Card>
                    </div>
                ))
            )}

            {!loading && shown.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                    Nothing here matches “{query}”. ARK has a great many settings and Polaris offers
                    the ones it can set as launch options; anything else lives in the game&apos;s own
                    files.
                </p>
            ) : null}

            <p className="text-xs text-muted-foreground">
                Polaris writes these as launch options rather than into the game&apos;s own settings
                file, because ARK rewrites that file when it stops - an edit made there while the
                server is up is thrown away at the moment it was meant to count.
            </p>

            {/* Two things people come to this screen for that are not here, because
                the game does not have them. Saying so is the only useful answer:
                the alternative is somebody reading forty rows looking for a switch
                that was never written. */}
            <p className="text-xs text-muted-foreground">
                ARK has no setting for showing everyone on the map - a player sees themselves and
                their tribe and nobody else - and none for how far away a name tag is readable. Both
                come from mods; add one from the Mods screen.
            </p>
        </div>
    );
}

function SettingRow({
    setting,
    pinned,
    live,
    first,
    busy,
    disabled,
    onChange
}: {
    setting: ArkSetting;
    /** What Polaris launches the server with, or null for a setting it does not
     *  pin. */
    pinned: string | null;
    /** What the game's own file says, for a setting Polaris does not pin. */
    live: string | null;
    /** The first row carries no divider above it. */
    first: boolean;
    busy: boolean;
    disabled: boolean;
    onChange: (value: string | null) => void;
}) {
    // What the row shows: what is pinned, else what the game says, else nothing -
    // and the note under it says which of the three this is.
    const shown = pinned ?? live ?? "";
    const [draft, setDraft] = useState(shown);
    useEffect(() => setDraft(shown), [shown]);

    // A switch is described as on or off rather than as the True or False in the
    // file: for the settings ARK names `DisableSomething` those two words are
    // opposites, and printing the raw one is the same trap as drawing it.
    const said = setting.type === "boolean" ? (switchIsOn(setting, live ?? "") ? "on" : "off") : live;
    const source =
        pinned !== null
            ? null
            : live !== null
              ? `The server's own file says ${said}.`
              : `Not set - the game uses ${setting.fallback}.`;

    return (
        <div
            className={cn(
                "flex flex-wrap items-center justify-between gap-3 py-3",
                !first && "border-t border-border"
            )}
        >
            <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-medium">
                    {setting.label}
                    {/* What ARK calls it. Quiet, because it is not what the row
                        is for - and present, because it is what somebody who
                        came here from a wiki is holding, and without it they are
                        reading forty rows of prose looking for a word that
                        appears in none of them. */}
                    <code className="min-w-0 truncate font-mono text-[11px] font-normal text-foreground-subtle">
                        {setting.key}
                    </code>
                    {busy && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />}
                </p>
                {setting.hint && <p className="text-xs text-muted-foreground">{setting.hint}</p>}
                {source && <p className="text-xs text-muted-foreground">{source}</p>}
            </div>
            <div className="flex items-center gap-2">
                {/* Only offered for a setting Polaris is pinning: there is nothing
                    to take back otherwise, and a button that does nothing is worse
                    than no button. */}
                {pinned !== null && (
                    <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Stop setting ${setting.label}`}
                        title="Leave it to the game"
                        disabled={disabled || busy}
                        onClick={() => onChange(null)}
                    >
                        <RotateCcw className="size-4" />
                    </Button>
                )}
                {setting.type === "boolean" ? (
                    <Switch
                        aria-label={setting.label}
                        disabled={disabled || busy}
                        // Through the setting rather than straight off the text: a
                        // few of ARK's switches are named `DisableSomething`, and
                        // drawing those as they are stored is how somebody turns
                        // gamma on and finds it off.
                        checked={switchIsOn(setting, shown)}
                        onChange={(next: boolean) => onChange(switchValue(setting, next))}
                    />
                ) : (
                    <Input
                        type="number"
                        className="w-28"
                        aria-label={setting.label}
                        disabled={disabled || busy}
                        min={setting.min}
                        max={setting.max}
                        step={setting.decimal ? "0.1" : "1"}
                        placeholder={setting.fallback}
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        // Committed on blur and on Enter rather than per keystroke:
                        // a write per digit would set the rate to 1, then 12, then
                        // 125.
                        onBlur={() => draft !== shown && onChange(draft)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter" && draft !== shown) onChange(draft);
                        }}
                        title={
                            setting.min !== undefined && setting.max !== undefined
                                ? `${setting.min} to ${setting.max}`
                                : undefined
                        }
                    />
                )}
            </div>
        </div>
    );
}
