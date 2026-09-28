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
import { hostUi } from "@polaris/app-host/client";
import { PlayerIconAction, PlayersTable } from "../../components/game-players-table";
import { useEffect, useMemo, useState, useTransition, type ComponentProps } from "react";
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
    LIKELIHOOD_LABEL,
    buildSuspects,
    rockPerOre,
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

const ACTIONS: readonly { readonly value: XrayAction; readonly label: string }[] = [
    { value: "notify", label: "Tell me, and do nothing else" },
    { value: "warn", label: "Tell me and warn the player" },
    { value: "warn-and-ban", label: "Tell me, warn, and ban if it goes on" }
];

const TONE: Readonly<Record<Likelihood, "neutral" | "warning" | "danger">> = {
    unlikely: "neutral",
    possible: "warning",
    likely: "danger",
    confirmed: "danger"
};

const FILTERS = [
    { value: "", label: "Every player" },
    { value: "suspicious", label: "Possible or worse" },
    { value: "xray", label: "X-Ray evidence" },
    { value: "movement", label: "Flying or teleporting" },
    { value: "engine", label: "Caught by the anti-cheat" }
] as const;

const KIND_LABEL: Readonly<Record<SuspectIncident["kind"], string>> = {
    honeypot: "Dug to a hidden ore",
    flying: "Hovered in the air",
    teleport: "Teleported"
};

/** `overworld 12 -40 88`, the way a player would type it into /tp. */
function placeOf(incident: { dimension: string; x: number; y: number; z: number }): string {
    return `${incident.dimension.replace("minecraft:", "").replace("the_", "")} ${incident.x} ${incident.y} ${incident.z}`;
}

/** One diamond per how many blocks of deepslate, or a dash with too little to say. */
function rateOf(suspect: Suspect): string {
    const figures = suspect.mining;
    if (!figures) return "-";
    const diamonds = rockPerOre(figures.diamonds, figures.deepRock);
    if (diamonds !== null) return `1 diamond per ${Math.round(diamonds)}`;
    const debris = rockPerOre(figures.debris, figures.netherRock);
    if (debris !== null) return `1 debris per ${Math.round(debris)}`;
    return "-";
}

