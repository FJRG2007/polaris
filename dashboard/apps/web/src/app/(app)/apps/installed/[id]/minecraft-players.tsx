"use client";

/**
 * Everyone this server knows about, as one table.
 *
 * A player is not five different things, but the game keeps them in five lists -
 * who is on, who is registered here, who is an operator, who is whitelisted, who
 * is banned - and a card per list means reading all five to answer "what is going
 * on with this person", then acting in whichever one happens to hold the verb. So
 * the lists are folded into one row per name carrying every state it is in, and
 * the cuts an operator actually reaches for are a filter over that.
 *
 * Every action is one RCON command and takes effect in the running game, so the
 * table is re-read from the server afterwards rather than patched locally - the
 * server is the record, not this screen.
 */

import { useMemo, useState, useTransition } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { GameAccessForm } from "@/components/game-access-form";
import type { PlayerAccessView } from "@/lib/apps/minecraft/player-access";
import { foldPlayers, type PlayerEntry } from "@/lib/apps/minecraft/players";
import { Badge, Button, Card, CardBody, Input, Select, Switch, cn } from "@polaris/ui";
import type { MinecraftFirewall, MinecraftRoster, MinecraftStatus } from "@/lib/apps/minecraft/service";
import {
    Ban,
    Crown,
    DoorOpen,
    Search,
    ShieldBan,
    ShieldMinus,
    ShieldPlus,
    UserMinus,
    UserPlus,
    Users
} from "lucide-react";
import {
    applyFirewallBansAction,
    grantPlayerAccessAction,
    moderatePlayerAction,
    revokePlayerAccessAction,
    setAddressBindingAction,
    setWhitelistEnforcedAction,
    type MinecraftModeration
} from "./minecraft-actions";

/** The cuts an operator reaches for; anything finer is what search is for. */
const FILTERS = [
    { value: "all", label: "Everyone" },
    { value: "online", label: "Online" },
    { value: "allowed", label: "Allowed in" },
    { value: "operators", label: "Operators" },
    { value: "banned", label: "Banned" }
] as const;

type Filter = (typeof FILTERS)[number]["value"];

