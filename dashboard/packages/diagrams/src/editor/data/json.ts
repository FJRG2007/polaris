import { fileOpen, fileSave } from "./filesystem";
import { cleanAppStateForExport, clearAppStateForDatabase } from "../appState";
import {
  DEFAULT_FILENAME,
  EXPORT_DATA_TYPES,
  EXPORT_SOURCE,
  LIBRARY_DATA_TYPES,
  MIME_TYPES,
  SCENE_DATA_TYPES,
  VERSIONS,
} from "../constants";
import { clearElementsForDatabase, clearElementsForExport } from "../element";
import type { DiagramElement } from "../element/types";
import type { AppState, BinaryFiles, LibraryItems } from "../types";
import { isImageFileHandle, loadFromBlob, normalizeFile } from "./blob";

import type {
  ExportedDataState,
  ImportedDataState,
  ExportedLibraryData,
  ImportedLibraryData,
} from "./types";

/**
 * Strips out files which are only referenced by deleted elements
 */
const filterOutDeletedFiles = (
  elements: readonly DiagramElement[],
  files: BinaryFiles,
) => {
  const nextFiles: BinaryFiles = {};
  for (const element of elements) {
    if (
      !element.isDeleted &&
      "fileId" in element &&
      element.fileId &&
      files[element.fileId]
    ) {
      nextFiles[element.fileId] = files[element.fileId];
    }
  }
  return nextFiles;
};

export const serializeAsJSON = (
  elements: readonly DiagramElement[],
  appState: Partial<AppState>,
  files: BinaryFiles,
  type: "local" | "database",
): string => {
  const data: ExportedDataState = {
    type: EXPORT_DATA_TYPES.diagram,
    version: VERSIONS.diagram,
    source: EXPORT_SOURCE,
    elements:
      type === "local"
        ? clearElementsForExport(elements)
        : clearElementsForDatabase(elements),
    appState:
      type === "local"
        ? cleanAppStateForExport(appState)
        : clearAppStateForDatabase(appState),
    files:
      type === "local"
        ? filterOutDeletedFiles(elements, files)
        : // will be stripped from JSON
          undefined,
  };

  return JSON.stringify(data, null, 2);
};

export const saveAsJSON = async (
  elements: readonly DiagramElement[],
  appState: AppState,
  files: BinaryFiles,
  /** filename */
  name: string = appState.name || DEFAULT_FILENAME,
) => {
  const serialized = serializeAsJSON(elements, appState, files, "local");
  const blob = new Blob([serialized], {
    type: MIME_TYPES.diagram,
  });

  const fileHandle = await fileSave(blob, {
    name,
    extension: "diagram",
    description: "Diagram file",
    fileHandle: isImageFileHandle(appState.fileHandle)
      ? null
      : appState.fileHandle,
  });
  return { fileHandle };
};

export const loadFromJSON = async (
  localAppState: AppState,
  localElements: readonly DiagramElement[] | null,
) => {
  const file = await fileOpen({
    description: "Diagram files",
    // ToDo: Be over-permissive until https://bugs.webkit.org/show_bug.cgi?id=34442
    // gets resolved. Else, iOS users cannot open `.polaris-diagram` files.
    // extensions: ["json", "polaris-diagram", "png", "svg"],
  });
  return loadFromBlob(
    await normalizeFile(file),
    localAppState,
    localElements,
    file.handle,
  );
};

export const isValidDiagramData = (data?: {
  type?: any;
  elements?: any;
  appState?: any;
}): data is ImportedDataState => {
  return (
    !!data &&
    SCENE_DATA_TYPES.includes(data.type) &&
    (!data.elements ||
      (Array.isArray(data.elements) &&
        (!data.appState || typeof data.appState === "object")))
  );
};

export const isValidLibrary = (json: any): json is ImportedLibraryData => {
  return (
    typeof json === "object" &&
    json &&
    LIBRARY_DATA_TYPES.includes(json.type) &&
    (json.version === 1 || json.version === 2)
  );
};

export const serializeLibraryAsJSON = (libraryItems: LibraryItems) => {
  const data: ExportedLibraryData = {
    type: EXPORT_DATA_TYPES.diagramLibrary,
    version: VERSIONS.diagramLibrary,
    source: EXPORT_SOURCE,
    libraryItems,
  };
  return JSON.stringify(data, null, 2);
};

export const saveLibraryAsJSON = async (libraryItems: LibraryItems) => {
  const serialized = serializeLibraryAsJSON(libraryItems);
  await fileSave(
    new Blob([serialized], {
      type: MIME_TYPES.diagramlib,
    }),
    {
      name: "library",
      extension: "diagramlib",
      description: "Diagram library file",
    },
  );
};
