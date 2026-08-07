import { SNIFF_BYTES, sniff, type Sniffed } from "./sniff.js";
import { supportFor, type Support } from "./support.js";

/**
 * Getting files *into* the application — drag-and-drop, and a picker.
 *
 * Vanilla DOM for the reason ADR-0009 gives about the ribbon: massing's shell is plain TypeScript, development
 * continues there, and a drop target that only works inside React is a drop target massing has to write twice.
 *
 * ## Two bugs that are the entire difficulty
 *
 * **Without `preventDefault` on `dragover`, the drop never fires — and the browser navigates to the file.** Not
 * "nothing happens": the page is *replaced* by the dropped file, and every unsaved edit in the session is gone.
 * The default action for a dropped file is navigation, and cancelling it is opt-in.
 *
 * And it is not enough to cancel it on the drop target. A user who misses the canvas by ten pixels hits the
 * document, whose default is the same navigation. So {@link createDropTarget} installs a document-level guard as
 * well — which is the difference between an app that survives a near-miss and one that loses your work when your
 * aim is off.
 *
 * **`dragleave` fires when the cursor crosses into a child element.** Every naive drop overlay flickers for this
 * reason, and worse, it ends up hidden while the pointer is still over the target. The fix is a depth counter
 * rather than a boolean, because enter/leave are properly nested and a boolean cannot represent nesting.
 */

/** What a caller gets, per file. Sniffed and routed, but not decoded — decoding belongs to whoever wants it. */
export interface OpenedFile {
  readonly name: string;
  readonly size: number;
  readonly file: File;
  readonly sniffed: Sniffed;
  readonly support: Support;
  /** The first {@link SNIFF_BYTES} bytes, already read. Reused rather than read twice. */
  readonly head: Uint8Array;
  /** Read the whole thing. Deliberately a function: a 240 MB file should not be resident until asked for. */
  bytes(): Promise<Uint8Array>;
  text(): Promise<string>;
}

export interface DropTargetOptions {
  /**
   * Files were dropped. Already sniffed, in the order the OS gave them.
   *
   * Called even when nothing is supported, because "you dropped four `.las` files, point clouds are M10" is a
   * useful thing to say and silence is not.
   */
  readonly onFiles: (files: readonly OpenedFile[]) => void;
  /** Hover state changed. For an overlay. Fires once per real enter and once per real leave, never per child. */
  readonly onHover?: (hovering: boolean) => void;
  /** Something went wrong reading a dropped item — a directory the browser refused, a file that vanished. */
  readonly onError?: (message: string) => void;
  /** Recurse into dropped folders. Default true; a user who drags a project folder means all of it. */
  readonly folders?: boolean;
  /** Cap on files taken from one drop, so a dropped home directory does not hang the tab. Default 500. */
  readonly limit?: number;
}

export interface DropTarget {
  dispose(): void;
}

async function describeFile(file: File): Promise<OpenedFile> {
  const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
  const sniffed = sniff(file.name, head, file.size);
  return {
    name: file.name,
    size: file.size,
    file,
    head,
    sniffed,
    support: supportFor(sniffed.kind),
    bytes: async () => new Uint8Array(await file.arrayBuffer()),
    text: () => file.text(),
  };
}

/**
 * Walk a dropped entry tree.
 *
 * `webkitGetAsEntry` is the only way to see a dropped *directory*, and despite the vendor prefix it is what
 * every current browser implements — including Safari. The unprefixed `getAsFileSystemHandle` exists in Chromium
 * only, so using it would make folder drops a Chromium feature, and Safari is the stated moat.
 */
async function collect(
  entry: FileSystemEntry,
  into: File[],
  limit: number,
  onError: (message: string) => void,
): Promise<void> {
  if (into.length >= limit) return;
  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) => {
      (entry as FileSystemFileEntry).file(resolve, () => resolve(null));
    });
    if (file === null) onError(`could not read ${entry.name}`);
    else into.push(file);
    return;
  }
  if (!entry.isDirectory) return;

  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // `readEntries` returns a *batch* and must be called until it returns none. Reading it once is a real bug and
  // an easy one to miss, because the first batch is 100 entries and most test folders are smaller.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve) => {
      reader.readEntries(resolve, () => resolve([]));
    });
    if (batch.length === 0) break;
    for (const child of batch) {
      await collect(child, into, limit, onError);
      if (into.length >= limit) return;
    }
  }
}