export function MinecraftPlayers({
    installedAppId,
    status,
    roster,
    firewall,
    access,
    onChanged
}: {
    installedAppId: string;
    status: MinecraftStatus | null;
    roster: MinecraftRoster | null;
    firewall: MinecraftFirewall | null;
    /** Who may connect and from where - the list the server is actually closed by. */
    access: PlayerAccessView | null;
    onChanged: () => void;
}) {
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState<Filter>("all");
    const [confirm, confirmElement] = useConfirm();

    const answering = status?.answering ?? false;
    const bedrock = status?.edition === "bedrock";
    const edition = access?.edition ?? status?.edition ?? "java";
    const players = useMemo(() => foldPlayers(status, roster, access), [status, roster, access]);
    const registered = access?.rules.length ?? 0;

    const shown = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return players.filter((player) => {
            if (filter === "online" && !player.online) return false;
            if (filter === "allowed" && player.address === null) return false;
            if (filter === "operators" && !player.operator) return false;
            if (filter === "banned" && !player.banned) return false;
            if (!needle) return true;
            return [player.name, player.address, player.note]
                .filter((value): value is string => Boolean(value))
                .some((value) => value.toLowerCase().includes(needle));
        });
    }, [players, query, filter]);

    function run(action: () => Promise<{ error?: string }>): void {
        setError(null);
        startTransition(async () => {
            const result = await action();
            if (result.error) {
                setError(result.error);
                return;
            }
            onChanged();
        });
    }

    function moderate(input: Omit<MinecraftModeration, "installedAppId">): void {
        run(() => moderatePlayerAction({ ...input, installedAppId }));
    }

    async function moderateWithConfirm(
        input: Omit<MinecraftModeration, "installedAppId">,
        title: string,
        description: string
    ): Promise<void> {
        if (!(await confirm({ title, description, confirmLabel: "Confirm", danger: true }))) return;
        moderate(input);
    }

    async function addPlayer(input: { username: string; address: string }): Promise<boolean> {
        setError(null);
        const result = await grantPlayerAccessAction({ installedAppId, ...input });
        if (result.error) {
            setError(result.error);
            return false;
        }
        onChanged();
        return true;
    }

    return (
        <div className="flex flex-col gap-4">
            {error && <p className="text-sm text-danger">{error}</p>}

            {/* A server with an empty list is one nobody on earth can join, and
                nothing anywhere saying why. It is also the state a server lands in
                when its first player was removed, so it is worth naming loudly. */}
            {access !== null && registered === 0 && (
                <Card className="border-warning/40 bg-warning/5">
                    <CardBody className="flex flex-col gap-1">
                        <p className="flex items-center gap-2 text-sm font-medium">
                            <Users className="size-4 text-warning" />
                            Nobody can join yet
                        </p>
                        <p className="text-sm text-muted-foreground">
                            The server is closed until somebody is registered. Add yourself first: your{" "}
                            {edition === "bedrock" ? "gamertag" : "Minecraft username"}, and the address you play from -
                            the locate button fills in the one you are on now.
                        </p>
                    </CardBody>
                </Card>
            )}

            <Card>
                <CardBody className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                            <p className="text-sm font-medium">Add a player</p>
                            <p className="text-xs text-muted-foreground">
                                A player is let in when the username is on this list and they arrive from the address
                                registered to it. The rest of the firewall guards HTTP, which a game port is not.
                            </p>
                        </div>
                        <div className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground">
                                {access?.bindAddresses ? "Address checked" : "Address not checked"}
                            </span>
                            <Switch
                                checked={access?.bindAddresses ?? true}
                                onChange={(enabled) => run(() => setAddressBindingAction(installedAppId, enabled))}
                                disabled={pending || access === null || !access.addressesAvailable}
                                aria-label="Check each player's address when they join"
                            />
                        </div>
                    </div>
                    <GameAccessForm edition={edition} disabled={pending} onAdd={addPlayer} />
                    {access && !access.addressesAvailable && (
                        <p className="text-xs text-muted-foreground">
                            Bedrock does not record where a player connected from, so only the names here are enforced.
                        </p>
                    )}
                </CardBody>
            </Card>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="relative flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        className="pl-9"
                        placeholder="Search by name, address or note"
                        aria-label="Search players"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                    />
                </div>
                <Select
                    className="sm:w-44"
                    aria-label="Filter players"
                    value={filter}
                    onValueChange={(value) => setFilter(value as Filter)}
                    options={FILTERS.map((entry) => ({ value: entry.value, label: entry.label }))}
                />
                {!bedrock && (
                    <WhitelistSwitch
                        installedAppId={installedAppId}
                        enforced={roster?.whitelistEnforced ?? false}
                        disabled={roster === null || !answering}
                        onError={setError}
                        onChanged={onChanged}
                    />
                )}
            </div>

            <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[40rem] text-sm">
                    <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                        <tr>
                            <th className="px-3 py-2 font-medium">Player</th>
                            <th className="px-3 py-2 font-medium">Standing</th>
                            <th className="hidden px-3 py-2 font-medium md:table-cell">Address</th>
                            <th className="px-3 py-2" />
                        </tr>
                    </thead>
                    <tbody>
                        {!answering && players.length === 0 ? (
                            <tr>
                                <td colSpan={4} className="px-3 py-8 text-center text-muted-foreground">
                                    {status?.message ?? "Connecting to the server..."}
                                </td>
                            </tr>
                        ) : shown.length === 0 ? (
                            <tr>
                                <td colSpan={4} className="px-3 py-8 text-center text-muted-foreground">
                                    {players.length === 0
                                        ? "Nobody is registered and nobody is playing."
                                        : "Nobody matches that."}
                                </td>
                            </tr>
                        ) : (
                            shown.map((player) => (
                                <PlayerRow
                                    key={player.name.toLowerCase()}
                                    player={player}
                                    bedrock={bedrock}
                                    answering={answering}
                                    pending={pending}
                                    onModerate={moderate}
                                    onModerateWithConfirm={moderateWithConfirm}
                                    onRevoke={() => run(() => revokePlayerAccessAction(installedAppId, player.name))}
                                />
                            ))
                        )}
                    </tbody>
                </table>
            </div>

            <FirewallSection
                installedAppId={installedAppId}
                firewall={firewall}
                onError={setError}
                onChanged={onChanged}
            />

            {confirmElement}
        </div>
    );
}

