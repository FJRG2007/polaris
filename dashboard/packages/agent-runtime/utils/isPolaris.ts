/**
 * true when a GitHub login belongs to Polaris's production or development app.
 */
export function isPolaris(actor: string | null | undefined): boolean {
  actor = actor?.toLowerCase().replace("[bot]", "");
  return !!actor && (actor === "polaris" || actor === "polaris");
}
