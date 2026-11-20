import type * as core from "@polaris/core";
import { posterFor } from "./video-poster";
import { measureMedia } from "./media-measure";
import type { RecordedSound } from "./voice-recorder";
import { writeMediaShape } from "@/lib/chat/media-shape";
import type { KeptPick } from "@/components/file-picker/as-files";
import { sendFile, type Sent } from "@/components/transfers/move-file";
import { viewOnceText, type ViewOnceChoice } from "@/lib/chat/view-once-choice";
import { withoutFiles, type SendOutcome, type SendProgress, type SendTrack } from "./outgoing";

/** Take a staged file back off the storage, for a send that failed after some of
 *  its files had already gone up. Best effort: the sweep is behind it. */
export async function discardUpload(channelId: string, id: string): Promise<void> {
    if (!id) return;
    await fetch(`/api/chat/channels/${channelId}/uploads?id=${encodeURIComponent(id)}`, {
        method: "DELETE"
    }).catch(() => undefined);
}

/**
 * What the server said about a file it would not take.
 *
 * The upload route answers with a sentence for the sender - "that is bigger than
 * 200 MB", "files cannot be sent here" - and it is the only thing worth showing:
 * the alternative is "that could not be sent" over a refusal that said exactly
 * what to do about it.
 */
function refusal(body: string): string | null {
    if (!body) return null;
    try {
        const parsed: unknown = JSON.parse(body);
        const said = (parsed as { error?: unknown }).error;
        return typeof said === "string" && said ? said : null;
    } catch {
        return null;
    }
}

/**
 * Why one file did not go, in the sender's language.
 *
 * The server's own sentence when it wrote one - it names the storage, the
 * limit, the rule - and otherwise what this tab saw happen: the connection
 * dropped, or every byte went and no answer ever came back.
 */
export function notUploadedSaid(
    sent: Sent,
    words: { readonly noAnswer: string; readonly dropped: string; readonly notSent: string }
): string {
    const said = refusal(sent.body);
    if (said) return said;
    if (sent.problem === "noAnswer") return words.noAnswer;
    if (sent.problem === "dropped") return words.dropped;
    return words.notSent;
}

/** A message with files, as one conversation's box hands it over. */
export interface FilesMessage {
    readonly channelId: string;
    readonly body: string;
    readonly files: readonly File[];
    readonly sounds?: readonly RecordedSound[];
    readonly spoilers?: readonly number[];
    readonly fromDrive?: readonly KeptPick[];
    readonly viewOnce?: readonly ViewOnceChoice[];
    readonly translation?: core.ChatSentTranslation;
    readonly report?: (progress: SendProgress) => void;
    readonly track?: SendTrack;
    /** What the message answers: `replyToId` in a conversation, `parentId` in a thread. */
    readonly fields?: Readonly<Record<string, string>>;
    /** Why one file did not go, in the sender's language. */
    readonly notUploaded: (sent: Sent, name: string) => string;
    /** The sentence for a message the server turned down without saying why. */
    readonly notSent: string;
    /** Called once every file is up, right before the message itself is posted. */
    readonly beforePost?: () => void;
}

/**
 * Send a message with files.
 *
 * The files go first, one request each, streamed straight to the storage -
 * see `components/transfers`. The message that follows names what was written
 * rather than carrying it, which is what lets a file be measured in gigabytes
 * instead of in what one request may hold. Answers "sent" when the message
 * landed, and otherwise what the box shows on it.
 */
