"use client";

/**
 * Anti-cheat on the Security tab: the honeypots and the movement watch switched
 * on or off, what happens when somebody is caught, and every player scored on how
 * likely it is they are cheating, with the incidents behind it.
 *
 * The score is the reading aid, not the verdict: its reasons sit under it, and
 * every incident is listed with where and when. The mining figures only nudge
 * the X-Ray score and never lift a player past "Unlikely" on their own (see
 * `suspicion.ts`) - a player who explores caves finds diamonds for very little
 * rock.
 *
 * Nothing here needs the server restarted - it is all commands sent to the
 * running game, so a change is in effect at the next look - except Polaris's
 * anti-cheat engine at the top, which is a plugin (`anticheat-engine-card`).
 */

import { Eraser, Loader2 } from "lucide-react";
import type { GameKey } from "../../../messages";
import { hostUi } from "@polaris/app-host/client";
import { useGameText, type GameText } from "../game-text";
import { PlayerIconAction, PlayersTable } from "../../components/game-players-table";
import { useEffect, useMemo, useRef, useState, useTransition, type ComponentProps } from "react";
import { Badge, Button, Card, CardBody, Input, Select, Skeleton, Switch, cn } from "@polaris/ui";
import {
    BAN_HITS_MIN,
    CONFIRM_HITS,
    DEFAULT_XRAY_SETTINGS,
    xraySettingsSchema,
    type XrayAction,
    type XraySettings
} from "../../lib/minecraft/xray";
import {
    buildSuspects,
    rockPerOre,
    reasonLine,
    type Likelihood,
    type Score,
    type Suspect,
    type SuspectIncident
} from "../../lib/minecraft/suspicion";
import {
    clearXrayPlayerAction,
    readXrayAction,
    saveXraySettingsAction,
    type XrayView
} from "./xray-actions";
import { AnticheatEngineCard } from "./anticheat-engine-card";

const { useConfirm } = hostUi.confirmDialog;
const { useDisplayFormat } = hostUi.displayFormat;
const { writeSnapshot } = hostUi.snapshotCache;
const { useKeptSnapshot } = hostUi.liveRead;
const { mergeUnchanged } = hostUi.structuralMerge;

/** How old a kept reading may be and still paint first on a revisit. */
const KEPT_XRAY_MS = 24 * 3_600_000;

const ACTIONS: readonly { readonly value: XrayAction; readonly label: GameKey<"minecraft"> }[] = [
    { value: "notify", label: "xray.actions.notify" },
    { value: "warn", label: "xray.actions.warn" },
    { value: "warn-and-ban", label: "xray.actions.ban" }
];

const TONE: Readonly<Record<Likelihood, "neutral" | "warning" | "danger">> = {
    unlikely: "neutral",
    possible: "warning",
    likely: "danger",
    confirmed: "danger"
};

const FILTERS = [
    { value: "", label: "xray.filters.all" },
    { value: "suspicious", label: "xray.filters.suspicious" },
    { value: "xray", label: "xray.filters.xray" },
    { value: "movement", label: "xray.filters.movement" },
    { value: "engine", label: "xray.filters.engine" }
] as const satisfies readonly { value: string; label: GameKey<"minecraft"> }[];

const KIND_LABEL: Readonly<Record<SuspectIncident["kind"], GameKey<"minecraft">>> = {
    honeypot: "xray.kinds.honeypot",
    flying: "xray.kinds.flying",
    teleport: "xray.kinds.teleport"
};

const LIKELIHOOD_KEYS: Readonly<Record<Likelihood, GameKey<"minecraft">>> = {
    unlikely: "xray.likelihood.unlikely",
    possible: "xray.likelihood.possible",
    likely: "xray.likelihood.likely",
    confirmed: "xray.likelihood.confirmed"
};

