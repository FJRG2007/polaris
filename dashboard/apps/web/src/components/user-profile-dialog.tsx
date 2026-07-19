"use client";

/**
 * Profile popover for a user reached from the activity feed. Shows the name and,
 * for admins, the email and ban controls. Loads the profile on open through the
 * server action, which decides what a given viewer may see.
 */

import { useEffect, useState } from "react";
import { Ban, Loader2 } from "lucide-react";
import { Badge, Button, Dialog, DialogContent, DialogHeader, DialogTitle, Input } from "@polaris/ui";
import {
    banUserAction,
    getUserProfileAction,
    unbanUserAction,
    type UserProfile
} from "@/app/(app)/drive/activity-actions";

export function UserProfileDialog({
    userId,
    onOpenChange
}: {
    userId: string | null;
    onOpenChange: (open: boolean) => void;
}) {
    const [profile, setProfile] = useState<UserProfile | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [reason, setReason] = useState("");
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!userId) {
            setProfile(null);
            return;
        }
        let active = true;
        setLoading(true);
        setError(null);
        setReason("");
        void getUserProfileAction(userId).then((result) => {
            if (!active) return;
            if (result.error) setError(result.error);
            else setProfile(result.profile ?? null);
            setLoading(false);
        });
        return () => {
            active = false;
        };
    }, [userId]);

    async function refresh() {
        if (!userId) return;
        const result = await getUserProfileAction(userId);
        if (result.profile) setProfile(result.profile);
    }

    async function onBan() {
        if (!userId) return;
        setBusy(true);
        setError(null);
        const result = await banUserAction(userId, reason);
        setBusy(false);
        if (result.error) setError(result.error);
        else await refresh();
    }

    async function onUnban() {
        if (!userId) return;
        setBusy(true);
        setError(null);
        const result = await unbanUserAction(userId);
        setBusy(false);
        if (result.error) setError(result.error);
        else await refresh();
    }

    return (
        <Dialog open={userId !== null} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>User</DialogTitle>
                </DialogHeader>
                {loading ? (
                    <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" /> Loading...
                    </div>
                ) : profile ? (
                    <div className="flex flex-col gap-4">
                        <div className="flex items-center gap-3">
                            <div className="grid size-11 shrink-0 place-items-center rounded-full bg-primary/15 text-lg font-medium text-primary">
                                {profile.name.trim().charAt(0).toUpperCase() || "?"}
                            </div>
                            <div className="min-w-0">
                                <p className="flex items-center gap-1.5 font-medium">
                                    <span className="truncate">{profile.name}</span>
                                    {profile.isAdmin ? <Badge variant="neutral">Admin</Badge> : null}
                                    {profile.banned ? <Badge variant="danger">Banned</Badge> : null}
                                </p>
                                {profile.email ? (
                                    <p className="truncate text-sm text-muted-foreground">{profile.email}</p>
                                ) : null}
                            </div>
                        </div>
                        {profile.banned && profile.banReason ? (
                            <p className="text-sm text-muted-foreground">Reason: {profile.banReason}</p>
                        ) : null}
                        {profile.viewerIsAdmin && !profile.self ? (
                            profile.banned ? (
                                <Button variant="secondary" onClick={onUnban} disabled={busy}>
                                    {busy ? "Working..." : "Unban user"}
                                </Button>
                            ) : (
                                <div className="flex flex-col gap-2 rounded-md border border-border p-3">
                                    <label className="flex flex-col gap-1 text-sm">
                                        Ban reason (optional)
                                        <Input
                                            value={reason}
                                            onChange={(event) => setReason(event.target.value)}
                                            placeholder="Why is this account being banned?"
                                        />
                                    </label>
                                    <Button variant="danger" onClick={onBan} disabled={busy}>
                                        <Ban className="size-4" />
                                        {busy ? "Banning..." : "Ban user"}
                                    </Button>
                                </div>
                            )
                        ) : null}
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                    </div>
                ) : error ? (
                    <p className="py-4 text-sm text-danger">{error}</p>
                ) : null}
            </DialogContent>
        </Dialog>
    );
}
