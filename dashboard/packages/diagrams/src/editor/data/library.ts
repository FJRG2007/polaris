import { loadLibraryFromBlob } from "./blob";
import type {
  LibraryItems,
  LibraryItem,
  DiagramImperativeAPI,
  LibraryItemsSource,
  LibraryItems_anyVersion,
} from "../types";
import { restoreLibraryItems } from "./restore";
import type App from "../components/App";
import { atom, editorJotaiStore } from "../editor-jotai";
import type { DiagramElement } from "../element/types";
import { getCommonBoundingBox } from "../element/bounds";
import { AbortError } from "../errors";
import { t } from "../i18n";
import { useEffect, useRef } from "react";
import {
  URL_HASH_KEYS,
  URL_QUERY_KEYS,
  APP_NAME,
  EVENT,
  DEFAULT_SIDEBAR,
  LIBRARY_SIDEBAR_TAB,
} from "../constants";
import { libraryItemSvgsCache } from "../hooks/useLibraryItemSvg";
import {
  arrayToMap,
  cloneJSON,
  preventUnload,
  promiseTry,
  resolvablePromise,
} from "../utils";
import type { MaybePromise } from "../utility-types";
import { Emitter } from "../emitter";
import { Queue } from "../queue";
import { hashElementsVersion, hashString } from "../element";
import { toValidURL } from "./url";

type LibraryUpdate = {
  /** deleted library items since last onLibraryChange event */
  deletedItems: Map<LibraryItem["id"], LibraryItem>;
  /** newly added items in the library */
  addedItems: Map<LibraryItem["id"], LibraryItem>;
};

// an object so that we can later add more properties to it without breaking,
// such as schema version
export type LibraryPersistedData = { libraryItems: LibraryItems };

const onLibraryUpdateEmitter = new Emitter<
  [update: LibraryUpdate, libraryItems: LibraryItems]
>();

export type LibraryAdatapterSource = "load" | "save";

export interface LibraryPersistenceAdapter {
  /**
   * Should load data that were previously saved into the database using the
   * `save` method. Should throw if saving fails.
   *
   * Will be used internally in multiple places, such as during save to
   * in order to reconcile changes with latest store data.
   */
  load(metadata: {
    /**
     * Indicates whether we're loading data for save purposes, or reading
     * purposes, in which case host app can implement more aggressive caching.
     */
    source: LibraryAdatapterSource;
  }): MaybePromise<{ libraryItems: LibraryItems_anyVersion } | null>;
  /** Should persist to the database as is (do no change the data structure). */
  save(libraryData: LibraryPersistedData): MaybePromise<void>;
}

export interface LibraryMigrationAdapter {
  /**
   * loads data from legacy data source. Returns `null` if no data is
   * to be migrated.
   */
  load(): MaybePromise<{ libraryItems: LibraryItems_anyVersion } | null>;

  /** clears entire storage afterwards */
  clear(): MaybePromise<void>;
}

export const libraryItemsAtom = atom<{
  status: "loading" | "loaded";
  /** indicates whether library is initialized with library items (has gone
   * through at least one update). Used in UI. Specific to this atom only. */
  isInitialized: boolean;
  libraryItems: LibraryItems;
}>({ status: "loaded", isInitialized: false, libraryItems: [] });

const cloneLibraryItems = (libraryItems: LibraryItems): LibraryItems =>
  cloneJSON(libraryItems);

/**
 * checks if library item does not exist already in current library
 */
const isUniqueItem = (
  existingLibraryItems: LibraryItems,
  targetLibraryItem: LibraryItem,
) => {
  return !existingLibraryItems.find((libraryItem) => {
    if (libraryItem.elements.length !== targetLibraryItem.elements.length) {
      return false;
    }

    // detect z-index difference by checking the polaris-diagram elements
    // are in order
    return libraryItem.elements.every((libItemDiagramItem, idx) => {
      return (
        libItemDiagramItem.id === targetLibraryItem.elements[idx].id &&
        libItemDiagramItem.versionNonce ===
          targetLibraryItem.elements[idx].versionNonce
      );
    });
  });
};

/** Merges otherItems into localItems. Unique items in otherItems array are
    sorted first. */
export const mergeLibraryItems = (
  localItems: LibraryItems,
  otherItems: LibraryItems,
): LibraryItems => {
  const newItems = [];
  for (const item of otherItems) {
    if (isUniqueItem(localItems, item)) {
      newItems.push(item);
    }
  }

  return [...newItems, ...localItems];
};

/**
 * Returns { deletedItems, addedItems } maps of all added and deleted items
 * since last onLibraryChange event.
 *
 * Host apps are recommended to diff with the latest state they have.
 */