/** `overworld 12 -40 88`, the way a player would type it into /tp. */
function placeOf(incident: { dimension: string; x: number; y: number; z: number }): string {
    return `${incident.dimension.replace("minecraft:", "").replace("the_", "")} ${incident.x} ${incident.y} ${incident.z}`;
}

/** One diamond per how many blocks of deepslate, or a dash with too little to say. */
function rateOf(t: GameText<"minecraft">, suspect: Suspect): string {
    const figures = suspect.mining;
    if (!figures) return "-";
    const diamonds = rockPerOre(figures.diamonds, figures.deepRock);
    if (diamonds !== null) return t("xray.diamondRate", { count: Math.round(diamonds) });
    const debris = rockPerOre(figures.debris, figures.netherRock);
    if (debris !== null) return t("xray.debrisRate", { count: Math.round(debris) });
    return "-";
}

/** A score, its word, and the first reason under it; every reason on hover. */
function ScoreCell({ score }: { score: Score }) {
    const t = useGameText("minecraft");
    const reasons = score.why.map((reason) => reasonLine(reason, t));
    return (
        <div className="flex min-w-0 flex-col gap-1" title={reasons.join("\n") || undefined}>
            <span className="flex items-center gap-2">
                <Badge variant={TONE[score.level]}>{t(LIKELIHOOD_KEYS[score.level])}</Badge>
                <span className="text-xs tabular-nums text-muted-foreground">{score.value}%</span>
            </span>
            <span className="h-1 w-24 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                <span
                    className={cn(
                        "block h-full rounded-full",
                        score.level === "unlikely"
                            ? "bg-foreground-subtle"
                            : score.level === "possible"
                              ? "bg-warning"
                              : "bg-danger"
                    )}
                    style={{ width: `${Math.max(score.value, 2)}%` }}
                />
            </span>
            {reasons[0] && (
                <span className="truncate text-xs text-muted-foreground">{reasons[0]}</span>
            )}
        </div>
    );
}

/** A switch, or its outline while the setting it shows is still being read -
 *  a default drawn in its place would flip over once the real one arrives - and
 *  nothing once reading it has failed. */
function LoadedSwitch({
    state,
    ...props
}: { state: "loaded" | "reading" | "failed" } & ComponentProps<typeof Switch>) {
    if (state === "loaded") return <Switch {...props} />;
    return state === "reading" ? <Skeleton className="h-5 w-9 shrink-0 rounded-full" /> : null;
}

/** Rows sketched in a table whose players are still being read. */
const TABLE_LOADING = (
    <div className="flex flex-col gap-2" aria-busy="true">
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-2/3" />
    </div>
);

