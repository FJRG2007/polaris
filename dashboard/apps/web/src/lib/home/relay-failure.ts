/**
 * Turning what the relay says into what a person can do about it.
 *
 * Asking the relay for a frame from a camera that will not open answers `200`
 * with an empty body. Not an error - go2rtc did its job and there was no
 * picture at the end of it - and the stream record it keeps carries no error
 * either. The reason exists in exactly one place, go2rtc's own log, and it is a
 * line written for whoever wrote go2rtc: `error="streams: 401 Unauthorized"`.
 *
 * Nobody using Polaris has a container to read that in, and "401" is not a
 * sentence anybody can act on anyway. So the line is matched against the
 * failures that actually happen to cameras and turned into the thing to go and
 * do - which for the commonest one is a switch in the maker's phone app that
 * has nothing to do with Polaris at all.
 *
 * Pure, so every one of these translations is a test rather than something
 * somebody has to reproduce with a camera.
 */

import { redactSource } from "@/lib/home/vendors";

/** How much of the relay's log is worth reading back. Its reason is always the
 *  most recent line about this camera; older ones are a different attempt. */
export const RELAY_LOG_TAIL = 8000;

/** What is said when the relay had nothing to say. Names the two causes that
 *  account for nearly all of these rather than describing the silence. */
export const UNEXPLAINED =
    "The camera accepted the connection and sent no video. On a Tapo that is usually the account refusing it - check Third-Party Compatibility is on in the Tapo app, under Me > Third-Party Services - and on a battery model it can also be the camera going back to sleep.";

/**
 * The failures worth naming, most specific first.
 *
 * Each one is a thing that happens to a real camera and has a different answer,
 * so they are matched in the order that keeps the specific one from being eaten
 * by the general one below it.
 */
const REASONS: readonly { readonly test: RegExp; readonly say: string }[] = [
    {
        // The one this file exists for. A camera that refuses the credential
        // says so the same way whatever is wrong with it, and on TP-Link's own
        // protocol the answer is nearly always the switch rather than the
        // password - which is why the switch is named first.
        test: /\b401\b|unauthorized|auth(entication)? failed|wrong password/i,
        say: "The camera refused the password. On a Tapo that is nearly always Third-Party Compatibility being off: in the Tapo app, Me > Third-Party Services > Third-Party Compatibility. If it is already on, the password is the one for your TP-Link account rather than one set on the camera."
    },
    {
        test: /\b403\b|forbidden/i,
        say: "The camera refused the connection outright. Its account may not be allowed to stream, or another app is holding the one connection it gives."
    },
    {
        test: /\b404\b|not found|no such stream/i,
        say: "The camera has no stream at that address. If it is a make with a stream path, the path is wrong; if it is one that picks by quality, it may publish only its full-size stream."
    },
    {
        test: /i\/o timeout|timeout|deadline exceeded|no route to host|connection refused|dial tcp/i,
        say: "The camera stopped answering partway through. On a battery model that is it going back to sleep; otherwise it is the network between here and it."
    },
    {
        test: /unsupported|unknown codec|no video/i,
        say: "The camera is sending something the relay cannot read. That is usually a codec this relay does not carry yet."
    }
];

/**
 * Why the last attempt failed, from the relay's log, or null when its log says
 * nothing about a failure.
 *
 * Only the tail is read and only the last matching line counts: a camera that
 * failed an hour ago for another reason must not be reported as the reason it
 * failed just now.
 */
export function explainRelayFailure(log: string): string | null {
    const lines = log.split(/\r?\n/).filter((line) => /err|error/i.test(line));
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]!;
        for (const reason of REASONS) {
            if (reason.test.test(line)) return reason.say;
        }
    }
    return null;
}

/** The relay's own words, for a failure none of the above recognises. Redacted,
 *  because its log quotes the source it was given and the source carries the
 *  camera password. */
export function relaySaid(log: string): string | null {
    const lines = log.split(/\r?\n/).filter((line) => /err|error/i.test(line));
    const last = lines[lines.length - 1];
    if (!last) return null;
    const quoted = last.match(/error="([^"]{1,200})"/)?.[1] ?? last.slice(-200);
    return redactSource(quoted.trim()) || null;
}
