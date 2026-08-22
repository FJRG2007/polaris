"use client";

/**
 * The forms an ARK server's players screen opens.
 *
 * Adding somebody is a form rather than two fields under the table, because it is
 * two values and one of them is a seventeen-digit number nobody types from memory:
 * a row of inputs sitting permanently below the list read as part of the list, and
 * the number went in half-pasted. It is also the same form as editing, which is
 * what makes a name that was typed wrong fixable at all - before this the only way
 * to correct one was to take the player off the server and add them again.
 *
 * The Steam id is the identity: ARK has no username to write a rule against, so an
 * id can be given a better label but never changed into another person.
 */

import * as actions from "./ark-actions";
import { isSteamId } from "@/lib/apps/ark/access";
import { Loader2, Plus, UserSearch, X } from "lucide-react";
import { AccountInput } from "@/components/account-input";
import { useEffect, useState, useTransition } from "react";
import type { ArkAllowedPlayer } from "@/lib/apps/ark/access";
import { PlayerRecordPanel } from "@/components/player-history";
import { ArkItemPicker, loadArkCatalog } from "./ark-item-picker";
import type { PlayerRecord } from "@/lib/apps/games-activity-service";
import { PlayerFormDialog, PlayerFormField } from "@/components/player-form-dialog";
import {
    describeArkGive,
    describeArkStacks,
    MAX_ARK_GIVE,
    MAX_ARK_GIVE_ITEMS,
    MAX_ARK_QUALITY,
    type ArkGiveLine,
    type ArkItem
} from "@/lib/apps/ark/items";
import { MAX_ARK_EXPERIENCE } from "@/lib/apps/ark/experience";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Switch
} from "@polaris/ui";

/** What the id has to look like, said the way it is refused. */
const STEAM_ID_HINT =
    "17 digits, starting 7656119. In Steam: Profile, then the number at the end of the URL.";

export function ArkPlayerDialog({
    player,
    pending,
    error,
    onClose,
    onSave,
    onLookUp
}: {
    /** The row being edited, or null to add somebody. */
    player: Pick<ArkAllowedPlayer, "steamId" | "label"> | null;
    pending: boolean;
    error: string | null;
    onClose: () => void;
    onSave: (input: { steamId: string; label: string }) => void;
    /** Find somebody by their Polaris name and hand back the Steam account they
     *  linked - its id, and the name they play under on it. Absent on a screen
     *  where nobody may look people up. */
    onLookUp?: (
        query: string
    ) => Promise<{ steamId?: string; name?: string; label?: string; error?: string }>;
}) {
    const editing = player !== null;
    const [steamId, setSteamId] = useState(player?.steamId ?? "");
    // The label falls back to the id itself when nobody gave one, and showing that
    // back as the name to edit would have somebody "renaming" a player to the
    // number they already are.
    const [label, setLabel] = useState(
        player && player.label !== player.steamId ? player.label : ""
    );

    const [person, setPerson] = useState("");
    const [lookUpError, setLookUpError] = useState<string | null>(null);
    const [looking, startLooking] = useTransition();

    const trimmed = steamId.trim();
    const invalid = trimmed.length > 0 && !isSteamId(trimmed);

    /** Fill both fields in from a Polaris account, so the id is never retyped by
     *  hand from a chat message. */
    function lookUp(query: string): void {
        const identifier = query.trim();
        if (!onLookUp || identifier.length === 0) return;
        setLookUpError(null);
        startLooking(async () => {
            const found = await onLookUp(identifier);
            if (found.error || !found.steamId) {
                setLookUpError(found.error ?? "Could not look that up");
                return;
            }
            setSteamId(found.steamId);
            // The name on their Steam account, which is what ARK knows them as.
            // Their Polaris name is somebody else's word for the same person and
            // would leave the list disagreeing with the server.
            if (found.label) setLabel(found.label);
        });
    }

    return (
        <PlayerFormDialog
            title={editing ? `Edit ${player.label}` : "Add a player"}
            description={
                editing
                    ? "The name is yours to change. The Steam id is what the server was told, so it stays."
                    : "The server is told as soon as it answers. Adding somebody while it is still installing is fine."
            }
            confirmLabel={editing ? "Save" : "Add player"}
            ready={isSteamId(trimmed)}
            pending={pending}
            error={error}
            onClose={onClose}
            onConfirm={() => onSave({ steamId: trimmed, label: label.trim() })}
        >
            {!editing && onLookUp && (
                <PlayerFormField
                    label="Somebody with a Polaris account"
                    error={lookUpError}
                    hint="If they have linked Steam, their id and the name they play under fill themselves in."
                >
                    <div className="flex items-center gap-1">
                        <AccountInput
                            autoFocus
                            value={person}
                            onValueChange={setPerson}
                            // Choosing somebody off the list is the whole errand,
                            // so it is not also worth a button press. Typing a name
                            // nobody picked still is, which is what Enter and the
                            // button beside it are for.
                            onPick={(account) => lookUp(account.username || account.email)}
                            onEnter={() => lookUp(person)}
                            placeholder="pau, or pau@example.com"
                            aria-label="Polaris username or email address"
                        />
                        <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            onClick={() => lookUp(person)}
                            disabled={looking || person.trim().length === 0}
                            aria-label="Find their Steam account"
                            title="Find their Steam account"
                        >
                            {looking ? (
                                <Loader2 className="size-4 animate-spin" />
                            ) : (
                                <UserSearch className="size-4" />
                            )}
                        </Button>
                    </div>
                </PlayerFormField>
            )}

            <PlayerFormField
                label="Steam id"
                error={invalid ? STEAM_ID_HINT : null}
                hint={editing ? undefined : STEAM_ID_HINT}
            >
                <Input
                    value={steamId}
                    onChange={(event) => setSteamId(event.target.value)}
                    placeholder="76561198000000000"
                    inputMode="numeric"
                    className="font-mono"
                    disabled={editing}
                    aria-label="Steam id"
                />
            </PlayerFormField>
            <PlayerFormField
                label="Name"
                hint="The name they play under on Steam. Only Polaris sees it - the server shows whoever is on."
            >
                <Input
                    autoFocus={editing}
                    value={label}
                    onChange={(event) => setLabel(event.target.value)}
                    placeholder="Their Steam name"
                    maxLength={48}
                    aria-label="Name"
                />
            </PlayerFormField>
        </PlayerFormDialog>
    );
}

