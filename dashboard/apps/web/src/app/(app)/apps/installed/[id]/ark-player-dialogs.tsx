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

import { Button, Input } from "@polaris/ui";
import { Loader2, UserSearch } from "lucide-react";
import { useState, useTransition } from "react";
import { isSteamId } from "@/lib/apps/ark/access";
import type { ArkAllowedPlayer } from "@/lib/apps/ark/access";
import { PlayerFormDialog, PlayerFormField } from "@/components/player-form-dialog";

/** What the id has to look like, said the way it is refused. */
const STEAM_ID_HINT = "17 digits, starting 7656119. In Steam: Profile, then the number at the end of the URL.";

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
     *  linked. Absent on a screen where nobody may look people up. */
    onLookUp?: (query: string) => Promise<{ steamId?: string; name?: string; error?: string }>;
}) {
    const editing = player !== null;
    const [steamId, setSteamId] = useState(player?.steamId ?? "");
    // The label falls back to the id itself when nobody gave one, and showing that
    // back as the name to edit would have somebody "renaming" a player to the
    // number they already are.
    const [label, setLabel] = useState(player && player.label !== player.steamId ? player.label : "");

    const [person, setPerson] = useState("");
    const [lookUpError, setLookUpError] = useState<string | null>(null);
    const [looking, startLooking] = useTransition();

    const trimmed = steamId.trim();
    const invalid = trimmed.length > 0 && !isSteamId(trimmed);

    /** Fill both fields in from a Polaris account, so the id is never retyped by
     *  hand from a chat message. */
    function lookUp(): void {
        if (!onLookUp || person.trim().length === 0) return;
        setLookUpError(null);
        startLooking(async () => {
            const found = await onLookUp(person.trim());
            if (found.error || !found.steamId) {
                setLookUpError(found.error ?? "Could not look that up");
                return;
            }
            setSteamId(found.steamId);
            if (found.name) setLabel(found.name);
            setPerson("");
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
                    hint="Their username or email address. If they have linked Steam, their id fills itself in."
                >
                    <div className="flex items-center gap-1">
                        <Input
                            autoFocus
                            value={person}
                            onChange={(event) => setPerson(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key !== "Enter") return;
                                event.preventDefault();
                                lookUp();
                            }}
                            placeholder="pau, or pau@example.com"
                            aria-label="Polaris username or email address"
                        />
                        <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            onClick={lookUp}
                            disabled={looking || person.trim().length === 0}
                            aria-label="Find their Steam account"
                            title="Find their Steam account"
                        >
                            {looking ? <Loader2 className="size-4 animate-spin" /> : <UserSearch className="size-4" />}
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
            <PlayerFormField label="Name" hint="What to call them in the list. Only Polaris sees it.">
                <Input
                    autoFocus={editing}
                    value={label}
                    onChange={(event) => setLabel(event.target.value)}
                    placeholder="Who this is"
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
