"use client";

/**
 * Starting this server over as something else.
 *
 * What people do instead is delete the server and make a new one, and it costs
 * them the address, the player list, the access other people hold on it and the
 * port - none of which is what they were trying to replace. So this is the same
 * server: only the game it plays, the release it runs and the map it plays on
 * change, and the card says which things it will not touch before it is opened
 * rather than after.
 *
 * It is not a delete and it does not read as one. The map being played is kept on
 * disk and the server can be switched back onto it under World, which is what
 * makes choosing the wrong blueprint survivable.
 */

import { useState } from "react";
import { findMap } from "@/lib/apps/minecraft/maps";
import { resetGameServerAction } from "./minecraft-actions";
import { saveServerAsTemplateAction } from "@/app/(app)/apps/games/actions";
import { BookmarkPlus, Loader2, RotateCcw, TriangleAlert } from "lucide-react";
import { formatMemory, recommendedMemoryMb, findBlueprint } from "@/lib/apps/minecraft/blueprints";
import {
    BlueprintFields,
    DEFAULT_SHAPE,
    LATEST,
    shapeError,
    type BlueprintShape
} from "@/components/game-blueprint-fields";
import {
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    Checkbox,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    Input,
    cn
} from "@polaris/ui";

export function MinecraftReset({
    installedAppId,
    edition,
    blueprintId,
    mapId,
    crossplay,
    playersOnline,
    onDone
}: {
    installedAppId: string;
    edition: "java" | "bedrock";
    /** What it is built from now, so the dialog opens on it. */
    blueprintId: string | null;
    /** The map it is on now, for the same reason. */
    mapId: string | null;
    /** Whether Bedrock clients join this Java server through Geyser. A reset does
     *  not change it - the second published port is part of the deployment - but
     *  Geyser still has to have a build for whatever release is picked, so the
     *  version list has to know. */
    crossplay: boolean;
    playersOnline: number;
    onDone: () => void;
}) {
    const [open, setOpen] = useState(false);
    const current = findBlueprint(blueprintId ?? "");
    const currentMap = findMap(mapId ?? "");

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <RotateCcw className="size-4 text-primary" />
                    Start over
                </CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">
                    Build this server again as another blueprint, or as an ordinary one, on a fresh map. It keeps its
                    address, its players, the access other people hold on it and its port - only the game changes.
                </p>
                <p className="text-xs text-muted-foreground">
                    {currentMap
                        ? `It is built from ${current?.name ?? "a blueprint"} on ${currentMap.name} now.`
                        : current
                          ? `It is built from ${current.name} now.`
                          : "It was not built from a blueprint, or was created before Polaris recorded which one."}{" "}
                    The map it is on is kept, so you can switch back to it under World.
                </p>
                <div className="flex justify-end">
                    <Button variant="secondary" onClick={() => setOpen(true)}>
                        Start over
                    </Button>
                </div>
            </CardBody>

            {open && (
                <ResetDialog
                    installedAppId={installedAppId}
                    edition={edition}
                    blueprintId={blueprintId}
                    mapId={mapId}
                    crossplay={crossplay}
                    playersOnline={playersOnline}
                    onClose={() => setOpen(false)}
                    onDone={onDone}
                />
            )}
        </Card>
    );
}