/** Say something to one person who is playing. Separate from the broadcast above
 *  the table, which everybody sees. */
export function ArkMessageDialog({
    name,
    pending,
    error,
    onClose,
    onSend
}: {
    name: string;
    pending: boolean;
    error: string | null;
    onClose: () => void;
    onSend: (message: string) => void;
}) {
    const [message, setMessage] = useState("");

    return (
        <PlayerFormDialog
            title={`Message ${name}`}
            description="Appears in their chat, and nobody else's."
            confirmLabel="Send"
            ready={message.trim().length > 0}
            pending={pending}
            error={error}
            onClose={onClose}
            onConfirm={() => onSend(message.trim())}
        >
            <PlayerFormField label="Message">
                <Input
                    autoFocus
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    placeholder="Careful, a raid is coming"
                    maxLength={200}
                    aria-label="Message"
                />
            </PlayerFormField>
        </PlayerFormDialog>
    );
}

/**
 * Hand a player something, or several somethings.
 *
 * ARK gives an operator no way to do this from outside the game: the two commands
 * everybody knows put the item in the inventory of whoever typed them, and over
 * RCON that is nobody. The third names its player - by a number out of their own
 * survivor file, which is what Polaris reads - so this is a give that works with
 * nobody logged in, which is the whole reason the screen has it.
 *
 * Several, because handing somebody a set of gear is one errand: a weapon, the
 * ammunition for it, and something to wear. Giving one thing closed the form, so
 * the second and the third meant finding the row again and opening it again, and
 * the fields were back to their defaults each time. Now the form keeps a list and
 * the confirm sends the lot.
 *
 * What it cannot do is confirm. ARK answers a give with silence whether it landed
 * or not, so the dialog says what was sent and to whom, and never that it arrived.
 */
