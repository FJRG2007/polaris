import React, { useState } from "react";

import { languageFor, setLanguage } from "../i18n";

import type { DiagramTranslator } from "../i18n";

interface Props {
  langCode?: string;
  translate?: DiagramTranslator;
  children: React.ReactElement;
}

/**
 * Installs the host's language before the editor's first render, so nothing
 * is ever drawn with untranslated keys. Later changes go through
 * `App.updateLanguage`, which also redraws the canvas chrome.
 */
export const InitializeApp = (props: Props) => {
  useState(() => {
    setLanguage(languageFor(props.langCode), props.translate);
    return true;
  });
  return props.children;
};
