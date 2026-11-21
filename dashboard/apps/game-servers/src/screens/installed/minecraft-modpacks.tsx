"use client";

/**
 * Modpacks.
 *
 * A modpack is not another mod: it decides the loader, the release and every mod
 * on the server, and the image installs it over whatever was chosen before. So it
 * gets a card of its own rather than a row among the mods, and choosing one is a
 * confirmation rather than a tick - what it costs is the server's current mod
 * list and, often, the readability of its world.
 *
 * The world is deliberately left alone. A modded world is the mods that made it,
 * so a pack that does not include them will generate new chunks around blocks it
 * does not know and may refuse to load the old ones - which is worth saying
 * before, and is not worth deciding for somebody by wiping their world.
 */

import { useEffect, useState, useTransition } from "react";
import { useGameText } from "../game-text";
import { Boxes, ExternalLink, Loader2, Search } from "lucide-react";
import type { ModrinthProject } from "../../lib/minecraft/modrinth";
import {
    applyServerPackAction,
    searchModpacksAction,
    serverPackInfoAction,
    setModpackAction
} from "./minecraft-actions";
import { ArchiveIntake, ArchiveSummary } from "../../components/archive-intake";
import type { ArchiveInfo } from "../../lib/minecraft/archives/store";
import {
    Badge,
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    Input,
    Select,
    Skeleton
} from "@polaris/ui";

