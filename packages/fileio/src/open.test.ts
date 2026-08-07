// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canPickHandles, createDropTarget, pickFiles, type OpenedFile } from "./open";

/**
 * The drop target's two real bugs, asserted.
 *
 * Both are about `preventDefault`, and both are *data loss* rather than cosmetic — which is why they get tests
 * rather than a comment. Dropping a file on a page that has not cancelled the default does not "do nothing": the
 * browser navigates to the file, and every unsaved edit in the session goes with it.
 */

let host: HTMLElement;
let child: HTMLElement;

/**
 * Every target created, disposed in `afterEach`.
 *
 * Not tidiness. `createDropTarget` installs listeners on `document`, which `document.body.innerHTML = ""` does
 * not remove — so a test that throws before its own `dispose()` leaks a guard into every test after it. That
 * happened while writing this file: one genuinely failing assertion produced two failures, and the second one
 * pointed at `dispose` rather than at the test that broke. A cascading failure hides its own cause.
 */
const targets: { dispose(): void }[] = [];
const track = <T extends { dispose(): void }>(target: T): T => {
  targets.push(target);
  return target;
};

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  child = document.createElement("span");
  host.appendChild(child);
  document.body.appendChild(host);
});

afterEach(() => {
  for (const target of targets.splice(0)) target.dispose();
  vi.restoreAllMocks();
});

/**
 * A DragEvent stand-in.
 *
 * happy-dom has no `DragEvent` and no `DataTransfer`, so these are built by hand. That is fine and arguably
 * better: the shape used is exactly the shape the code depends on, so anything else it started depending on
 * would fail loudly here rather than pass against a generous polyfill.
 */
function dragEvent(
  type: string,
  init: { files?: File[]; items?: unknown[] } = {},
): Event & { dataTransfer: unknown; defaultPreventedBy?: string } {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const dataTransfer = {
    files: init.files ?? [],
    items: init.items ?? [],
    dropEffect: "none",
    types: init.files === undefined ? [] : ["Files"],
  };
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer, writable: false });
  return event as Event & { dataTransfer: typeof dataTransfer };
}

const ifcFile = (name = "Tower-A.ifc"): File =>
  new File(["ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n"], name, { type: "" });

describe("the default that navigates your session away", () => {
  it("cancels dragover on the target, or there is no drop event at all", () => {
    // The load-bearing line. Without `preventDefault` on `dragover` the browser never fires `drop` — it
    // navigates to the dropped file instead, replacing the page.
    track(createDropTarget(host, { onFiles: () => {} }));
    const event = dragEvent("dragover");
    host.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect((event.dataTransfer as { dropEffect: string }).dropEffect).toBe("copy");
  });

  it("cancels a drop that MISSES the target, so bad aim is not data loss", () => {
    // The subtler half. A user who lands ten pixels outside the canvas hits the document, whose default is the
    // same navigation. Guarding only the target leaves a data-loss bug triggered by aim.
    track(createDropTarget(host, { onFiles: () => {} }));
    const outside = document.createElement("p");
    document.body.appendChild(outside);

    for (const type of ["dragover", "drop"]) {
      const event = dragEvent(type, { files: [ifcFile()] });
      outside.dispatchEvent(event);
      expect(event.defaultPrevented, `${type} outside the target`).toBe(true);
      expect((event.dataTransfer as { dropEffect: string }).dropEffect).toBe("none");
    }
  });

  it("does not let the document guard steal a drop ON the target", async () => {
    // The guard must not swallow the real thing. Since both handlers see the event, the guard has to check
    // containment — and getting that backwards would make the feature never work at all.
    //
    // Awaited, because reading the head of each file is async: `onFiles` cannot have been called by the time
    // `dispatchEvent` returns, and asserting synchronously (as a first version did) fails for a reason that has
    // nothing to do with what is being tested.
    const dropped = await new Promise<readonly OpenedFile[]>((resolve) => {
      track(createDropTarget(host, { onFiles: resolve }));
      // Dispatched on the CHILD, which is inside the host — so containment has to be checked, not assumed.
      child.dispatchEvent(dragEvent("drop", { files: [ifcFile()] }));
    });
    expect(dropped).toHaveLength(1);
  });
});

