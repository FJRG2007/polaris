"use client";

/**
 * A Hytale server, which is the one game here Polaris cannot finish installing.
 *
 * Its files come from the operator's own account - Hytale hands the server out
 * to people who own it, through a downloader signed in as them - so the create
 * flow can build the machine, the volume and the address, and the last step is
 * two files only they can provide. That is the same bargain FiveM makes with its
 * key, and the whole job of this screen is to make it a drag rather than a
 * terminal: it says which file is missing and opens the folder it goes in.
 *
 * The container is waiting rather than failing while that is true (see
 * `services/hytale/entrypoint.sh`), so nothing here has to be restarted
 * afterwards - the server starts by itself the moment both files land.
 */

import Link from "next/link";
import { GameConsole } from "./game-console";
import { hytaleFilesAction } from "./hytale-actions";
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, CardBody, Skeleton } from "@polaris/ui";
import { HYTALE_PORT, type HytaleFiles } from "../../lib/hytale/service";
import { CheckCircle2, FolderOpen, Loader2, RefreshCw, TriangleAlert } from "lucide-react";

/** How often the files are looked for while they are missing. Often enough that
 *  an upload is answered by the screen before somebody goes back to it, rare
 *  enough that a server sitting unfinished for a week costs nothing. */
const LOOK_EVERY_MS = 10_000;

export function HytalePanel({
    installedAppId,
    applicationId,
    running
}: {
    installedAppId: string;
    applicationId: string | null;
    running: boolean;
}) {
    const [files, setFiles] = useState<HytaleFiles | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [looking, setLooking] = useState(false);

    const look = useCallback(async () => {
        setLooking(true);
        const result = await hytaleFilesAction(installedAppId);
        setLooking(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        setError(null);
        setFiles(result.files ?? null);
    }, [installedAppId]);

    useEffect(() => {
        void look();
    }, [look]);

    // Only while something is missing: a server that is running has nothing left
    // for this to find, and a poll against a container costs a command each time.
    const waiting = files !== null && files.read && !(files.jar && files.assets);
    useEffect(() => {
        if (!waiting) return;
        const timer = setInterval(() => void look(), LOOK_EVERY_MS);
        return () => clearInterval(timer);
    }, [waiting, look]);

    return (
        <div className="flex flex-col gap-4">
            <Card>
                <CardBody className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="min-w-0">
                            <p className="text-sm font-medium">Server files</p>
                            <p className="text-xs text-muted-foreground">
                                Hytale hands these out through your own account, so Polaris cannot
                                fetch them for you.
                            </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                            <Button
                                size="sm"
                                variant="ghost"
                                disabled={looking}
                                onClick={() => void look()}
                                aria-label="Look again"
                                title="Look again"
                            >
                                {looking ? (
                                    <Loader2 className="size-4 animate-spin" />
                                ) : (
                                    <RefreshCw className="size-4" />
                                )}
                            </Button>
                            {applicationId ? (
                                <Link href={`/drive?c=container:${applicationId}&p=/data`}>
                                    <Button size="sm" variant="secondary">
                                        <FolderOpen className="size-4" /> Files
                                    </Button>
                                </Link>
                            ) : null}
                        </div>
                    </div>

                    {error ? (
                        <p className="flex items-center gap-2 text-sm text-danger">
                            <TriangleAlert className="size-4 shrink-0" />
                            {error}
                        </p>
                    ) : files === null ? (
                        <Skeleton className="h-16 w-full" />
                    ) : !files.read ? (
                        // The machine, not the files. Saying "put your files in"
                        // here would be asking somebody to fix what is already
                        // right.
                        <p className="text-sm text-muted-foreground">
                            This server is not answering, so what is in it cannot be read yet.
                        </p>
                    ) : (
                        <>
                            <ul className="flex flex-col gap-1 text-sm">
                                <FileRow name="HytaleServer.jar" there={files.jar} />
                                <FileRow name="Assets.zip" there={files.assets} />
                            </ul>
                            {files.jar && files.assets ? (
                                <p className="text-xs text-muted-foreground">
                                    Both are here. Players reach the server on UDP {HYTALE_PORT}.
                                </p>
                            ) : (
                                <p className="text-xs text-muted-foreground">
                                    Put them in the top folder under Files - from the Hytale
                                    launcher&apos;s own installation, or from the official
                                    downloader. The server starts by itself once both are there;
                                    nothing needs restarting.
                                </p>
                            )}
                        </>
                    )}
                </CardBody>
            </Card>

            <GameConsole
                installedAppId={installedAppId}
                applicationId={applicationId}
                running={running}
                logName="hytale"
                game="hytale"
                hint="the server's own commands"
            />
        </div>
    );
}

function FileRow({ name, there }: { name: string; there: boolean }) {
    return (
        <li className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
            <code className="truncate font-mono text-xs" title={name}>{name}</code>
            {there ? (
                <Badge variant="success">
                    <CheckCircle2 className="size-3" /> here
                </Badge>
            ) : (
                <Badge variant="warning">waiting</Badge>
            )}
        </li>
    );
}
