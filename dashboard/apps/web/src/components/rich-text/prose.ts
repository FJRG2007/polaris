/**
 * How written text is set, on both sides of the same field.
 *
 * The editor draws its own DOM and the reader draws React, so without one shared
 * set of classes a heading would be one size while it is being written and
 * another once it is saved - and the whole point of editing in place is that
 * nothing moves when you click into it.
 *
 * Deliberately small and deliberately not the typography plugin: this is a
 * description and a note, not a magazine.
 */

import { cn } from "@polaris/ui";

export const RICH_TEXT_PROSE = cn(
    "text-sm leading-relaxed [&>*+*]:mt-3",
    "[&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-semibold",
    "[&_a]:text-primary [&_a]:underline [&_li]:my-0.5",
    "[&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6",
    // A checklist is drawn by its boxes, so it keeps neither bullets nor the
    // indent that goes with them.
    "[&_ul[data-type=taskList]]:list-none [&_ul[data-type=taskList]]:pl-0",
    "[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
    "[&_hr]:my-4 [&_hr]:border-border [&_img]:max-w-full [&_img]:rounded-md",
    // A highlighted fence brings its own frame - a header with the language and
    // a copy button - and it opts out by carrying `data-code`. Without the
    // exclusion this rule wins on specificity and paints a second background
    // inside the first.
    "[&_pre:not([data-code])]:overflow-x-auto [&_pre:not([data-code])]:rounded-md [&_pre:not([data-code])]:bg-muted [&_pre:not([data-code])]:p-3 [&_pre:not([data-code])]:font-mono [&_pre:not([data-code])]:text-xs",
    "[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5"
);
