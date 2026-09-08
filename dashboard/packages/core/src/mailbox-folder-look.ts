/**
 * What a folder in the rail should look like, worked out from its name.
 *
 * A mail server tells a client what a folder IS only when it bothers to - the
 * SPECIAL-USE flags are optional and plenty of servers publish none. Polaris
 * already falls back to matching English names for the roles that matter, but a
 * mailbox in Spanish, French or German comes back with every folder drawn as the
 * same grey stack of paper, including the four everybody recognises on sight.
 *
 * So the name is read here as well, in the languages this is likely to meet, and
 * it decides two things:
 *
 * - **the icon**, which is the whole point: a rail of twenty identical rows is a
 *   rail nobody scans, and Papelera is a bin whatever the server said;
 * - **a suggested role**, for a folder the server left as `none`, so archiving
 *   into `Archivo` works without its owner being asked which folder that is.
 *
 * Deliberately conservative about the role. Getting an icon wrong costs a
 * glance; getting a role wrong files somebody's mail into a folder they did not
 * choose, so a name has to be one of the ones below outright rather than merely
 * contain it.
 *
 * Pure and accent-insensitive: "Elementos enviados" and "elementos enviados" are
 * one folder, and so are "Entwürfe" and "Entwurfe".
 */

/** What a folder is drawn as. Names rather than icons, because this package has
 *  no components in it - the rail turns these into whatever it draws. */
export const FOLDER_LOOKS = [
    "inbox",
    "drafts",
    "sent",
    "archive",
    "junk",
    "trash",
    "starred",
    "snoozed",
    "important",
    "notes",
    "outbox",
    "folder"
] as const;

export type FolderLook = (typeof FOLDER_LOOKS)[number];

/** Text with its accents taken off and its case dropped, so one list covers
 *  every way somebody's server writes a folder name. */
function plain(text: string): string {
    return text
        .normalize("NFKD")
        // The combining marks NFKD just split off, written as an escape rather
        // than as the characters themselves: a file of invisible accents is one
        // an editor eventually eats.
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

/**
 * The names each look answers to.
 *
 * English, Spanish, French, German, Portuguese and Italian, which is most of
 * what a European mail server writes, plus the handful of names the big services
 * use in English regardless of the account's language.
 */
const NAMES: Readonly<Record<FolderLook, readonly string[]>> = {
    inbox: ["inbox", "bandeja de entrada", "entrada", "recibidos", "boite de reception",
        "posteingang", "caixa de entrada", "posta in arrivo"],
    drafts: ["drafts", "draft", "borradores", "borrador", "brouillons", "entwurfe",
        "rascunhos", "bozze"],
    sent: ["sent", "sent items", "sent mail", "sent messages", "enviados",
        "elementos enviados", "correo enviado", "envoyes", "messages envoyes",
        "gesendet", "gesendete elemente", "gesendete objekte", "enviadas",
        "posta inviata", "inviata"],
    archive: ["archive", "archives", "archivo", "archivados", "archivierung",
        "archiv", "arquivo", "archivio"],
    junk: ["junk", "spam", "junk email", "junk e mail", "bulk mail", "correo no deseado",
        "no deseado", "courrier indesirable", "indesirables", "unerwunscht",
        "lixo eletronico", "posta indesiderata"],
    trash: ["trash", "deleted", "deleted items", "deleted messages", "bin",
        "papelera", "elementos eliminados", "corbeille", "papierkorb", "geloschte elemente",
        "lixeira", "cestino"],
    starred: ["starred", "flagged", "destacados", "favoritos", "suivis", "markiert",
        "con estrella", "preferiti"],
    snoozed: ["snoozed", "pospuestos", "differes", "zuruckgestellt"],
    important: ["important", "importante", "importants", "wichtig", "priority",
        "prioritario"],
    notes: ["notes", "notas", "notizen", "note"],
    outbox: ["outbox", "queue", "bandeja de salida", "salida", "boite d envoi",
        "postausgang", "caixa de saida", "posta in uscita"],
    folder: []
};

/** The role a look implies, for the five that are roles. The rest are ways of
 *  looking at a mailbox rather than places mail is filed, so they suggest
 *  nothing. */
const ROLE_FOR: Readonly<Partial<Record<FolderLook, string>>> = {
    inbox: "inbox",
    drafts: "drafts",
    sent: "sent",
    archive: "archive",
    junk: "junk",
    trash: "trash"
};

/**
 * What this folder looks like.
 *
 * The last segment of the path, because a server writes `INBOX.Papelera` and the
 * folder is still a bin. Matched whole rather than by substring: "Archive of
 * 2019" is somebody's own folder and drawing it as the archive would be wrong in
 * the one direction that matters.
 */
export function folderLook(name: string, role: string): FolderLook {
    // What the server said, when it said anything. Its own answer beats a guess
    // at its language every time.
    for (const [look, mapped] of Object.entries(ROLE_FOR)) {
        if (mapped === role) return look as FolderLook;
    }

    const leaf = plain(name.split(/[/.\\]/).filter(Boolean).pop() ?? name);
    if (!leaf) return "folder";
    for (const [look, names] of Object.entries(NAMES)) {
        if (names.includes(leaf)) return look as FolderLook;
    }
    return "folder";
}

/**
 * The role a folder's name suggests, for one the server left unsaid.
 *
 * Only ever a suggestion: it is what lets Polaris offer "is this your Trash?"
 * with the right folder already chosen, rather than a decision it makes on
 * somebody's behalf. Filing mail into the wrong folder is the one mistake here
 * that loses something.
 */
export function suggestedFolderRole(name: string): string | null {
    const look = folderLook(name, "none");
    return ROLE_FOR[look] ?? null;
}
