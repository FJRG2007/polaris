"use client";

/**
 * Sending a file, and saving one, with something on screen while it happens.
 *
 * Two helpers rather than one because the two directions are genuinely different
 * problems, and both of them have a trap in them.
 *
 * **Sending** cannot use `fetch`. There is no upload-progress event on it - the
 * request body is handed to the browser and nothing comes back until the response
 * does - so a ten-minute upload through `fetch` is ten minutes of a spinner that
 * knows nothing. `XMLHttpRequest` has `upload.onprogress`, which is the whole
 * reason it is still here, and it can be aborted, which is the other.
 *
 * **Saving** is the opposite problem: the browser already has a download manager
 * with a bar in it, and taking that over means reading the whole file into memory
 * to hand back as a blob - which for the files this exists for is the one thing
 * not to do. So a save is handed to the browser, and what Polaris reports is the
 * part the browser cannot see: the wait before the first byte, while the server is
 * opening a share that may be many seconds from answering. That is honest about
 * what it knows, which a percentage would not be.
 */

import { beginTransfer, type TransferHandle } from "./transfer-store";
import {
    downloadStarted,
    forgetDownloadTicket,
    newDownloadTicket
} from "@/lib/download-ticket";

/** What came back, in the shape a caller of `fetch` would expect. */
export interface Sent {
    readonly ok: boolean;
    readonly status: number;
    readonly body: string;
}

/**
 * Put one file somewhere, with a bar.
 *
 * @param url Where it goes. Any method the route takes; PUT is what the streaming
 *   routes use.
 */
export async function sendFile(
    url: string,
    payload: (Blob & { readonly name?: string }) | FormData,
    options: {
        readonly method?: string;
        readonly name?: string;
        readonly headers?: Record<string, string>;
        /** Told as it goes, for a screen that draws its own progress as well. */
        readonly onProgress?: (moved: number, total: number) => void;
    } = {}
): Promise<Sent> {
    // Either shape, because Polaris has both: the streaming routes take one file as
    // the body, and the older ones take a form with a file in it. A form reports
    // progress exactly the same way - it is the request body either way - so there
    // is no reason for the two to have different senders.
    const asForm = payload instanceof FormData ? payload : null;
    const asFile = asForm ? null : (payload as Blob & { readonly name?: string });
    const weight = asForm ? formWeight(asForm) : asFile!.size;
    const name = options.name ?? (asForm ? formName(asForm) : asFile!.name) ?? "file";

    const request = new XMLHttpRequest();
    const transfer = beginTransfer({
        name,
        way: "up",
        total: weight,
        stop: () => request.abort()
    });

    return new Promise<Sent>((resolve) => {
        request.open(options.method ?? (asForm ? "POST" : "PUT"), url, true);
        // A form sets its own content type, boundary and all, and overriding it is
        // how a multipart body arrives unparseable. A single file travels as the
        // body, so its type has to be said here: these routes take one file and
        // nothing else, and there is no form to put a name in.
        if (asFile?.type) request.setRequestHeader("Content-Type", asFile.type);
        for (const [header, value] of Object.entries(options.headers ?? {})) {
            request.setRequestHeader(header, value);
        }

        request.upload.onprogress = (event) => {
            const total = event.lengthComputable ? event.total : weight;
            transfer.moved(event.loaded, total);
            options.onProgress?.(event.loaded, total);
        };
        request.onload = () => {
            const ok = request.status >= 200 && request.status < 300;
            if (ok) transfer.done();
            else transfer.failed(said(request) ?? `${name} was refused`);
            resolve({ ok, status: request.status, body: request.responseText });
        };
        request.onerror = () => {
            // No status and no body: the request never reached anything, which is
            // the network rather than the server.
            transfer.failed(`${name} could not be sent - the connection dropped`);
            resolve({ ok: false, status: 0, body: "" });
        };
        request.onabort = () => {
            transfer.stopped();
            resolve({ ok: false, status: 0, body: "" });
        };
        request.send(payload);
    });
}

/** What a form weighs, which is what its files weigh - the fields beside them are
 *  bytes nobody is waiting on. */
function formWeight(form: FormData): number {
    let total = 0;
    for (const value of form.values()) {
        if (typeof value !== "string") total += value.size;
    }
    return total;
}

/** What to call a form on screen: the file in it, or the first of several. */
function formName(form: FormData): string | undefined {
    const files = [...form.values()].filter(
        (value): value is File => typeof value !== "string" && "name" in value
    );
    if (files.length === 0) return undefined;
    return files.length === 1 ? files[0]!.name : `${files.length} files`;
}

