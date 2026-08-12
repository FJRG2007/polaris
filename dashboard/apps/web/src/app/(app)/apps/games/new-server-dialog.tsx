"use client";

/**
 * Creating a server: which game, who it is for, and how many of them.
 *
 * The game is the first question because it changes the rest of them - a
 * Minecraft server has an edition and a world seed, an ARK server has a map and a
 * Steam id - and everything that does not change is asked once, in the same place,
 * for both: what it is called, how big it is, which machine it goes on and what
 * players will type to reach it.
 *
 * How much memory it gets follows from the players it expects rather than from a
 * number nobody can calibrate, and the machine list says what each one has left so
 * a server is not put where it does not fit. The address is shown before it
 * exists, because "what will people type" is the question anyone creating a server
 * has next.
 *
 * Every rule checked here is checked again by the action, from the same schema.
 * This is what keeps a refusal on the form rather than on a container that has
 * already been built.
 */

import { useRouter } from "next/navigation";
import * as arkAccess from "@/lib/apps/ark/access";
import * as world from "@/lib/apps/minecraft/world";
import { CopyButton } from "@/components/copy-button";
import { GamePicker } from "@/components/game-picker";
import { expectedArkMemoryMb } from "@/lib/apps/ark/config";
import { GAMES, type GameId } from "@/lib/apps/games-catalog";
import { ARK_MAPS, mapRequirementHint } from "@/lib/apps/ark/maps";
import { useEffect, useMemo, useState, useTransition } from "react";
import { isAddressRule, isPlayerName } from "@/lib/apps/minecraft/access";
import { createGameServerSchema, isModIdList } from "@/lib/apps/games-schema";
import { createGameServerAction, gameMachinesAction, gameSetupAction, type GameSetup } from "./actions";
import { Gamepad2, Loader2, MemoryStick, RefreshCw, ShieldCheck, Users } from "lucide-react";
import { findBlueprint, formatMemory, recommendedMemoryMb } from "@/lib/apps/minecraft/blueprints";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Input, Select, Skeleton, Switch, cn } from "@polaris/ui";
import {
    BlueprintFields,
    Choice,
    DEFAULT_SHAPE,
    LATEST,
    shapeError,
    type BlueprintShape
} from "@/components/game-blueprint-fields";

/** A password the operator did not have to invent, from the browser's own
 *  randomness rather than a round trip - it is a field they may still overwrite. */
function mintPassword(): string {
    return arkAccess.generateJoinPassword((size) => crypto.getRandomValues(new Uint8Array(size)));
}

