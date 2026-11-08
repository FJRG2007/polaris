"use client";

/**
 * Play with others, from a game's own page: open a room for that game, join
 * one by its code, or pick one of its public rooms. Only a game whose
 * definition declares rooms is offered this. A room is played on the
 * lobby's page, where its code is shown and more people are invited with the
 * same dialog a lobby uses. Lent to the Games app through the host's client
 * pieces, like the invite dialog, because the Games page cannot reach the
 * server's sessions on its own.
 *
 * The forms are on screen at once; only the list of public rooms waits, and it
 * starts from the last list this tab saw.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, RefreshCw, Users } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { readSnapshot, writeSnapshot } from "@/lib/snapshot-cache";
import { Button, Input, Skeleton, Switch } from "@polaris/ui";
import { normalizeRoomCode, roomCodeSchema, ROOM_CODE_LENGTH } from "@/lib/arcade/room-code";
import {
    createGameRoom,
    joinGameRoom,
    publicGameRooms,
    type PublicRoom,
    type RoomRefusal
} from "@/app/(app)/chat/room-actions";

const LIST_KEY = "arcade.public-rooms.";
const LIST_MAX_AGE_MS = 30 * 1000;

export interface RoomGame {
    readonly id: string;
    readonly name: string;
}

export function GameRooms({ game: { id: game } }: { game: RoomGame }) {
    const t = useTranslations("components");
    const router = useRouter();
    const listKey = `${LIST_KEY}${game}`;
    const [isPublic, setPublic] = useState(false);
    const [code, setCode] = useState("");
    const [busy, setBusy] = useState<"create" | "join" | null>(null);
    const [failed, setFailed] = useState<{ form: "create" | "join"; reason: RoomRefusal } | null>(
        null
    );
    const [rooms, setRooms] = useState<readonly PublicRoom[] | null>(
        () => readSnapshot<readonly PublicRoom[]>(listKey, LIST_MAX_AGE_MS)?.value ?? null
    );
    const [listFailed, setListFailed] = useState<RoomRefusal | "network" | null>(null);
    const [loading, setLoading] = useState(false);

    const load = useCallback(() => {
        setLoading(true);
        setListFailed(null);
        void publicGameRooms({ game })
            .then((answer) => {
                if (!answer.ok) return setListFailed(answer.reason);
                setRooms(answer.rooms);
                writeSnapshot(listKey, answer.rooms);
            })
            .catch(() => setListFailed("network"))
            .finally(() => setLoading(false));
    }, [game, listKey]);
    useEffect(load, [load]);

    const go = (form: "create" | "join", answer: Awaited<ReturnType<typeof createGameRoom>>) => {
        if (answer.ok) router.push(answer.href);
        else setFailed({ form, reason: answer.reason });
    };
    const create = () => {
        if (!game || busy) return;
        setBusy("create");
        setFailed(null);
        void createGameRoom({ game, isPublic })
            .then((answer) => go("create", answer))
            .catch(() => setFailed({ form: "create", reason: "failed" }))
            .finally(() => setBusy(null));
    };

    // Incomplete is not invalid: only a code of the full length that still
    // does not read as one is called wrong.
    const typed = normalizeRoomCode(code);
    const codeReady = roomCodeSchema.safeParse(code).success;
    const codeWrong = typed.length >= ROOM_CODE_LENGTH && !codeReady;
    const join = () => {
        if (!codeReady || busy) return;
        setBusy("join");
        setFailed(null);
        void joinGameRoom({ code })
            .then((answer) => go("join", answer))
            .catch(() => setFailed({ form: "join", reason: "failed" }))
            .finally(() => setBusy(null));
    };

    const refusal = (form: "create" | "join") =>
        failed?.form === form ? (
            <p role="alert" className="text-sm text-destructive">
                {t(`gameRooms.refused.${failed.reason}`)}
            </p>
        ) : null;

    return (
        <div className="flex min-w-0 flex-col gap-4">
            <div className="grid min-w-0 gap-4 md:grid-cols-2">
                <form
                    className="flex min-w-0 flex-col gap-3 rounded-lg border p-4"
                    onSubmit={(event) => {
                        event.preventDefault();
                        create();
                    }}
                >
                    <h3 className="text-sm font-medium">{t("gameRooms.createTitle")}</h3>
                    <label className="flex min-w-0 items-start gap-3 text-sm">
                        <Switch
                            checked={isPublic}
                            onChange={setPublic}
                            aria-label={t("gameRooms.public")}
                        />
                        <span className="min-w-0">
                            <span className="block">{t("gameRooms.public")}</span>
                            <span className="block text-xs text-muted-foreground">
                                {t("gameRooms.publicHint")}
                            </span>
                        </span>
                    </label>
                    {refusal("create")}
                    <Button
                        type="submit"
                        size="sm"
                        className="self-start"
                        disabled={!game || busy !== null}
                    >
                        {busy === "create" ? (
                            <Loader2 className="size-4 animate-spin" aria-hidden />
                        ) : (
                            <Plus className="size-4" aria-hidden />
                        )}
                        {t("gameRooms.create")}
                    </Button>
                </form>
                <form
                    className="flex min-w-0 flex-col gap-3 rounded-lg border p-4"
                    onSubmit={(event) => {
                        event.preventDefault();
                        join();
                    }}
                >
                    <h3 className="text-sm font-medium">{t("gameRooms.joinTitle")}</h3>
                    <Input
                        value={code}
                        onChange={(event) => setCode(event.target.value)}
                        // i18n-ignore: the shape of a room code
                        placeholder="ABCD-2345"
                        aria-label={t("gameRooms.code")}
                        aria-invalid={codeWrong || undefined}
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={16}
                        className="font-mono uppercase tracking-wider"
                    />
                    {codeWrong && (
                        <p className="text-sm text-destructive">{t("gameRooms.codeInvalid")}</p>
                    )}
                    {refusal("join")}
                    <Button
                        type="submit"
                        size="sm"
                        className="self-start"
                        aria-disabled={!codeReady || busy !== null}
                        disabled={busy !== null}
                    >
                        {busy === "join" && <Loader2 className="size-4 animate-spin" aria-hidden />}
                        {t("gameRooms.join")}
                    </Button>
                </form>
            </div>

            <section className="flex min-w-0 flex-col gap-2" aria-labelledby="public-rooms">
                <div className="flex min-w-0 items-center gap-2">
                    <h3 id="public-rooms" className="min-w-0 flex-1 truncate text-sm font-medium">
                        {t("gameRooms.publicRooms")}
                    </h3>
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={load}
                        disabled={loading}
                        aria-label={t("gameRooms.refresh")}
                    >
                        <RefreshCw
                            className={loading ? "size-4 animate-spin" : "size-4"}
                            aria-hidden
                        />
                        <span className="hidden sm:inline">{t("gameRooms.refresh")}</span>
                    </Button>
                </div>
                {listFailed && !rooms ? (
                    <div role="alert" className="flex flex-col items-start gap-2">
                        <p className="text-sm text-muted-foreground">
                            {listFailed === "network"
                                ? t("gameRooms.loadFailed")
                                : t(`gameRooms.refused.${listFailed}`)}
                        </p>
                        <Button size="sm" variant="outline" onClick={load}>
                            {t("gameRooms.retry")}
                        </Button>
                    </div>
                ) : rooms === null ? (
                    <ul className="flex flex-col gap-2" aria-busy>
                        {[0, 1, 2].map((index) => (
                            <li key={index}>
                                <Skeleton className="h-14 w-full" />
                            </li>
                        ))}
                    </ul>
                ) : rooms.length === 0 ? (
                    <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                        {t("gameRooms.empty")}
                    </p>
                ) : (
                    <ul className="flex flex-col divide-y rounded-lg border">
                        {rooms.map((room) => (
                            <li key={room.id} className="flex min-w-0 items-center gap-3 p-3">
                                <Users
                                    className="size-5 shrink-0 text-muted-foreground"
                                    aria-hidden
                                />
                                <div className="min-w-0 flex-1">
                                    <p
                                        className="truncate text-sm font-medium"
                                        title={room.host.name}
                                    >
                                        {room.host.name}
                                    </p>
                                    <p className="truncate text-xs text-muted-foreground">
                                        {t("gameRooms.players", {
                                            count: room.players,
                                            max: room.max
                                        })}
                                    </p>
                                </div>
                                <Button asChild size="sm" variant="outline">
                                    <Link href={room.href} prefetch={false}>
                                        {t("gameRooms.joinRoom")}
                                    </Link>
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </div>
    );
}