/**
 * Hand a file to the browser to save, and say so while the server gets ready.
 *
 * The browser does the downloading, with its own bar. What this adds is the bit
 * before that: a link pressed on a file that lives on a share is a request that
 * can take a long time to answer, and until it did there was nothing on screen at
 * all. The transfer is marked as waiting, and cleared when the answer starts
 * coming back.
 *
 * Nothing is read here. The address is given to an anchor, which is what keeps a
 * four-gigabyte download out of this tab's memory.
 */
export function saveFile(
    url: string,
    name: string,
    /** `asFile` adds the `download=1` the chat and task routes read to mean "hand
     *  this over rather than draw it inline". Every other route here already
     *  answers with an attachment, and an extra parameter they do not read would
     *  only be noise in a log.
     *
     *  `onStarted` and `onGaveUp` are for a screen with an indicator of its own -
     *  a toolbar button that spins while anything it asked for is still coming -
     *  so there is one ticket and one watcher rather than two that disagree. */
    options: {
        readonly asFile?: boolean;
        readonly onStarted?: () => void;
        readonly onGaveUp?: () => void;
    } = {}
): void {
    const transfer = beginTransfer({ name, way: "down", total: null });
    // The ticket is how a navigation reports back: the response sets a cookie
    // naming it, which can only happen once the server has answered - see
    // `download-ticket`. No second request, and nothing read here.
    const ticket = newDownloadTicket();
    const query = new URLSearchParams();
    if (options.asFile) query.set("download", "1");
    query.set("dl", ticket);
    const address = `${url}${url.includes("?") ? "&" : "?"}${query.toString()}`;

    const anchor = document.createElement("a");
    anchor.href = address;
    anchor.download = name;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    watchHandover(transfer, ticket, options);
}

/** How often the cookie is looked for. Often enough that a file which was ready
 *  anyway never reads as a wait. */
const POLL_MS = 250;

/** When a download that never began is given up on. Something has failed
 *  somewhere this page cannot see, and a bar that never goes away is worse than
 *  one that says so. */
const GIVE_UP_MS = 120_000;

/**
 * Watch for the moment the server starts answering.
 *
 * That is all a page can honestly know about a download the browser owns, and it
 * is the part the browser does not show: the wait before the first byte, while a
 * share is being opened or an archive built. Once it has started, the browser's
 * own indicator takes over and this stops claiming to know anything.
 */
function watchHandover(
    transfer: TransferHandle,
    ticket: string,
    told: { readonly onStarted?: () => void; readonly onGaveUp?: () => void }
): void {
    if (typeof window === "undefined") {
        transfer.done();
        told.onStarted?.();
        return;
    }
    const began = Date.now();
    const timer = window.setInterval(() => {
        if (downloadStarted(ticket)) {
            forgetDownloadTicket(ticket);
            window.clearInterval(timer);
            transfer.done();
            told.onStarted?.();
            return;
        }
        if (Date.now() - began < GIVE_UP_MS) return;
        window.clearInterval(timer);
        told.onGaveUp?.();
        // It may still arrive - this is a page watching a cookie, not the transfer
        // itself - so the sentence says what is known rather than calling it dead.
        transfer.failed("This is taking longer than usual. Your browser will save it if it arrives.");
    }, POLL_MS);
}

/**
 * Read a file out of Polaris into this tab, with a real bar.
 *
 * For the places that need the bytes here rather than on disk - a viewer, a
 * preview, anything that renders what it fetched. The size comes from the
 * response, so a server that does not say one gets a transfer with no percentage
 * rather than a made-up one.
 */
export async function readFile(
    url: string,
    name: string,
    options: { readonly signal?: AbortSignal } = {}
): Promise<Blob | null> {
    const controller = new AbortController();
    const transfer = beginTransfer({ name, way: "down", stop: () => controller.abort() });
    options.signal?.addEventListener("abort", () => controller.abort());

    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok || !response.body) {
            transfer.failed(`${name} could not be read`);
            return null;
        }
        const total = Number(response.headers.get("content-length") ?? "0") || null;
        const reader = response.body.getReader();
        const pieces: Uint8Array[] = [];
        let moved = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            pieces.push(value);
            moved += value.byteLength;
            transfer.moved(moved, total);
        }
        transfer.done();
        return new Blob(pieces as BlobPart[], {
            type: response.headers.get("content-type") ?? "application/octet-stream"
        });
    } catch (error) {
        if (controller.signal.aborted) transfer.stopped();
        else transfer.failed(`${name} could not be read`);
        void error;
        return null;
    }
}

/** What the server said went wrong, when it said anything a reader can use. */
function said(request: XMLHttpRequest): string | null {
    const body = request.responseText?.trim();
    if (!body) return null;
    try {
        const parsed = JSON.parse(body) as { error?: unknown };
        return typeof parsed.error === "string" && parsed.error ? parsed.error : null;
    } catch {
        // A plain-text refusal, which several of the public routes answer with.
        return body.length <= 200 ? body : null;
    }
}
