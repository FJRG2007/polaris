/** What the chosen model reads, from the catalogue. `inputs` empty is unknown:
 *  then only the older `attachment` flag says it takes pictures. */
export interface ModelReads {
    inputs: readonly string[];
    attachment: boolean;
}

/**
 * How a file reaches the model: as the file itself when the model reads that
 * kind (a picture to a model that sees, a PDF to one whose catalogue entry lists
 * "pdf"), otherwise as the text taken out of it. Plain text always goes as text:
 * every model reads that, and not every provider takes a text file part.
 */
export function fileRoute(mediaType: string, reads: ModelReads): "file" | "text" {
    if (mediaType.startsWith("image/")) {
        return reads.inputs.includes("image") || (reads.inputs.length === 0 && reads.attachment)
            ? "file"
            : "text";
    }
    if (mediaType === "application/pdf" && reads.inputs.includes("pdf")) return "file";
    return "text";
}
