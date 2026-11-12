import { AppLogo } from "./app-logo";

/**
 * The Polaris products another screen may name: "Add a Polaris meeting" in
 * Calendar, "A file sent from Drive" in Chat's settings, "Save to Drive" in Mail.
 */
export type PolarisProduct =
    | "chat"
    | "drive"
    | "mail"
    | "calendar"
    | "tasks"
    | "office"
    | "vault"
    | "polar"
    | "notes"
    | "crm"
    | "automations"
    | "translate";

/**
 * Another Polaris product's logo, drawn at text size beside the words that name
 * it - the way a meeting button wears the meeting product's mark - so a reader
 * recognises the product before reading its name. Decorative: the label beside
 * it already says which product it is.
 */
export function ProductMark({
    app,
    size = 16,
    className
}: {
    app: PolarisProduct;
    /** Rendered width and height in pixels; 16 matches body text and buttons. */
    size?: number;
    className?: string;
}) {
    return <AppLogo appId={app} size={size} className={className} />;
}
