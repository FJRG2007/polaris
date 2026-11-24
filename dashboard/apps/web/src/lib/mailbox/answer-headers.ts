/**
 * The headers that change who a reply to all goes to.
 *
 * Mail-Followup-To and List-Post are fetched with every message and kept in its
 * `headers` column as they arrived - raw, so a name in one can still be an
 * encoded word. They are read here, when a message is opened for answering,
 * rather than at sync, because only an answered message ever needs them.
 * Mail that arrived before they were fetched has neither, and answers the way
 * it always did.
 */

import * as core from "@polaris/core";
import { simpleParser } from "mailparser";

export interface AnswerHeaders {
    readonly followupTo: readonly core.MailAddress[];
    readonly listPost: string;
}

const NONE: AnswerHeaders = { followupTo: [], listPost: "" };

export async function answerHeaders(headers: unknown): Promise<AnswerHeaders> {
    if (!headers || typeof headers !== "object") return NONE;
    const held = headers as Record<string, unknown>;
    const followup = typeof held["mail-followup-to"] === "string" ? held["mail-followup-to"] : "";
    const post = typeof held["list-post"] === "string" ? held["list-post"] : "";
    return {
        followupTo: followup ? await addressList(followup) : [],
        listPost: listPostAddress(post)
    };
}

/**
 * The address a list takes posts at. RFC 2369 writes it as one or more
 * bracketed URLs, or `NO` for a list nobody may post to; only a `mailto:` one
 * is an address.
 */
export function listPostAddress(value: string): string {
    for (const match of value.matchAll(/<([^>]*)>/g)) {
        const seed = core.parseMailto(match[1] ?? "");
        const address = seed?.to[0];
        if (address) return address.toLowerCase();
    }
    return "";
}

/**
 * An address header's value, decoded the way the message's own To is: through
 * the same parser the rest of the server reads mail with, as the Reply-To of a
 * message that is nothing but that header.
 */
async function addressList(value: string): Promise<core.MailAddress[]> {
    // One line, so nothing in the value can start a header of its own.
    const line = value.replace(/[\r\n]+/g, " ").slice(0, 4000);
    const parsed = await simpleParser(Buffer.from(`Reply-To: ${line}\r\n\r\n`)).catch(() => null);
    const out: core.MailAddress[] = [];
    const walk = (entries: readonly { name?: string; address?: string; group?: unknown }[]) => {
        for (const entry of entries) {
            if (Array.isArray(entry.group)) walk(entry.group);
            else if (entry.address)
                out.push({ name: entry.name ?? "", address: entry.address.toLowerCase() });
        }
    };
    walk(parsed?.replyTo?.value ?? []);
    return core.dedupeAddresses(out).slice(0, 100) as core.MailAddress[];
}