export function ModpacksCard({
    installedAppId,
    /** What the server runs now: the pack, or blank for a server that runs none. */
    modpack,
    /** The uploaded server pack it runs (`GENERIC_PACK`), blank for none. */
    serverPack = "",
    onSaved
}: {
    installedAppId: string;
    modpack: string;
    serverPack?: string;
    onSaved: () => void;
}) {
    const t = useGameText("minecraft");
    const g = useGameText("games");
    const [uploaded, setUploaded] = useState<ArchiveInfo | null>(null);
    const [running, setRunning] = useState<ArchiveInfo | null>(null);
    const [packLoader, setPackLoader] = useState("FORGE");
    const [packConfirm, setPackConfirm] = useState(false);

    // What the uploaded pack it runs is, by the id its address carries. Asked
    // every time rather than only when the settings name one: the variable is
    // not among the ones every screen is handed.
    useEffect(() => {
        let active = true;
        void serverPackInfoAction(installedAppId).then((info) => {
            if (active) setRunning(info);
        });
        return () => {
            active = false;
        };
    }, [installedAppId, serverPack, uploaded]);

    function applyPack(pack: ArchiveInfo): void {
        setError(null);
        startTransition(async () => {
            const result = await applyServerPackAction({
                installedAppId,
                archiveId: pack.id,
                ...(pack.loader
                    ? {}
                    : { software: packLoader as "FORGE" | "NEOFORGE" | "FABRIC" | "QUILT" })
            });
            if (result.error) {
                setError(result.error);
                return;
            }
            setPackConfirm(false);
            setUploaded(null);
            onSaved();
        });
    }
    const [query, setQuery] = useState("");
    const [packs, setPacks] = useState<ModrinthProject[] | null>(null);
    const [chosen, setChosen] = useState<ModrinthProject | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    useEffect(() => {
        let active = true;
        const timer = setTimeout(() => {
            void searchModpacksAction(installedAppId, query).then((answer) => {
                if (active) setPacks(answer.packs ?? []);
            });
        }, 250);
        return () => {
            active = false;
            clearTimeout(timer);
        };
    }, [installedAppId, query]);

    function apply(slug: string): void {
        setError(null);
        startTransition(async () => {
            const result = await setModpackAction({ installedAppId, modpack: slug, restart: true });
            if (result.error) {
                setError(result.error);
                return;
            }
            setChosen(null);
            onSaved();
        });
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Boxes className="size-4 text-primary" />
                    {t("modpacks.modpacks")}
                </CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <p className="text-xs text-muted-foreground">{t("modpacks.aPackBringsItsOwn")}</p>

                {modpack.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2">
                        <span className="text-xs text-muted-foreground">
                            {t("modpacks.running")}
                        </span>
                        <span className="text-sm font-medium">{modpack}</span>
                        <Button
                            size="sm"
                            variant="ghost"
                            className="ms-auto"
                            disabled={pending}
                            onClick={() => apply("")}
                        >
                            {t("modpacks.stopRunningIt")}
                        </Button>
                    </div>
                )}

                <div className="relative">
                    <Search className="pointer-events-none absolute start-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={t("modpacks.searchModpacks")}
                        className="ps-8"
                    />
                </div>

                <div className="flex flex-col gap-2">
                    {packs === null ? (
                        <>
                            <Skeleton className="h-14 w-full" />
                            <Skeleton className="h-14 w-full" />
                        </>
                    ) : packs.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                            {t("modpacks.nothingCameBackModrinthMay")}
                        </p>
                    ) : (
                        packs.map((pack) => (
                            <div
                                key={pack.slug}
                                className="flex items-start gap-3 rounded-md border border-border p-2"
                            >
                                {pack.iconUrl ? (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img
                                        src={pack.iconUrl}
                                        alt=""
                                        className="size-8 shrink-0 rounded"
                                    />
                                ) : (
                                    <div className="size-8 shrink-0 rounded bg-muted" />
                                )}
                                <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <a
                                            href={`https://modrinth.com/modpack/${pack.slug}`}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="text-sm font-medium hover:underline"
                                        >
                                            {pack.title}
                                            <ExternalLink className="ms-1 inline size-3 shrink-0" />
                                        </a>
                                        {pack.slug === modpack && (
                                            <Badge variant="success">
                                                {t("modpacks.runningBadge")}
                                            </Badge>
                                        )}
                                    </div>
                                    <p className="line-clamp-2 text-xs text-muted-foreground">
                                        {pack.description}
                                    </p>
                                </div>
                                {pack.slug !== modpack && (
                                    <Button
                                        size="sm"
                                        variant="secondary"
                                        disabled={pending}
                                        onClick={() => setChosen(pack)}
                                    >
                                        {t("modpacks.install")}
                                    </Button>
                                )}
                            </div>
                        ))
                    )}
                </div>

                {chosen && (
                    <div className="flex flex-col gap-2 rounded-md border border-warning-edge bg-warning-soft px-3 py-2">
                        <p className="text-sm font-medium">
                            {t("modpacks.installTitle", { name: chosen.title })}
                        </p>
                        <p className="text-xs text-muted-foreground">{t("modpacks.installBody")}</p>
                        <div className="flex items-center gap-2">
                            <Button size="sm" disabled={pending} onClick={() => apply(chosen.slug)}>
                                {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                                {t("modpacks.installIt")}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setChosen(null)}>
                                {t("modpacks.cancel")}
                            </Button>
                        </div>
                    </div>
                )}

                <div className="flex flex-col gap-2 border-t border-border pt-3">
                    <span className="text-sm font-medium">{g("archive.serverPack")}</span>
                    <p className="text-xs text-muted-foreground">{g("archive.serverPackIntro")}</p>
                    {running && !uploaded && (
                        <div className="flex flex-col gap-1">
                            <span className="text-xs text-muted-foreground">
                                {t("modpacks.running")}
                            </span>
                            <ArchiveSummary archive={running} onRemove={null} />
                        </div>
                    )}
                    <ArchiveIntake
                        kind="pack"
                        value={uploaded}
                        onChange={(pack) => {
                            setUploaded(pack);
                            setPackConfirm(false);
                        }}
                        disabled={pending}
                    />
                    {uploaded && !uploaded.loader && (
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">{g("archive.whichLoader")}</span>
                            <Select
                                value={packLoader}
                                onValueChange={setPackLoader}
                                options={[
                                    // i18n-ignore: product names
                                    { value: "FORGE", label: "Forge" },
                                    // i18n-ignore: product names
                                    { value: "NEOFORGE", label: "NeoForge" },
                                    // i18n-ignore: product names
                                    { value: "FABRIC", label: "Fabric" },
                                    // i18n-ignore: product names
                                    { value: "QUILT", label: "Quilt" }
                                ]}
                                aria-label={g("archive.whichLoader")}
                            />
                        </label>
                    )}
                    {uploaded && !packConfirm && (
                        <Button
                            size="sm"
                            className="self-start"
                            disabled={pending}
                            onClick={() => setPackConfirm(true)}
                        >
                            {t("modpacks.install")}
                        </Button>
                    )}
                    {uploaded && packConfirm && (
                        <div className="flex flex-col gap-2 rounded-md border border-warning-edge bg-warning-soft px-3 py-2">
                            <p className="text-sm font-medium">
                                {t("modpacks.installTitle", { name: uploaded.name })}
                            </p>
                            <p className="text-xs text-muted-foreground">{t("modpacks.installBody")}</p>
                            <div className="flex items-center gap-2">
                                <Button size="sm" disabled={pending} onClick={() => applyPack(uploaded)}>
                                    {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                                    {t("modpacks.installIt")}
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => setPackConfirm(false)}>
                                    {t("modpacks.cancel")}
                                </Button>
                            </div>
                        </div>
                    )}
                </div>

                {error && <p className="text-xs text-danger">{error}</p>}
            </CardBody>
        </Card>
    );
}
