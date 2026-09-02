"use client";

/**
 * Where the things people upload are kept: the files they attach to their work,
 * and the photos they put on their profile.
 *
 * Two separate choices rather than one, because they are not the same kind of
 * file. An attachment can be a phone video and is read once; a profile photo
 * weighs nothing and is read on every screen, so an instance may reasonably want
 * the photos on its own disk and the attachments on the NAS.
 */

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { runAction } from "@/lib/run-action";
import type { FootageSettings } from "@/lib/home/stills";
import type { AvatarSettings } from "@/lib/avatar-service";
import { ResolvedTarget, TargetPicker } from "./target-picker";
import type { ChatStorageSettings } from "@/lib/chat/attachments";
import type { PersonalDriveSettings } from "@/lib/personal-drive";
import type { OrganizationDriveSettings } from "@/lib/organization-drive";
import type { UploadSettings } from "@/lib/tasks/attachment-service";
import { Button, Card, CardBody, ConfirmDeleteDialog, Input, Switch, cn } from "@polaris/ui";
import {
    checkStorageAction,
    setAvatarSettingsAction,
    setChatStorageTargetAction,
    setFootageTargetAction,
    setOrganizationDriveTargetAction,
    setPersonalDriveTargetAction,
    setUploadSettingsAction,
    tidyChatStorageAction,
    type StorageCheck
} from "./actions";

/** Megabytes are what people think in; the setting is stored in bytes. */
function toMegabytes(bytes: number): number {
    return Math.round(bytes / (1024 * 1024));
}

/**
 * Prove it works, rather than that it saved.
 *
 * Storage that takes a file and will not give it back looks exactly like storage
 * that works, right up until somebody opens a message from last week and gets
 * nothing. This writes a small file, reads it back and removes it - the same
 * three calls an upload and a download make - and says what happened.
 */
function CheckButton({ which }: { which: StorageCheck }) {
    const [busy, setBusy] = useState(false);
    const [said, setSaid] = useState<{ ok: boolean; detail: string; where: string } | null>(null);

    return (
        <div className="flex flex-col gap-1.5">
            <div>
                <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={async () => {
                        setBusy(true);
                        setSaid(null);
                        const result = await runAction(
                            () => checkStorageAction(which),
                            () => undefined
                        );
                        setBusy(false);
                        setSaid(
                            result ?? {
                                ok: false,
                                detail: "That check could not be run.",
                                where: ""
                            }
                        );
                    }}
                >
                    {busy && <Loader2 className="size-4 animate-spin" />}
                    Check it works
                </Button>
            </div>
            {said && (
                <p className={cn("text-xs", said.ok ? "text-muted-foreground" : "text-danger")}>
                    {said.where ? `${said.where}: ` : ""}
                    {said.detail}
                </p>
            )}
        </div>
    );
}

/**
 * Take out the folders no conversation answers for.
 *
 * Only on the chat card, because that is the storage that grew them: a
 * conversation deleted by an older build left its whole folder behind, and a
 * message deleted one at a time left an empty one named after a uuid. Nothing
 * else will ever remove either, and neither is reachable from anywhere in
 * Polaris.
 *
 * Asked first, because what it does is a recursive delete on somebody's disk and
 * a press is not a decision. It runs against every storage the instance has ever
 * written chat files to - a NAS share other people may also be using among them -
 * and nothing puts back what it takes.
 *
 * What could not be removed is said as plainly as what was. A run where half the
 * folders refused and the line only counted the other half reads as a clean
 * sweep, which is how a full disk stays full.
 */
