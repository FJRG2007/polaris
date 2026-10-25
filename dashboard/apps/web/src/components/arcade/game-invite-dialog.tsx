"use client";

/**
 * Invite people to play a game: a conversation the reader is in, or people to
 * play with. Sending it opens the game in that conversation's call, posts its
 * card there and tells the people invited; the reader is taken to the call,
 * where the game starts. Lent to the Games app through the host's client
 * pieces, because the Games page cannot reach chat on its own.
 */

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Hash, Loader2, Users, Volume2, X } from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    cn
} from "@polaris/ui";
import { AccountInput } from "@/components/account-input";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    gameInviteTargets,
    inviteToGame,
    type InviteRefusal,
    type InviteTarget
} from "@/app/(app)/chat/activity-card-actions";

/** The most people one invitation picks, the size of a group with the inviter. */
const PEOPLE_MAX = 9;

export function GameInviteDialog({
    game,
    gameName,
    onClose
}: {
    game: string;
    gameName: string;
    onClose: () => void;
}) {
    const t = useTranslations("components");
    const router = useRouter();
    const [targets, setTargets] = useState<readonly InviteTarget[] | null>(null);
    const [search, setSearch] = useState("");
    const [channelId, setChannelId] = useState<string | null>(null);
    const [people, setPeople] = useState<readonly { id: string; name: string }[]>([]);
    const [typed, setTyped] = useState("");
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState<InviteRefusal | null>(null);

    useEffect(() => {
        let live = true;
        void gameInviteTargets()
            .then((found) => live && setTargets(found))
            .catch(() => live && setTargets([]));
        return () => {
            live = false;
        };
    }, []);

    const shown = useMemo(() => {
        const wanted = search.trim().toLowerCase();
        const all = targets ?? [];
        const found = wanted
            ? all.filter((target) => target.name.toLowerCase().includes(wanted))
            : all;
        return found.slice(0, 50);
    }, [targets, search]);

    const ready = channelId !== null || people.length > 0;
    const send = () => {
        if (!ready || busy) return;
        setBusy(true);
        setFailed(null);
        const input = channelId
            ? { game, channelId }
            : { game, userIds: people.map((person) => person.id) };
        void inviteToGame(input)
            .then((answer) => {
                if (answer.ok) {
                    onClose();
                    router.push(answer.href);
                } else setFailed(answer.reason);
            })
            .catch(() => setFailed("call"))
            .finally(() => setBusy(false));
    };

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="flex max-h-[85vh] max-w-md flex-col">
                <DialogHeader>
                    <DialogTitle>{t("gameInvite.title", { game: gameName })}</DialogTitle>
                    <DialogDescription>{t("gameInvite.intro")}</DialogDescription>
                </DialogHeader>

                <div className="flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain">
                    <div className="flex flex-col gap-1.5">
                        <span className="text-sm font-medium">{t("gameInvite.people")}</span>
                        <AccountInput
                            value={typed}
                            onValueChange={setTyped}
                            aria-label={t("gameInvite.people")}
                            placeholder={t("gameInvite.peopleHint")}
                            disabled={people.length >= PEOPLE_MAX}
                            onPick={(account) => {
                                setTyped("");
                                setChannelId(null);
                                setPeople((was) =>
                                    was.some((person) => person.id === account.id) ||
                                    was.length >= PEOPLE_MAX
                                        ? was
                                        : [...was, { id: account.id, name: account.name }]
                                );
                            }}
                        />
                        {people.length > 0 && (
                            <ul className="flex flex-wrap gap-1">
                                {people.map((person) => (
                                    <li key={person.id}>
                                        <span className="flex max-w-52 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
                                            <span className="min-w-0 truncate" title={person.name}>
                                                {person.name}
                                            </span>
                                            <button
                                                type="button"
                                                aria-label={t("gameInvite.remove", {
                                                    name: person.name
                                                })}
                                                title={t("gameInvite.remove", {
                                                    name: person.name
                                                })}
                                                onClick={() =>
                                                    setPeople((was) =>
                                                        was.filter(
                                                            (other) => other.id !== person.id
                                                        )
                                                    )
                                                }
                                                className="shrink-0 rounded-full hover:text-foreground"
                                            >
                                                <X className="size-3" />
                                            </button>
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>

                    <div className="flex min-h-0 flex-col gap-1.5">
                        <span className="text-sm font-medium">{t("gameInvite.conversation")}</span>
                        <Input
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            placeholder={t("gameInvite.search")}
                            aria-label={t("gameInvite.search")}
                        />
                        {targets === null ? (
                            <ul className="flex flex-col gap-1" aria-hidden>
                                {[0, 1, 2].map((row) => (
                                    <li
                                        key={row}
                                        className="h-9 animate-pulse rounded-md bg-muted"
                                    />
                                ))}
                            </ul>
                        ) : shown.length === 0 ? (
                            <p className="text-sm text-muted-foreground">{t("gameInvite.none")}</p>
                        ) : (
                            <ul
                                className="flex flex-col gap-0.5"
                                role="listbox"
                                aria-label={t("gameInvite.conversation")}
                            >
                                {shown.map((target) => {
                                    const Icon =
                                        target.kind === "voice"
                                            ? Volume2
                                            : target.kind === "text"
                                              ? Hash
                                              : Users;
                                    const picked = channelId === target.id;
                                    return (
                                        <li key={target.id} role="option" aria-selected={picked}>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setPeople([]);
                                                    setChannelId(picked ? null : target.id);
                                                }}
                                                className={cn(
                                                    "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
                                                    picked && "bg-primary/10 text-primary"
                                                )}
                                            >
                                                <Icon className="size-4 shrink-0 text-muted-foreground" />
                                                <span
                                                    className="min-w-0 flex-1 truncate"
                                                    title={target.name}
                                                >
                                                    {target.name}
                                                </span>
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </div>
                </div>

                {failed && (
                    <p role="alert" className="text-sm text-danger">
                        {t(`gameInvite.failed.${failed}`)}
                    </p>
                )}
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        {t("gameInvite.cancel")}
                    </Button>
                    <Button onClick={send} disabled={!ready || busy}>
                        {busy && <Loader2 className="size-4 animate-spin" />}
                        {t("gameInvite.send")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
