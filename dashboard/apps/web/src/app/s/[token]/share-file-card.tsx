"use client";

/**
 * Single-file share hero. A file share has nothing to browse, so it shows the one
 * file with the same actions the explorer offers per row - inline preview (when
 * the share allows it and the type is viewable) through the in-app viewer, and a
 * download - both served through the share's token route. Read-only throughout.
 */

import { useState } from "react";
import { Download, Eye, File } from "lucide-react";
import { formatBytes } from "@polaris/core";
import { Button, Card, CardBody } from "@polaris/ui";
import { FileViewer, isViewable, type ViewerTarget } from "@/app/(app)/drive/file-viewer";

/** URL of the token download route for this file (attachment or inline preview). */
function fileUrl(token: string, path: string, inline: boolean): string {
    const query = new URLSearchParams({ p: path });
    if (inline) query.set("disposition", "inline");
    return `/api/s/${token}/download?${query.toString()}`;
}

export function ShareFileCard({
    token,
    name,
    path,
    size,
    allowDownload,
    allowPreview
}: {
    token: string;
    name: string;
    path: string;
    size: string;
    allowDownload: boolean;
    allowPreview: boolean;
}) {
    const [viewerTarget, setViewerTarget] = useState<ViewerTarget | null>(null);
    const canPreview = allowPreview && isViewable(name);

    return (
        <Card>
            <CardBody className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex min-w-0 items-center gap-3">
                    <File className="size-6 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                        <p className="truncate font-medium">{name}</p>
                        <p className="text-xs text-muted-foreground">{formatBytes(BigInt(size))}</p>
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    {canPreview ? (
                        <Button
                            variant="secondary"
                            onClick={() =>
                                setViewerTarget({ path, name, size, locationLabel: "Shared file" })
                            }
                        >
                            <Eye className="size-4" />
                            Preview
                        </Button>
                    ) : null}
                    {allowDownload ? (
                        <Button asChild>
                            <a href={fileUrl(token, path, false)} download={name}>
                                <Download className="size-4" />
                                Download
                            </a>
                        </Button>
                    ) : null}
                </div>
            </CardBody>

            <FileViewer
                target={viewerTarget}
                onOpenChange={(open) => !open && setViewerTarget(null)}
                urlFor={(target, inline) => fileUrl(token, target.path, inline)}
                readOnly
            />
        </Card>
    );
}
