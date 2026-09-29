"use client";

/**
 * How a FiveM server is run: its name in the browser, how many people fit, what
 * clients are allowed to bring with them.
 *
 * Nothing here is live. Every one of these is a line in `server.cfg`, which the
 * server reads when it starts - so a change is a change to what it will next be
 * launched with, and the screen says so on every save rather than pretending a
 * switch moved something. The restart that applies them is offered here too,
 * because otherwise the honest note about the next start is a dead end.
 *
 * Each row shows one of two things and the difference matters: what the config
 * sets, or what the game does when nothing sets it. Unsetting a row takes the line
 * back out, which is not the same as writing the default in - a default moves
 * between builds and a line does not.
 */

import * as actions from "./fivem-actions";
import { useGameText, type GameText } from "../game-text";
import { hostUi } from "@polaris/app-host/client";
import { RestartPlanner } from "./restart-planner";
import { useCallback, useEffect, useState } from "react";
import type { FivemRule } from "../../lib/fivem/service";
import { AlertTriangle, Loader2, RefreshCw, RotateCcw, Search } from "lucide-react";
import { Button, Card, CardBody, Input, Select, Skeleton, Switch, cn } from "@polaris/ui";
import {
    settingError,
    switchIsOn,
    switchValue,
    FIVEM_SETTINGS,
    FIVEM_SETTING_GROUPS,
    type FivemSetting
} from "../../lib/fivem/settings";

const { writeSnapshot } = hostUi.snapshotCache;
const { useKeptSnapshot } = hostUi.liveRead;
const { mergeUnchanged } = hostUi.structuralMerge;

/** How old the kept rules may be and still paint first on a revisit. */
const KEPT_RULES_MS = 24 * 3_600_000;