describe("hover, which every hand-rolled drop zone gets wrong", () => {
  it("stays hovering when the cursor crosses into a child element", async () => {
    // `dragenter` on the child fires BEFORE `dragleave` on the parent, so a boolean flag is set false while the
    // pointer is still inside — the overlay flickers, or worse, hides and stops accepting the drop. The fix is a
    // depth counter, because enter/leave are properly nested and a boolean cannot represent nesting.
    const states: boolean[] = [];
    track(createDropTarget(host, { onFiles: () => {}, onHover: (h) => states.push(h) }));

    host.dispatchEvent(dragEvent("dragenter")); // enter the host
    child.dispatchEvent(dragEvent("dragenter")); // enter the child (bubbles to the host handler)
    host.dispatchEvent(dragEvent("dragleave")); // leave the host, fired after the child's enter

    expect(states).toEqual([true]); // one enter, no spurious leave
  });

  it("reports leaving exactly once, when the last level unwinds", () => {
    const states: boolean[] = [];
    track(createDropTarget(host, { onFiles: () => {}, onHover: (h) => states.push(h) }));

    host.dispatchEvent(dragEvent("dragenter"));
    child.dispatchEvent(dragEvent("dragenter"));
    child.dispatchEvent(dragEvent("dragleave"));
    host.dispatchEvent(dragEvent("dragleave"));

    expect(states).toEqual([true, false]);
  });

  it("clears hover on drop, not only on leave", () => {
    // A drop does not fire `dragleave`, so an overlay that only listens for leave stays up forever after a
    // successful drop — which looks like the app hung at the exact moment it succeeded.
    const states: boolean[] = [];
    track(createDropTarget(host, { onFiles: () => {}, onHover: (h) => states.push(h) }));
    host.dispatchEvent(dragEvent("dragenter"));
    host.dispatchEvent(dragEvent("drop", { files: [] }));
    expect(states).toEqual([true, false]);
  });

  it("never goes negative, so a stray leave cannot invert the state", () => {
    const states: boolean[] = [];
    track(createDropTarget(host, { onFiles: () => {}, onHover: (h) => states.push(h) }));
    // A leave with no matching enter happens for real: a drag that began before the listener was attached.
    host.dispatchEvent(dragEvent("dragleave"));
    host.dispatchEvent(dragEvent("dragenter"));
    expect(states).toEqual([true]);
  });
});