function TidyButton() {
    const [asking, setAsking] = useState(false);
    const [busy, setBusy] = useState(false);
    const [said, setSaid] = useState<{ detail: string; failed: boolean } | null>(null);

    const tidy = async () => {
        setBusy(true);
        setSaid(null);
        const result = await runAction(
            () => tidyChatStorageAction(),
            () => undefined
        );
        setBusy(false);
        setAsking(false);
        if (!result || result.error) {
            setSaid({ detail: result?.error ?? "That could not be run.", failed: true });
            return;
        }
        const removed = result.removed ?? 0;
        const failed = result.failed ?? 0;
        const took =
            removed === 0
                ? "Nothing to take out."
                : `Took out ${removed} folder${removed === 1 ? "" : "s"}.`;
        setSaid({
            detail:
                failed === 0
                    ? took
                    : `${took} ${failed} could not be removed - the storage refused, or it is not answering.`,
            failed: failed > 0
        });
    };

    return (
        <div className="flex flex-col gap-1.5">
            <div>
                <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    title="Removes folders for conversations that no longer exist, and empty ones."
                    onClick={() => {
                        setSaid(null);
                        setAsking(true);
                    }}
                >
                    {busy && <Loader2 className="size-4 animate-spin" />}
                    Tidy up
                </Button>
            </div>
            {said && (
                <p className={cn("text-xs", said.failed ? "text-danger" : "text-muted-foreground")}>
                    {said.detail}
                </p>
            )}

            <ConfirmDeleteDialog
                open={asking}
                onOpenChange={(open) => !busy && setAsking(open)}
                requireTyping={false}
                name="chat storage"
                kind="folders"
                title="Tidy the chat storage"
                confirmLabel="Tidy up"
                pending={busy}
                description={
                    <>
                        Deletes every folder under the chat root whose conversation no longer
                        exists, with everything inside it, and any folder left empty. The files do
                        not come back.
                    </>
                }
                question="Tidy every storage this instance has written chat files to?"
                onConfirm={() => void tidy()}
            />
        </div>
    );
}

/** The Save row every card ends with, including what it says afterwards. */
function SaveRow({
    dirty,
    valid,
    saving,
    saved,
    error,
    onSave
}: {
    dirty: boolean;
    valid: boolean;
    saving: boolean;
    saved: boolean;
    error: string;
    onSave: () => void;
}) {
    return (
        <>
            {error && <p className="text-sm text-danger">{error}</p>}
            <div className="flex items-center gap-3">
                <Button onClick={onSave} disabled={!dirty || !valid || saving}>
                    {saving && <Loader2 className="size-4 animate-spin" />}
                    Save
                </Button>
                {saved && !dirty && <span className="text-xs text-muted-foreground">Saved.</span>}
            </div>
        </>
    );
}

function AttachmentsCard({ settings }: { settings: UploadSettings }) {
    const [target, setTarget] = useState(settings.choice);
    const [megabytes, setMegabytes] = useState(String(toMegabytes(settings.maxBytes)));
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState("");

    const limit = Number(megabytes);
    const limitValid = Number.isFinite(limit) && limit >= 1 && limit <= 10240;
    const dirty = target !== settings.choice || toMegabytes(settings.maxBytes) !== limit;

    const save = async () => {
        if (!limitValid || saving) return;
        setSaving(true);
        setError("");
        const result = await runAction(
            () => setUploadSettingsAction({ target, maxBytes: limit * 1024 * 1024 }),
            setError
        );
        setSaving(false);
        if (result?.error) {
            setError(result.error);
            return;
        }
        setSaved(true);
    };

    return (
        <Card>
            <CardBody className="flex flex-col gap-4 p-4">
                <div>
                    <h2 className="text-sm font-medium">Files attached to work</h2>
                    <p className="text-xs text-muted-foreground">
                        Screenshots, recordings and documents people staple to a task.
                    </p>
                </div>

                <ResolvedTarget
                    resolved={settings.resolved}
                    automatic="Worked out from what this instance has connected. Connect a NAS and new files follow it."
                />

                <TargetPicker
                    label="Where to keep them"
                    hint="Files already attached stay where they were written; this decides where the next ones go."
                    value={target}
                    options={settings.options}
                    resolvedName={settings.resolved.name}
                    onChange={(value) => {
                        setTarget(value);
                        setSaved(false);
                    }}
                />

                <label className="flex flex-col gap-1.5">
                    <span className="text-sm font-medium">Biggest single file</span>
                    <div className="flex items-center gap-2">
                        <Input
                            type="number"
                            min={1}
                            max={10240}
                            value={megabytes}
                            aria-label="Upload limit in megabytes"
                            onChange={(event) => {
                                setMegabytes(event.target.value);
                                setSaved(false);
                            }}
                            className={cn("w-28", !limitValid && "border-danger/50")}
                        />
                        <span className="text-sm text-muted-foreground">MB</span>
                    </div>
                    {!limitValid && (
                        <span className="text-xs text-danger">Between 1 and 10240 MB.</span>
                    )}
                </label>

                <CheckButton which="tasks" />
                <SaveRow
                    dirty={dirty}
                    valid={limitValid}
                    saving={saving}
                    saved={saved}
                    error={error}
                    onSave={() => void save()}
                />
            </CardBody>
        </Card>
    );
}