export function NewServerDialog({ onClose }: { onClose: () => void }) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [setup, setSetup] = useState<GameSetup | null>(null);
    const [error, setError] = useState<string | null>(null);

    const [game, setGame] = useState<GameId>("minecraft");
    const [name, setName] = useState("");
    const [serverId, setServerId] = useState("local");
    const [maxPlayers, setMaxPlayers] = useState(20);
    const [concurrentPlayers, setConcurrentPlayers] = useState(8);
    const [subdomain, setSubdomain] = useState("");

    const [edition, setEdition] = useState<"java" | "bedrock">("java");
    const [crossplay, setCrossplay] = useState(false);
    /** The game this server plays and the map it plays it on, as one value: the
     *  same one the reset dialog holds, from the same fields. */
    const [shape, setShape] = useState<BlueprintShape>(DEFAULT_SHAPE);
    const [ownerPlayer, setOwnerPlayer] = useState("");
    const [ownerAddress, setOwnerAddress] = useState("");

    const [map, setMap] = useState("TheIsland");
    const [sessionName, setSessionName] = useState("");
    const [joinPassword, setJoinPassword] = useState(mintPassword);
    const [ownerSteamId, setOwnerSteamId] = useState("");
    const [exclusiveJoin, setExclusiveJoin] = useState(true);
    const [mods, setMods] = useState("");

    // Offered rather than imposed: it is where this operator is right now, which is
    // where their own client would arrive from, and they can widen or replace it.
    useEffect(() => {
        if (setup?.yourAddress && ownerAddress.length === 0) setOwnerAddress(setup.yourAddress);
    }, [setup, ownerAddress]);

    useEffect(() => {
        let active = true;
        void gameSetupAction()
            .then((loaded) => {
                if (!active) return;
                setSetup(loaded);
                // Whatever this Polaris actually has. A picker that offered a game
                // whose manager is not installed would fail at the action.
                if (loaded.games.length > 0 && !loaded.games.includes("minecraft")) setGame(loaded.games[0]!);
            })
            .catch(() => active && setError("Could not read your machines"));
        return () => {
            active = false;
        };
    }, []);

    // What each machine has free, which costs a round trip to every one of them.
    // Asked for beside the setup rather than inside it, so the form is on screen
    // and answerable while the figures are still coming back; they land on the
    // machine already chosen without disturbing the choice. A failure leaves the
    // list exactly as it was, which is the list with no figures on it.
    useEffect(() => {
        let active = true;
        void gameMachinesAction()
            .then((machines) => active && setSetup((current) => (current ? { ...current, machines } : current)))
            .catch(() => undefined);
        return () => {
            active = false;
        };
    }, []);

    const blueprint = findBlueprint(shape.blueprintId);
    const offered = useMemo(() => GAMES.filter((entry) => setup?.games.includes(entry.id) ?? false), [setup]);

    const memory =
        game === "ark"
            ? formatMemory(expectedArkMemoryMb(concurrentPlayers))
            : formatMemory(recommendedMemoryMb(concurrentPlayers, blueprint?.weight ?? "normal"));
    const machine = setup?.machines.find((entry) => entry.id === serverId) ?? null;

    // Crossplay is a Java server Bedrock can also join, so it cannot survive a
    // switch to a Bedrock one.
    useEffect(() => {
        if (edition === "bedrock") setCrossplay(false);
    }, [edition]);

    // Checked as it is typed, against the same rules the action re-checks: a name
    // the server would refuse is worth saying before a container is built for it.
    const playerError =
        ownerPlayer.trim().length === 0 || isPlayerName(edition, ownerPlayer)
            ? null
            : edition === "bedrock"
              ? "That is not an Xbox gamertag"
              : "3 to 16 letters, digits or underscores";
    const addressError =
        ownerAddress.trim().length === 0 || isAddressRule(ownerAddress) ? null : "That is not an address or a range";
    const seedError = shapeError(shape);
    const steamIdError =
        ownerSteamId.trim().length === 0 || arkAccess.isSteamId(ownerSteamId)
            ? null
            : "17 digits, starting 7656119";
    const passwordError = arkAccess.isJoinPassword(joinPassword) ? null : arkAccess.JOIN_PASSWORD_HINT;
    const modsError = mods.trim().length === 0 || isModIdList(mods) ? null : "Workshop ids are numbers, comma separated";
    const ready =
        name.trim().length > 0 &&
        (game === "ark"
            ? arkAccess.isSteamId(ownerSteamId) && passwordError === null && modsError === null
            : isPlayerName(edition, ownerPlayer) && isAddressRule(ownerAddress) && seedError === null);

    const label = (subdomain.trim() || name.trim() || "server")
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    const suffix = setup?.domainSuffixes[game] ?? null;
    const address = suffix ? `${label || "server"}${suffix}` : null;

    function submit(): void {
        setError(null);
        const common = {
            name: name.trim(),
            serverId,
            maxPlayers,
            concurrentPlayers,
            subdomain: subdomain.trim() || undefined
        };
        const parsed = createGameServerSchema.safeParse(
            game === "ark"
                ? {
                      game: "ark" as const,
                      ...common,
                      map,
                      sessionName: sessionName.trim() || name.trim(),
                      joinPassword: joinPassword.trim(),
                      ownerSteamId: ownerSteamId.trim(),
                      ownerLabel: ownerPlayer.trim() || undefined,
                      exclusiveJoin,
                      mods: mods.trim() || undefined
                  }
                : {
                      game: "minecraft" as const,
                      ...common,
                      ownerPlayer: ownerPlayer.trim(),
                      ownerAddress: ownerAddress.trim(),
                      edition,
                      crossplay,
                      blueprintId: shape.blueprintId,
                      software: edition === "java" ? shape.software : undefined,
                      version: shape.version.trim() || LATEST,
                      seed: shape.seed.trim() || undefined,
                      levelType: edition === "java" ? shape.levelType : undefined,
                      biome: edition === "java" && world.usesBiome(shape.levelType) ? shape.biome : undefined
                  }
        );
        if (!parsed.success) {
            setError(parsed.error.issues[0]?.message ?? "Check the details and try again");
            return;
        }
        startTransition(async () => {
            const result = await createGameServerAction(parsed.data);
            if (result.error || !result.installedAppId) {
                setError(result.error ?? "Could not create the server");
                return;
            }
            router.push(`/apps/installed/${result.installedAppId}`);
        });
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Gamepad2 className="size-5" /> New server
                    </DialogTitle>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    {/* First, and always: it changes every question under it, and a
                        form whose shape depends on an answer buried further down is
                        a form people fill in twice. Asked as a picker rather than a
                        row of cards because the list of games only grows. */}
                    <div className="flex flex-col gap-2">
                        <span className="text-sm font-medium">Game</span>
                        {setup === null ? (
                            <Skeleton className="h-14 w-full" />
                        ) : (
                            <GamePicker games={offered} value={game} onChange={setGame} />
                        )}
                    </div>

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Name</span>
                        <Input
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder={game === "ark" ? "The Island" : "Survival"}
                        />
                    </label>

                    {game === "minecraft" ? (
                        <>
                            <div className="flex flex-col gap-2">
                                <span className="text-sm font-medium">Who plays on it</span>
                                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                                    <Choice
                                        selected={edition === "java" && !crossplay}
                                        onSelect={() => {
                                            setEdition("java");
                                            setCrossplay(false);
                                        }}
                                        title="Java"
                                        detail="PC players"
                                    />
                                    <Choice
                                        selected={edition === "bedrock"}
                                        onSelect={() => setEdition("bedrock")}
                                        title="Bedrock"
                                        detail="Phones, consoles, Windows app"
                                    />
                                    <Choice
                                        selected={edition === "java" && crossplay}
                                        onSelect={() => {
                                            setEdition("java");
                                            setCrossplay(true);
                                        }}
                                        title="Both"
                                        detail="A Java world Bedrock can join, through Geyser"
                                    />
                                </div>
                            </div>

                            <BlueprintFields
                                edition={edition}
                                crossplay={crossplay}
                                value={shape}
                                onChange={setShape}
                            />
                        </>
                    ) : (
                        <>
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                <label className="flex flex-col gap-1 text-sm">
                                    <span className="font-medium">Map</span>
                                    <Select
                                        value={map}
                                        onValueChange={setMap}
                                        options={ARK_MAPS.map((entry) => ({
                                            value: entry.value,
                                            label: entry.label
                                        }))}
                                    />
                                    <span className="text-xs text-muted-foreground">
                                        {mapRequirementHint(ARK_MAPS.find((entry) => entry.value === map))}
                                    </span>
                                </label>
                                <label className="flex flex-col gap-1 text-sm">
                                    <span className="font-medium">Name in the server browser</span>
                                    <Input
                                        value={sessionName}
                                        onChange={(event) => setSessionName(event.target.value)}
                                        placeholder={name.trim() || "The Island"}
                                    />
                                    <span className="text-xs text-muted-foreground">
                                        Blank uses the name above. This is what players search for in game.
                                    </span>
                                </label>
                            </div>

                            <label className="flex flex-col gap-1 text-sm">
                                <span className="font-medium">Mods</span>
                                <Input
                                    value={mods}
                                    onChange={(event) => setMods(event.target.value)}
                                    placeholder="Steam Workshop ids, comma separated"
                                />
                                <span className={cn("text-xs", modsError ? "text-danger" : "text-muted-foreground")}>
                                    {modsError ?? "Optional. Every player needs the same mods to join."}
                                </span>
                            </label>
                        </>
                    )}

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">Player slots</span>
                            <Input
                                type="number"
                                min={1}
                                value={maxPlayers}
                                onChange={(event) => setMaxPlayers(Number(event.target.value))}
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">Playing at once, usually</span>
                            <Input
                                type="number"
                                min={1}
                                value={concurrentPlayers}
                                onChange={(event) => setConcurrentPlayers(Number(event.target.value))}
                            />
                        </label>
                    </div>

                    <p className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-xs text-muted-foreground">
                        <MemoryStick className="size-4 shrink-0" />
                        <span>
                            {game === "ark" ? (
                                <>
                                    An ARK server for {concurrentPlayers}{" "}
                                    {concurrentPlayers === 1 ? "player" : "players"} at once uses around{" "}
                                    <strong className="text-foreground">{memory}</strong> of memory and about 30 GB of
                                    disk, downloaded the first time it starts.
                                </>
                            ) : (
                                <>
                                    Polaris will give it <strong className="text-foreground">{memory}</strong> of memory
                                    for {concurrentPlayers} {concurrentPlayers === 1 ? "player" : "players"} at once. You
                                    can change it later under Settings.
                                </>
                            )}
                        </span>
                    </p>

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Runs on</span>
                        {setup === null ? (
                            <Skeleton className="h-9 w-full" />
                        ) : (
                            <Select
                                value={serverId}
                                onValueChange={setServerId}
                                options={setup.machines.map((entry) => ({
                                    value: entry.id,
                                    label: machineLabel(entry)
                                }))}
                            />
                        )}
                        {machine && (
                            <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                <Users className="size-3" />
                                {machine.committedMb > 0
                                    ? `${formatMemory(machine.committedMb)} already promised to servers here.`
                                    : "No other game server on this machine yet."}
                            </span>
                        )}
                    </label>

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Address</span>
                        {address ? (
                            <>
                                <Input
                                    value={subdomain}
                                    onChange={(event) => setSubdomain(event.target.value)}
                                    placeholder={label || "survival"}
                                />
                                <span className="text-xs text-muted-foreground">
                                    Players will connect to <code className="font-mono">{address}</code>
                                    {game === "ark" || edition === "bedrock" ? " and its port." : "."}
                                </span>
                            </>
                        ) : (
                            <span className="text-xs text-muted-foreground">
                                No domain is configured, so players connect to this machine&apos;s address and port. Add
                                a domain under Settings to give servers names.
                            </span>
                        )}
                    </label>

                    <div className="flex flex-col gap-2">
                        <span className="text-sm font-medium">Who can connect</span>
                        {game === "ark" ? (
                            <>
                                <label className="flex flex-col gap-1 text-sm">
                                    <span className="text-muted-foreground">Join password</span>
                                    <div className="flex items-center gap-1">
                                        <Input
                                            value={joinPassword}
                                            onChange={(event) => setJoinPassword(event.target.value)}
                                            className="font-mono"
                                        />
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            onClick={() => setJoinPassword(mintPassword())}
                                            aria-label="Generate another password"
                                            title="Generate another password"
                                        >
                                            <RefreshCw className="size-4" />
                                        </Button>
                                        <CopyButton value={joinPassword} label="the join password" />
                                    </div>
                                    <span className={cn("text-xs", passwordError ? "text-danger" : "text-muted-foreground")}>
                                        {passwordError ?? "Everyone who joins types this. Copy it before you create."}
                                    </span>
                                </label>
                                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                    <label className="flex flex-col gap-1 text-sm">
                                        <span className="text-muted-foreground">Your Steam id</span>
                                        <Input
                                            value={ownerSteamId}
                                            onChange={(event) => setOwnerSteamId(event.target.value)}
                                            placeholder="76561198000000000"
                                            inputMode="numeric"
                                        />
                                        <span className={cn("text-xs", steamIdError ? "text-danger" : "text-muted-foreground")}>
                                            {steamIdError ?? "The 17-digit number on your Steam profile."}
                                        </span>
                                    </label>
                                    <label className="flex flex-col gap-1 text-sm">
                                        <span className="text-muted-foreground">Your name on the list</span>
                                        <Input
                                            value={ownerPlayer}
                                            onChange={(event) => setOwnerPlayer(event.target.value)}
                                            placeholder="You"
                                        />
                                        <span className="text-xs text-muted-foreground">
                                            Optional. A 17-digit number identifies nobody at a glance.
                                        </span>
                                    </label>
                                </div>
                                <label className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2">
                                    <span className="flex flex-col gap-0.5 text-sm">
                                        <span className="font-medium">Only players you add can join</span>
                                        <span className="text-xs text-muted-foreground">
                                            On top of the password. Off leaves the password as the only lock.
                                        </span>
                                    </span>
                                    <Switch
                                        checked={exclusiveJoin}
                                        onChange={setExclusiveJoin}
                                        aria-label="Only players you add can join"
                                    />
                                </label>
                            </>
                        ) : (
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                <label className="flex flex-col gap-1 text-sm">
                                    <span className="text-muted-foreground">
                                        {edition === "bedrock" ? "Your gamertag" : "Your Minecraft username"}
                                    </span>
                                    <Input
                                        value={ownerPlayer}
                                        onChange={(event) => setOwnerPlayer(event.target.value)}
                                        placeholder={edition === "bedrock" ? "Gamertag" : "Steve"}
                                    />
                                    {playerError && <span className="text-xs text-danger">{playerError}</span>}
                                </label>
                                <label className="flex flex-col gap-1 text-sm">
                                    <span className="text-muted-foreground">Connecting from</span>
                                    <Input
                                        value={ownerAddress}
                                        onChange={(event) => setOwnerAddress(event.target.value)}
                                        placeholder="203.0.113.9"
                                    />
                                    <span className={cn("text-xs", addressError ? "text-danger" : "text-muted-foreground")}>
                                        {addressError ?? 'One address, a range like 203.0.113.0/24, or "any".'}
                                    </span>
                                </label>
                            </div>
                        )}
                        <p className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-xs text-muted-foreground">
                            <ShieldCheck className="size-4 shrink-0" />
                            <span>
                                {game === "ark"
                                    ? "The server starts closed: a password of its own, an admin password Polaris keeps for you, and nobody else let in until you add them. It is opened from the server's own Access screen."
                                    : "The server starts closed: nobody else can join until you add them, and each player is only let in from the address registered to them. Change it later under Firewall."}
                            </span>
                        </p>
                    </div>

                    {error && <p className="text-sm text-danger">{error}</p>}

                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={onClose} disabled={pending}>
                            Cancel
                        </Button>
                        <Button onClick={submit} disabled={pending || !ready}>
                            {pending && <Loader2 className="size-4 animate-spin" />}
                            Create server
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

/** A machine with what it has left, so the choice is made on the figures. */
function machineLabel(machine: { name: string; memoryFreeBytes: number | null; memoryTotalBytes: number | null }): string {
    if (machine.memoryFreeBytes === null || machine.memoryTotalBytes === null) return machine.name;
    const free = Math.round(machine.memoryFreeBytes / (1024 * 1024 * 1024));
    const total = Math.round(machine.memoryTotalBytes / (1024 * 1024 * 1024));
    return `${machine.name} - ${free} of ${total} GB free`;
}