export async function sendWithFiles(message: FilesMessage): Promise<"sent" | Exclude<SendOutcome, void>> {
    const { channelId, body, files, track, report, notUploaded } = message;
    const spoilers = message.spoilers ?? [];
    const sounds = message.sounds ?? [];
    const viewOnce = message.viewOnce ?? [];
    const fromDrive = message.fromDrive ?? [];
    // What an earlier try already put on the server, by file index.
    const staged: (string | null)[] = files.map((_, at) => track?.staged[at] ?? null);
    // A message sent to be seen once is a few kilobytes of text and rides
    // the message itself, where the server reads it before keeping it.
    const inForm =
        files.length === 1 && viewOnce.length === 1 && viewOnceText(files[0]!.type) ? files[0]! : null;
    // The still and the shape of each picture or video are worked out
    // while the bytes go, not before: nothing waits on them.
    const stills = files.map((file) => posterFor(file).catch(() => null));
    const shapes = files.map((file, at) =>
        stills[at]!.then((still) => measureMedia(file, still)).catch(() => null)
    );
    let failure: { sent: Sent; name: string } | null = null;
    // The files the sender tapped the ring of while they were going.
    const stopped = new Set<number>();
    const upload = async (at: number): Promise<void> => {
        const file = files[at]!;
        if (staged[at]) return;
        const query = new URLSearchParams({ name: file.name });
        // Covered is chosen before the upload, because that is when the
        // sender marked it.
        if (spoilers.includes(at)) query.set("spoiler", "1");
        const signal = track?.signal(at);
        track?.onFile(at, { phase: "sending", fraction: 0 });
        const sent = await sendFile(`/api/chat/channels/${channelId}/uploads?${query.toString()}`, file, {
            // The ring on the picture in the conversation is where
            // this one's progress is - see `OutgoingFileState`.
            listed: !track,
            signal,
            onProgress: (moved, total) => {
                report?.({ file: at, files: files.length, moved, total });
                track?.onFile(at, {
                    phase: total > 0 && moved >= total ? "processing" : "sending",
                    fraction: total > 0 ? Math.min(1, moved / total) : 0
                });
            }
        });
        if (!sent.ok && signal?.aborted) {
            stopped.add(at);
            track?.onFile(at, { phase: "cancelled", fraction: 0 });
            return;
        }
        if (!sent.ok) {
            failure ??= { sent, name: file.name };
            track?.onFile(at, { phase: "failed", fraction: 0 });
            return;
        }
        const answer: unknown = JSON.parse(sent.body || "{}");
        const id = String((answer as { id?: unknown }).id ?? "");
        staged[at] = id;
        track?.onStaged(at, id);
        track?.onFile(at, { phase: "sent", fraction: 1 });
    };
    const going = inForm ? [] : files.map((_, at) => at);
    if (track) {
        // Each file on its own, three at a time, the way an album goes:
        // one slow picture does not hold up the rest, and one that fails
        // is retried alone.
        let next = 0;
        await Promise.all(
            Array.from({ length: Math.min(3, going.length) }, async () => {
                while (next < going.length) await upload(going[next++]!);
            })
        );
    } else {
        for (const at of going) {
            await upload(at);
            if (failure) break;
        }
    }
    const failed = failure as { sent: Sent; name: string } | null;
    if (failed) {
        // With a ring on each file, the ones that went up wait on the
        // server and a retry sends only what is missing. Without, nothing
        // is left behind: the files that did go up are taken off the
        // storage rather than waiting for the sweep. Either way the
        // message is not sent without them.
        if (!track) {
            await Promise.all(staged.flatMap((id) => (id ? [discardUpload(channelId, id)] : [])));
        }
        return { error: notUploaded(failed.sent, failed.name), keepStaged: Boolean(track) };
    }
    // Every file was stopped and there is nothing else to carry them.
    if (stopped.size > 0 && stopped.size === files.length && fromDrive.length === 0) {
        return { cancelled: true };
    }
    const left = withoutFiles({ files, hidden: spoilers, sounds, viewOnce, staged }, stopped);
    const uploaded = inForm ? [] : (left.staged ?? []).filter((id): id is string => Boolean(id));
    const keptShapes = await Promise.all(shapes.filter((_, at) => !stopped.has(at)));
    const keptStills = stills.filter((_, at) => !stopped.has(at));

    const form = new FormData();
    form.set("body", body);
    for (const [name, value] of Object.entries(message.fields ?? {})) form.set(name, value);
    if (message.translation) form.set("translation", JSON.stringify(message.translation));
    // Which of them arrive covered, by position. Sent only when there
    // are any, which is nearly never - an empty field on every message
    // in Polaris to say "none" is a field nobody needed.
    if (left.hidden.length > 0) form.set("spoilers", left.hidden.join(","));
    if ((left.viewOnce ?? []).length > 0) form.set("viewOnce", JSON.stringify(left.viewOnce));
    if (uploaded.length > 0) form.set("uploads", JSON.stringify(uploaded));
    if (inForm) form.append("files", inForm);
    // The size and blur of each picture and video, in file order, for
    // every reader to draw it at its final size before it arrives.
    if (keptShapes.some(Boolean)) {
        form.set("media", JSON.stringify(keptShapes.map(writeMediaShape)));
    }
    // A still per video, in the same order as the files that were just
    // uploaded, with an empty one standing in for everything that is not
    // a video - so the two lists line up on the other side without
    // either of them carrying an index. It rides the message because it
    // is kilobytes. Taken here rather than on the server: the bytes are
    // already in this browser, and the alternative is a transcoder on
    // the machine Polaris runs on.
    for (const pending of keptStills) {
        const still = await pending;
        form.append("posters", still ?? new Blob([], { type: "image/jpeg" }));
    }
    // How long each recording is and what it looks like, measured while
    // it was made. Sent as one field in file order rather than one per
    // file, so a message with no recording in it sends nothing.
    if ((left.sounds ?? []).length > 0) form.set("sounds", JSON.stringify(left.sounds));
    // The files that are staying where they are: where to find each one
    // and nothing else. What happens to them - copied into the
    // conversation or pointed at - is the instance's setting, answered on
    // the other side. Nothing about them is read in this browser, which
    // is the whole point: a file in Drive is not downloaded here so it
    // can be uploaded back.
    if (fromDrive.length > 0) {
        form.set("borrowed", JSON.stringify(fromDrive.map((one) => ({ c: one.connectionId, p: one.path }))));
    }
    message.beforePost?.();
    const response = await fetch(`/api/chat/channels/${channelId}/messages`, {
        method: "POST",
        body: form
    }).catch(() => null);
    if (!response?.ok) {
        const answer: unknown = await response?.json().catch(() => null);
        // The files that went up are this message's; a retry stages them
        // again, so these would only wait for the sweep.
        await Promise.all(uploaded.map((id) => discardUpload(channelId, id)));
        return {
            error:
                typeof answer === "object" && answer !== null && "error" in answer
                    ? String((answer as { error: unknown }).error)
                    : message.notSent
        };
    }
    // Which message it became, so the row drawn while it went is the row it
    // lands in - see `landedAs`.
    const stored: unknown = await response.json().catch(() => null);
    const id = typeof stored === "object" && stored !== null ? (stored as { id?: unknown }).id : null;
    if (typeof id === "string" && id) track?.onPosted?.(id);
    return "sent";
}
