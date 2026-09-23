"use client";

/**
 * The game a Minecraft server plays, and the settings underneath that decision.
 *
 * Shared by the dialog that creates a server and the one that rebuilds an
 * existing one, because they ask the same question and a second copy of it is a
 * second place for a blueprint to mean something slightly different.
 *
 * Two tiers on purpose. The blueprint is the whole question for most people, so
 * it is the only thing on screen by default, with the release it will run on
 * stated under it - a blueprint pinning an older Minecraft is a real consequence
 * and finding it out afterwards is how somebody deletes a server and starts
 * again. Everything that is a preference rather than a decision - the release,
 * the seed, the shape of the world, the server software - lives under Advanced,
 * open to anyone who wants it and out of the way of anyone who does not.
 *
 * The releases offered are the ones the blueprint's plugins actually have a build
 * for. That is the point of the picker being a picker: a release typed in by hand
 * that the plugin has nothing built for is exactly the case that used to produce
 * an ordinary survival server and no explanation.
 */

import { ChevronDown, Search } from "lucide-react";
import * as world from "../lib/minecraft/world";
import { useEffect, useMemo, useState } from "react";
import { Input, Select, Skeleton, cn } from "@polaris/ui";
import {
    findSoftware,
    isModpackReference,
    isServerJarUrl,
    searchSoftware,
    SOFTWARE_GROUPS,
    type MinecraftSoftware
} from "@polaris/core";
import { blueprintsFor } from "../lib/minecraft/blueprints";
import { mapsFor, pinnedRelease } from "../lib/minecraft/maps";
import { blueprintVersionsAction, type BlueprintVersions } from "../screens/actions";

/**
 * What each blueprint answered last time it was asked, for this tab.
 *
 * The answer comes from Modrinth, one request per plugin the blueprint installs,
 * and it does not change while somebody is filling in a form. Without this,
 * clicking through the blueprints to read what each one is put the version field
 * back behind a skeleton every time - including on the way back to the one that
 * had already answered. Held outside the component so it survives the dialog
 * being closed and opened again, which is the other way the same wait was paid
 * twice.
 */
const answered = new Map<string, BlueprintVersions>();

/** What the operator picked, which is everything both dialogs need to build a
 *  server: the game it plays and the map it plays it on. */
export interface BlueprintShape {
    readonly blueprintId: string;
    /** A prebuilt map to build on. Blank generates a world instead. */
    readonly mapId: string;
    /** Java only. Ignored when the blueprint pins its own. */
    readonly software: string;
    /** The one value the chosen software needs and nothing else does: the modpack
     *  for a modpack server, the URL of the jar for a custom one. Blank for the
     *  software that asks for nothing, which is most of it. */
    readonly source: string;
    /** A release, or LATEST for the newest the blueprint can run on. */
    readonly version: string;
    /** Blank generates a random world. */
    readonly seed: string;
    readonly levelType: string;
    readonly biome: string;
}

/** The version that means "whatever the blueprint can newest run on", rather than
 *  a release somebody chose. */
export const LATEST = "LATEST";

/**
 * The lines a server can follow instead of a release.
 *
 * Both are what the image itself accepts in `VERSION`, and both mean "whatever is
 * newest here, and keep moving": a snapshot server upgrades itself every time
 * Mojang publishes one. Worth offering and worth the sentence underneath - a
 * server on one of these is a server whose plugins will break on a Tuesday.
 */
const JAVA_CHANNELS = [
    {
        value: "SNAPSHOT",
        label: "Snapshot - the newest, unfinished",
        detail: "Mojang's weekly builds. Almost nothing has a plugin or mod built for one."
    }
] as const;

const BEDROCK_CHANNELS = [
    {
        value: "PREVIEW",
        label: "Preview - the newest, unfinished",
        detail: "Mojang's preview builds. Only players on a preview client can join."
    }
] as const;

/** The value both dialogs open on, before a blueprint has been chosen. */
export const DEFAULT_SHAPE: BlueprintShape = {
    blueprintId: "survival",
    mapId: "",
    software: "PAPER",
    source: "",
    version: LATEST,
    seed: "",
    levelType: world.DEFAULT_LEVEL_TYPE,
    biome: world.DEFAULT_BIOME
};