export function FivemRules({
    installedAppId,
    canManage,
    running
}: {
    installedAppId: string;
    /** False for somebody who may watch the server and not change it. */
    canManage: boolean;
    /** Whether the server is up. The config is a file inside its container, so a
     *  stopped server can be neither read nor changed. */
    running: boolean;
}) {
    const t = useGameText("fivem");
    // What this tab last read paints first, so a revisit is not a skeleton while
    // the config is read inside the container again; the read replaces what moved.
    const rulesKey = `fivem-rules:${installedAppId}`;
    const [rules, setRules] = useState<readonly FivemRule[] | null>(null);
    const [loading, setLoading] = useState(true);
    useKeptSnapshot<readonly FivemRule[]>(rulesKey, KEPT_RULES_MS, (kept) => {
        setRules((current) => current ?? kept.value);
        setLoading(false);
    });
    // Whether this visit's own read has answered. The kept values only paint: no
    // row can be typed into or switched until the config has been read again.
    const [fresh, setFresh] = useState(false);
    useEffect(() => {
        if (fresh && rules) writeSnapshot(rulesKey, rules);
    }, [fresh, rulesKey, rules]);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    /** Whether anything has been changed since this screen was opened, which is
     *  what makes the restart worth offering rather than a button that is always
     *  there. */
    const [changed, setChanged] = useState(false);
    const [query, setQuery] = useState("");

    const load = useCallback(async () => {
        const result = await actions.readFivemRulesAction(installedAppId);
        setRules((current) => mergeUnchanged(current, result.rules ?? null));
        setError(result.error ?? null);
        setFresh(true);
        setLoading(false);
    }, [installedAppId]);

    useEffect(() => {
        void load();
    }, [load]);

    /**
     * The groups to draw, narrowed to what was asked for.
     *
     * The key is matched as well as the words, which is the half that matters:
     * somebody arriving here has almost always just read `sv_scriptHookAllowed`
     * somewhere else, and the row they want says "Allow ScriptHook mods".
     */
    const wanted = query.trim().toLowerCase();
    const shown = FIVEM_SETTING_GROUPS.map((group) => ({
        group,
        settings: FIVEM_SETTINGS.filter(
            (setting) =>
                setting.group === group &&
                (wanted.length === 0 ||
                    [setting.key, t(setting.label), setting.hint ? t(setting.hint) : "", t(group)]
                        .join(" ")
                        .toLowerCase()
                        .includes(wanted))
        )
    })).filter((entry) => entry.settings.length > 0);

    /** Write one line, or take it out with null. What is drawn afterwards is what
     *  the file now holds, so a row never shows something that was not written. */
    async function apply(setting: FivemSetting, value: string | null): Promise<void> {
        if (value !== null) {
            const problem = settingError(setting, value, t);
            if (problem) {
                setError(
                    `${t(setting.label)}: ${problem.charAt(0).toLowerCase()}${problem.slice(1)}`
                );
                return;
            }
        }
        setBusy(setting.key);
        setError(null);
        const result = await actions.saveFivemRulesAction(installedAppId, { [setting.key]: value });
        if (result.error) {
            setBusy(null);
            setError(result.error);
            return;
        }
        await load();
        setBusy(null);
        setChanged(true);
    }

    const ruleFor = (key: string): FivemRule | null =>
        rules?.find((rule) => rule.key === key) ?? null;

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm text-muted-foreground">{t("rules.theseAreTheLinesIn")}</p>
                <Button
                    size="icon"
                    variant="ghost"
                    className="ml-auto"
                    aria-label={t("rules.readTheConfigAgain")}
                    title={t("rules.readTheConfigAgain")}
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

            {canManage && (
                <RestartPlanner
                    installedAppId={installedAppId}
                    running={running}
                    changed={changed}
                    reason={t("rules.restartReason")}
                    onRestarted={() => {
                        setChanged(false);
                        void load();
                    }}
                />
            )}

            {/* The settings are Polaris' own list, so the search and every row
                are drawn at once; only what the config says waits for the
                container. */}
            <label className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t("rules.findASettingByWhat")}
                    aria-label={t("rules.findASetting")}
                    className="pl-8"
                />
            </label>

            {shown.map((entry) => (
                <div key={entry.group} className="flex flex-col gap-1">
                    <p className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {t(entry.group)}
                    </p>
                    <Card>
                        <CardBody className="flex flex-col gap-0 py-0">
                            {entry.settings.map((setting, index) => (
                                <SettingRow
                                    key={setting.key}
                                    setting={setting}
                                    rule={ruleFor(setting.key)}
                                    first={index === 0}
                                    busy={busy === setting.key}
                                    loading={loading}
                                    disabled={!canManage || !running || rules === null || !fresh}
                                    onChange={(value) => void apply(setting, value)}
                                />
                            ))}
                        </CardBody>
                    </Card>
                </div>
            ))}

            {shown.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("rules.noMatch", { query })}</p>
            ) : null}

            <p className="text-xs text-muted-foreground">{t("rules.anythingAResourceAddsJobs")}</p>
        </div>
    );
}