function PhotosCard({ settings }: { settings: AvatarSettings }) {
    const [target, setTarget] = useState(settings.choice);
    const [gravatar, setGravatar] = useState(settings.gravatar);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState("");

    const dirty = target !== settings.choice || gravatar !== settings.gravatar;

    const save = async () => {
        if (saving) return;
        setSaving(true);
        setError("");
        const result = await runAction(
            () => setAvatarSettingsAction({ target, gravatar }),
            setError
        );
        setSaving(false);
        if (result?.error) {
            setError(result.error);
            return;
        }
        setSaved(true);
    };

    return (
        <Card>
            <CardBody className="flex flex-col gap-4 p-4">
                <div>
                    <h2 className="text-sm font-medium">Profile photos</h2>
                    <p className="text-xs text-muted-foreground">
                        The picture on somebody&rsquo;s account. Capped at 2 MB and squared by the
                        browser before it is sent, so these stay small wherever they go.
                    </p>
                </div>

                <ResolvedTarget
                    resolved={settings.resolved}
                    automatic="Worked out from what this instance has connected. Connect a NAS and new photos follow it."
                />

                <TargetPicker
                    label="Where to keep them"
                    hint="Photos already uploaded stay where they were written; this decides where the next ones go."
                    value={target}
                    options={settings.options}
                    resolvedName={settings.resolved.name}
                    onChange={(value) => {
                        setTarget(value);
                        setSaved(false);
                    }}
                />

                <label className="flex items-start justify-between gap-4">
                    <span className="flex flex-col gap-0.5">
                        <span className="text-sm font-medium">Use Gravatar</span>
                        <span className="text-xs text-muted-foreground">
                            For accounts with no photo of their own, show the one their email
                            address has on Gravatar. Polaris asks for it, not the browser, so no
                            address leaves this server and nobody is told who is looking. Off means
                            initials until somebody uploads a photo.
                        </span>
                    </span>
                    <Switch
                        checked={gravatar}
                        aria-label="Use Gravatar"
                        onChange={(value) => {
                            setGravatar(value);
                            setSaved(false);
                        }}
                    />
                </label>

                <CheckButton which="avatars" />
                <SaveRow
                    dirty={dirty}
                    valid
                    saving={saving}
                    saved={saved}
                    error={error}
                    onSave={() => void save()}
                />
            </CardBody>
        </Card>
    );
}

/**
 * Where people's own drives are kept.
 *
 * First on this screen because it is the biggest thing the instance will ever
 * hold: everything else here is what somebody attached to something, and this is
 * everything they have. Changing it points the drives made from now on at the
 * new disk and moves nothing - a drive records where its files actually are when
 * it is made, so somebody who has been using Polaris for a year keeps opening
 * theirs where it is.
 */