export function BlueprintFields({
    edition,
    crossplay,
    value,
    onChange,
    /** False on the reset dialog's first paint, where the blueprint the server is
     *  already built from arrives with the rest of its settings. */
    ready = true
}: {
    edition: "java" | "bedrock";
    crossplay: boolean;
    value: BlueprintShape;
    onChange: (next: BlueprintShape) => void;
    ready?: boolean;
}) {
    const [advanced, setAdvanced] = useState(false);
    /** Null until the releases are known, which is a wait worth showing rather
     *  than a list that silently starts as one entry and grows. */
    const [offered, setOffered] = useState<BlueprintVersions | null>(null);

    const blueprints = useMemo(() => blueprintsFor(edition), [edition]);
    const blueprint = blueprints.find((entry) => entry.id === value.blueprintId);
    const maps = useMemo(() => mapsFor(blueprint), [blueprint]);
    // Read off this blueprint's own list rather than by id alone, so a map left
    // over from the blueprint before it is not treated as the current choice.
    const map = maps.find((entry) => entry.id === value.mapId);
    const pinned = pinnedRelease(map);
    const seedError = shapeError(value);

    function set(patch: Partial<BlueprintShape>): void {
        onChange({ ...value, ...patch });
    }

    // A blueprint belongs to an edition; switching away from one that does not
    // have it leaves the picker on something that cannot be created.
    useEffect(() => {
        if (ready && !blueprints.some((entry) => entry.id === value.blueprintId)) {
            onChange({ ...value, blueprintId: blueprints[0]?.id ?? "survival" });
        }
    }, [ready, blueprints, value, onChange]);

    // A map that is not this blueprint's is one the server cannot be built on, and
    // it arrives that way from the reset dialog, which opens on what the server
    // already is and then has the blueprint changed under it.
    useEffect(() => {
        if (ready && value.mapId.length > 0 && !maps.some((entry) => entry.id === value.mapId)) {
            onChange({ ...value, mapId: "" });
        }
    }, [ready, maps, value, onChange]);

    // Asked as the blueprint is chosen rather than at submit, so the releases it
    // can run on are on screen while the decision is still being made.
    useEffect(() => {
        let active = true;
        const key = `${value.blueprintId}|${crossplay}|${value.mapId}`;
        const known = answered.get(key);
        // Straight to the answer where there is one: a skeleton drawn over a
        // field that is about to show the same list it showed a second ago is a
        // wait invented rather than reported.
        setOffered(known ?? null);
        if (known) return;
        void blueprintVersionsAction(value.blueprintId, crossplay, value.mapId || undefined)
            .then((answer) => {
                answered.set(key, answer);
                if (active) setOffered(answer);
            })
            .catch(() => undefined);
        return () => {
            active = false;
        };
    }, [value.blueprintId, crossplay, value.mapId]);

    const isLatest = value.version.trim().length === 0 || value.version.trim().toUpperCase() === LATEST;
    // A channel is not a release: it names whatever is newest on a line that has
    // no release number yet. Checking one against the list of releases a plugin
    // supports would mark every snapshot unsupported, which is true of the
    // plugins and not what the field is being asked.
    const channels = edition === "bedrock" ? BEDROCK_CHANNELS : JAVA_CHANNELS;
    const channel = channels.find((entry) => entry.value === value.version.trim().toUpperCase()) ?? null;
    // A pinned map settles the release on its own, without waiting on Modrinth:
    // it is a property of the map rather than of anything that has to be asked.
    const running = pinned ?? (isLatest ? offered?.latest ?? null : value.version.trim());
    // Only ever said when the answer is known. A list that came back empty is a
    // Modrinth nobody could reach, not a release nothing supports.
    const unsupported =
        !isLatest &&
        !channel &&
        offered !== null &&
        offered.versions.length > 0 &&
        !offered.versions.includes(value.version.trim());

    return (
        <>
            <div className="flex flex-col gap-2">
                <span className="text-sm font-medium">Blueprint</span>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {blueprints.map((entry) => (
                        <Choice
                            key={entry.id}
                            selected={value.blueprintId === entry.id}
                            onSelect={() =>
                                set({
                                    blueprintId: entry.id,
                                    // A blueprint that has maps opens on one of
                                    // them rather than on an empty world: for
                                    // half of these the map is the game, and a
                                    // flat lobby is what "it did not work" looks
                                    // like. Still a choice - the list underneath
                                    // has "generate a world" on it.
                                    mapId: mapsFor(entry)[0]?.id ?? "",
                                    // The shape of the world follows the game: a
                                    // minigame's spawn is a lobby, and a lobby
                                    // generated as ordinary terrain is why one of
                                    // these looked like an ordinary server. Still
                                    // only a default - Advanced overrides it.
                                    levelType: entry.levelType ?? world.DEFAULT_LEVEL_TYPE,
                                    // The release the last blueprint could run on
                                    // is not one this one is promised, so the
                                    // choice goes back to whatever is newest for
                                    // it rather than carrying a stale pin over.
                                    version: LATEST
                                })
                            }
                            title={entry.name}
                            detail={entry.summary}
                        />
                    ))}
                </div>
                <p className="text-xs text-muted-foreground">
                    {pinned ? (
                        `${map?.name} plays on Minecraft ${pinned}, so the server is built on it.`
                    ) : offered === null ? (
                        <span className="inline-block align-middle">
                            <Skeleton className="h-3 w-56" />
                        </span>
                    ) : running === null ? (
                        "The release is chosen when the server starts."
                    ) : offered.pinned && isLatest ? (
                        `${blueprint?.name} runs on Minecraft ${running}, so the server is built on it.`
                    ) : (
                        `Minecraft ${running}.`
                    )}
                    {/* What is left to do is the map's when there is one: it is
                        the thing that decides, and the blueprint's note is about
                        the plugin the map replaced. */}
                    {(map ? map.setup : blueprint?.setup) && ` ${map ? map.setup : blueprint?.setup}`}
                </p>
            </div>

            {maps.length > 0 && (
                <div className="flex flex-col gap-2">
                    <span className="text-sm font-medium">Map</span>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {maps.map((entry) => (
                            <Choice
                                key={entry.id}
                                selected={value.mapId === entry.id}
                                // The release is the map's, so a pin the last one
                                // carried does not follow this one onto the form.
                                // The seed goes with it: it generates nothing now,
                                // and one left in a field nobody can see is a
                                // submit refused for a reason nobody can read.
                                onSelect={() => set({ mapId: entry.id, version: LATEST, seed: "" })}
                                title={entry.name}
                                detail={entry.summary}
                                note={`${entry.author} - ${entry.players.min === entry.players.max ? entry.players.max : `${entry.players.min} to ${entry.players.max}`} players`}
                            />
                        ))}
                        <Choice
                            selected={value.mapId.length === 0}
                            onSelect={() => set({ mapId: "", version: LATEST })}
                            title="Generate a world"
                            detail={
                                blueprint?.projects.length
                                    ? "A new world for the plugin to run its game in."
                                    : "A new world and nothing built in it."
                            }
                        />
                    </div>
                    <p className="text-xs text-muted-foreground">
                        {map
                            ? `Downloaded onto the server while it is being created. Built by ${map.author}.`
                            : "The server generates its own world on its first start."}
                    </p>
                </div>
            )}

            <div className="flex flex-col gap-3">
                <button
                    type="button"
                    onClick={() => setAdvanced((open) => !open)}
                    aria-expanded={advanced}
                    className="flex items-center gap-1 self-start text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                    <ChevronDown className={cn("size-4 transition-transform", advanced && "rotate-180")} />
                    Advanced
                </button>

                {advanced && (
                    <div className="flex flex-col gap-3 border-l border-border pl-3">
                        <div className="grid grid-cols-1 gap-3">
                            {edition === "java" && (
                                <SoftwarePicker
                                    value={blueprint?.software ?? value.software}
                                    source={value.source}
                                    onChange={(software, source) => set({ software, source })}
                                    pinnedBy={blueprint?.software ? blueprint.name : null}
                                />
                            )}
                            <label className="flex flex-col gap-1 text-sm">
                                <span className="font-medium">Minecraft version</span>
                                {pinned ? (
                                    <Select
                                        value={pinned}
                                        onValueChange={() => undefined}
                                        options={[{ value: pinned, label: pinned }]}
                                        disabled
                                    />
                                ) : offered === null ? (
                                    <Skeleton className="h-9 w-full" />
                                ) : (
                                    <Select
                                        value={isLatest ? LATEST : (channel?.value ?? value.version.trim())}
                                        onValueChange={(version) => set({ version })}
                                        options={[
                                            {
                                                value: LATEST,
                                                label: offered.latest ? `Latest (${offered.latest})` : "Latest"
                                            },
                                            ...channels.map((entry) => ({
                                                value: entry.value,
                                                label: entry.label
                                            })),
                                            ...offered.versions.map((entry) => ({ value: entry, label: entry }))
                                        ]}
                                    />
                                )}
                                <span
                                    className={cn("text-xs", unsupported ? "text-danger" : "text-muted-foreground")}
                                >
                                    {pinned
                                        ? `${map?.name} was built for this release and its game does not run on later ones.`
                                        : channel
                                          ? channel.detail
                                          : unsupported
                                          ? `${blueprint?.name} has nothing built for ${value.version.trim()}.`
                                          : offered?.pinned
                                            ? "Only the releases this blueprint's plugins have a build for."
                                            : "Players have to be on the same release to join."}
                                </span>
                            </label>
                        </div>

                        {/* A map brings its own terrain, so the questions about
                            generating one have no answer that changes anything. */}
                        {!map && (
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <label className="flex flex-col gap-1 text-sm">
                                <span className="font-medium">World seed</span>
                                <Input
                                    value={value.seed}
                                    onChange={(event) => set({ seed: event.target.value })}
                                    placeholder="Leave blank for a random world"
                                />
                                <span className={cn("text-xs", seedError ? "text-danger" : "text-muted-foreground")}>
                                    {seedError ?? "A number or any words. The same seed always generates the same map."}
                                </span>
                            </label>
                            {edition === "java" && (
                                <label className="flex flex-col gap-1 text-sm">
                                    <span className="font-medium">World type</span>
                                    <Select
                                        value={value.levelType}
                                        onValueChange={(levelType) => set({ levelType })}
                                        options={world.LEVEL_TYPES.map((entry) => ({
                                            value: entry.value,
                                            label: entry.label
                                        }))}
                                    />
                                    <span className="text-xs text-muted-foreground">
                                        {world.LEVEL_TYPES.find((entry) => entry.value === value.levelType)?.detail}
                                    </span>
                                </label>
                            )}
                        </div>
                        )}

                        {!map && edition === "java" && world.usesBiome(value.levelType) && (
                            <label className="flex flex-col gap-1 text-sm">
                                <span className="font-medium">Biome</span>
                                <Select
                                    value={value.biome}
                                    onValueChange={(biome) => set({ biome })}
                                    options={world.BIOMES.map((entry) => ({ value: entry.value, label: entry.label }))}
                                />
                                <span className="text-xs text-muted-foreground">
                                    The whole overworld is this one biome. The Nether and the End are unchanged.
                                </span>
                            </label>
                        )}
                    </div>
                )}
            </div>
        </>
    );
}

