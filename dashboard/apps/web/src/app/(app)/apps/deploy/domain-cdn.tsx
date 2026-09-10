"use client";

/**
 * One domain served through Cloudflare's proxy, which caches the service's
 * static assets at Cloudflare's edge: the switch, and emptying the cache by
 * hand. The cache is emptied after every successful deploy anyway; the button
 * is for the time something changed without one.
 */

import { Cloud, Loader2 } from "lucide-react";
import { useState, useTransition } from "react";
import { cachePurgeSchema } from "@polaris/core";
import { purgeDomainCacheAction, setDomainCdnAction } from "./database-actions";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Switch,
    cn
} from "@polaris/ui";

export function DomainCdnButton({
    domainId,
    hostname,
    enabled,
    onChanged
}: {
    domainId: string;
    hostname: string;
    enabled: boolean;
    onChanged: () => void;
}) {
    const [open, setOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState<string | null>(null);
    const [prefix, setPrefix] = useState("");
    const [pending, startTransition] = useTransition();
    const valid = cachePurgeSchema.safeParse({ domainId, prefix });

    function toggle(next: boolean) {
        setError(null);
        setDone(null);
        startTransition(async () => {
            const result = await setDomainCdnAction({ domainId, enabled: next });
            if (result.error) setError(result.error);
            else onChanged();
        });
    }

    function purge() {
        setError(null);
        setDone(null);
        startTransition(async () => {
            const result = await purgeDomainCacheAction({ domainId, ...(prefix.trim() ? { prefix: prefix.trim() } : {}) });
            if (result.error) setError(result.error);
            else setDone(prefix.trim() ? `Emptied ${hostname}/${prefix.trim().replace(/^\/+/, "")}.` : `Emptied the cache for ${hostname}.`);
        });
    }

    return (
        <>
            <button
                type="button"
                title={enabled ? "Served through Cloudflare" : "Serve through Cloudflare"}
                aria-label="Cloudflare CDN"
                onClick={() => setOpen(true)}
                className={cn(
                    "shrink-0 rounded p-0.5 transition-colors hover:text-foreground",
                    enabled ? "text-primary" : "text-muted-foreground"
                )}
            >
                <Cloud className="size-3.5" />
            </button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>Cloudflare CDN</DialogTitle>
                        <DialogDescription>
                            Serves {hostname} through Cloudflare&apos;s proxy, which caches static assets at its edge. Needs the
                            domain&apos;s DNS on the Cloudflare account connected under Domains.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="flex flex-col gap-4">
                        <label className="flex items-center gap-2 text-sm">
                            <Switch checked={enabled} disabled={pending} onChange={toggle} aria-label="Serve through Cloudflare" />
                            {enabled ? "Served through Cloudflare" : "Not served through Cloudflare"}
                        </label>
                        {enabled ? (
                            <div className="flex flex-col gap-2">
                                <p className="text-xs text-muted-foreground">
                                    The cache is emptied after every successful deploy. Empty it now, for the whole domain or
                                    under one path.
                                </p>
                                <Input
                                    value={prefix}
                                    onChange={(event) => setPrefix(event.target.value)}
                                    placeholder="Path, e.g. assets/ (blank for everything)"
                                />
                                {prefix.trim() && !valid.success ? (
                                    <p className="text-xs text-warning">{valid.error.issues[0]?.message}</p>
                                ) : null}
                            </div>
                        ) : null}
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        {done ? <p className="text-sm text-success">{done}</p> : null}
                    </div>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setOpen(false)}>
                            Close
                        </Button>
                        {enabled ? (
                            <Button disabled={pending || !valid.success} onClick={purge}>
                                {pending ? <Loader2 className="size-4 animate-spin" /> : null} Empty cache
                            </Button>
                        ) : null}
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
