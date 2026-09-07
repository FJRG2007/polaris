/**
 * What comes back when somebody chooses a file.
 *
 * Three shapes, because a file reaches a screen in three genuinely different
 * ways and flattening them would mean uploading a file that is already on this
 * server in order to attach it to something else on this server.
 *
 * Kept apart from the dialog so a server module can name the type without
 * pulling a client component in behind it.
 */

export type PickedFile =
    /** Off the machine the reader is sitting at. The bytes are in the browser. */
    | { readonly kind: "upload"; readonly file: File }
    /** Already on a storage Polaris can reach. Nothing has moved yet: what
     *  travels is where it is, and whoever asked decides what to do with it. */
    | {
          readonly kind: "drive";
          readonly connectionId: string;
          readonly path: string;
          readonly name: string;
          readonly size: number;
      }
    /** An address somebody pasted. Fetched by the server through the same guard
     *  every outside address goes through, never by the browser. */
    | { readonly kind: "url"; readonly url: string };

/** What to call a pick, for a list of them. */
export function pickedName(picked: PickedFile): string {
    if (picked.kind === "upload") return picked.file.name;
    if (picked.kind === "drive") return picked.name;
    return picked.url.split("/").filter(Boolean).at(-1) || picked.url;
}