const createLibraryUpdate = (
  prevLibraryItems: LibraryItems,
  nextLibraryItems: LibraryItems,
): LibraryUpdate => {
  const nextItemsMap = arrayToMap(nextLibraryItems);

  const update: LibraryUpdate = {
    deletedItems: new Map<LibraryItem["id"], LibraryItem>(),
    addedItems: new Map<LibraryItem["id"], LibraryItem>(),
  };

  for (const item of prevLibraryItems) {
    if (!nextItemsMap.has(item.id)) {
      update.deletedItems.set(item.id, item);
    }
  }

  const prevItemsMap = arrayToMap(prevLibraryItems);

  for (const item of nextLibraryItems) {
    if (!prevItemsMap.has(item.id)) {
      update.addedItems.set(item.id, item);
    }
  }

  return update;
};

class Library {
  /** latest libraryItems */
  private currLibraryItems: LibraryItems = [];
  /** snapshot of library items since last onLibraryChange call */
  private prevLibraryItems = cloneLibraryItems(this.currLibraryItems);

  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  private updateQueue: Promise<LibraryItems>[] = [];

  private getLastUpdateTask = (): Promise<LibraryItems> | undefined => {
    return this.updateQueue[this.updateQueue.length - 1];
  };

  private notifyListeners = () => {
    if (this.updateQueue.length > 0) {
      editorJotaiStore.set(libraryItemsAtom, (s) => ({
        status: "loading",
        libraryItems: this.currLibraryItems,
        isInitialized: s.isInitialized,
      }));
    } else {
      editorJotaiStore.set(libraryItemsAtom, {
        status: "loaded",
        libraryItems: this.currLibraryItems,
        isInitialized: true,
      });
      try {
        const prevLibraryItems = this.prevLibraryItems;
        this.prevLibraryItems = cloneLibraryItems(this.currLibraryItems);

        const nextLibraryItems = cloneLibraryItems(this.currLibraryItems);

        this.app.props.onLibraryChange?.(nextLibraryItems);

        // for internal use in `useHandleLibrary` hook
        onLibraryUpdateEmitter.trigger(
          createLibraryUpdate(prevLibraryItems, nextLibraryItems),
          nextLibraryItems,
        );
      } catch (error) {
        console.error(error);
      }
    }
  };

  /** call on polaris-diagram instance unmount */
  destroy = () => {
    this.updateQueue = [];
    this.currLibraryItems = [];
    editorJotaiStore.set(libraryItemSvgsCache, new Map());
    // TODO uncomment after/if we make jotai store scoped to each excal instance
    // jotaiStore.set(libraryItemsAtom, {
    //   status: "loading",
    //   isInitialized: false,
    //   libraryItems: [],
    // });
  };

  resetLibrary = () => {
    return this.setLibrary([]);
  };

  /**
   * @returns latest cloned libraryItems. Awaits all in-progress updates first.
   */
  getLatestLibrary = (): Promise<LibraryItems> => {
    return new Promise(async (resolve) => {
      try {
        const libraryItems = await (this.getLastUpdateTask() ||
          this.currLibraryItems);
        if (this.updateQueue.length > 0) {
          resolve(this.getLatestLibrary());
        } else {
          resolve(cloneLibraryItems(libraryItems));
        }
      } catch (error) {
        return resolve(this.currLibraryItems);
      }
    });
  };

  // NOTE this is a high-level public API (exposed on DiagramAPI) with
  // a slight overhead (always restoring library items). For internal use
  // where merging isn't needed, use `library.setLibrary()` directly.
  updateLibrary = async ({
    libraryItems,
    prompt = false,
    merge = false,
    openLibraryMenu = false,
    defaultStatus = "unpublished",
  }: {
    libraryItems: LibraryItemsSource;
    merge?: boolean;
    prompt?: boolean;
    openLibraryMenu?: boolean;
    defaultStatus?: "unpublished" | "published";
  }): Promise<LibraryItems> => {
    if (openLibraryMenu) {
      this.app.setState({
        openSidebar: { name: DEFAULT_SIDEBAR.name, tab: LIBRARY_SIDEBAR_TAB },
      });
    }

    return this.setLibrary(() => {
      return new Promise<LibraryItems>(async (resolve, reject) => {
        try {
          const source = await (typeof libraryItems === "function" &&
          !(libraryItems instanceof Blob)
            ? libraryItems(this.currLibraryItems)
            : libraryItems);

          let nextItems;

          if (source instanceof Blob) {
            nextItems = await loadLibraryFromBlob(source, defaultStatus);
          } else {
            nextItems = restoreLibraryItems(source, defaultStatus);
          }
          if (
            !prompt ||
            window.confirm(
              t("alerts.confirmAddLibrary", {
                numShapes: nextItems.length,
              }),
            )
          ) {
            if (prompt) {
              // focus container if we've prompted. We focus conditionally
              // lest `props.autoFocus` is disabled (in which case we should
              // focus only on user action such as prompt confirm)
              this.app.focusContainer();
            }

            if (merge) {
              resolve(mergeLibraryItems(this.currLibraryItems, nextItems));
            } else {
              resolve(nextItems);
            }
          } else {
            reject(new AbortError());
          }
        } catch (error: any) {
          reject(error);
        }
      });
    });
  };