describe("what a drop yields", () => {
  it("sniffs each file and attaches its support state", async () => {
    const dropped = await new Promise<readonly OpenedFile[]>((resolve) => {
      track(createDropTarget(host, { onFiles: (files) => resolve(files) }));
      host.dispatchEvent(dragEvent("drop", { files: [ifcFile(), new File(["PKjunk"], "model.ifc")] }));
    });

    expect(dropped).toHaveLength(2);
    expect(dropped[0]!.sniffed.kind).toBe("ifc");
    expect(dropped[0]!.sniffed.schema).toBe("IFC4");
    expect(dropped[0]!.support.state).toBe("supported");

    // The mislabelled one comes through too, flagged rather than dropped. A UI that silently discards it is a UI
    // where the user believes they opened a file they did not.
    expect(dropped[1]!.sniffed.kind).toBe("zip");
    expect(dropped[1]!.sniffed.agrees).toBe(false);
    expect(dropped[1]!.support.state).toBe("planned");
  });

  it("reads the whole file only when asked", async () => {
    const dropped = await new Promise<readonly OpenedFile[]>((resolve) => {
      track(createDropTarget(host, { onFiles: (files) => resolve(files) }));
      host.dispatchEvent(dragEvent("drop", { files: [ifcFile()] }));
    });
    // `bytes()` is a function, not a field, so dropping a folder of 240 MB models does not make all of them
    // resident before the user has picked one.
    expect(typeof dropped[0]!.bytes).toBe("function");
    expect((await dropped[0]!.bytes()).length).toBe(dropped[0]!.size);
    expect(await dropped[0]!.text()).toContain("ISO-10303-21");
  });

  it("says so when it truncates, rather than quietly taking the first N", async () => {
    // Silent truncation reads as "the importer is broken". A drop of 900 files that quietly loaded 500 is worse
    // than a refusal, because nothing distinguishes it from success.
    const errors: string[] = [];
    const files = Array.from({ length: 6 }, (_, i) => ifcFile(`m${i}.ifc`));
    const dropped = await new Promise<readonly OpenedFile[]>((resolve) => {
      track(createDropTarget(host, {
        limit: 3,
        onError: (m) => errors.push(m),
        onFiles: (f) => resolve(f),
      }));
      host.dispatchEvent(dragEvent("drop", { files }));
    });
    expect(dropped).toHaveLength(3);
    expect(errors.join(" ")).toMatch(/first 3 file/);
  });

  it("falls back to dataTransfer.files when the entry walk yields nothing", async () => {
    // Found in WebKit, and it broke drag-and-drop in Safari completely. `webkitGetAsEntry` returns an entry, so
    // the entry path is taken — and then `entry.file()` invokes its *error* callback, so the walk produces no
    // files. `dataTransfer.files` had the file the whole time.
    //
    // The general rule this encodes: the entry API exists to add folder support, so it is an enhancement over
    // `.files`. Failing to use it must never lose a file `.files` already holds.
    const errors: string[] = [];
    const brokenEntry = {
      name: "Tower-A.ifc",
      isFile: true,
      isDirectory: false,
      // The failure shape exactly: the success callback is never called, the error callback is.
      file: (_ok: (f: File) => void, fail: () => void) => fail(),
    };

    const dropped = await new Promise<readonly OpenedFile[]>((resolve) => {
      track(createDropTarget(host, { onFiles: resolve, onError: (m) => errors.push(m) }));
      host.dispatchEvent(
        dragEvent("drop", {
          files: [ifcFile()],
          items: [{ webkitGetAsEntry: () => brokenEntry }],
        }),
      );
    });

    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.sniffed.kind).toBe("ifc");
    // And silently: the fallback succeeded, so "could not read Tower-A.ifc" would be noise about an internal
    // detail the user neither caused nor can act on.
    expect(errors).toEqual([]);
  });

  it("still reports a genuine read failure when there is nothing to fall back to", async () => {
    // The other side of the same branch. Clearing the errors unconditionally would make a real unreadable file
    // silently vanish, which is worse than the bug it was fixing.
    const errors: string[] = [];
    const brokenEntry = {
      name: "gone.ifc",
      isFile: true,
      isDirectory: false,
      file: (_ok: (f: File) => void, fail: () => void) => fail(),
    };

    const dropped = await new Promise<readonly OpenedFile[]>((resolve) => {
      track(createDropTarget(host, { onFiles: resolve, onError: (m) => errors.push(m) }));
      host.dispatchEvent(dragEvent("drop", { files: [], items: [{ webkitGetAsEntry: () => brokenEntry }] }));
    });

    expect(dropped).toEqual([]);
    expect(errors).toEqual(["could not read gone.ifc"]);
  });

  it("calls back even when nothing is supported", async () => {
    // "You dropped four .las files; point clouds are M10" is useful. Silence is not, and a callback that only
    // fires for openable files makes silence the default for every unsupported drop.
    const dropped = await new Promise<readonly OpenedFile[]>((resolve) => {
      track(createDropTarget(host, { onFiles: (f) => resolve(f) }));
      host.dispatchEvent(dragEvent("drop", { files: [new File(["LASF...."], "scan.las")] }));
    });
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.support.state).toBe("planned");
    expect(dropped[0]!.support.reason).toMatch(/point clouds/);
  });
});