/** Whether what is in this shape can be submitted at all. The same rule the
 *  schema applies, so a refusal lands on the field rather than on a container. */
export function shapeError(shape: BlueprintShape): string | null {
    if (shape.seed.trim().length > 0 && !world.isSeed(shape.seed.trim()))
        return "A seed is up to 64 characters of ordinary text";
    return sourceError(shape.software, shape.source);
}

/** What is wrong with the value the chosen software asks for, or null. Null for
 *  the software that asks for nothing, whatever is left in the field. */
export function sourceError(software: string, source: string): string | null {
    const asks = findSoftware(software)?.asks;
    if (!asks) return null;
    const value = source.trim();
    if (value.length === 0)
        return asks === "modpack" ? "Name the modpack to install" : "Give the URL of the server jar";
    if (asks === "modpack" && !isModpackReference(value))
        return "That is a modpack short name, or the link to its page";
    if (asks === "jar" && !isServerJarUrl(value)) return "That is an https link ending in .jar";
    return null;
}

/**
 * Which server software this runs, out of everything the image knows how to
 * install.
 *
 * A list rather than a dropdown, and searchable, because it is twenty entries
 * long and the difference between two of them is a sentence: Paper and Pufferfish
 * in a dropdown is a choice made by guessing. Grouped the way people already
 * think about it - what most servers run, what is established, what is
 * experimental, and the hybrids that take plugins and mods at once.
 *
 * Collapsed to the chosen one until somebody opens it, so the ordinary case - the
 * default is right - is one line rather than a wall of cards.
 */
