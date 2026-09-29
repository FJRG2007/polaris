/**
 * A refusal from the mailbox layer, in the reader's language.
 *
 * The services under `lib/mailbox` refuse in English - `MailAccessError`,
 * `MailSetupError`, `MailFolderError` and the rest - because they run for jobs,
 * the public API and MCP tools as well as for screens, and a log line or an API
 * caller reads the English. The screen is where somebody is reading, so the
 * action that catches one hands its sentence through here: the sentences Mail
 * writes itself are drawn from the `mail` catalog, looked up by the English, and
 * anything else - a mail server's own words - passes through as it came.
 *
 * `test/mail/mail-refusal-text.test.ts` holds every sentence thrown under
 * `lib/mailbox` to having an entry, so a new one cannot reach a Spanish reader
 * in English unnoticed.
 */

import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";

type MailKey = NamespaceKey<"mail">;

/** Sentences with nothing to fill in, by their English. */
export const MAIL_REFUSALS: Readonly<Record<string, MailKey>> = {
    "That folder is not yours.": "refusals.folderNotYours",
    "That folder is not in that mailbox.": "refusals.folderNotInMailbox",
    "That rule is not on this mailbox.": "refusals.ruleNotOnMailbox",
    "That mailbox is not yours.": "refusals.mailboxNotYours",
    "That mailbox is already here.": "refusals.mailboxAlreadyHere",
    "Choose the account that authorizes this mailbox.": "refusals.chooseAuthorizer",
    "That authorized account is not linked here any more.": "refusals.authorizerUnlinked",
    "That account is linked, but it has not been given access to its mail. Authorize it again from here.":
        "refusals.authorizerNoMailAccess",
    "Polaris could not reach the incoming server. Check the name and the port.": "refusals.incomingUnreachable",
    "Polaris could not reach the outgoing server. Check the name and the port.": "refusals.outgoingUnreachable",
    "Enter the password for this mailbox.": "refusals.enterPassword",
    "The servers or login changed, so enter the password again.": "refusals.passwordAgain",
    "That message has no files to save.": "refusals.noFilesToSave",
    "That draft is not yours.": "refusals.draftNotYours",
    "This mailbox needs its password again.": "refusals.needsPassword",
    "The account that authorized this mailbox is no longer linked.": "refusals.authorizerGone",
    "The account that authorized this mailbox needs authorizing again.": "refusals.authorizerExpired",
    "Google is not connected on this Polaris any more.": "refusals.googleGone",
    "Microsoft is not connected on this Polaris any more.": "refusals.microsoftGone",
    "This mailbox needs authorizing again.": "refusals.needsAuthorizing",
    "A folder needs a name.": "refusals.folderNeedsName",
    "That name is too long.": "refusals.nameTooLong",
    "That folder is one this mailbox is built out of.": "refusals.folderIsStructural",
    "That folder has folders inside it. Delete those first.": "refusals.folderHasChildren",
    "The mail server refused this account's credentials.": "refusals.credentialsRefused",
    "Polaris could not reach this mail server.": "refusals.serverUnreachable",
    "This mailbox can already send as that address.": "refusals.alreadySendsAs",
    "That address is not on this mailbox.": "refusals.addressNotHere",
    "That message is not yours.": "refusals.messageNotYours",
    "That attachment is not yours.": "refusals.attachmentNotYours",
    "That person is not in this organization.": "refusals.personNotInOrg",
    "That mailbox is not this organization's.": "refusals.mailboxNotOrgs",
    "That is not yours to do.": "refusals.notYoursToDo",
    "That subscription is not yours.": "refusals.subscriptionNotYours",
    "This sender no longer publishes a way to unsubscribe.": "refusals.noUnsubscribe",
    "That template is not yours.": "refusals.templateNotYours",
    "Not sent. The outgoing server refused this message.": "refusals.sendRefused",
    "Not sent yet. Polaris could not reach the outgoing server, and will try again.": "refusals.sendRetrying",
    "Not sent yet. Polaris could not reach the outgoing server.": "refusals.sendUnreached",
    "It did not reach the address it was sent to.": "refusals.bounced",
    // What the browser's own mail calls say when the answer never came back
    // (`outbox`, `message-store`, `use-mail-list`).
    "Polaris could not be reached. Try again.": "refusals.unreachable",
    "That draft could not be saved.": "refusals.draftNotSaved",
    "That message could not be sent.": "refusals.notSent",
    "That message has already gone.": "refusals.alreadyGone",
    "That message could not be sent now.": "refusals.notSentNow",
    "That list could not be loaded.": "refusals.listNotLoaded",
    "That message could not be opened.": "refusals.notOpened",
    "Not delivered yet, and the server is still trying.": "refusals.delayed",
    // core's mailbox schemas (`@polaris/core`), shared with the API and MCP tools.
    "Add something to match on": "schema.matchOn",
    "Choose the authorized account this mailbox belongs to": "schema.chooseAccount",
    "Enter the password for this mailbox": "schema.password",
    "Give it a name": "schema.name",
    "Give the rule a name": "schema.ruleName",
    "It has to end after it starts": "schema.endsAfterStart",
    "Keep the name under 80 characters": "schema.nameUnder80",
    "Name the server": "schema.serverName",
    "Say what should happen": "schema.sayWhatHappens",
    "Say what to look for": "schema.sayWhatToLookFor",
    "Say whether to pin or mute.": "schema.pinOrMute",
    "Say who it goes to": "schema.sayWho",
    "That is longer than a template can be": "schema.templateTooLong",
    "That is more recipients than one message should carry": "schema.tooManyRecipients",
    "That is not a color": "schema.notColor",
    "That is not a server name": "schema.notServer",
    "That is not an email address": "schema.notEmail",
    "That time has passed": "schema.timePassed",
    "Write what it should say": "schema.writeWhat",
    "Write what the template says": "schema.writeTemplate",
    "That is not one of the waits on offer.": "schema.waitNotOffered"
};