export function ArkGiveDialog({
    name,
    pending,
    error,
    recent,
    onClose,
    onGive
}: {
    name: string;
    pending: boolean;
    error: string | null;
    /** What was handed out on this server lately, for the grid to open on. */
    recent?: readonly string[];
    onClose: () => void;
    onGive: (lines: readonly ArkGiveLine[]) => void;
}) {
    const [picked, setPicked] = useState<string | null>(null);
    const [query, setQuery] = useState("");
    const [quantity, setQuantity] = useState(1);
    const [quality, setQuality] = useState(0);
    const [blueprint, setBlueprint] = useState(false);
    const [items, setItems] = useState<readonly ArkItem[]>([]);
    /** What has been put on the list so far. The fields above are the line being
     *  written; this is the ones already written down. */
    const [queued, setQueued] = useState<readonly ArkGiveLine[]>([]);

    useEffect(() => {
        let live = true;
        void loadArkCatalog().then(
            (loaded) => live && setItems(loaded),
            () => undefined
        );
        return () => {
            live = false;
        };
    }, []);

    const item = picked === null ? undefined : items.find((entry) => entry.id === picked);
    // One to a stack is what every piece of gear in the game is, and gear is
    // exactly what has a quality and a blueprint. Anything that stacks has
    // neither, and the game ignores both arguments for it - so the two fields are
    // only drawn where they mean something.
    const gear = item !== undefined && item.stack === 1;
    const split = item ? describeArkStacks(item.stack, quantity) : null;
    /** The line the fields are describing right now, if they describe one. */
    const writing: ArkGiveLine | null =
        picked === null
            ? null
            : { key: picked, quantity, quality: gear ? quality : 0, blueprint: gear && blueprint };
    // What confirming would send: the list, plus the line still in the fields.
    // Somebody who picks one thing and presses the button never touches the list
    // at all, which is the case this must not make longer.
    const sending = writing ? [...queued, writing] : queued;
    // Measured on what confirming would send rather than on the list, so the line
    // still in the fields cannot be the one that takes the errand over the cap.
    const full = sending.length >= MAX_ARK_GIVE_ITEMS;

    /** Put the line in the fields on the list and clear them for the next one. */
    function addAnother(): void {
        if (!writing || full) return;
        setQueued((was) => [...was, writing]);
        setPicked(null);
        setQuantity(1);
        setQuality(0);
        setBlueprint(false);
    }

    /** What one queued line is called, for its row and for the label that removes
     *  it. Falls back to the class the catalogue keys it by, which is at least
     *  recognisable, for a line whose item the catalogue has since dropped. */
    function describe(line: ArkGiveLine): string {
        return describeArkGive(items.find((entry) => entry.id === line.key)?.label ?? line.key, line);
    }

    return (
        <PlayerFormDialog
            title={`Give ${name} something`}
            description="Goes straight into their inventory. They have to have played on this server before."
            confirmLabel={sending.length > 1 ? `Give them ${sending.length} things` : "Give it to them"}
            ready={sending.length > 0}
            pending={pending}
            error={error}
            onClose={onClose}
            onConfirm={() => sending.length > 0 && onGive(sending)}
        >
            <ArkItemPicker
                value={picked}
                query={query}
                onQueryChange={setQuery}
                onSelect={setPicked}
                {...(recent ? { recent } : {})}
            />

            <PlayerFormField
                label="How many"
                hint={
                    (!blueprint && split) ||
                    "Straight into their inventory, wherever they are standing."
                }
            >
                <Input
                    type="number"
                    min={1}
                    max={MAX_ARK_GIVE}
                    value={quantity}
                    aria-label="How many"
                    className="w-24"
                    onChange={(event) =>
                        setQuantity(Math.max(1, Math.min(MAX_ARK_GIVE, Number(event.target.value) || 1)))
                    }
                />
            </PlayerFormField>

            {gear && (
                <>
                    <PlayerFormField
                        label="Quality"
                        hint="0 is what a survivor crafts with no skill. Higher is better gear, the way a drop from a red crate is."
                    >
                        <Input
                            type="number"
                            min={0}
                            max={MAX_ARK_QUALITY}
                            value={quality}
                            aria-label="Quality"
                            className="w-24"
                            onChange={(event) =>
                                setQuality(
                                    Math.max(0, Math.min(MAX_ARK_QUALITY, Number(event.target.value) || 0))
                                )
                            }
                        />
                    </PlayerFormField>
                    <label className="flex items-center justify-between gap-3 text-sm">
                        <span>
                            The blueprint instead
                            <span className="block text-xs text-muted-foreground">
                                They craft it themselves, with the materials it costs.
                            </span>
                        </span>
                        <Switch checked={blueprint} onChange={setBlueprint} aria-label="The blueprint instead" />
                    </label>
                </>
            )}

            {/* The second half of the form: what is already on the list. A give
                that is one thing never touches any of this - the button is what
                somebody presses when the errand turns out to be four things. */}
            <div className="flex flex-col gap-2">
                <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={writing === null || full || pending}
                    onClick={addAnother}
                >
                    <Plus className="size-4" />
                    Add another
                </Button>
                {full && (
                    <p className="text-xs text-muted-foreground">
                        {MAX_ARK_GIVE_ITEMS} things is as much as one give carries. Send these and open it again.
                    </p>
                )}
                {queued.length > 0 && (
                    <ul className="flex max-h-32 flex-col gap-1 overflow-y-auto">
                        {queued.map((line, index) => (
                            <li
                                key={`${line.key}-${index}`}
                                className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs"
                            >
                                <span className="truncate" title={describe(line)}>
                                    {describe(line)}
                                </span>
                                <button
                                    type="button"
                                    disabled={pending}
                                    title={`Take ${describe(line)} off the list`}
                                    aria-label={`Take ${describe(line)} off the list`}
                                    className="shrink-0 text-muted-foreground transition-colors hover:text-danger"
                                    onClick={() => setQueued((was) => was.filter((_, at) => at !== index))}
                                >
                                    <X className="size-3.5" />
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </PlayerFormDialog>
    );
}

/**
 * Hand a player experience.
 *
 * Only handing it over, because that is the only verb ARK has: there is no
 * command that takes experience away and none that sets it, and a negative amount
 * is ignored rather than subtracted. Said out loud in the form rather than left
 * as two options that quietly do nothing.
 */
export function ArkExperienceDialog({
    name,
    pending,
    error,
    onClose,
    onGive
}: {
    name: string;
    pending: boolean;
    error: string | null;
    onClose: () => void;
    onGive: (amount: number) => void;
}) {
    const [amount, setAmount] = useState(1000);

    return (
        <PlayerFormDialog
            title={`Give ${name} experience`}
            description="Goes to their survivor, not to their tribe."
            confirmLabel="Give it"
            ready={amount >= 1}
            pending={pending}
            error={error}
            onClose={onClose}
            onConfirm={() => onGive(amount)}
        >
            <PlayerFormField
                label="How much"
                hint="ARK can only hand experience over: it has no command that takes it away or sets a level."
            >
                <Input
                    autoFocus
                    type="number"
                    min={1}
                    max={MAX_ARK_EXPERIENCE}
                    value={amount}
                    aria-label="How much"
                    className="w-32"
                    onChange={(event) =>
                        setAmount(Math.max(1, Math.min(MAX_ARK_EXPERIENCE, Number(event.target.value) || 1)))
                    }
                />
            </PlayerFormField>
        </PlayerFormDialog>
    );
}

/**
 * How much somebody has played on this server, and when they were last on.
 *
 * ARK never had this. It could say who was connected at that second and nothing
 * else - no last seen, no playtime, no sense of whether a name on the list is a
 * regular or somebody who joined once in March. The record behind this is not read
 * out of the game, which prints nothing worth parsing: Polaris asks who is on once
 * a minute and writes down what changed, so the same rule that gives Minecraft its
 * history gives ARK one too.
 */
export function ArkHistoryDialog({
    installedAppId,
    player,
    steamId,
    onClose
}: {
    installedAppId: string;
    player: string;
    /** Who the visits belong to. The name is only what they were called at the
     *  time: a survivor can be renamed, and the list holds a different name again. */
    steamId: string;
    onClose: () => void;
}) {
    const [record, setRecord] = useState<PlayerRecord | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let live = true;
        void actions.readArkPlayerRecordAction(installedAppId, player, steamId).then((answer) => {
            if (!live) return;
            setRecord(answer.record ?? null);
            setLoading(false);
        });
        return () => {
            live = false;
        };
    }, [installedAppId, player, steamId]);

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{player} on this server</DialogTitle>
                    <DialogDescription>
                        Counted from the moment Polaris started watching this server.
                    </DialogDescription>
                </DialogHeader>
                <PlayerRecordPanel record={record} loading={loading} />
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        Close
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