function PlayerRow({
    player,
    bedrock,
    answering,
    pending,
    onModerate,
    onModerateWithConfirm,
    onRevoke
}: {
    player: PlayerEntry;
    bedrock: boolean;
    answering: boolean;
    pending: boolean;
    onModerate: (input: Omit<MinecraftModeration, "installedAppId">) => void;
    onModerateWithConfirm: (
        input: Omit<MinecraftModeration, "installedAppId">,
        title: string,
        description: string
    ) => Promise<void>;
    onRevoke: () => void;
}) {
    const { name } = player;
    // Every verb below is an RCON command, so none of them exist while the server
    // is not answering. Registering and unregistering are Polaris' own and do.
    const live = answering && !pending;

    return (
        <tr className={cn("border-t border-border hover:bg-card-hover", player.banned && "opacity-60")}>
            <td className="px-3 py-2">
                <p className="flex items-center gap-1.5 truncate font-medium" title={name}>
                    {player.operator && <Crown className="size-3.5 shrink-0 text-warning" />}
                    {name}
                </p>
                {(player.note ?? player.banReason) && (
                    <p
                        className="truncate text-xs text-muted-foreground"
                        title={player.banReason ?? player.note ?? undefined}
                    >
                        {player.banReason ?? player.note}
                    </p>
                )}
            </td>
            <td className="px-3 py-2">
                <div className="flex flex-wrap items-center gap-1">
                    {player.online && <Badge variant="success">online</Badge>}
                    {player.address !== null && <Badge variant="primary">allowed</Badge>}
                    {player.operator && <Badge>operator</Badge>}
                    {player.whitelisted && <Badge>whitelisted</Badge>}
                    {player.banned && (
                        <Badge variant="danger">
                            <Ban className="size-3" />
                            banned
                        </Badge>
                    )}
                    {/* A name the game knows and Polaris does not is the gap that
                        lets somebody in on the username alone. */}
                    {player.address === null && !player.banned && <Badge variant="warning">not registered</Badge>}
                </div>
            </td>
            <td className="hidden px-3 py-2 text-xs text-muted-foreground md:table-cell">
                {player.address ?? "-"}
            </td>
            <td className="px-3 py-2">
                <div className="flex justify-end gap-1">
                    {!bedrock && (
                        <IconAction
                            label={player.operator ? `Remove ${name} as operator` : `Make ${name} an operator`}
                            icon={
                                player.operator ? (
                                    <ShieldMinus className="size-4" />
                                ) : (
                                    <ShieldPlus className="size-4" />
                                )
                            }
                            disabled={!live}
                            onClick={() => onModerate({ action: player.operator ? "deop" : "op", player: name })}
                        />
                    )}
                    {!bedrock && (
                        <IconAction
                            label={
                                player.whitelisted
                                    ? `Take ${name} off the whitelist`
                                    : `Put ${name} on the whitelist`
                            }
                            icon={
                                player.whitelisted ? (
                                    <UserMinus className="size-4" />
                                ) : (
                                    <UserPlus className="size-4" />
                                )
                            }
                            disabled={!live}
                            onClick={() =>
                                onModerate({
                                    action: player.whitelisted ? "whitelist-remove" : "whitelist-add",
                                    player: name
                                })
                            }
                        />
                    )}
                    {player.online && (
                        <IconAction
                            label={`Kick ${name}`}
                            icon={<DoorOpen className="size-4" />}
                            disabled={!live}
                            onClick={() =>
                                void onModerateWithConfirm(
                                    { action: "kick", player: name },
                                    `Kick ${name}?`,
                                    "They are disconnected and can join again straight away."
                                )
                            }
                        />
                    )}
                    {!bedrock &&
                        (player.banned ? (
                            <IconAction
                                label={`Lift the ban on ${name}`}
                                icon={<UserPlus className="size-4" />}
                                disabled={!live}
                                onClick={() => onModerate({ action: "pardon", player: name })}
                            />
                        ) : (
                            <IconAction
                                label={`Ban ${name}`}
                                icon={<Ban className="size-4" />}
                                danger
                                disabled={!live}
                                onClick={() =>
                                    void onModerateWithConfirm(
                                        { action: "ban", player: name },
                                        `Ban ${name}?`,
                                        "They are disconnected and cannot rejoin until the ban is lifted."
                                    )
                                }
                            />
                        ))}
                    {player.address !== null && (
                        <IconAction
                            label={`Remove ${name} from the player list`}
                            icon={<UserMinus className="size-4" />}
                            danger
                            disabled={pending}
                            onClick={onRevoke}
                        />
                    )}
                </div>
            </td>
        </tr>
    );
}