/** A score, its word, and the first reason under it; every reason on hover. */
function ScoreCell({ score }: { score: Score }) {
    return (
        <div className="flex min-w-0 flex-col gap-1" title={score.reasons.join("\n") || undefined}>
            <span className="flex items-center gap-2">
                <Badge variant={TONE[score.level]}>{LIKELIHOOD_LABEL[score.level]}</Badge>
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
            {score.reasons[0] && (
                <span className="truncate text-xs text-muted-foreground">{score.reasons[0]}</span>
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
    const display = useDisplayFormat();
    const [view, setView] = useState<XrayView | null>(null);
    const [draft, setDraft] = useState<XraySettings>(DEFAULT_XRAY_SETTINGS);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [filter, setFilter] = useState<string>("");
    const [pending, startTransition] = useTransition();
    const [confirm, confirmElement] = useConfirm();

    useEffect(() => {
        void readXrayAction(installedAppId).then((answer) => {
            if (answer.view) {
                setView(answer.view);
                setDraft(answer.view.settings);
            } else setError(answer.error ?? "Anti-cheat could not be read");
        });
    }, [installedAppId]);

    const problem = useMemo(() => {
        const parsed = xraySettingsSchema.safeParse(draft);
        return parsed.success ? null : (parsed.error.issues[0]?.message ?? "Check the settings");
    }, [draft]);
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
        // The figures are only read on open; a save or a clear keeps them.
        setView((current) => ({ ...next, mining: current?.mining ?? next.mining }));
        setDraft(next.settings);
    }

    function save(): void {
        setError(null);
        startTransition(async () => {
            const result = await saveXraySettingsAction({ installedAppId, settings: draft });
            if (!result.view) {
                setError(result.error ?? "That could not be saved");
                return;
            }
            keepView(result.view);
            const { enabled, movement } = result.view.settings;
            setNote(
                enabled || movement
                    ? `Saved. ${enabled ? "Honeypots are placed around the players within a minute" : "Honeypots are being turned back into rock"}${movement ? ", and players are watched from the next few seconds" : ""}. No restart needed.`
                    : "Off. The honeypots are being turned back into rock. No restart needed."
            );
        });
    }

    async function clear(player: string): Promise<void> {
        const agreed = await confirm({
            title: `Clear ${player}?`,
            description: "Everything recorded against them is forgotten, as if it never happened.",
            confirmLabel: "Clear"
        });
        if (!agreed) return;
        startTransition(async () => {
            const result = await clearXrayPlayerAction({ installedAppId, player });
            if (result.view) keepView(result.view);
            else setError(result.error ?? "That could not be cleared");
        });
    }

    // Everything that is not the reading itself is drawn straight away: the
    // engine's own card asks for its state at the same time, and only the values
    // and the tables wait. The reading goes into the container for the players'
    // stats files and the player list, which is the slow part of this tab.
    const loaded = view !== null;
    const reading = loaded ? "loaded" : error ? "failed" : "reading";

    return (
        <div className="flex flex-col gap-4">
            <AnticheatEngineCard installedAppId={installedAppId} canManage={canManage} />
            <Card>
                <CardBody className="flex flex-col gap-4">
                    <div className="flex items-start justify-between gap-3">
                        <div>
                            <p className="text-sm font-medium">Anti X-Ray</p>
                            <p className="text-xs text-muted-foreground">
                                Polaris hides single diamonds and ancient debris fully enclosed in
                                rock around the players. Nobody can see them without X-Ray, so
                                digging straight to {CONFIRM_HITS} of them confirms it. One on its
                                own could be chance.
                            </p>
                        </div>
                        <LoadedSwitch
                            state={reading}
                            checked={draft.enabled}
                            disabled={!canManage || view?.refusal != null}
                            onChange={(enabled) => change({ enabled })}
                            aria-label="Hide honeypots"
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
                                        Honeypots around each player
                                    </span>
                                    <Input
                                        type="number"
                                        min={4}
                                        max={40}
                                        value={draft.perDimension}
                                        disabled={!canManage}
                                        onChange={(event) =>
                                            change({
                                                perDimension: Math.round(
                                                    Number(event.target.value) || 0
                                                )
                                            })
                                        }
                                    />
                                    <span className="text-xs text-muted-foreground">
                                        Around every player, wherever they are. Between 4 and 40.
                                    </span>
                                </label>
                                <label className="flex items-center justify-between gap-2 text-sm sm:mt-6">
                                    <span>Ancient debris in the Nether too</span>
                                    <Switch
                                        checked={draft.nether}
                                        disabled={!canManage}
                                        onChange={(nether) => change({ nether })}
                                        aria-label="Hide ancient debris in the Nether"
                                    />
                                </label>
                            </div>

                            <label className="flex flex-col gap-1 text-sm">
                                <span className="font-medium">When somebody is confirmed</span>
                                <Select
                                    value={draft.action}
                                    onValueChange={(value) =>
                                        change({ action: value as XrayAction })
                                    }
                                    options={ACTIONS.map((one) => ({
                                        value: one.value,
                                        label: one.label
                                    }))}
                                    disabled={!canManage}
                                    aria-label="What happens when somebody is confirmed"
                                />
                            </label>

                            {draft.action !== "notify" && (
                                <label className="flex flex-col gap-1 text-sm">
                                    <span className="font-medium">Warning they see</span>
                                    <Input
                                        value={draft.warning}
                                        maxLength={400}
                                        disabled={!canManage}
                                        onChange={(event) =>
                                            change({ warning: event.target.value })
                                        }
                                    />
                                    <span className="text-xs text-muted-foreground">
                                        In the chat, with a title. Colour codes such as &amp;c work.
                                    </span>
                                </label>
                            )}

                            {draft.action === "warn-and-ban" && (
                                <div className="grid gap-3 sm:grid-cols-2">
                                    <label className="flex flex-col gap-1 text-sm">
                                        <span className="font-medium">
                                            Ban after this many honeypots
                                        </span>
                                        <Input
                                            type="number"
                                            min={BAN_HITS_MIN}
                                            max={10}
                                            value={draft.banHits}
                                            disabled={!canManage}
                                            onChange={(event) =>
                                                change({
                                                    banHits: Math.round(
                                                        Number(event.target.value) || 0
                                                    )
                                                })
                                            }
                                        />
                                        <span className="text-xs text-muted-foreground">
                                            At least {BAN_HITS_MIN}, and only after the warning.
                                        </span>
                                    </label>
                                    <label className="flex flex-col gap-1 text-sm">
                                        <span className="font-medium">Ban for (hours)</span>
                                        <Input
                                            type="number"
                                            min={1}
                                            max={168}
                                            value={draft.banHours}
                                            disabled={!canManage}
                                            onChange={(event) =>
                                                change({
                                                    banHours: Math.round(
                                                        Number(event.target.value) || 0
                                                    )
                                                })
                                            }
                                        />
                                        <span className="text-xs text-muted-foreground">
                                            Up to a week.
                                        </span>
                                    </label>
                                </div>
                            )}
                        </>
                    )}

                    <div className="flex items-start justify-between gap-3 border-t border-border pt-4">
                        <div>
                            <p className="text-sm font-medium">Flying and teleporting</p>
                            <p className="text-xs text-muted-foreground">
                                Flags a player seen hovering without being allowed to fly, or moving
                                further in a few seconds than anybody can, when no operator
                                teleported them. Operators, creative mode, elytras, vehicles and
                                portals are left out. Never acted on automatically: an ender pearl
                                stasis chamber can look like a teleport.
                            </p>
                        </div>
                        <LoadedSwitch
                            state={reading}
                            checked={draft.movement}
                            disabled={!canManage || view?.refusal != null}
                            onChange={(movement) => change({ movement })}
                            aria-label="Watch for flying and teleporting"
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
                                    ? `${view.traps.overworld} diamonds and ${view.traps.nether} debris hidden right now. Changes apply without a restart.`
                                    : canManage
                                      ? "Changes apply to the running server, with no restart."
                                      : "Only somebody who manages this server can change it.")}
                        </span>
                        <Button
                            disabled={
                                !loaded || !canManage || pending || !dirty || problem !== null
                            }
                            onClick={save}
                        >
                            {pending && <Loader2 className="size-4 animate-spin" />}
                            Save
                        </Button>
                    </div>
                </CardBody>
            </Card>

            <Card>
                <CardBody className="flex flex-col gap-3">
                    <div>
                        <p className="text-sm font-medium">How likely each player is cheating</p>
                        <p className="text-xs text-muted-foreground">
                            From what was found in the last 14 days. Only honeypots can confirm
                            X-Ray; the mining rate is context and on its own never goes past
                            Unlikely. The anti-cheat column is Polaris anti-cheat&apos;s alerts,
                            which count once a check has failed past its own threshold. Everybody
                            online is listed. Mining counts are the game&apos;s own and arrive when
                            the server saves, a few minutes behind.
                        </p>
                    </div>
                    <PlayersTable
                        columns={[
                            { label: "Player" },
                            { label: "X-Ray" },
                            { label: "Flying and teleporting" },
                            { label: "Anti-cheat" },
                            { label: "Mining rate", className: "hidden lg:table-cell" },
                            { label: "Last incident", className: "hidden md:table-cell" }
                        ]}
                        minWidth="58rem"
                        search={search}
                        onSearch={setSearch}
                        filter={filter}
                        filters={FILTERS}
                        onFilter={setFilter}
                        isEmpty={shown.length === 0}
                        empty={
                            reading === "reading"
                                ? TABLE_LOADING
                                : !loaded
                                  ? "The players could not be read."
                                : suspects.length === 0
                                  ? "Nothing recorded against anybody yet, and no mining figures to show."
                                  : "No player matches."
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
                                            {suspect.bannedAt ? "Banned" : "Warned"}
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
                                            ? `${suspect.mining.diamonds} diamonds, ${suspect.mining.deepRock} deepslate, ${suspect.mining.debris} debris, ${suspect.mining.netherRock} nether rock`
                                            : undefined
                                    }
                                >
                                    {rateOf(suspect)}
                                </td>
                                <td className="hidden px-3 py-2 align-top text-xs text-muted-foreground md:table-cell">
                                    {suspect.lastAt ? display.dateTime(suspect.lastAt) : "-"}
                                </td>
                                <td className="px-3 py-2 text-right align-top">
                                    {(suspect.hits > 0 ||
                                        suspect.flights + suspect.teleports > 0) && (
                                        <PlayerIconAction
                                            label={`Clear ${suspect.name}`}
                                            icon={<Eraser className="size-4" />}
                                            disabled={pending}
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
                        <p className="text-sm font-medium">Incidents</p>
                        <p className="text-xs text-muted-foreground">
                            Where and when, newest first, so you can go and look before deciding.
                        </p>
                    </div>
                    <PlayersTable
                        columns={[
                            { label: "When" },
                            { label: "Player" },
                            { label: "What" },
                            { label: "Where", className: "hidden sm:table-cell" }
                        ]}
                        minWidth="36rem"
                        isEmpty={incidents.length === 0}
                        empty={
                            reading === "reading"
                                ? TABLE_LOADING
                                : loaded
                                  ? "Nothing has happened in the last 14 days."
                                  : "The incidents could not be read."
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
                                    {KIND_LABEL[incident.kind]}
                                    {incident.distance !== null && (
                                        <span className="text-muted-foreground">
                                            {` - ${incident.distance} blocks`}
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
