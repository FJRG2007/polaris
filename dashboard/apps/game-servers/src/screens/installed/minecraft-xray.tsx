"use client";

/**
 * Anti X-Ray on the Security tab: the honeypots switched on or off, what happens
 * when somebody digs to them, the evidence per player, and the game's own mining
 * figures beside it for context.
 *
 * The figures are never a verdict (see `xray.ts`): a player who explores caves
 * finds diamonds at a rate that would read as cheating, so they are shown as
 * numbers with no colour and no label.
 */

import { Loader2 } from "lucide-react";
import { hostUi } from "@polaris/app-host/client";
import { useEffect, useMemo, useState, useTransition } from "react";
import { Badge, Button, Card, CardBody, Input, Select, Switch } from "@polaris/ui";
import {
    BAN_HITS_MIN,
    CONFIRM_HITS,
    DEFAULT_XRAY_SETTINGS,
    xraySettingsSchema,
    type XrayAction,
    type XraySettings
} from "../../lib/minecraft/xray";
import {
    clearXrayPlayerAction,
    readXrayAction,
    saveXraySettingsAction,
    type XrayView
} from "./xray-actions";

const { useConfirm } = hostUi.confirmDialog;

const ACTIONS: readonly { readonly value: XrayAction; readonly label: string }[] = [
    { value: "notify", label: "Tell me, and do nothing else" },
    { value: "warn", label: "Tell me and warn the player" },
    { value: "warn-and-ban", label: "Tell me, warn, and ban if it goes on" }
];

/** One diamond per how many blocks of deepslate, or a dash with too little to say. */
function oneIn(ore: number, rock: number): string {
    if (ore === 0 || rock < 50) return "-";
    return `1 per ${Math.max(1, Math.round(rock / ore))}`;
}