describe("dispose", () => {
  it("removes the document guard as well as the target listeners", () => {
    // The document listeners are the easy ones to forget, and forgetting them means a disposed viewer keeps
    // swallowing drops for the rest of the page's life — a bug with no visible cause.
    const onFiles = vi.fn();
    const target = track(createDropTarget(host, { onFiles }));
    target.dispose();
    // Disposed here *and* again in `afterEach`. That is deliberate: `removeEventListener` for a listener that is
    // already gone is a no-op, so double disposal has to be harmless — and a viewer torn down twice by a
    // framework's cleanup is a real situation, not a hypothetical.

    const onTarget = dragEvent("dragover");
    host.dispatchEvent(onTarget);
    expect(onTarget.defaultPrevented).toBe(false);

    const outside = document.createElement("p");
    document.body.appendChild(outside);
    const missed = dragEvent("dragover");
    outside.dispatchEvent(missed);
    expect(missed.defaultPrevented).toBe(false);

    host.dispatchEvent(dragEvent("drop", { files: [ifcFile()] }));
    expect(onFiles).not.toHaveBeenCalled();
  });
});

describe("the picker, and why the fallback is not a nicety", () => {
  it("uses an <input> where showOpenFilePicker does not exist", async () => {
    // Safari and Firefox have no File System Access picker, and Safari is the stated differentiator for this
    // project. A picker that only works in Chromium would disable opening a file on the platform this is meant
    // to win on, so the fallback is load-bearing.
    expect(canPickHandles()).toBe(false); // happy-dom has no showOpenFilePicker, which is the case under test

    const pending = pickFiles({ accept: [".ifc"] });
    // The input is created, appended and clicked; drive it the way a user would.
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.accept).toBe(".ifc");
    expect(input.multiple).toBe(true);

    Object.defineProperty(input, "files", { value: [ifcFile()], writable: false });
    input.dispatchEvent(new Event("change"));

    const result = await pending;
    expect(result.via).toBe("input");
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.sniffed.kind).toBe("ifc");
    // And the element is cleaned up, or every picker call leaks a hidden input into the body.
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it("resolves rather than hanging when the dialog is dismissed", async () => {
    // Without the `cancel` listener this promise stays pending forever. That is a leak with no symptom until
    // someone awaits it, which is the worst kind: it looks like the picker is slow.
    const pending = pickFiles();
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    input.dispatchEvent(new Event("cancel"));
    const result = await pending;
    expect(result.files).toEqual([]);
    expect(result.via).toBe("input");
  });

  it("prefers handles when they exist, and reports which path ran", async () => {
    // `via` exists because the two are not equivalent: handles can be persisted so a recent-files list actually
    // reopens, an <input> cannot. A UI offering "reopen" has to know which it got.
    const handle = { getFile: async () => ifcFile() };
    vi.stubGlobal("showOpenFilePicker", vi.fn(async () => [handle]));
    expect(canPickHandles()).toBe(true);

    const result = await pickFiles({ accept: [".ifc"], description: "Models" });
    expect(result.via).toBe("handles");
    expect(result.handles).toHaveLength(1);
    expect(result.files[0]!.sniffed.kind).toBe("ifc");
  });

  it("treats AbortError as a cancellation and anything else as real", async () => {
    // Cancelling is not an error. Collapsing every rejection into "cancelled" would hide a genuine failure —
    // a permission policy blocking the picker, say — behind a shrug.
    vi.stubGlobal("showOpenFilePicker", vi.fn(async () => {
      throw new DOMException("The user aborted a request.", "AbortError");
    }));
    await expect(pickFiles()).resolves.toMatchObject({ files: [], via: "handles" });

    vi.stubGlobal("showOpenFilePicker", vi.fn(async () => {
      throw new DOMException("File picker blocked by permissions policy", "SecurityError");
    }));
    await expect(pickFiles()).rejects.toThrow(/permissions policy/);
  });
});