export function MinecraftXray({
    installedAppId,
    canManage
}: {
    installedAppId: string;
    canManage: boolean;
}) {
    const t = useGameText("minecraft");
    const display = useDisplayFormat();
    const [view, setView] = useState<XrayView | null>(null);
    const [draft, setDraft] = useState<XraySettings>(DEFAULT_XRAY_SETTINGS);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [filter, setFilter] = useState<string>("");
    const [pending, startTransition] = useTransition();
    const [confirm, confirmElement] = useConfirm();

    // What this tab last read paints first, so the settings and the tables are
    // there at once on a revisit; the read below replaces what moved.
    const viewKey = `xray-view:${installedAppId}`;
    /** Whether the server has answered, after which the kept copy has no say.
     *  Until then the kept settings and tables are shown but cannot be changed,
     *  saved or cleared: a draft is only ever started from what the server holds. */
    const [heard, setHeard] = useState(false);
    const answered = useRef(false);
    useEffect(() => {
        if (heard && view) writeSnapshot(viewKey, view);
    }, [heard, viewKey, view]);
    useKeptSnapshot<XrayView>(viewKey, KEPT_XRAY_MS, (kept) => {
        if (answered.current) return;
        setView(kept.value);
        setDraft(kept.value.settings);
    });

    useEffect(() => {
        void readXrayAction(installedAppId).then((answer) => {
            const fresh = answer.view;
            if (!fresh) {
                setError(answer.error ?? t("xray.readFailed"));
                if (!answered.current) {
                    setView(null);
                    setDraft(DEFAULT_XRAY_SETTINGS);
                }
                return;
            }
            // A save or a clear already answered with a newer view than this read.
            if (answered.current) return;
            answered.current = true;
            setHeard(true);
            setView((current) => mergeUnchanged(current, fresh));
            // Nothing could be typed before this answer, so the form simply takes
            // the server's settings.
            setDraft((current) => mergeUnchanged(current, fresh.settings));
        });
    }, [installedAppId]);

    const problem = useMemo(() => {
        const parsed = xraySettingsSchema.safeParse(draft);
        if (parsed.success) return null;
        const message = parsed.error.issues[0]?.message;
        // The schema names its own words as `minecraft:<key>`, being shared with
        // the server, which has no reader when it loads.
        return message?.startsWith("minecraft:")
            ? t(message.slice("minecraft:".length) as GameKey<"minecraft">)
            : (message ?? t("xray.checkSettings"));
    }, [draft, t]);
    const dirty = view !== null && JSON.stringify(draft) !== JSON.stringify(view.settings);

    const { suspects, incidents } = useMemo(
        () =>
            view
                ? buildSuspects({
                      honeypots: view.players,
                      movement: view.movement,
                      mining: view.mining,
                      engine: view.engine,
                      players: view.online
                  })
                : { suspects: [], incidents: [] },
        [view]
    );
    const shown = useMemo(() => {
        const needle = search.trim().toLowerCase();
        return suspects.filter((one) => {
            if (needle && !one.key.includes(needle)) return false;
            if (filter === "suspicious")
                return (
                    one.xray.level !== "unlikely" ||
                    one.movement.level !== "unlikely" ||
                    one.engine.level !== "unlikely"
                );
            if (filter === "engine") return one.engineChecks.length > 0;
            if (filter === "xray") return one.hits > 0;
            if (filter === "movement") return one.flights + one.teleports > 0;
            return true;
        });
    }, [suspects, search, filter]);

    const change = (patch: Partial<XraySettings>) => {
        setDraft((current) => ({ ...current, ...patch }));
        setNote(null);
    };

    function keepView(next: XrayView): void {
        answered.current = true;
        setHeard(true);
        // The figures are only read on open; a save or a clear keeps them.
        setView((current) => ({ ...next, mining: current?.mining ?? next.mining }));
        setDraft(next.settings);
    }

    function save(): void {
        setError(null);
        startTransition(async () => {
            const result = await saveXraySettingsAction({ installedAppId, settings: draft });
            if (!result.view) {
                setError(result.error ?? t("xray.saveFailed"));
                return;
            }
            keepView(result.view);
            const { enabled, movement } = result.view.settings;
            setNote(
                enabled || movement
                    ? t(
                          enabled
                              ? movement
                                  ? "xray.savedPlacedWatched"
                                  : "xray.savedPlaced"
                              : "xray.savedRemovedWatched"
                      )
                    : t("xray.savedOff")
            );
        });
    }

    async function clear(player: string): Promise<void> {
        const agreed = await confirm({
            title: t("xray.clearTitle", { name: player }),
            description: t("xray.everythingRecordedAgainstThemIs"),
            confirmLabel: t("xray.clear")
        });
        if (!agreed) return;
        startTransition(async () => {
            const result = await clearXrayPlayerAction({ installedAppId, player });
            if (result.view) keepView(result.view);
            else setError(result.error ?? t("xray.clearFailed"));
        });
    }

    // Everything that is not the reading itself is drawn straight away: the
    // engine's own card asks for its state at the same time, and only the values
    // and the tables wait. The reading goes into the container for the players'
    // stats files and the player list, which is the slow part of this tab.
    const loaded = view !== null;
    /** Changing anything waits for the server's answer, as the form did when it
     *  was only drawn after it. */
    const editable = canManage && heard;
    const reading = loaded ? "loaded" : error ? "failed" : "reading";

    return (
        <div className="flex flex-col gap-4">
            <AnticheatEngineCard installedAppId={installedAppId} canManage={canManage} />
            <Card>
                <CardBody className="flex flex-col gap-4">
                    <div className="flex items-start justify-between gap-3">
                        <div>
                            <p className="text-sm font-medium">{t("xray.antiXRay")}</p>
                            <p className="text-xs text-muted-foreground">
                                {t("xray.intro", { count: CONFIRM_HITS })}
                            </p>
                        </div>
                        <LoadedSwitch
                            state={reading}
                            checked={draft.enabled}
                            disabled={!editable || view?.refusal != null}
                            onChange={(enabled) => change({ enabled })}
                            aria-label={t("xray.hideHoneypots")}
                        />
                    </div>
                    {view?.refusal && (
                        <p className="text-xs text-muted-foreground">{view.refusal}.</p>
                    )}

                    {reading === "reading" ? (
                        <Skeleton className="h-24 w-full" />
                    ) : !loaded ? null : (
                        <>
                            <div className="grid gap-3 sm:grid-cols-2">
                                <label className="flex flex-col gap-1 text-sm">
                                    <span className="font-medium">
                                        {t("xray.honeypotsAroundEachPlayer")}
                                    </span>
                                    <Input
                                        type="number"
                                        min={4}
                                        max={40}
                                        value={draft.perDimension}
                                        disabled={!editable}
                                        onChange={(event) =>
                                            change({
                                                perDimension: Math.round(
                                                    Number(event.target.value) || 0
                                                )
                                            })
                                        }
                                    />
                                    <span className="text-xs text-muted-foreground">
                                        {t("xray.aroundEveryPlayerWhereverThey")}
                                    </span>
                                </label>
                                <label className="flex items-center justify-between gap-2 text-sm sm:mt-6">
                                    <span>{t("xray.ancientDebrisInTheNether")}</span>
                                    <Switch
                                        checked={draft.nether}
                                        disabled={!editable}
                                        onChange={(nether) => change({ nether })}
                                        aria-label={t("xray.hideAncientDebrisInThe")}
                                    />
                                </label>
                            </div>

                            <label className="flex flex-col gap-1 text-sm">
                                <span className="font-medium">
                                    {t("xray.whenSomebodyIsConfirmed")}
                                </span>
                                <Select
                                    value={draft.action}
                                    onValueChange={(value) =>
                                        change({ action: value as XrayAction })
                                    }
                                    options={ACTIONS.map((one) => ({
                                        value: one.value,
                                        label: t(one.label)
                                    }))}
                                    disabled={!editable}
                                    aria-label={t("xray.whatHappensWhenSomebodyIs")}
                                />
                            </label>

                            {draft.action !== "notify" && (
                                <label className="flex flex-col gap-1 text-sm">
                                    <span className="font-medium">{t("xray.warningTheySee")}</span>
                                    <Input
                                        value={draft.warning}
                                        maxLength={400}
                                        disabled={!editable}
                                        onChange={(event) =>
                                            change({ warning: event.target.value })
                                        }
                                    />
                                    <span className="text-xs text-muted-foreground">
                                        {t("xray.inTheChatWithA")}
                                    </span>
                                </label>
                            )}

                            {draft.action === "warn-and-ban" && (
                                <div className="grid gap-3 sm:grid-cols-2">
                                    <label className="flex flex-col gap-1 text-sm">
                                        <span className="font-medium">
                                            {t("xray.banAfterThisManyHoneypots")}
                                        </span>
                                        <Input
                                            type="number"
                                            min={BAN_HITS_MIN}
                                            max={10}
                                            value={draft.banHits}
                                            disabled={!editable}
                                            onChange={(event) =>
                                                change({
                                                    banHits: Math.round(
                                                        Number(event.target.value) || 0
                                                    )
                                                })
                                            }
                                        />
                                        <span className="text-xs text-muted-foreground">
                                            {t("xray.atLeast", { count: BAN_HITS_MIN })}
                                        </span>
                                    </label>
                                    <label className="flex flex-col gap-1 text-sm">
                                        <span className="font-medium">{t("xray.banForHours")}</span>
                                        <Input
                                            type="number"
                                            min={1}
                                            max={168}
                                            value={draft.banHours}
                                            disabled={!editable}
                                            onChange={(event) =>
                                                change({
                                                    banHours: Math.round(
                                                        Number(event.target.value) || 0
                                                    )
                                                })
                                            }
                                        />
                                        <span className="text-xs text-muted-foreground">
                                            {t("xray.upToAWeek")}
                                        </span>
                                    </label>
                                </div>
                            )}
                        </>
                    )}

                    <div className="flex items-start justify-between gap-3 border-t border-border pt-4">
                        <div>
                            <p className="text-sm font-medium">{t("xray.flyingAndTeleporting")}</p>
                            <p className="text-xs text-muted-foreground">
                                {t("xray.flagsAPlayerSeenHovering")}
                            </p>
                        </div>
                        <LoadedSwitch
                            state={reading}
                            checked={draft.movement}
                            disabled={!editable || view?.refusal != null}
                            onChange={(movement) => change({ movement })}
                            aria-label={t("xray.watchForFlyingAndTeleporting")}
                        />
                    </div>
                    {view?.teleportCheck && (
                        <p className="text-xs text-warning-ink">{view.teleportCheck}.</p>
                    )}

                    {(problem || error) && (
                        <p role="alert" className="text-sm text-danger">
                            {problem ?? error}
                        </p>
                    )}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs text-muted-foreground">
                            {note ??
                                (view?.settings.enabled
                                    ? t("xray.hiddenNow", {
                                          diamonds: view.traps.overworld,
                                          debris: view.traps.nether
                                      })
                                    : canManage
                                      ? t("xray.changesApplyToTheRunning")
                                      : t("xray.onlySomebodyWhoManagesThis"))}
                        </span>
                        <Button
                            disabled={!loaded || !editable || pending || !dirty || problem !== null}
                            onClick={save}
                        >
                            {pending && <Loader2 className="size-4 animate-spin" />}
                            {t("xray.save")}
                        </Button>
                    </div>
                </CardBody>
            </Card>

            <Card>
                <CardBody className="flex flex-col gap-3">
                    <div>
                        <p className="text-sm font-medium">{t("xray.howLikelyEachPlayerIs")}</p>
                        <p className="text-xs text-muted-foreground">
                            {t("xray.fromWhatWasFoundIn")}
                        </p>
                    </div>
                    <PlayersTable
                        columns={[
                            { label: t("xray.player") },
                            { label: t("xray.xRay") },
                            { label: t("xray.flyingAndTeleporting") },
                            { label: t("xray.antiCheat") },
                            { label: t("xray.miningRate"), className: "hidden lg:table-cell" },
                            { label: t("xray.lastIncident"), className: "hidden md:table-cell" }
                        ]}
                        minWidth="58rem"
                        search={search}
                        onSearch={setSearch}
                        filter={filter}
                        filters={FILTERS.map((one) => ({ value: one.value, label: t(one.label) }))}
                        onFilter={setFilter}
                        isEmpty={shown.length === 0}
                        empty={
                            reading === "reading"
                                ? TABLE_LOADING
                                : !loaded
                                  ? t("xray.playersFailed")
                                  : suspects.length === 0
                                    ? t("xray.nothingRecorded")
                                    : t("xray.noPlayerMatches")
                        }
                        rows={shown.map((suspect) => (
                            <tr
                                key={suspect.key}
                                className="border-t border-border hover:bg-card-hover"
                            >
                                <td className="px-3 py-2 align-top">
                                    <p className="truncate font-medium" title={suspect.name}>
                                        {suspect.name}
                                    </p>
                                    {(suspect.bannedAt || suspect.warnedAt) && (
                                        <p className="text-xs text-muted-foreground">
                                            {suspect.bannedAt ? t("xray.banned") : t("xray.warned")}
                                        </p>
                                    )}
                                </td>
                                <td className="max-w-[16rem] px-3 py-2 align-top">
                                    <ScoreCell score={suspect.xray} />
                                </td>
                                <td className="max-w-[16rem] px-3 py-2 align-top">
                                    <ScoreCell score={suspect.movement} />
                                </td>
                                <td className="max-w-[16rem] px-3 py-2 align-top">
                                    <ScoreCell score={suspect.engine} />
                                </td>
                                <td
                                    className="hidden px-3 py-2 align-top text-xs tabular-nums text-muted-foreground lg:table-cell"
                                    title={
                                        suspect.mining
                                            ? t("xray.miningFigures", {
                                                  diamonds: suspect.mining.diamonds,
                                                  deep: suspect.mining.deepRock,
                                                  debris: suspect.mining.debris,
                                                  nether: suspect.mining.netherRock
                                              })
                                            : undefined
                                    }
                                >
                                    {rateOf(t, suspect)}
                                </td>
                                <td className="hidden px-3 py-2 align-top text-xs text-muted-foreground md:table-cell">
                                    {suspect.lastAt ? display.dateTime(suspect.lastAt) : "-"}
                                </td>
                                <td className="px-3 py-2 text-right align-top">
                                    {(suspect.hits > 0 ||
                                        suspect.flights + suspect.teleports > 0) && (
                                        <PlayerIconAction
                                            label={t("xray.clearNamed", { name: suspect.name })}
                                            icon={<Eraser className="size-4" />}
                                            disabled={pending || !heard}
                                            onClick={() => void clear(suspect.name)}
                                        />
                                    )}
                                </td>
                            </tr>
                        ))}
                    />
                </CardBody>
            </Card>

            <Card>
                <CardBody className="flex flex-col gap-3">
                    <div>
                        <p className="text-sm font-medium">{t("xray.incidents")}</p>
                        <p className="text-xs text-muted-foreground">
                            {t("xray.whereAndWhenNewestFirst")}
                        </p>
                    </div>
                    <PlayersTable
                        columns={[
                            { label: t("xray.when") },
                            { label: t("xray.player") },
                            { label: t("xray.what") },
                            { label: t("xray.where"), className: "hidden sm:table-cell" }
                        ]}
                        minWidth="36rem"
                        isEmpty={incidents.length === 0}
                        empty={
                            reading === "reading"
                                ? TABLE_LOADING
                                : loaded
                                  ? t("xray.noIncidents")
                                  : t("xray.incidentsFailed")
                        }
                        rows={incidents.slice(0, 100).map((incident) => (
                            <tr
                                key={`${incident.kind}:${incident.name}:${incident.at}:${incident.x}:${incident.z}`}
                                className="border-t border-border hover:bg-card-hover"
                            >
                                <td className="px-3 py-2 text-xs text-muted-foreground">
                                    {display.dateTime(incident.at)}
                                </td>
                                <td className="px-3 py-2 font-medium">{incident.name}</td>
                                <td className="px-3 py-2">
                                    {t(KIND_LABEL[incident.kind])}
                                    {incident.distance !== null && (
                                        <span className="text-muted-foreground">
                                            {t("xray.blocks", { count: incident.distance })}
                                        </span>
                                    )}
                                </td>
                                <td className="hidden px-3 py-2 font-mono text-xs text-muted-foreground sm:table-cell">
                                    {placeOf(incident)}
                                </td>
                                <td className="px-3 py-2" />
                            </tr>
                        ))}
                    />
                </CardBody>
            </Card>
            {confirmElement}
        </div>
    );
}
