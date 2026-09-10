/**
 * The colours Mail tells things apart by: a mailbox's dot, a folder's icon.
 *
 * Eight, and swatches rather than a picker. A menu with an input in it is a menu
 * that steals the input focus the moment it opens - see the note in
 * `@polaris/ui` - and eight is already more than anybody needs to make three
 * mailboxes or three folders findable at a glance. One list, so a mailbox given
 * "Green" on its edit form is the green its folders can be given in the rail.
 */
export const MAIL_PALETTE: readonly { hex: string; name: string }[] = [
    { hex: "#6366f1", name: "Indigo" },
    { hex: "#0ea5e9", name: "Blue" },
    { hex: "#10b981", name: "Green" },
    { hex: "#f59e0b", name: "Amber" },
    { hex: "#ef4444", name: "Red" },
    { hex: "#a855f7", name: "Purple" },
    { hex: "#14b8a6", name: "Teal" },
    { hex: "#f43f5e", name: "Pink" }
];
