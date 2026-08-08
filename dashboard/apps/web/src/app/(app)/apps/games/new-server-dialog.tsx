"use client";

/**
 * Creating a server: who it is for, how many of them, and what game it runs.
 *
 * The three questions that decide everything else, in that order. How much memory
 * it gets follows from the players it expects rather than from a number nobody
 * can calibrate, and the machine list says what each one has left so a server is
 * not put where it does not fit. The address is shown before it exists, because
 * "what will people type" is the question anyone creating a server has next.
 */

import { useRouter } from "next/navigation";
import { isSeed } from "@/lib/apps/minecraft/world";
import { createGameServerSchema } from "@/lib/apps/games-schema";
import { useEffect, useMemo, useState, useTransition } from "react";
import { isAddressRule, isPlayerName } from "@/lib/apps/minecraft/access";
import { Gamepad2, Loader2, MemoryStick, ShieldCheck, Users } from "lucide-react";
import { createGameServerAction, gameSetupAction, type GameSetup } from "./actions";
import { blueprintsFor, formatMemory, recommendedMemoryMb } from "@/lib/apps/minecraft/blueprints";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Input, Select, Skeleton, cn } from "@polaris/ui";

const SOFTWARE = [
    { value: "PAPER", label: "Paper - plugins, fastest" },
    { value: "PURPUR", label: "Purpur - Paper with more settings" },
    { value: "FABRIC", label: "Fabric - mods" },
    { value: "NEOFORGE", label: "NeoForge - mods" },
    { value: "FORGE", label: "Forge - mods" },
    { value: "VANILLA", label: "Vanilla - nothing added" }
];

export function NewServerDialog({ onClose }: { onClose: () => void }) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [setup, setSetup] = useState<GameSetup | null>(null);
    const [error, setError] = useState<string | null>(null);

    const [name, setName] = useState("");
    const [edition, setEdition] = useState<"java" | "bedrock">("java");
    const [crossplay, setCrossplay] = useState(false);
    const [blueprintId, setBlueprintId] = useState("survival");
    const [software, setSoftware] = useState("PAPER");
    const [version, setVersion] = useState("LATEST");
    const [seed, setSeed] = useState("");
    const [serverId, setServerId] = useState("local");
    const [maxPlayers, setMaxPlayers] = useState(20);
    const [concurrentPlayers, setConcurrentPlayers] = useState(8);
    const [subdomain, setSubdomain] = useState("");
    const [ownerPlayer, setOwnerPlayer] = useState("");
    const [ownerAddress, setOwnerAddress] = useState("");

    // Offered rather than imposed: it is where this operator is right now, which is
    // where their own client would arrive from, and they can widen or replace it.
    useEffect(() => {
        if (setup?.yourAddress && ownerAddress.length === 0) setOwnerAddress(setup.yourAddress);
    }, [setup, ownerAddress]);

    const blueprints = useMemo(() => blueprintsFor(edition), [edition]);
    const blueprint = blueprints.find((entry) => entry.id === blueprintId);
    const memory = formatMemory(recommendedMemoryMb(concurrentPlayers, blueprint?.weight ?? "normal"));
    const machine = setup?.machines.find((entry) => entry.id === serverId) ?? null;

    useEffect(() => {
        let active = true;
        void gameSetupAction()
            .then((loaded) => active && setSetup(loaded))
            .catch(() => active && setError("Could not read your machines"));
        return () => {
            active = false;
        };
    }, []);

    // A blueprint belongs to an edition; switching away from one that does not
    // have it leaves the picker on something that cannot be created.
    useEffect(() => {
        if (!blueprints.some((entry) => entry.id === blueprintId)) setBlueprintId(blueprints[0]?.id ?? "survival");
        if (edition === "bedrock") setCrossplay(false);
    }, [edition, blueprints, blueprintId]);

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
    const seedError =
        seed.trim().length === 0 || isSeed(seed.trim()) ? null : "A seed is up to 64 characters of ordinary text";
    const ready =
        name.trim().length > 0 &&
        isPlayerName(edition, ownerPlayer) &&
        isAddressRule(ownerAddress) &&
        seedError === null;

    const label = (subdomain.trim() || name.trim() || "server")
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    const address = setup?.domainExample ? setup.domainExample.replace(/^[^.]+/, label || "server") : null;

    function submit(): void {
        setError(null);
        const parsed = createGameServerSchema.safeParse({
            name: name.trim(),
            ownerPlayer: ownerPlayer.trim(),
            ownerAddress: ownerAddress.trim(),
            edition,
            crossplay,
            blueprintId,
            software: edition === "java" ? software : undefined,
            version: version.trim() || "LATEST",
            seed: seed.trim() || undefined,
            serverId,
            maxPlayers,
            concurrentPlayers,
            subdomain: subdomain.trim() || undefined
        });
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
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Name</span>
                        <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Survival" />
                    </label>

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

                    <div className="flex flex-col gap-2">
                        <span className="text-sm font-medium">Blueprint</span>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            {blueprints.map((entry) => (
                                <Choice
                                    key={entry.id}
                                    selected={blueprintId === entry.id}
                                    onSelect={() => setBlueprintId(entry.id)}
                                    title={entry.name}
                                    detail={entry.summary}
                                />
                            ))}
                        </div>
                    </div>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        {edition === "java" && (
                            <label className="flex flex-col gap-1 text-sm">
                                <span className="font-medium">Software</span>
                                <Select
                                    value={blueprint?.software ?? software}
                                    onValueChange={setSoftware}
                                    options={SOFTWARE}
                                    disabled={Boolean(blueprint?.software)}
                                />
                                {blueprint?.software && (
                                    <span className="text-xs text-muted-foreground">
                                        {blueprint.name} runs on {blueprint.software.toLowerCase()}.
                                    </span>
                                )}
                            </label>
                        )}
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">Version</span>
                            <Input value={version} onChange={(event) => setVersion(event.target.value)} />
                            <span className="text-xs text-muted-foreground">LATEST, or pin one like 1.21.4.</span>
                        </label>
                    </div>

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">World seed</span>
                        <Input
                            value={seed}
                            onChange={(event) => setSeed(event.target.value)}
                            placeholder="Leave blank for a random world"
                        />
                        <span className={cn("text-xs", seedError ? "text-danger" : "text-muted-foreground")}>
                            {seedError ??
                                "A number or any words. The same seed generates the same map - you can start another one from a different seed later."}
                        </span>
                    </label>

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
                            Polaris will give it <strong className="text-foreground">{memory}</strong> of memory for{" "}
                            {concurrentPlayers} {concurrentPlayers === 1 ? "player" : "players"} at once. You can change
                            it later under Settings.
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
                                    {edition === "bedrock" ? " and its port." : "."}
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
                        <p className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-xs text-muted-foreground">
                            <ShieldCheck className="size-4 shrink-0" />
                            <span>
                                The server starts closed: nobody else can join until you add them, and each player is
                                only let in from the address registered to them. Change it later under Firewall.
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

function Choice({
    selected,
    onSelect,
    title,
    detail
}: {
    selected: boolean;
    onSelect: () => void;
    title: string;
    detail: string;
}) {
    return (
        <button
            type="button"
            onClick={onSelect}
            className={cn(
                "rounded-md border p-3 text-left transition-colors",
                selected ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"
            )}
        >
            <p className="text-sm font-medium">{title}</p>
            <p className="text-xs text-muted-foreground">{detail}</p>
        </button>
    );
}