  setLibrary = (
    /**
     * LibraryItems that will replace current items. Can be a function which
     * will be invoked after all previous tasks are resolved
     * (this is the prefered way to update the library to avoid race conditions,
     * but you'll want to manually merge the library items in the callback
     *  - which is what we're doing in Library.importLibrary()).
     *
     * If supplied promise is rejected with AbortError, we swallow it and
     * do not update the library.
     */
    libraryItems:
      | LibraryItems
      | Promise<LibraryItems>
      | ((
          latestLibraryItems: LibraryItems,
        ) => LibraryItems | Promise<LibraryItems>),
  ): Promise<LibraryItems> => {
    const task = new Promise<LibraryItems>(async (resolve, reject) => {
      try {
        await this.getLastUpdateTask();

        if (typeof libraryItems === "function") {
          libraryItems = libraryItems(this.currLibraryItems);
        }

        this.currLibraryItems = cloneLibraryItems(await libraryItems);

        resolve(this.currLibraryItems);
      } catch (error: any) {
        reject(error);
      }
    })
      .catch((error) => {
        if (error.name === "AbortError") {
          console.warn("Library update aborted by user");
          return this.currLibraryItems;
        }
        throw error;
      })
      .finally(() => {
        this.updateQueue = this.updateQueue.filter((_task) => _task !== task);
        this.notifyListeners();
      });

    this.updateQueue.push(task);
    this.notifyListeners();

    return task;
  };
}

export default Library;

export const distributeLibraryItemsOnSquareGrid = (
  libraryItems: LibraryItems,
) => {
  const PADDING = 50;
  const ITEMS_PER_ROW = Math.ceil(Math.sqrt(libraryItems.length));

  const resElements: DiagramElement[] = [];

  const getMaxHeightPerRow = (row: number) => {
    const maxHeight = libraryItems
      .slice(row * ITEMS_PER_ROW, row * ITEMS_PER_ROW + ITEMS_PER_ROW)
      .reduce((acc, item) => {
        const { height } = getCommonBoundingBox(item.elements);
        return Math.max(acc, height);
      }, 0);
    return maxHeight;
  };

  const getMaxWidthPerCol = (targetCol: number) => {
    let index = 0;
    let currCol = 0;
    let maxWidth = 0;
    for (const item of libraryItems) {
      if (index % ITEMS_PER_ROW === 0) {
        currCol = 0;
      }
      if (currCol === targetCol) {
        const { width } = getCommonBoundingBox(item.elements);
        maxWidth = Math.max(maxWidth, width);
      }
      index++;
      currCol++;
    }
    return maxWidth;
  };

  let colOffsetX = 0;
  let rowOffsetY = 0;

  let maxHeightCurrRow = 0;
  let maxWidthCurrCol = 0;

  let index = 0;
  let col = 0;
  let row = 0;

  for (const item of libraryItems) {
    if (index && index % ITEMS_PER_ROW === 0) {
      rowOffsetY += maxHeightCurrRow + PADDING;
      colOffsetX = 0;
      col = 0;
      row++;
    }

    if (col === 0) {
      maxHeightCurrRow = getMaxHeightPerRow(row);
    }
    maxWidthCurrCol = getMaxWidthPerCol(col);

    const { minX, minY, width, height } = getCommonBoundingBox(item.elements);
    const offsetCenterX = (maxWidthCurrCol - width) / 2;
    const offsetCenterY = (maxHeightCurrRow - height) / 2;
    resElements.push(
      // eslint-disable-next-line no-loop-func
      ...item.elements.map((element) => ({
        ...element,
        x:
          element.x +
          // offset for column
          colOffsetX +
          // offset to center in given square grid
          offsetCenterX -
          // subtract minX so that given item starts at 0 coord
          minX,
        y:
          element.y +
          // offset for row
          rowOffsetY +
          // offset to center in given square grid
          offsetCenterY -
          // subtract minY so that given item starts at 0 coord
          minY,
      })),
    );
    colOffsetX += maxWidthCurrCol + PADDING;
    index++;
    col++;
  }

  return resElements;
};
