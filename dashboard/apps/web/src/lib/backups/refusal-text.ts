/**
 * A backup refusal in the reader's words.
 *
 * The services under `lib/backups` refuse in English - they run on a schedule as
 * well as behind a screen, where there is nobody to ask for a language - and the
 * actions hand the refusal on. This matches the English back to its key in the
 * `backups` catalog, exactly or by its shape for a sentence that names a server,
 * a path or a count. Anything it does not know - what a program printed when it
 * failed, a newer service - passes through.
 */

import { kindInSentence } from "@/lib/backups/words";
import { RESOURCE_KINDS_INFO } from "@/lib/backups/kinds";
import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";

type Words = NamespaceTranslator<"backups">;
type Key = NamespaceKey<"backups">;

const EXACT: Readonly<Record<string, Key>> = {
    "That did not work": "errors.failed",
    "Copies beside the source are written by the source itself, not through a destination": "refusals.besideSource",
    "This backup key was stored under a different master key. Add its recovery key to open the copies it sealed.":
        "refusals.otherMasterKey",
    "This copy was sealed under a key this Polaris does not have. Add its recovery key first.": "refusals.missingKey",
    "That key belongs to somebody else here": "refusals.keyNotYours",
    "That recovery key does not match the key already stored here under the same id. Check it for a typo.":
        "refusals.keyMismatch",
    "The key's id is not one Polaris writes": "refusals.keyId",
    "The key itself is not 32 bytes": "refusals.keyBytes",
    "That protected item no longer exists": "refusals.resourceGone",
    "That plan does not exist": "refusals.planMissing",
    "That copy does not exist": "refusals.copyMissing",
    "That copy did not finish being written": "refusals.copyUnfinished",
    "That copy cannot be read back": "refusals.copyUnreadable",
    "One of those destinations does not exist": "refusals.someDestinationMissing",
    "That destination does not exist": "refusals.destinationMissing",
    "That storage connection does not exist": "refusals.connectionMissing",
    "That server does not exist": "refusals.serverMissing",
    "That destination still holds copies. Delete them first, or keep it so they stay reachable.":
        "refusals.destinationHoldsCopies",
    "That is the default destination. Make another one the default first.": "refusals.defaultDestination",
    "There is nowhere to keep this server's copies": "refusals.nowhereForServer",
    "That copy was sealed with a passphrase, not a backup key": "refusals.passphraseSealed",
    "That file is not sealed": "refusals.notSealed",
    "That file was sealed by a newer Polaris": "refusals.newerPolaris",
    "That file names a key kind Polaris does not know": "refusals.unknownKeyKind",
    "That file's chunk size is not one Polaris writes": "refusals.chunkSize",
    "That file's passphrase settings are out of range": "refusals.passphraseSettings",
    "That file ends in the middle of a chunk": "refusals.truncatedChunk",
    "That file does not open with this key, or has been changed": "refusals.wrongKey",
    "That file is too large to seal": "refusals.tooLarge",
    "That file ends before its header does": "refusals.truncatedHeader",
    "There is nowhere to put this backup. Add a destination first.": "refusals.noDestination",
    "This database's id is missing from its record": "refusals.databaseId",
    "That database no longer exists": "refusals.databaseGone",
    "That database has no container to run the dump in": "refusals.databaseNoContainer",
    "A Redis cluster cannot be restored in place: each master holds its own share of the keys. Nothing was changed.":
        "refusals.clusterInPlace",
    "This backup is of a Redis cluster: it holds each master's snapshot separately, and cannot be loaded into a single instance. Nothing was changed.":
        "refusals.clusterIntoSingle",
    "The server this database runs on is not registered": "refusals.databaseHostMissing",
    "That cluster has no nodes to take a backup of": "refusals.clusterEmpty",
    "This volume's id is missing from its record": "refusals.volumeId",
    "That volume cannot be reached right now": "refusals.volumeUnreachable",
    "This folder's connection is missing from its record": "refusals.folderConnection",
    "That storage connection cannot be reached": "refusals.connectionUnreachable",
    "This mail server's id is missing from its record": "refusals.mailServerId",
    "That mail server no longer exists": "refusals.mailServerGone",
    "That mail server has not finished setting up": "refusals.mailServerSettingUp",
    "That mail server's engine is not running": "refusals.mailServerStopped",
    "The engine's volumes could not be found on its machine": "refusals.mailServerVolumes",
    "That copy is not an export of this mail server": "refusals.notThisMailServer",
    "A copy of the server as it is now could not be taken, so nothing was restored": "refusals.mailSafetyFailed"
};

