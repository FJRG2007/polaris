import React from "react";

import { tRich, useI18n } from "../i18n";

import type { TranslationKeys } from "../i18n";

/**
 * A message with markup in it, drawn by the caller.
 *
 *     "Loading from a file will <bold>replace your content</bold>."
 *     <Trans i18nKey="..." bold={(el) => <strong>{el}</strong>} />
 *
 * Tags are ICU tags, so the host's translator does the parsing; a function prop
 * draws a tag, anything else fills in a `{value}`.
 */
const Trans = ({
  i18nKey,
  children,
  ...props
}: {
  i18nKey: TranslationKeys;
  [key: string]: React.ReactNode | ((el: React.ReactNode) => React.ReactNode);
}) => {
  // Subscribes to language changes.
  useI18n();
  const values: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(props)) {
    values[name] =
      typeof value === "function"
        ? (chunks: React.ReactNode[]) =>
            (value as (el: React.ReactNode) => React.ReactNode)(
              React.createElement(React.Fragment, {}, ...chunks),
            )
        : value;
  }
  // Keys are spread so React does not ask for one per part.
  return React.createElement(
    React.Fragment,
    {},
    ...tRich(i18nKey, values),
  );
};

export default Trans;
