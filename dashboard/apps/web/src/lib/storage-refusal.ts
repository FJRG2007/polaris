/**
 * The sentence for an upload no storage would keep, in the sender's language.
 *
 * Every route that writes a file meets the same two failures - a storage that is
 * not there at all, and one that answered and refused - and each used to say it
 * its own way, most of them as the socket's own words or as "could not be
 * stored". Neither tells anybody whether to try again in a minute or to go and
 * find an administrator. This says which storage, and which of the two.
 *
 * The driver's own words go only to an administrator, who is the one person who
 * can act on them; they can name hosts and paths nobody else was given.
 */

import { readerWords } from "@/lib/i18n/reader-words";
import { isUnreachable, StorageRefused } from "@/lib/storage-target";

export async function storageRefusal(error: unknown, isAdmin: boolean): Promise<string> {
    const t = await readerWords("common");
    const name = error instanceof StorageRefused ? error.storage : null;
    const sentence = isUnreachable(error)
        ? name
            ? t("storage.unreachable", { name })
            : t("storage.unreachableHere")
        : name
          ? t("storage.refused", { name })
          : t("storage.refusedHere");
    if (!isAdmin) return sentence;
    const detail = error instanceof Error ? error.message : String(error);
    return t("storage.withDetail", { sentence, detail: detail.slice(0, 300) });
}
