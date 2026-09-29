"use client";

/**
 * Profile popover for a user reached from the activity feed. Shows the name and,
 * for admins, the email and ban controls. Loads the profile on open through the
 * server action, which decides what a given viewer may see.
 */

import { useEffect, useState } from "react";
import { Ban, Loader2 } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { PersonName } from "@/components/person-name";
import {
    Badge,
    Button,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    Input
} from "@polaris/ui";
import {
    banUserAction,
    getUserProfileAction,
    unbanUserAction,
    type UserProfile
} from "@/app/(app)/drive/activity-actions";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function UserProfileDialog({
    userId,
    onOpenChange
}: {
    userId: string | null;
    onOpenChange: (open: boolean) => void;
}) {
    const t = useTranslations("components");
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
                    <DialogTitle>{t("userProfile.title")}</DialogTitle>
                </DialogHeader>
                {loading ? (
                    <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" /> {t("userProfile.loading")}
                    </div>
                ) : profile ? (
                    <div className="flex flex-col gap-4">
                        <div className="flex items-center gap-3">
                            <Avatar
                                openable
                                decorated
                                person={{ id: userId ?? "", name: profile.name }}
                                size={44}
                            />
                            <div className="min-w-0">
                                <p className="flex items-center gap-1.5 font-medium">
                                    <span className="truncate">
                                        <PersonName id={userId} name={profile.name} />
                                    </span>
                                    {profile.isAdmin ? (
                                        <Badge variant="neutral">{t("userProfile.admin")}</Badge>
                                    ) : null}
                                    {profile.banned ? <Badge variant="danger">{t("userProfile.banned")}</Badge> : null}
                                </p>
                                {profile.email ? (
                                    <p className="truncate text-sm text-muted-foreground">
                                        {profile.email}
                                    </p>
                                ) : null}
                            </div>
                        </div>
                        {profile.banned && profile.banReason ? (
                            <p className="text-sm text-muted-foreground">
                                {t("userProfile.reason", { reason: profile.banReason })}
                            </p>
                        ) : null}
                        {profile.viewerIsAdmin && !profile.self ? (
                            profile.banned ? (
                                <Button variant="secondary" onClick={onUnban} disabled={busy}>
                                    {busy ? t("userProfile.working") : t("userProfile.unban")}
                                </Button>
                            ) : (
                                <div className="flex flex-col gap-2 rounded-md border border-border p-3">
                                    <label className="flex flex-col gap-1 text-sm">
                                        {t("userProfile.banReason")}
                                        <Input
                                            value={reason}
                                            onChange={(event) => setReason(event.target.value)}
                                            placeholder={t("userProfile.banPlaceholder")}
                                        />
                                    </label>
                                    <Button variant="danger" onClick={onBan} disabled={busy}>
                                        <Ban className="size-4" />
                                        {busy ? t("userProfile.banning") : t("userProfile.ban")}
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