function SoftwarePicker({
    value,
    source,
    onChange,
    pinnedBy
}: {
    value: string;
    source: string;
    onChange: (software: string, source: string) => void;
    /** The blueprint that settles this, when one does. Its plugins load into one
     *  thing, and choosing another is a server that boots without them. */
    pinnedBy: string | null;
}) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const chosen = findSoftware(value);
    const found = useMemo(() => searchSoftware(query), [query]);
    const shelves = useMemo(
        () =>
            SOFTWARE_GROUPS.map((group) => ({
                ...group,
                entries: found.filter((entry: MinecraftSoftware) => entry.group === group.id)
            })).filter((shelf) => shelf.entries.length > 0),
        [found]
    );
    const wrong = sourceError(value, source);

    return (
        <div className="flex flex-col gap-2 text-sm">
            <div className="flex items-center justify-between gap-2">
                <span className="font-medium">Server software</span>
                {!pinnedBy && (
                    <button
                        type="button"
                        onClick={() => setOpen((shown) => !shown)}
                        className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                    >
                        {open ? "Done" : "Change"}
                    </button>
                )}
            </div>

            <div className="rounded-md border border-border p-3">
                <p className="text-sm font-medium">{chosen?.name ?? value}</p>
                <p className="text-xs text-muted-foreground">
                    {pinnedBy
                        ? `${pinnedBy} loads its plugins into this, so it is what the server runs.`
                        : (chosen?.summary ?? "Installed exactly as it is written here.")}
                </p>
                {chosen?.caveat && !pinnedBy && <p className="mt-1 text-xs text-warning">{chosen.caveat}</p>}
            </div>

            {chosen?.asks && !pinnedBy && (
                <label className="flex flex-col gap-1">
                    <span className="font-medium">{chosen.asks === "modpack" ? "Modpack" : "Server jar"}</span>
                    <Input
                        value={source}
                        onChange={(event) => onChange(value, event.target.value)}
                        placeholder={
                            chosen.asks === "modpack"
                                ? "cobblemon-fabric, or the link to its page"
                                : "https://example.com/server.jar"
                        }
                    />
                    <span className={cn("text-xs", wrong ? "text-danger" : "text-muted-foreground")}>
                        {wrong ??
                            (chosen.asks === "modpack"
                                ? "The pack brings its own mod loader and its own mods."
                                : "Fetched once, the first time the server starts.")}
                    </span>
                </label>
            )}

            {open && !pinnedBy && (
                <div className="flex flex-col gap-2">
                    <div className="relative">
                        <Search className="pointer-events-none absolute left-2 top-1/2 size-4 shrink-0 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder="Search software"
                            className="pl-8"
                        />
                    </div>
                    <div className="flex max-h-72 flex-col gap-3 overflow-y-auto pr-1">
                        {shelves.map((shelf) => (
                            <div key={shelf.id} className="flex flex-col gap-2">
                                <span className="text-xs font-medium text-muted-foreground">{shelf.label}</span>
                                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                    {shelf.entries.map((entry: MinecraftSoftware) => (
                                        <Choice
                                            key={entry.id}
                                            selected={entry.id === value}
                                            onSelect={() => {
                                                // What the last software asked for
                                                // means nothing to this one, and a
                                                // modpack left in the box is a
                                                // create refused over a field
                                                // nobody can see any more.
                                                onChange(entry.id, entry.id === value ? source : "");
                                                setOpen(false);
                                            }}
                                            title={entry.name}
                                            detail={entry.summary}
                                            {...(entry.caveat ? { note: entry.caveat } : {})}
                                        />
                                    ))}
                                </div>
                            </div>
                        ))}
                        {shelves.length === 0 && (
                            <p className="text-xs text-muted-foreground">
                                Nothing here is called that. Anything this list is missing can be run as a custom
                                server jar.
                            </p>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

/** One of a small set of answers, as a card rather than a row in a list: these
 *  each need a sentence of their own to be chosen between. */
export function Choice({
    selected,
    onSelect,
    title,
    detail,
    /** Who made it and what it takes, for a choice that is somebody's work
     *  rather than a setting. */
    note
}: {
    selected: boolean;
    onSelect: () => void;
    title: string;
    detail: string;
    note?: string;
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
            {note && <p className="mt-1 text-xs text-muted-foreground/70">{note}</p>}
        </button>
    );
}