/** Sentences that carry values, by the shape of their English. Each group of
 *  the pattern fills the parameter named at the same place. */
const PATTERNS: readonly { readonly pattern: RegExp; readonly key: MailKey; readonly params: readonly string[] }[] = [
    { pattern: /^This mailbox has no (.+) folder\.$/, key: "refusals.noRoleFolder", params: ["role"] },
    { pattern: /^A folder name cannot contain "(.+)"\.$/, key: "refusals.folderNameCharacter", params: ["character"] },
    { pattern: /^You already have a label called (.+)\.$/, key: "refusals.labelTaken", params: ["name"] },
    { pattern: /^You already have a template called (.+)\.$/, key: "refusals.templateTaken", params: ["name"] },
    { pattern: /^Not sent\. The outgoing server refused it: (.+)$/s, key: "refusals.sendRefusedBecause", params: ["reason"] },
    {
        pattern: /^Not sent yet\. The outgoing server said: (.+) Polaris will try again\.$/s,
        key: "refusals.sendRetryingBecause",
        params: ["reason"]
    },
    { pattern: /^Not sent yet\. The outgoing server said: (.+)$/s, key: "refusals.sendSaid", params: ["reason"] },
    {
        pattern: /^The outgoing server would not send it to (.+) and (\d+) more\.$/s,
        key: "refusals.partialMore",
        params: ["names", "rest"]
    },
    { pattern: /^The outgoing server would not send it to (.+)\.$/s, key: "refusals.partial", params: ["names"] },
    { pattern: /^It did not reach to (.+?): (.+)$/s, key: "refusals.bouncedToBecause", params: ["recipient", "reason"] },
    { pattern: /^It did not reach to (.+)\.$/s, key: "refusals.bouncedTo", params: ["recipient"] },
    { pattern: /^It did not reach the address it was sent to: (.+)$/s, key: "refusals.bouncedBecause", params: ["reason"] },
    {
        pattern: /^Not delivered to (.+?) yet, and the server is still trying: (.+)$/s,
        key: "refusals.delayedToBecause",
        params: ["recipient", "reason"]
    },
    {
        pattern: /^Not delivered to (.+?) yet, and the server is still trying\.$/s,
        key: "refusals.delayedTo",
        params: ["recipient"]
    },
    {
        pattern: /^Not delivered yet, and the server is still trying: (.+)$/s,
        key: "refusals.delayedBecause",
        params: ["reason"]
    }
];

export function mailRefusalText(t: NamespaceTranslator<"mail">, message: string): string {
    const key = MAIL_REFUSALS[message];
    if (key) return t(key);
    // A send that ran out of attempts says why, then that it stopped.
    const stopped = /^(.*) Polaris has stopped trying after (\d+) attempts\.$/s.exec(message);
    if (stopped) {
        return t("refusals.stoppedTrying", {
            reason: mailRefusalText(t, stopped[1] ?? ""),
            attempts: Number(stopped[2])
        });
    }
    for (const { pattern, key: shaped, params } of PATTERNS) {
        const found = pattern.exec(message);
        if (!found) continue;
        return t(shaped, Object.fromEntries(params.map((name, index) => [name, found[index + 1] ?? ""])));
    }
    return message;
}