/** Whether the game's own whitelist is enforced at all - a list nobody is checked
 *  against is the commonest way to think you are private and not be. */
function WhitelistSwitch({
    installedAppId,
    enforced,
    disabled,
    onError,
    onChanged
}: {
    installedAppId: string;
    enforced: boolean;
    disabled: boolean;
    onError: (message: string | null) => void;
    onChanged: () => void;
}) {
    const [pending, startTransition] = useTransition();

    return (
        <div className="flex h-10 items-center gap-2 rounded-md border border-border px-3">
            <span className="whitespace-nowrap text-xs text-muted-foreground">
                Whitelist {enforced ? "enforced" : "off"}
            </span>
            <Switch
                checked={enforced}
                disabled={disabled || pending}
                aria-label="Enforce the whitelist"
                onChange={(next) => {
                    onError(null);
                    startTransition(async () => {
                        const result = await setWhitelistEnforcedAction(installedAppId, next);
                        if (result.error) {
                            onError(result.error);
                            return;
                        }
                        onChanged();
                    });
                }}
            />
        </div>
    );
}

/**
 * What the Polaris firewall blocks, and whether this server has been told.
 *
 * The firewall guards HTTP; a game server is not HTTP, so nothing joins the two
 * on its own. Handing its addresses to the server's own ban list is what makes
 * one blocklist mean one thing across the instance - and it is a button rather
 * than something automatic, because banning an address from a game is visible to
 * whoever is playing from it.
 */
function FirewallSection({
    installedAppId,
    firewall,
    onError,
    onChanged
}: {
    installedAppId: string;
    firewall: MinecraftFirewall | null;
    onError: (message: string | null) => void;
    onChanged: () => void;
}) {
    const [pending, startTransition] = useTransition();
    const [applied, setApplied] = useState<string | null>(null);
    const outstanding = firewall ? firewall.blocked.filter((entry) => !firewall.applied.includes(entry)) : [];

    function apply(): void {
        onError(null);
        startTransition(async () => {
            const result = await applyFirewallBansAction(installedAppId);
            if (result.error) {
                onError(result.error);
                return;
            }
            setApplied(
                result.banned === 0
                    ? "Every blocked address was already banned here"
                    : `Banned ${result.banned} ${result.banned === 1 ? "address" : "addresses"}`
            );
            onChanged();
        });
    }

    if (!firewall || (firewall.blocked.length === 0 && firewall.ranges.length === 0)) return null;

    return (
        <Card>
            <CardBody className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium">
                        Firewall <span className="text-muted-foreground">{firewall.blocked.length || ""}</span>
                    </p>
                    <Button size="sm" variant="secondary" onClick={apply} disabled={pending || outstanding.length === 0}>
                        <ShieldBan className="size-4" />
                        {outstanding.length === 0 ? "All applied" : `Ban ${outstanding.length} here`}
                    </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                    Addresses the Polaris firewall blocks. A game server refuses them only once they are on its own ban
                    list.
                </p>
                {firewall.ranges.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                        {firewall.ranges.length} {firewall.ranges.length === 1 ? "range is" : "ranges are"} blocked in
                        the firewall. Minecraft bans single addresses only, so those are not applied here.
                    </p>
                )}
                {applied && <p className="text-xs text-muted-foreground">{applied}</p>}
            </CardBody>
        </Card>
    );
}

function IconAction({
    label,
    icon,
    onClick,
    disabled,
    danger
}: {
    label: string;
    icon: React.ReactNode;
    onClick: () => void;
    disabled?: boolean;
    danger?: boolean;
}) {
    return (
        <Button
            size="icon"
            variant="ghost"
            onClick={onClick}
            disabled={disabled}
            aria-label={label}
            title={label}
            className={danger ? "text-danger hover:text-danger" : undefined}
        >
            {icon}
        </Button>
    );
}