function ResetDialog({
    installedAppId,
    edition,
    blueprintId,
    mapId,
    crossplay,
    playersOnline,
    onClose,
    onDone
}: {
    installedAppId: string;
    edition: "java" | "bedrock";
    blueprintId: string | null;
    mapId: string | null;
    crossplay: boolean;
    playersOnline: number;
    onClose: () => void;
    onDone: () => void;
}) {
    const [shape, setShape] = useState<BlueprintShape>(() => {
        const blueprint = findBlueprint(blueprintId ?? "");
        return blueprint
            ? {
                  ...DEFAULT_SHAPE,
                  blueprintId: blueprint.id,
                  // What it is on now, not what a new server of this game would
                  // open on: a reset is meant to start from where the server is.
                  mapId: mapId ?? "",
                  levelType: blueprint.levelType ?? DEFAULT_SHAPE.levelType
              }
            : DEFAULT_SHAPE;
    });
    const [concurrentPlayers, setConcurrentPlayers] = useState(8);
    const [keepPlayers, setKeepPlayers] = useState(false);
    const [templateName, setTemplateName] = useState("");
    const [templateNote, setTemplateNote] = useState<string | null>(null);
    const [savingTemplate, setSavingTemplate] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const blueprint = findBlueprint(shape.blueprintId);
    const seedError = shapeError(shape);
    const memory = formatMemory(recommendedMemoryMb(concurrentPlayers, blueprint?.weight ?? "normal"));
    // Bedrock keeps player data inside the level database, where it cannot be
    // separated from the terrain, so there it is not offered.
    // Not onto a map, and not as a preference: carrying players means creating the
    // new level folder before the server boots, and the image fetches the map only
    // when that folder is absent. Offering the choice would be offering a server
    // with no map in it.
    const carriesPlayers = edition === "java" && !mapId;

    async function submit(): Promise<void> {
        setPending(true);
        setError(null);
        const result = await resetGameServerAction({
            installedAppId,
            blueprintId: shape.blueprintId,
            ...(shape.mapId ? { mapId: shape.mapId } : {}),
            ...(edition === "java" ? { software: shape.software } : {}),
            version: shape.version.trim() || LATEST,
            ...(shape.seed.trim() ? { seed: shape.seed.trim() } : {}),
            ...(edition === "java" ? { levelType: shape.levelType, biome: shape.biome } : {}),
            concurrentPlayers,
            keepPlayers: keepPlayers && carriesPlayers
        });
        setPending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        onDone();
        onClose();
    }

    return (
        <Dialog open onOpenChange={(next) => !next && onClose()}>
            <DialogContent className="max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <RotateCcw className="size-4" /> Start this server over
                    </DialogTitle>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    <BlueprintFields edition={edition} crossplay={crossplay} value={shape} onChange={setShape} />

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Playing at once, usually</span>
                        <Input
                            type="number"
                            min={1}
                            value={concurrentPlayers}
                            onChange={(event) => setConcurrentPlayers(Math.max(1, Number(event.target.value) || 1))}
                        />
                        <span className="text-xs text-muted-foreground">
                            The rebuilt server is given <strong className="text-foreground">{memory}</strong> of memory.
                            Player slots and everything else on Settings are left as they are.
                        </span>
                    </label>

                    {/* The opposite of everything else on this screen: it changes
                        nothing about this server, it writes down how it is built so
                        another can be built the same way. Here because this is
                        where its blueprint and its map are, which is most of what
                        gets written down. */}
                    <div className="flex flex-wrap items-end gap-2 rounded-md border border-border p-3">
                        <label className="flex flex-1 flex-col gap-1 text-sm">
                            <span className="font-medium">Save this server as a template</span>
                            <Input
                                value={templateName}
                                onChange={(event) => setTemplateName(event.target.value)}
                                placeholder="My survival setup"
                                maxLength={60}
                            />
                            <span className="text-xs text-muted-foreground">
                                {templateNote ??
                                    "Keeps what you changed from the blueprint's defaults - not this server's address, players or ports."}
                            </span>
                        </label>
                        <Button
                            variant="secondary"
                            disabled={savingTemplate || templateName.trim().length === 0}
                            onClick={() => {
                                setSavingTemplate(true);
                                setTemplateNote(null);
                                void saveServerAsTemplateAction(installedAppId, templateName, "").then((answer) => {
                                    setSavingTemplate(false);
                                    setTemplateNote(answer.error ?? "Saved. It is offered when you create a server.");
                                    if (!answer.error) setTemplateName("");
                                });
                            }}
                        >
                            {savingTemplate ? <Loader2 className="size-4 animate-spin" /> : <BookmarkPlus className="size-4" />}
                            Save
                        </Button>
                    </div>

                    <label className={cn("flex items-start gap-2 text-sm", carriesPlayers ? "cursor-pointer" : "opacity-60")}>
                        <Checkbox
                            checked={keepPlayers && carriesPlayers}
                            disabled={!carriesPlayers}
                            onChange={(event) => setKeepPlayers(event.target.checked)}
                            className="mt-0.5"
                        />
                        <span className="flex flex-col gap-0.5">
                            <span className="font-medium">Keep what players are carrying</span>
                            <span className="text-xs text-muted-foreground">
                                {carriesPlayers
                                    ? "Inventories, ender chests, stats and advancements come across. The server has to be running for the copy to be made."
                                    : mapId
                                      ? "A built map comes with its own spawn and its own idea of what you start with, so everyone begins it fresh."
                                      : "Bedrock keeps player data inside the world itself, so a new map always starts everyone over."}
                            </span>
                        </span>
                    </label>

                    <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs">
                        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
                        <span className="text-muted-foreground">
                            The server restarts onto a new map, so anybody playing is disconnected
                            {playersOnline > 0
                                ? ` - ${playersOnline} ${playersOnline === 1 ? "is" : "are"} on it right now`
                                : ""}
                            . The map it is on now is kept and you can switch back to it under World.
                        </span>
                    </p>

                    {error && <p className="text-sm text-danger">{error}</p>}

                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={onClose} disabled={pending}>
                            Cancel
                        </Button>
                        <Button onClick={() => void submit()} disabled={pending || seedError !== null}>
                            {pending && <Loader2 className="size-4 animate-spin" />}
                            Start over
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
