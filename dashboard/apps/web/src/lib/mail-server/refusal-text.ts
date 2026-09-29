/**
 * A mail server refusal in the reader's words.
 *
 * The services under `lib/mail-server` refuse in English - they run in jobs and
 * webhooks as well as behind a screen, where there is nobody to ask for a
 * language - and the actions hand the refusal on. This matches the English back
 * to its key in the `mailServer` catalog, exactly or by its shape for a sentence
 * that names a domain, an address or a count. Anything it does not know - the
 * engine's own description of a refusal, a newer service - passes through.
 */

import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";

type Words = NamespaceTranslator<"mailServer">;
type Key = NamespaceKey<"mailServer">;

const EXACT: Readonly<Record<string, Key>> = {
    "That mail server was not found.": "refusals.notFound",
    "You cannot manage this organization's mail servers.": "refusals.notYourOrg",
    "This mail server has no administrator credential yet. Run setup again.": "refusals.noAdmin",
    "Mail server is not installed.": "refusals.notInstalled",
    "Mail server is not installed. Install it from the Marketplace first.": "refusals.notInstalledHint",
    "Only whoever installed Mail server, or an administrator, can uninstall it.": "refusals.uninstallOwner",
    "This mail server is not running yet. Finish setting it up first.": "refusals.notRunning",
    "That report unpacks to more than any real report does.": "refusals.reportTooBig",
    "That compressed report is damaged, or unpacks to more than any real report does.": "refusals.reportDamaged",
    "That zip file is damaged.": "refusals.zipDamaged",
    "That zip file unpacks to more than any real report does.": "refusals.zipTooBig",
    "No DMARC report was found in that file.": "refusals.noReport",
    "This mail server is still being set up.": "refusals.settingUp",
    "Connect a Cloudflare API token under Integrations to publish records from here.": "refusals.connectCloudflare",
    "That domain is not on this mail server.": "refusals.domainMissing",
    "That rule is not on this mail server.": "refusals.ruleMissing",
    "The server's first domain holds Polaris's own accounts and cannot be removed.": "refusals.firstDomain",
    "That mailbox is not on this mail server.": "refusals.mailboxMissing",
    "Polaris sends its own mail from this mailbox, so it is left as it is.": "refusals.polarisMailbox",
    "An alias names a domain that is not on this mail server.": "refusals.aliasDomain",
    "A forward cannot send mail back to its own address.": "refusals.forwardLoop",
    "That forward is not on this mail server.": "refusals.forwardMissing",
    "Enter the relay's SMTP host.": "refusals.relayHost",
    "Enter the relay's password or API key.": "refusals.relaySecret",
    "Enter the relay's username.": "refusals.relayUser",
    "That server was not found among yours.": "refusals.serverNotYours",
    "That server deploys through a swarm, which hides the address every incoming connection comes from. A mail server needs it for spam filtering and sender checks, so choose a server that runs plain containers.":
        "refusals.swarm",
    "The administrator credential is missing. Remove this server and set it up again.": "refusals.adminMissing",
    "The mail server's service is missing. Repair from the start.": "refusals.serviceMissing",
    "The server this was to run on is no longer connected.": "refusals.placementGone",
    "That server deploys through a swarm, which a mail server cannot run behind.": "refusals.swarmShort",
    "The mail server's project has no environment.": "refusals.noEnvironment",
    "After the restart the mail server did not accept Polaris's administrator account, so the setup credential was put back. Run setup again.":
        "refusals.adminRejected",
    "The event signing key is missing. Remove this server and set it up again.": "refusals.signingKey",
    "The mail server answered with something that is not a JMAP session.": "refusals.notJmapSession",
    "The mail server's session does not offer this mailbox's mail.": "refusals.noMailboxMail",
    "The mail server would not hand that attachment over.": "refusals.attachment",
    "The mail server failed to answer that request.": "refusals.failedRequest",
    "The mail server answered with something that is not JMAP.": "refusals.notJmap",
    "The mail server did not answer that request": "refusals.noAnswer",
    "The mail server's service no longer exists.": "refusals.serviceGone",
    "Polaris does not know this machine's address yet.": "refusals.noAddress",
    "The mail server is not answering on this machine.": "refusals.downHere",
    "Polaris could not reach the server the mail server runs on.": "refusals.hostUnreachable",
    "The mail server is not answering on its server.": "refusals.downThere"
};

/** Sentences that carry a value, by their shape. */
const SHAPED: readonly (readonly [RegExp, Key, readonly string[]])[] = [
    [/^(.+) is missing from the mail server\. Repair it from the start\.$/, "refusals.domainGone", ["domain"]],
    [/^(.+) is missing from the mail server\. Repair from the start\.$/, "refusals.domainGoneShort", ["domain"]],
    [
        /^Publishing from here needs (.+) verified under Domains\. Until then, add the records listed under it at your DNS host\.$/,
        "refusals.needsVerified",
        ["domain"]
    ],
    [/^(.+) is on this Polaris's own DNS account\. Verify it under Domains, then add it here\.$/, "refusals.ownDnsAccount", ["domain"]],
    [/^(.+) is not a zone in the Cloudflare account Polaris is connected to\.$/, "refusals.notAZone", ["domain"]],
    [/^A mail server holds at most (\d+) rules\.$/, "refusals.tooManyRules", ["max"]],
    [/^(.+) still has (\d+) mailbox(?:es)?\. Remove them first\.$/, "refusals.domainHasMailboxes", ["domain", "count"]],
    [/^(.+) is Polaris's own\. Choose another name\.$/, "refusals.reservedAddress", ["address"]],
    [/^(.+) already has a mail server here\.$/, "refusals.hostnameTaken", ["hostname"]],
    [/^The mail server did not start: (.+)$/s, "refusals.didNotStart", ["reason"]]
];

/** Every English sentence this knows, for the test that holds the catalog to it. */
export const KNOWN_MAIL_REFUSALS: readonly string[] = Object.keys(EXACT);

export function mailServerRefusalText(t: Words, message: string): string {
    const exact = EXACT[message];
    if (exact) return t(exact);
    for (const [pattern, key, names] of SHAPED) {
        const match = pattern.exec(message);
        if (!match) continue;
        const params: Record<string, string | number> = {};
        names.forEach((name, index) => {
            const value = match[index + 1] ?? "";
            params[name] = name === "count" || name === "max" ? Number(value) : value;
        });
        return t(key, params);
    }
    return message;
}