export function MinecraftXray({
    installedAppId,
    canManage
}: {
    installedAppId: string;
    canManage: boolean;
}) {
    const [view, setView] = useState<XrayView | null>(null);
    const [draft, setDraft] = useState<XraySettings>(DEFAULT_XRAY_SETTINGS);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [confirm, confirmElement] = useConfirm();

    useEffect(() => {
        void readXrayAction(installedAppId).then((answer) => {
            if (answer.view) {
                setView(answer.view);
                setDraft(answer.view.settings);
            } else setError(answer.error ?? "Anti X-Ray could not be read");
        });
    }, [installedAppId]);

    const problem = useMemo(() => {
        const parsed = xraySettingsSchema.safeParse(draft);
        return parsed.success ? null : (parsed.error.issues[0]?.message ?? "Check the settings");
    }, [draft]);
    const dirty = view !== null && JSON.stringify(draft) !== JSON.stringify(view.settings);

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
            setNote(
                result.view.settings.enabled
                    ? "On. Honeypots are placed around the players within a minute."
                    : "Off. The honeypots are being turned back into rock."
            );
        });
    }

    async function clear(player: string): Promise<void> {
        const agreed = await confirm({
            title: `Clear ${player}?`,
            description: "Their honeypot finds are forgotten, as if they never happened.",
            confirmLabel: "Clear"
        });
        if (!agreed) return;
        startTransition(async () => {
            const result = await clearXrayPlayerAction({ installedAppId, player });
            if (result.view) keepView(result.view);
            else setError(result.error ?? "That could not be cleared");
        });
    }

    if (!view) {
        return (
            <Card>
                <CardBody className="flex flex-col gap-2">
                    <p className="text-sm font-medium">Anti X-Ray</p>
                    {error ? (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    ) : (
                        <div className="h-32 animate-pulse rounded-md bg-muted" />
                    )}
                </CardBody>
            </Card>
        );
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                <div className="flex items-start justify-between gap-3">
                    <div>
                        <p className="text-sm font-medium">Anti X-Ray</p>
                        <p className="text-xs text-muted-foreground">
                            Polaris hides single diamonds and ancient debris fully enclosed in rock
                            around the players. Nobody can see them without X-Ray, so digging
                            straight to {CONFIRM_HITS} of them is the evidence. One on its own is
                            treated as chance.
                        </p>
                    </div>
                    <Switch
                        checked={draft.enabled}
                        disabled={!canManage || view.refusal !== null}
                        onChange={(enabled) => change({ enabled })}
                        aria-label="Hide honeypots"
                    />
                </div>
                {view.refusal && <p className="text-xs text-muted-foreground">{view.refusal}.</p>}

                <div className="grid gap-3 sm:grid-cols-2">
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Honeypots around the players</span>
                        <Input
                            type="number"
                            min={4}
                            max={40}
                            value={draft.perDimension}
                            disabled={!canManage}
                            onChange={(event) =>
                                change({
                                    perDimension: Math.round(Number(event.target.value) || 0)
                                })
                            }
                        />
                        <span className="text-xs text-muted-foreground">
                            In each dimension. Between 4 and 40.
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
                        onValueChange={(value) => change({ action: value as XrayAction })}
                        options={ACTIONS.map((one) => ({ value: one.value, label: one.label }))}
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
                            onChange={(event) => change({ warning: event.target.value })}
                        />
                        <span className="text-xs text-muted-foreground">
                            In the chat, with a title. Colour codes such as &amp;c work.
                        </span>
                    </label>
                )}

                {draft.action === "warn-and-ban" && (
                    <div className="grid gap-3 sm:grid-cols-2">
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">Ban after this many honeypots</span>
                            <Input
                                type="number"
                                min={BAN_HITS_MIN}
                                max={10}
                                value={draft.banHits}
                                disabled={!canManage}
                                onChange={(event) =>
                                    change({ banHits: Math.round(Number(event.target.value) || 0) })
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
                                        banHours: Math.round(Number(event.target.value) || 0)
                                    })
                                }
                            />
                            <span className="text-xs text-muted-foreground">Up to a week.</span>
                        </label>
                    </div>
                )}

                {(problem || error) && (
                    <p role="alert" className="text-sm text-danger">
                        {problem ?? error}
                    </p>
                )}
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">
                        {note ??
                            (view.settings.enabled
                                ? `${view.traps.overworld} diamonds and ${view.traps.nether} debris hidden right now.`
                                : canManage
                                  ? ""
                                  : "Only somebody who manages this server can change it.")}
                    </span>
                    <Button
                        disabled={!canManage || pending || !dirty || problem !== null}
                        onClick={save}
                    >
                        {pending && <Loader2 className="size-4 animate-spin" />}
                        Save
                    </Button>
                </div>

                <div className="flex flex-col gap-2">
                    <p className="text-sm font-medium">Honeypots found</p>
                    {view.players.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                            Nobody has dug to one. Only what is found in the last 14 days counts.
                        </p>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-left text-xs">
                                <thead className="text-muted-foreground">
                                    <tr>
                                        <th className="py-1 pr-3 font-medium">Player</th>
                                        <th className="py-1 pr-3 font-medium">Found</th>
                                        <th className="py-1 pr-3 font-medium">Last</th>
                                        <th className="py-1 pr-3 font-medium">Done</th>
                                        <th className="py-1" />
                                    </tr>
                                </thead>
                                <tbody>
                                    {view.players.map((player) => {
                                        const last = player.hits.at(-1);
                                        return (
                                            <tr
                                                key={player.name}
                                                className="border-t border-border"
                                            >
                                                <td className="py-1.5 pr-3 font-medium">
                                                    {player.name}
                                                </td>
                                                <td className="py-1.5 pr-3">
                                                    <span className="flex items-center gap-1.5">
                                                        {player.hits.length}
                                                        <Badge
                                                            variant={
                                                                player.verdict === "confirmed"
                                                                    ? "danger"
                                                                    : "neutral"
                                                            }
                                                        >
                                                            {player.verdict === "confirmed"
                                                                ? "Confirmed"
                                                                : "Could be chance"}
                                                        </Badge>
                                                    </span>
                                                </td>
                                                <td
                                                    className="py-1.5 pr-3 text-muted-foreground"
                                                    title={
                                                        last
                                                            ? `${last.dimension.replace("minecraft:", "")} ${last.x} ${last.y} ${last.z}`
                                                            : undefined
                                                    }
                                                >
                                                    {last
                                                        ? new Date(last.at).toLocaleString()
                                                        : "-"}
                                                </td>
                                                <td className="py-1.5 pr-3 text-muted-foreground">
                                                    {player.bannedAt
                                                        ? "Banned"
                                                        : player.warnedAt
                                                          ? "Warned"
                                                          : "-"}
                                                </td>
                                                <td className="py-1.5 text-right">
                                                    <Button
                                                        size="sm"
                                                        variant="ghost"
                                                        disabled={pending}
                                                        onClick={() => void clear(player.name)}
                                                        title="Forget these finds"
                                                    >
                                                        Clear
                                                    </Button>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>

                {view.mining.length > 0 && (
                    <div className="flex flex-col gap-2">
                        <div>
                            <p className="text-sm font-medium">What each player has mined</p>
                            <p className="text-xs text-muted-foreground">
                                The game&apos;s own count, for context. Exploring caves finds
                                diamonds faster than digging for them, so these numbers are never
                                taken as proof.
                            </p>
                        </div>
                        <div className="overflow-x-auto">
                            <table className="w-full text-left text-xs tabular-nums">
                                <thead className="text-muted-foreground">
                                    <tr>
                                        <th className="py-1 pr-3 font-medium">Player</th>
                                        <th className="py-1 pr-3 font-medium">Diamonds</th>
                                        <th className="py-1 pr-3 font-medium">Deepslate</th>
                                        <th className="py-1 pr-3 font-medium">Rate</th>
                                        <th className="py-1 pr-3 font-medium">Debris</th>
                                        <th className="py-1 font-medium">Nether rock</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {[...view.mining]
                                        .filter(
                                            (one) =>
                                                one.figures.deepRock + one.figures.netherRock > 0
                                        )
                                        .sort(
                                            (left, right) =>
                                                right.figures.diamonds - left.figures.diamonds
                                        )
                                        .map((one) => (
                                            <tr key={one.name} className="border-t border-border">
                                                <td className="py-1.5 pr-3 font-medium">
                                                    {one.name}
                                                </td>
                                                <td className="py-1.5 pr-3">
                                                    {one.figures.diamonds}
                                                </td>
                                                <td className="py-1.5 pr-3">
                                                    {one.figures.deepRock}
                                                </td>
                                                <td className="py-1.5 pr-3">
                                                    {oneIn(
                                                        one.figures.diamonds,
                                                        one.figures.deepRock
                                                    )}
                                                </td>
                                                <td className="py-1.5 pr-3">
                                                    {one.figures.debris}
                                                </td>
                                                <td className="py-1.5">{one.figures.netherRock}</td>
                                            </tr>
                                        ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}
                {confirmElement}
            </CardBody>
        </Card>
    );
}