function DrivesCard({ settings }: { settings: PersonalDriveSettings }) {
    const initial = settings.choice;
    const [target, setTarget] = useState(initial);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState("");

    const dirty = target !== initial;
    const made = settings.existing.reduce((total, row) => total + row.count, 0);
    // Only worth saying when it would surprise: drives already sitting somewhere
    // other than where this setting now points.
    const elsewhere = settings.existing.filter((row) => row.targetId !== settings.resolved.id);

    const save = async () => {
        if (saving) return;
        setSaving(true);
        setError("");
        const result = await runAction(() => setPersonalDriveTargetAction({ target }), setError);
        setSaving(false);
        if (result?.error) {
            setError(result.error);
            return;
        }
        setSaved(true);
    };

    return (
        <Card>
            <CardBody className="flex flex-col gap-4 p-4">
                <div>
                    <h2 className="text-sm font-medium">People&apos;s own drives</h2>
                    <p className="text-xs text-muted-foreground">
                        Everybody gets a private folder of their own in Drive, made the first time
                        they open it. What it can hold is whatever is free on the disk it is on.
                    </p>
                </div>

                <ResolvedTarget
                    resolved={settings.resolved}
                    automatic="Worked out from what this instance has connected. Connect a NAS and new drives follow it."
                />

                <TargetPicker
                    label="Where to keep them"
                    hint="Drives that already exist stay on the disk they were made on; this decides where the next ones go."
                    value={target}
                    options={settings.options}
                    resolvedName={settings.resolved.name}
                    onChange={(value) => {
                        setTarget(value);
                        setSaved(false);
                    }}
                />

                {made > 0 && (
                    <p className="text-xs text-muted-foreground">
                        {made === 1 ? "One drive has been made" : `${made} drives have been made`}
                        {elsewhere.length > 0
                            ? `, ${elsewhere.reduce((total, row) => total + row.count, 0)} of them on a different disk from the one above.`
                            : "."}
                    </p>
                )}

                <div>
                    <CheckButton which="drive" />
                </div>
                <SaveRow
                    dirty={dirty}
                    valid
                    saving={saving}
                    saved={saved}
                    error={error}
                    onSave={() => void save()}
                />
            </CardBody>
        </Card>
    );
}

function ChatCard({ settings }: { settings: ChatStorageSettings }) {
    const initial = settings.choice;
    const [target, setTarget] = useState(initial);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState("");

    const dirty = target !== initial;

    const save = async () => {
        if (saving) return;
        setSaving(true);
        setError("");
        const result = await runAction(() => setChatStorageTargetAction({ target }), setError);
        setSaving(false);
        if (result?.error) {
            setError(result.error);
            return;
        }
        setSaved(true);
    };

    return (
        <Card>
            <CardBody className="flex flex-col gap-4 p-4">
                <div>
                    <h2 className="text-sm font-medium">Files sent in chat</h2>
                    <p className="text-xs text-muted-foreground">
                        Screenshots and documents people put on a message. Capped at 25 MB each -
                        anything bigger belongs in Drive, with a link to it in the conversation.
                    </p>
                </div>

                <ResolvedTarget
                    resolved={settings.resolved}
                    automatic="Worked out from what this instance has connected. Connect a NAS and new files follow it."
                />

                <TargetPicker
                    label="Where to keep them"
                    hint="Files already sent stay where they were written; this decides where the next ones go."
                    value={target}
                    options={settings.options}
                    resolvedName={settings.resolved.name}
                    onChange={(value) => {
                        setTarget(value);
                        setSaved(false);
                    }}
                />

                <div className="flex flex-wrap items-start gap-2">
                    <CheckButton which="chat" />
                    <TidyButton />
                </div>
                <SaveRow
                    dirty={dirty}
                    valid
                    saving={saving}
                    saved={saved}
                    error={error}
                    onSave={() => void save()}
                />
            </CardBody>
        </Card>
    );
}

/**
 * Camera footage.
 *
 * Its own card because it is not like the others: it is written by machines
 * rather than by people, it arrives all day, and it is the only kind here that
 * can fill a disk without anybody doing anything. A camera may still be pointed
 * at a disk of its own - that decision lives on the camera - and this is what
 * every camera that has not been is written to.
 */
function FootageCard({ settings }: { settings: FootageSettings }) {
    const initial = settings.choice;
    const [target, setTarget] = useState(initial);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState("");

    const dirty = target !== initial;

    const save = async () => {
        if (saving) return;
        setSaving(true);
        setError("");
        const result = await runAction(() => setFootageTargetAction({ target }), setError);
        setSaving(false);
        if (result?.error) {
            setError(result.error);
            return;
        }
        setSaved(true);
    };

    return (
        <Card>
            <CardBody className="flex flex-col gap-4 p-4">
                <div>
                    <h2 className="text-sm font-medium">Camera footage</h2>
                    <p className="text-xs text-muted-foreground">
                        Recordings and the pictures that go with what the cameras notice. A NAS is
                        the right answer if you have one: this is the only thing here that grows
                        whether or not anybody uses it.
                    </p>
                </div>

                <ResolvedTarget
                    resolved={settings.resolved}
                    automatic="Worked out from what this instance has connected. Connect a NAS and new footage follows it."
                />

                <TargetPicker
                    label="Where to keep it"
                    hint="Footage already recorded stays where it was written. A camera can override this on its own settings."
                    value={target}
                    options={settings.options}
                    resolvedName={settings.resolved.name}
                    onChange={(value) => {
                        setTarget(value);
                        setSaved(false);
                    }}
                />

                <CheckButton which="footage" />
                <SaveRow
                    dirty={dirty}
                    valid
                    saving={saving}
                    saved={saved}
                    error={error}
                    onSave={() => void save()}
                />
            </CardBody>
        </Card>
    );
}