/** Sentences that carry a value, by their shape. */
const SHAPED: readonly (readonly [RegExp, Key, readonly string[]])[] = [
    [/^A recovery key starts with (\S+): and has three parts$/, "refusals.keyShape", ["prefix"]],
    [/^"(.+)" names no storage connection$/, "refusals.namesNoConnection", ["name"]],
    [/^"(.+)" names no server$/, "refusals.namesNoServer", ["name"]],
    [/^Unknown destination kind: (.+)$/, "refusals.unknownDestinationKind", ["kind"]],
    [/^Unknown kind: (.+)$/, "refusals.unknownKind", ["kind"]],
    [/^Polaris no longer knows how to back up a (.+)$/, "refusals.noLongerKnows", ["kind"]],
    [/^Polaris cannot dump a (.+) database yet$/, "refusals.cannotDump", ["engine"]],
    [/^Nothing was restored: a copy of what is there now could not be taken first \((.+)\)\.$/s, "refusals.safetyFailedWhy", ["why"]],
    [/^(\d+) of the cluster's (\d+) masters answered, so no backup was taken: a copy of part of a cluster is not a backup of it\.$/, "refusals.clusterPartial", ["answered", "masters"]],
    [/^The dump failed inside (.+?): (.+)$/s, "refusals.dumpFailed", ["container", "reason"]],
    [/^The snapshot failed on (.+?): (.+)$/s, "refusals.snapshotFailed", ["node", "reason"]],
    [/^Preparing the export failed: (.*)$/s, "refusals.exportPrepare", ["reason"]],
    [/^Archiving the export failed: (.*)$/s, "refusals.exportArchive", ["reason"]],
    [/^Unpacking the export failed: (.*)$/s, "refusals.exportUnpack", ["reason"]],
    [/^Archiving (.+?) failed: (.*)$/s, "refusals.archiveFailed", ["path", "reason"]],
    [/^Unpacking into (.+?) failed: (.*)$/s, "refusals.unpackFailed", ["path", "reason"]]
];

const NUMBERS = new Set(["answered", "masters"]);

/** Every English sentence this knows, for the test that holds the catalog to it. */
export const KNOWN_BACKUP_REFUSALS: readonly string[] = Object.keys(EXACT);

export function backupRefusalText(t: Words, message: string): string {
    const exact = EXACT[message];
    if (exact) return t(exact);
    if (message === "Nothing was restored: a copy of what is there now could not be taken first.") {
        return t("refusals.safetyFailed");
    }
    // The one sentence that names a kind by its English label.
    const restore = /^A (.+) cannot be put back from here - download it instead$/.exec(message);
    if (restore) {
        const info = Object.values(RESOURCE_KINDS_INFO).find((kind) => kind.label.toLowerCase() === restore[1]);
        return t("refusals.cannotRestore", { kind: info ? kindInSentence(t, info.kind) : (restore[1] ?? "") });
    }
    for (const [pattern, key, names] of SHAPED) {
        const match = pattern.exec(message);
        if (!match) continue;
        const params: Record<string, string | number> = {};
        names.forEach((name, index) => {
            const value = match[index + 1] ?? "";
            params[name] = NUMBERS.has(name) ? Number(value) : value;
        });
        return t(key, params);
    }
    return message;
}