export function createDropTarget(element: HTMLElement, options: DropTargetOptions): DropTarget {
  const limit = options.limit ?? 500;
  const wantFolders = options.folders !== false;
  const onError = options.onError ?? (() => {});

  /**
   * Nesting depth, not a boolean.
   *
   * `dragenter` on a child fires *before* `dragleave` on the parent, so the sequence crossing into a child is
   * enter(child), leave(parent) — and a boolean set to false by that leave hides the overlay while the pointer
   * is still inside. The counter is the standard fix and the reason every hand-rolled drop zone flickers.
   */
  let depth = 0;
  const setHover = (hovering: boolean): void => options.onHover?.(hovering);

  const onDragEnter = (event: DragEvent): void => {
    event.preventDefault();
    depth++;
    if (depth === 1) setHover(true);
  };

  const onDragOver = (event: DragEvent): void => {
    // The load-bearing line in this file. Without it there is no drop event at all, and the browser navigates to
    // the file, discarding the session.
    event.preventDefault();
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "copy";
  };

  const onDragLeave = (event: DragEvent): void => {
    event.preventDefault();
    // The `was > 0` guard, not just a clamp at zero. A stray `dragleave` with no matching `dragenter` is real —
    // it happens for a drag that began before this listener was attached — and clamping alone still fires
    // `onHover(false)` for it, because depth is already 0 and `depth === 0` is trivially true. That emits a
    // "stopped hovering" for a hover that never started, which flips an overlay on for the *next* drag.
    const wasInside = depth > 0;
    depth = Math.max(0, depth - 1);
    if (wasInside && depth === 0) setHover(false);
  };

  const onDrop = (event: DragEvent): void => {
    event.preventDefault();
    depth = 0;
    setHover(false);
    const transfer = event.dataTransfer;
    if (transfer === null) return;

    // `items` must be read synchronously: the DataTransfer is neutered the moment this handler returns, so any
    // `await` before touching it yields an empty list. Snapshot the entries first, then go async.
    const entries: FileSystemEntry[] = [];
    if (wantFolders && typeof transfer.items?.[0]?.webkitGetAsEntry === "function") {
      for (const item of transfer.items) {
        const entry = item.webkitGetAsEntry();
        if (entry !== null) entries.push(entry);
      }
    }
    const plain = [...transfer.files];

    void (async () => {
      const files: File[] = [];
      /**
       * Errors from the entry walk, held rather than reported immediately.
       *
       * Because the walk might not be the path that succeeds. **WebKit hands back a `FileSystemEntry` whose
       * `file()` callback fails**, so the entry API is present, appears usable, and yields nothing — while
       * `dataTransfer.files` has the file the whole time. A first version reported "could not read scan.las" and
       * stopped there, which meant drag-and-drop did not work in Safari at all: the browser this project treats
       * as its differentiator.
       *
       * The general rule is worth more than the specific fix. The entry API exists to add *folder* support; it is
       * an enhancement over `.files`, so failing to use it must never lose a file that `.files` already holds.
       */
      const entryErrors: string[] = [];
      if (entries.length > 0) {
        for (const entry of entries) await collect(entry, files, limit, (message) => entryErrors.push(message));
      }

      if (files.length === 0 && plain.length > 0) {
        // Recovered, so the entry-walk failures were not failures — reporting them would be noise about an
        // internal fallback the user neither caused nor needs to know about.
        files.push(...plain.slice(0, limit));
        entryErrors.length = 0;
      }
      for (const message of entryErrors) onError(message);

      if (plain.length > limit || files.length >= limit) {
        // Never silently truncate. A drop that quietly took 500 of 900 files reads as "the importer is broken".
        onError(`took the first ${limit} file(s); drop fewer, or raise the limit`);
      }
      options.onFiles(await Promise.all(files.map(describeFile)));
    })();
  };

  element.addEventListener("dragenter", onDragEnter);
  element.addEventListener("dragover", onDragOver);
  element.addEventListener("dragleave", onDragLeave);
  element.addEventListener("drop", onDrop);

  /**
   * The document-level guard.
   *
   * Cancels the default for drops that miss the target. Without it, landing ten pixels outside the canvas
   * navigates the tab to the dropped file and takes the session with it — a data-loss bug caused by *aim*.
   */
  const swallow = (event: DragEvent): void => {
    if (element.contains(event.target as Node)) return;
    event.preventDefault();
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "none";
  };
  document.addEventListener("dragover", swallow);
  document.addEventListener("drop", swallow);

  return {
    dispose(): void {
      element.removeEventListener("dragenter", onDragEnter);
      element.removeEventListener("dragover", onDragOver);
      element.removeEventListener("dragleave", onDragLeave);
      element.removeEventListener("drop", onDrop);
      document.removeEventListener("dragover", swallow);
      document.removeEventListener("drop", swallow);
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// The picker
// ---------------------------------------------------------------------------------------------------

export interface PickOptions {
  readonly multiple?: boolean;
  /** Extensions to suggest, e.g. `[".ifc", ".ifczip"]`. A suggestion only — {@link sniff} still decides. */
  readonly accept?: readonly string[];
  readonly description?: string;
}

export interface PickResult {
  readonly files: readonly OpenedFile[];
  /**
   * Which mechanism ran.
   *
   * Reported because the two are not equivalent, and the difference is user-visible: `handles` can be persisted
   * so a recent-files list actually *reopens*, `input` cannot. A UI that offers "reopen" needs to know which one
   * it got, and today it is Chromium versus everything else.
   */
  readonly via: "handles" | "input";
  /** File System Access handles, when available. Persistable in IndexedDB for genuine reopening. */
  readonly handles?: readonly FileSystemFileHandle[];
}

/** Does this browser have the File System Access picker? */
export function canPickHandles(): boolean {
  return typeof (globalThis as { showOpenFilePicker?: unknown }).showOpenFilePicker === "function";
}

/**
 * Open a file picker, using File System Access where it exists and an `<input>` where it does not.
 *
 * The fallback is not a nicety. `showOpenFilePicker` is Chromium-only: **Safari does not have it, and neither
 * does Firefox.** Safari and iPad are the stated differentiator for this project, so a picker that only works in
 * Chrome would disable opening a file on the platform the product is meant to win on.
 *
 * Resolves with an empty list when the user cancels, rather than rejecting. Cancellation is not an error, and
 * making it one forces every caller to write a try/catch that distinguishes "no thanks" from "it broke".
 */
export async function pickFiles(options: PickOptions = {}): Promise<PickResult> {
  const multiple = options.multiple ?? true;

  if (canPickHandles()) {
    const picker = (globalThis as unknown as {
      showOpenFilePicker: (o: unknown) => Promise<FileSystemFileHandle[]>;
    }).showOpenFilePicker;
    try {
      const handles = await picker({
        multiple,
        excludeAcceptAllOption: false,
        types:
          options.accept === undefined
            ? []
            : [{ description: options.description ?? "Models", accept: { "*/*": [...options.accept] } }],
      });
      const files = await Promise.all(handles.map(async (h) => describeFile(await h.getFile())));
      return { files, via: "handles", handles };
    } catch (error) {
      // AbortError is the user pressing Cancel. Anything else is real and should not be swallowed into "cancelled".
      if (error instanceof DOMException && error.name === "AbortError") return { files: [], via: "handles", handles: [] };
      throw error;
    }
  }

  return await new Promise<PickResult>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = multiple;
    if (options.accept !== undefined) input.accept = options.accept.join(",");
    input.style.display = "none";

    let settled = false;
    const finish = async (files: readonly File[]): Promise<void> => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve({ files: await Promise.all(files.map(describeFile)), via: "input" });
    };

    input.addEventListener("change", () => void finish([...(input.files ?? [])]));
    // `cancel` is the only signal that the dialog was dismissed, and it is recent. Without it a cancelled picker
    // leaves this promise pending forever, which is a leak with no symptom until the caller awaits it.
    input.addEventListener("cancel", () => void finish([]));

    document.body.appendChild(input);
    input.click();
  });
}
