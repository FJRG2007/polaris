"use client";

/**
 * Which storage a kind of upload goes to.
 *
 * Polaris already knows how to reach a NAS, an NFS export or an SFTP host, so
 * this is not a new kind of storage - it is the choice of which one to use. Left
 * alone it picks the obvious answer: the NAS if this instance has one, because
 * that is the disk with the room and the backups, and its own disk if it does
 * not.
 *
 * Changing it moves nothing. Everything already written remembers the storage it
 * went to, so it stays readable exactly where it is.
 *
 * Shared, because more than one thing gets uploaded and each makes this choice
 * separately: a profile photo is read constantly and weighs nothing, so keeping
 * it on the server while the big attachments go to the NAS is a sensible answer
 * rather than an inconsistency.
 */

import { Select } from "@polaris/ui";
import { HardDrive, Server } from "lucide-react";
import type { TargetOption, UploadTarget } from "@/lib/storage-target";

export const AUTOMATIC = "auto";
export const LOCAL = "local";

/** Where this kind of upload is going right now, and why. */
export function ResolvedTarget({ resolved, automatic }: { resolved: UploadTarget; automatic: string }) {
    return (
        <div className="flex items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                {resolved.id === LOCAL ? <Server className="size-5" /> : <HardDrive className="size-5" />}
            </span>
            <div className="min-w-0">
                <p className="text-sm font-medium">Kept on {resolved.name}</p>
                <p className="text-xs text-muted-foreground">{resolved.automatic ? automatic : "Chosen here."}</p>
            </div>
        </div>
    );
}

export function TargetPicker({
    label,
    hint,
    value,
    options,
    resolvedName,
    onChange,
    lead
}: {
    label: string;
    hint: string;
    value: string;
    options: readonly TargetOption[];
    /** Named in the automatic option, so it says what it would actually pick. */
    resolvedName: string;
    onChange: (value: string) => void;
    /** A choice that comes before the storage ones, for a kind of upload that
     *  can defer to another kind rather than answer for itself. */
    lead?: { value: string; label: string };
}) {
    return (
        <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">{label}</span>
            <Select
                value={value}
                onValueChange={onChange}
                options={[
                    ...(lead ? [lead] : []),
                    { value: AUTOMATIC, label: `Choose for me (${resolvedName})` },
                    { value: LOCAL, label: "This server" },
                    ...options.map((connection) => ({
                        value: connection.id,
                        label: `${connection.name} (${connection.kind})`
                    }))
                ]}
                aria-label={label}
                className="w-full"
            />
            <span className="text-xs text-muted-foreground">{hint}</span>
        </label>
    );
}