function SettingRow({
    setting,
    rule,
    first,
    busy,
    loading,
    disabled,
    onChange
}: {
    setting: FivemSetting;
    /** What the config sets, or null while the file has not been read. */
    rule: FivemRule | null;
    /** The first row carries no divider above it. */
    first: boolean;
    busy: boolean;
    /** While the config is still being read: the row is drawn, its control is an
     *  outline rather than a default that would flip once the value lands. */
    loading: boolean;
    disabled: boolean;
    onChange: (next: string | null) => void;
}) {
    const t = useGameText("fivem");
    // Never the value for a secret: the reading does not carry one, and the row
    // says whether it is set instead - which is the only thing anybody needs to
    // read off it.
    const value = rule?.value ?? null;
    const isSet = rule?.set ?? false;
    const [draft, setDraft] = useState(value ?? "");
    useEffect(() => setDraft(value ?? ""), [value]);

    return (
        <div
            className={cn(
                "flex flex-wrap items-center justify-between gap-3 py-3",
                !first && "border-t border-border"
            )}
        >
            <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-medium">
                    {t(setting.label)}
                    {/* What FiveM calls it. Quiet, because it is not what the row is
                        for - and present, because it is what somebody arriving from
                        a forum post is holding. */}
                    <code className="min-w-0 truncate font-mono text-[0.6875rem] font-normal text-foreground-subtle">
                        {setting.key}
                    </code>
                    {busy && (
                        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                    )}
                </p>
                {setting.hint && <p className="text-xs text-muted-foreground">{t(setting.hint)}</p>}
                {!isSet && !loading && (
                    <p className="text-xs text-muted-foreground">
                        {t("rules.notSet", { fallback: fallbackText(t, setting.fallback) })}
                    </p>
                )}
            </div>
            {loading ? (
                <Skeleton
                    className={cn(
                        "shrink-0",
                        setting.type === "boolean"
                            ? "h-5 w-9 rounded-full"
                            : setting.type === "choice"
                              ? "h-9 w-48"
                              : setting.type === "number"
                                ? "h-9 w-28"
                                : "h-9 w-56"
                    )}
                />
            ) : (
                <div className="flex items-center gap-2">
                    {/* Only offered for a line the config actually has: there is nothing
                        to take back otherwise, and a button that does nothing is worse
                        than no button. */}
                    {isSet && setting.type !== "boolean" && (
                        <Button
                            size="icon"
                            variant="ghost"
                            aria-label={t("rules.stopSetting", { name: t(setting.label) })}
                            title={t("rules.leaveItToTheServer")}
                            disabled={disabled || busy}
                            onClick={() => onChange(null)}
                        >
                            <RotateCcw className="size-4" />
                        </Button>
                    )}
                    {setting.type === "boolean" ? (
                        <Switch
                            aria-label={t(setting.label)}
                            disabled={disabled || busy}
                            checked={switchIsOn(setting, value)}
                            onChange={(next: boolean) => onChange(switchValue(setting, next))}
                        />
                    ) : setting.type === "choice" ? (
                        <Select
                            className="w-48"
                            aria-label={t(setting.label)}
                            disabled={disabled || busy}
                            value={value ?? ""}
                            onValueChange={(next) => onChange(next || null)}
                            options={[
                                {
                                    value: "",
                                    label: t("rules.leaveWithFallback", {
                                        fallback: fallbackText(t, setting.fallback)
                                    })
                                },
                                ...(setting.choices ?? []).map((choice) => ({
                                    value: choice.value,
                                    label: t(choice.label)
                                }))
                            ]}
                        />
                    ) : (
                        <Input
                            type={setting.type === "number" ? "number" : "text"}
                            className={setting.type === "number" ? "w-28" : "w-56"}
                            aria-label={t(setting.label)}
                            disabled={disabled || busy}
                            min={setting.min}
                            max={setting.max}
                            autoComplete="off"
                            spellCheck={false}
                            placeholder={
                                setting.secret && isSet
                                    ? t("rules.setTypeANewOne")
                                    : fallbackText(t, setting.fallback)
                            }
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
                            // Committed on blur and on Enter rather than per keystroke: a
                            // write per digit would set the slots to 3, then 32, then 320.
                            onBlur={() =>
                                draft !== (value ?? "") && onChange(draft.length > 0 ? draft : null)
                            }
                            onKeyDown={(event) => {
                                if (event.key === "Enter" && draft !== (value ?? "")) {
                                    onChange(draft.length > 0 ? draft : null);
                                }
                            }}
                        />
                    )}
                </div>
            )}
        </div>
    );
}

/** What the server falls back to, in words: the table's own few words translated,
 *  anything else - a name, a number - as it is. */
function fallbackText(t: GameText<"fivem">, fallback: string): string {
    if (fallback === "on") return t("rules.fallbacks.on");
    if (fallback === "off") return t("rules.fallbacks.off");
    if (fallback === "none") return t("rules.fallbacks.none");
    if (fallback === "the newest") return t("rules.fallbacks.newest");
    return fallback;
}