/**
 * Where organizations' shelves are kept.
 *
 * Its own choice rather than the one above, because the two fill up for
 * different reasons: personal drives grow one person at a time, and a company's
 * holds the things everybody there works on. An instance may reasonably want the
 * company's documents on the NAS and everybody's own on the box.
 */
function OrganizationDrivesCard({ settings }: { settings: OrganizationDriveSettings }) {
    const initial = settings.choice;
    const [target, setTarget] = useState(initial);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState("");

    const made = settings.existing.reduce((total, row) => total + row.count, 0);
    const elsewhere = settings.existing.filter((row) => row.targetId !== settings.resolved.id);

    const save = async () => {
        if (saving) return;
        setSaving(true);
        setError("");
        const result = await runAction(
            () => setOrganizationDriveTargetAction({ target }),
            setError
        );
        setSaving(false);
        if (result?.error) {
            setError(result.error);
            return;
        }
        setSaved(true);
    };

    return (
        <Card>
            <CardBody className="flex flex-col gap-4 p-4">
                <div>
                    <h2 className="text-sm font-medium">Organizations&apos; shelves</h2>
                    <p className="text-xs text-muted-foreground">
                        Every organization gets a shelf of its own in Drive, made the first time
                        somebody there opens it. It is where a company keeps what belongs to the
                        company rather than to one person.
                    </p>
                </div>

                <ResolvedTarget
                    resolved={settings.resolved}
                    automatic="Worked out from what this instance has connected. Connect a NAS and new shelves follow it."
                />

                <TargetPicker
                    label="Where to keep them"
                    hint="Shelves that already exist stay on the disk they were made on; this decides where the next ones go."
                    value={target}
                    options={settings.options}
                    resolvedName={settings.resolved.name}
                    onChange={(value) => {
                        setTarget(value);
                        setSaved(false);
                    }}
                />

                {made > 0 && (
                    <p className="text-xs text-muted-foreground">
                        {made === 1 ? "One shelf has been made" : `${made} shelves have been made`}
                        {elsewhere.length > 0
                            ? `, ${elsewhere.reduce((total, row) => total + row.count, 0)} of them on a different disk from the one above.`
                            : "."}
                    </p>
                )}

                <div>
                    <CheckButton which="orgDrive" />
                </div>
                <SaveRow
                    dirty={target !== initial}
                    valid
                    saving={saving}
                    saved={saved}
                    error={error}
                    onSave={() => void save()}
                />
            </CardBody>
        </Card>
    );
}

export function UploadsView({
    uploads,
    avatars,
    chat,
    drives,
    orgDrives,
    footage
}: {
    uploads: UploadSettings;
    avatars: AvatarSettings;
    chat: ChatStorageSettings;
    drives: PersonalDriveSettings;
    orgDrives: OrganizationDriveSettings;
    /** Absent on an instance with no Home installed - there is nothing recording,
     *  so a card about where recordings go would be a setting for a feature that
     *  is not there. */
    footage: FootageSettings | null;
}) {
    return (
        <div className="flex max-w-2xl flex-col gap-4">
            <DrivesCard settings={drives} />
            <OrganizationDrivesCard settings={orgDrives} />
            <AttachmentsCard settings={uploads} />
            <PhotosCard settings={avatars} />
            <ChatCard settings={chat} />
            {footage ? <FootageCard settings={footage} /> : null}
        </div>
    );
}
