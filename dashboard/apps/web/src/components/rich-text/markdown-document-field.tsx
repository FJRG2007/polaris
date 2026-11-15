"use client";

/**
 * A Markdown document in a form: instructions, a skill, anything that is read
 * as Markdown later. The body is the shared rich editor; a leading frontmatter
 * block, which the editor would rewrite, is shown as the raw lines it is and
 * written back exactly as typed.
 */

import { Textarea } from "@polaris/ui";
import { RichTextEditor } from "./rich-text-editor";
import { joinFrontmatter, splitFrontmatter } from "./frontmatter";

const FENCE = /^---[ \t]*\r?\n|\r?\n---[ \t]*(?:\r?\n)?$/g;

export function MarkdownDocumentField({
    value,
    onChange,
    ariaLabel,
    frontmatterLabel,
    placeholder,
    invalid = false
}: {
    value: string;
    onChange: (markdown: string) => void;
    ariaLabel: string;
    /** Names the raw frontmatter box when the document has one. */
    frontmatterLabel: string;
    placeholder?: string;
    invalid?: boolean;
}) {
    const { frontmatter, body } = splitFrontmatter(value);
    return (
        <div className="flex min-w-0 flex-col gap-2">
            {frontmatter ? (
                <Textarea
                    aria-label={frontmatterLabel}
                    rows={Math.min(8, frontmatter.split("\n").length)}
                    value={frontmatter.replace(FENCE, "")}
                    className="font-mono text-xs"
                    onChange={(event) =>
                        onChange(joinFrontmatter(`---\n${event.target.value}\n---\n`, body))
                    }
                />
            ) : null}
            <RichTextEditor
                value={body}
                bordered
                ariaLabel={ariaLabel}
                invalid={invalid}
                placeholder={placeholder}
                className="max-h-[50vh] min-h-[10rem] overflow-y-auto overscroll-contain"
                onChange={(next) => onChange(joinFrontmatter(frontmatter, next))}
            />
        </div>
    );
}
