import type { ReactNode } from "react";

import { useAtomValue, editorJotaiStore, atom } from "./editor-jotai";

/**
 * The editor's words come from the application that hosts it.
 *
 * Upstream shipped its own catalogs and loaded them by language code; here the
 * host hands over a translator for its own `diagram` namespace, so the editor is
 * in whatever language the rest of the screen is, switches with it, and has one
 * catalog per locale instead of a second set nobody keeps in step.
 *
 * Messages are ICU: `{name}` fills in, `<tag>text</tag>` is drawn by the caller.
 */
export interface DiagramTranslator {
  (key: string, values?: Record<string, string | number>): string;
  /** The same message, with its tags drawn by the functions in `values`. */
  rich(key: string, values: Record<string, unknown>): (string | ReactNode)[];
  /** Whether the catalog has a message at `key`. */
  has(key: string): boolean;
}

export interface Language {
  code: string;
  rtl?: boolean;
}

/** Keys are checked against the host catalog by the host's own tests, not here:
 *  this package does not own the words. */
export type TranslationKeys = string;

export const defaultLang: Language = { code: "en-US" };

/** Used until a host provides one: a key is shown as itself. */
const untranslated: DiagramTranslator = Object.assign(
  (key: string) => key,
  {
    rich: (key: string) => [key],
    has: () => false,
  },
);

/** Scripts written right to left, by the language part of a locale code. */
const RTL = new Set(["ar", "fa", "he", "ur", "ps", "yi"]);

/** The language a locale code names. */
export const languageFor = (code: string | undefined): Language =>
  code
    ? { code, rtl: RTL.has(code.split("-")[0].toLowerCase()) }
    : defaultLang;

let currentLang: Language = defaultLang;
let translator: DiagramTranslator = untranslated;
let revision = 0;

/** Install the host's language and translator. Never touches `<html>`: the page
 *  around the editor owns its own `lang` and `dir`. */
export const setLanguage = (lang: Language, next?: DiagramTranslator) => {
  currentLang = lang;
  if (next) {
    translator = next;
  }
  revision += 1;
  editorJotaiStore.set(editorLangCodeAtom, `${lang.code}#${revision}`);
};

export const getLanguage = () => currentLang;

export const t = (
  path: TranslationKeys,
  replacement?: { [key: string]: string | number } | null,
  fallback?: string,
): string => {
  if (fallback !== undefined && !translator.has(path)) {
    return fallback;
  }
  return translator(path, replacement ?? undefined);
};

/** A message whose tags are drawn by the caller - see `Trans`. */
export const tRich = (
  path: TranslationKeys,
  values: Record<string, unknown>,
): (string | ReactNode)[] => translator.rich(path, values);

/** @private atom used solely to rerender components using `useI18n` hook */
const editorLangCodeAtom = atom(defaultLang.code);

// Should be used in components that fall under these cases:
// - component is rendered as an <Diagram> child
// - component is rendered internally by <Diagram>, but the component
//   is memoized w/o being updated on `langCode`, `AppState`, or `UIAppState`
export const useI18n = () => {
  const langCode = useAtomValue(editorLangCodeAtom);
  return { t, langCode };
};
