"use client";

/**
 * The GitHub account this Polaris account belongs to.
 *
 * It is here rather than under Integrations because it is personal: the operator's
 * GitHub connection is what Polaris acts with, and this is only a statement of who
 * you are. What it buys is that a runner pool can be pointed at "these people's
 * repositories" and mean it - which also means unlinking takes your repositories
 * off whatever machine was serving them, so the card says so before you do it.
 */

import { useRouter } from "next/navigation";
import { unlinkGithubAction } from "./actions";
import { Button, Card, CardBody } from "@polaris/ui";
import { GitHubMark } from "@/components/brand-icons";
import { useEffect, useState, useTransition } from "react";

/** What the round trip to GitHub came back with, as the callback flagged it. */
const OUTCOMES: Record<string, { text: string; bad: boolean }> = {
    linked: { text: "GitHub account linked.", bad: false },
    cancelled: { text: "The authorization was cancelled.", bad: true },
    state_error: { text: "That link request did not come from this page. Start it again.", bad: true },
    taken: { text: "That GitHub account is already linked to another Polaris account.", bad: true },
    unavailable: { text: "This Polaris cannot verify GitHub accounts yet.", bad: true },
    error: { text: "GitHub did not complete the authorization.", bad: true }
};

export interface GithubIdentityCardProps {
    /** The linked account, or null. */
    login: string | null;
    avatarUrl: string | null;
    /** False when the GitHub connection has no OAuth client, which is what
     *  authorizing a person needs (see github-service). */
    canLink: boolean;
}

export function GithubCard({ login, avatarUrl, canLink }: GithubIdentityCardProps) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [confirming, setConfirming] = useState(false);
    const [notice, setNotice] = useState<{ text: string; bad: boolean } | null>(null);
    // Optimistic: the row goes the moment unlinking starts, and comes back if the
    // server refuses.
    const [unlinked, setUnlinked] = useState(false);

    // The callback returns here with ?github=..., which is read once and cleared so
    // a refresh does not keep re-announcing something that happened minutes ago.
    useEffect(() => {
        const outcome = new URLSearchParams(window.location.search).get("github");
        if (!outcome) return;
        setNotice(OUTCOMES[outcome] ?? null);
        const url = new URL(window.location.href);
        url.searchParams.delete("github");
        window.history.replaceState(null, "", url.toString());
    }, []);

    const linked = login !== null && !unlinked;

    function unlink() {
        setConfirming(false);
        setUnlinked(true);
        setNotice(null);
        startTransition(async () => {
            const result = await unlinkGithubAction();
            if (result.error) {
                setUnlinked(false);
                setNotice({ text: result.error, bad: true });
                return;
            }
            router.refresh();
        });
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div>
                    <h2 className="text-sm font-medium">GitHub</h2>
                    <p className="text-xs text-muted-foreground">
                        Linking proves which GitHub account is yours, so a runner pool can be told to serve your
                        repositories.
                    </p>
                </div>

                {linked ? (
                    <div className="flex items-center gap-3 rounded-md border border-border/60 px-3 py-2">
                        {avatarUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element -- one remote avatar, no loader needed
                            <img src={avatarUrl} alt="" className="size-6 rounded-full" />
                        ) : (
                            <GitHubMark className="size-5 text-muted-foreground" />
                        )}
                        <span className="min-w-0 flex-1 truncate text-sm">{login}</span>
                        {confirming ? (
                            <>
                                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={pending}>
                                    Cancel
                                </Button>
                                <Button size="sm" onClick={unlink} disabled={pending}>
                                    Unlink
                                </Button>
                            </>
                        ) : (
                            <Button size="sm" variant="ghost" onClick={() => setConfirming(true)} disabled={pending}>
                                Unlink
                            </Button>
                        )}
                    </div>
                ) : canLink ? (
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-sm text-muted-foreground">No GitHub account linked.</span>
                        <Button size="sm" variant="secondary" onClick={() => router.push("/api/integrations/github/link")}>
                            <GitHubMark className="size-4" /> Link GitHub
                        </Button>
                    </div>
                ) : (
                    <p className="text-sm text-muted-foreground">
                        Available once this Polaris is connected to GitHub through a GitHub App. Ask whoever administers
                        it to connect one under Integrations.
                    </p>
                )}

                {confirming ? (
                    <p className="text-xs text-muted-foreground">
                        Unlinking stops any runner pool that serves you from serving your repositories.
                    </p>
                ) : null}

                {notice ? (
                    <p className={`text-sm ${notice.bad ? "text-danger" : "text-success"}`}>{notice.text}</p>
                ) : null}
            </CardBody>
        </Card>
    );
}
