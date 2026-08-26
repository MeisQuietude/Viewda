import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  revealOpenedSource,
  shortcutModifier,
  type RecentSource,
} from "./desktop";
import type { OpenFile } from "./open-files";

export function FileSwitcher({
  files,
  recentSources,
  opening,
  onActivate,
  onClose,
  onDismiss,
  onContextMenu,
  onOpenFile,
  onOpenFolder,
  onCancelOpen,
  onOpenRecent,
  onRemoveRecent,
}: {
  files: OpenFile[];
  recentSources: RecentSource[];
  opening: boolean;
  onActivate: (generation: number) => Promise<void>;
  onClose: (generation: number) => Promise<boolean>;
  onDismiss: () => void;
  onContextMenu: (generation: number, x: number, y: number) => void;
  onOpenFile: () => Promise<void>;
  onOpenFolder: () => Promise<void>;
  onCancelOpen: () => void;
  onOpenRecent: (id: string) => Promise<void>;
  onRemoveRecent: (id: string) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const previousFileCount = useRef(files.length);
  const search = query.trim().toLocaleLowerCase();
  const matches = (name: string, path: string) =>
    search.length === 0 ||
    `${name}\n${path}`.toLocaleLowerCase().includes(search);
  const visibleFiles = files.filter((file) => matches(file.name, file.path));
  const openLocations = new Set(
    files.filter((file) => file.kind === "file").map((file) => file.path),
  );
  const visibleRecents = recentSources.filter(
    (entry) =>
      (entry.kind !== "file" || !openLocations.has(entry.path)) &&
      matches(entry.name, entry.path),
  );
  const rows = [
    ...visibleFiles.map((file) => ({ kind: "open" as const, file })),
    ...visibleRecents.map((recent) => ({ kind: "recent" as const, recent })),
  ];
  const directoryLabels = distinguishDirectories(
    rows.map((row) => (row.kind === "open" ? row.file : row.recent)),
  );
  const selectedIndex =
    rows.length === 0 ? -1 : Math.min(highlighted, rows.length - 1);
  const selected = rows[selectedIndex];
  const selectedId =
    selected?.kind === "open"
      ? `file-switcher-open-${selected.file.generation}`
      : selected?.kind === "recent"
        ? `file-switcher-recent-${selected.recent.id}`
        : undefined;

  useEffect(() => setHighlighted(0), [query]);

  useEffect(() => {
    if (files.length > 0 && files.length < previousFileCount.current) {
      searchRef.current?.focus();
    }
    previousFileCount.current = files.length;
  }, [files.length]);

  const choose = async () => {
    if (selected?.kind === "open") {
      await onActivate(selected.file.generation);
      onDismiss();
    } else if (selected?.kind === "recent") {
      await onOpenRecent(selected.recent.id);
    }
  };

  return (
    <div className="file-switcher-backdrop" onPointerDown={onDismiss}>
      <section
        className="file-switcher"
        aria-label="Source switcher"
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onDismiss();
            return;
          }
          if (event.target !== searchRef.current) return;
          if (event.key === "ArrowDown" && rows.length > 0) {
            event.preventDefault();
            setHighlighted((index) => (index + 1) % rows.length);
          } else if (event.key === "ArrowUp" && rows.length > 0) {
            event.preventDefault();
            setHighlighted((index) => (index - 1 + rows.length) % rows.length);
          } else if (event.key === "Enter") {
            event.preventDefault();
            void choose();
          } else if (
            event.key === "Backspace" &&
            (event.metaKey || event.ctrlKey) &&
            selected?.kind === "recent"
          ) {
            event.preventDefault();
            void onRemoveRecent(selected.recent.id);
          }
        }}
      >
        <div className="file-switcher-search-field">
          <input
            ref={searchRef}
            autoFocus
            className="file-switcher-search"
            type="search"
            aria-label="Search sources"
            aria-activedescendant={selectedId}
            aria-controls="file-switcher-results"
            aria-expanded="true"
            role="combobox"
            placeholder="Search sources"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          {query.length === 0 && (
            <kbd className="file-switcher-shortcut" aria-hidden="true">
              {shortcutModifier}P
            </kbd>
          )}
        </div>
        <div
          className="file-switcher-results"
          id="file-switcher-results"
          role="listbox"
          aria-label="Sources"
        >
          {visibleFiles.length > 0 && (
            <Section label="Open sources">
              {visibleFiles.map((file, index) => (
                <Row
                  key={file.generation}
                  id={`file-switcher-open-${file.generation}`}
                  active={file.active}
                  highlighted={index === selectedIndex}
                  name={file.name}
                  directory={
                    file.kind === "file"
                      ? (directoryLabels[index] ?? file.directory)
                      : `${datasetKindLabel(file.kind)} · ${file.datasetMemberCount?.toLocaleString("en-US") ?? "…"} files${file.datasetIgnoredFileCount ? ` · ${file.datasetIgnoredFileCount.toLocaleString("en-US")} ignored` : ""} · ${middleTruncate(file.path)}`
                  }
                  path={file.path}
                  includePathInAccessibleName={file.kind === "file"}
                  busy={file.busy}
                  onChoose={() =>
                    void onActivate(file.generation).then(onDismiss)
                  }
                  onClose={() => void onClose(file.generation)}
                  onContextMenu={(x, y) => onContextMenu(file.generation, x, y)}
                />
              ))}
            </Section>
          )}
          {visibleRecents.length > 0 && (
            <Section label="Recent">
              {visibleRecents.map((entry, index) => (
                <Row
                  key={entry.id}
                  id={`file-switcher-recent-${entry.id}`}
                  highlighted={visibleFiles.length + index === selectedIndex}
                  name={entry.name}
                  directory={
                    entry.kind === "file"
                      ? (directoryLabels[visibleFiles.length + index] ??
                        entry.directory)
                      : `${datasetKindLabel(entry.kind)} · ${middleTruncate(entry.path)}`
                  }
                  path={entry.path}
                  onChoose={() => void onOpenRecent(entry.id)}
                />
              ))}
            </Section>
          )}
          {rows.length === 0 && (
            <p className="file-switcher-empty">No matching sources</p>
          )}
        </div>
        <div className="file-switcher-actions">
          <button
            className="file-switcher-footer"
            type="button"
            onClick={() => (opening ? onCancelOpen() : void onOpenFile())}
          >
            {opening ? (
              <span>Cancel opening</span>
            ) : (
              <>
                <span>Open file…</span>
                <kbd aria-hidden="true">{shortcutModifier}O</kbd>
              </>
            )}
          </button>
          <button
            className="file-switcher-footer"
            type="button"
            title="Open every Parquet file in the selected folder and its subfolders as one dataset. Hive-style key=value folders become columns."
            disabled={opening}
            onClick={() => void onOpenFolder()}
          >
            <span>Open folder as dataset…</span>
            <kbd aria-hidden="true">⇧{shortcutModifier}O</kbd>
          </button>
        </div>
      </section>
    </div>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="file-switcher-section" role="group" aria-label={label}>
      <h2>{label}</h2>
      <div>{children}</div>
    </section>
  );
}

function Row({
  id,
  active = false,
  highlighted,
  name,
  directory,
  path,
  includePathInAccessibleName = true,
  busy = false,
  onChoose,
  onClose,
  onContextMenu,
}: {
  id: string;
  active?: boolean;
  highlighted: boolean;
  name: string;
  directory: string;
  path?: string;
  includePathInAccessibleName?: boolean;
  busy?: boolean;
  onChoose: () => void;
  onClose?: () => void;
  onContextMenu?: (x: number, y: number) => void;
}) {
  return (
    <div
      className={`file-switcher-row${highlighted ? " is-highlighted" : ""}`}
      title={path}
      onContextMenu={(event) => {
        if (onContextMenu === undefined) return;
        event.preventDefault();
        onContextMenu(event.clientX, event.clientY);
      }}
    >
      <button
        className="file-switcher-choice"
        id={id}
        type="button"
        role="option"
        aria-label={`${name} — ${directory}${path === undefined || !includePathInAccessibleName ? "" : ` — ${path}`}`}
        aria-selected={highlighted}
        onClick={onChoose}
      >
        <span className="file-switcher-mark" aria-hidden="true">
          {active && "✓"}
          {busy && <span className="file-switcher-spinner" />}
        </span>
        <span className="file-switcher-copy">
          <span className="file-switcher-name">{name}</span>
          <span className="file-switcher-directory">{directory}</span>
        </span>
      </button>
      {onClose !== undefined && (
        <button
          className="file-switcher-close"
          type="button"
          aria-label={`Close ${name}`}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

export function middleTruncate(value: string, maximum = 56): string {
  const characters = Array.from(value);
  if (characters.length <= maximum) return value;
  const left = Math.ceil((maximum - 1) / 2);
  const right = Math.floor((maximum - 1) / 2);
  return `${characters.slice(0, left).join("")}…${characters.slice(-right).join("")}`;
}

function distinguishDirectories(
  entries: readonly { name: string; directory: string; path: string }[],
): string[] {
  const candidates = entries.map((entry, index) => {
    const rivals = entries
      .filter(
        (other, otherIndex) =>
          otherIndex !== index && other.name === entry.name,
      )
      .map((other) => directorySegments(other.path));
    if (rivals.length === 0) {
      return { label: entry.directory, distinguishingSegment: null };
    }

    const segments = directorySegments(entry.path);
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const tail = segments.slice(-depth);
      if (rivals.every((rival) => !endsWithSegments(rival, tail))) {
        return {
          label: `…/${tail.join("/")}`,
          distinguishingSegment: tail[0] ?? null,
        };
      }
    }
    return { label: entry.directory, distinguishingSegment: null };
  });
  const labels = candidates.map(({ label }) => middleTruncate(label));
  const needsDisambiguation = entries.map((entry, index) =>
    entries.some(
      (other, otherIndex) =>
        otherIndex !== index &&
        other.name === entry.name &&
        labels[otherIndex] === labels[index],
    ),
  );

  entries.forEach((entry, index) => {
    if (!needsDisambiguation[index]) return;
    const segments = directorySegments(entry.path);
    const distinguishingSegment =
      candidates[index]?.distinguishingSegment ??
      segments.at(-1) ??
      entry.directory;
    const stableTail = segments.slice(-2).join("/");
    labels[index] =
      `…/${middleTruncate(distinguishingSegment, 30)}/…/${middleTruncate(stableTail, 18)}`;
  });

  collidingLabelGroups(entries, labels).forEach((indices) => {
    const directories = indices.map((index) =>
      directoryPath(entries[index]!.path),
    );
    indices.forEach((index, groupIndex) => {
      const stableTail = directorySegments(entries[index]!.path).at(-1) ?? "";
      const fragment = uniquePathFragment(
        directories[groupIndex]!,
        directories.filter((_, rivalIndex) => rivalIndex !== groupIndex),
      );
      labels[index] = `${fragment}/…/${middleTruncate(stableTail, 18)}`;
    });
  });

  const remainingByName = new Map<string, number[]>();
  new Set(collidingLabelGroups(entries, labels).flat()).forEach((index) => {
    const name = entries[index]!.name;
    remainingByName.set(name, [...(remainingByName.get(name) ?? []), index]);
  });
  remainingByName.forEach((indices) => {
    const signatures = distinguishingCharacters(
      indices.map((index) => directoryPath(entries[index]!.path)),
    );
    indices.forEach((index, groupIndex) => {
      const stableTail = directorySegments(entries[index]!.path).at(-1) ?? "";
      labels[index] =
        `…/‹${signatures[groupIndex]}›/…/${middleTruncate(stableTail, 18)}`;
    });
  });

  return labels;
}

function collidingLabelGroups(
  entries: readonly { name: string; path: string }[],
  labels: readonly string[],
): number[][] {
  const groups = new Map<string, number[]>();
  entries.forEach((entry, index) => {
    const key = JSON.stringify([entry.name, labels[index]]);
    groups.set(key, [...(groups.get(key) ?? []), index]);
  });
  return [...groups.values()].filter(
    (indices) =>
      indices.length > 1 &&
      new Set(indices.map((index) => entries[index]!.path)).size > 1,
  );
}

function datasetKindLabel(kind: "folderDataset" | "fileDataset"): string {
  return kind === "folderDataset" ? "Folder dataset" : "Selected files";
}

function uniquePathFragment(value: string, rivals: readonly string[]): string {
  const characters = Array.from(value);
  const maximumContent = 26;
  for (
    let length = 1;
    length <= Math.min(maximumContent, characters.length);
    length += 1
  ) {
    for (let start = 0; start + length <= characters.length; start += 1) {
      const candidate = characters.slice(start, start + length).join("");
      if (rivals.some((rival) => rival.includes(candidate))) continue;

      const contextLength = Math.min(maximumContent, Math.max(length, 12));
      const contextStart = Math.max(
        0,
        Math.min(
          start - Math.floor((contextLength - length) / 2),
          characters.length - contextLength,
        ),
      );
      const contextEnd = Math.min(
        characters.length,
        contextStart + contextLength,
      );
      return `${contextStart > 0 ? "…" : ""}${characters.slice(contextStart, contextEnd).join("")}${contextEnd < characters.length ? "…" : ""}`;
    }
  }
  return middleTruncate(value, 28);
}

function distinguishingCharacters(values: readonly string[]): string[] {
  const characters = values.map((value) => Array.from(value));
  const maximumLength = Math.max(...characters.map((value) => value.length));
  const positions = Array.from(
    { length: maximumLength },
    (_, index) => index,
  ).filter(
    (position) =>
      new Set(characters.map((value) => value[position] ?? "∅")).size > 1,
  );
  const selected: number[] = [];
  const signature = (value: readonly string[], extra?: number) =>
    [...selected, ...(extra === undefined ? [] : [extra])]
      .map((position) => value[position] ?? "∅")
      .join("");
  while (
    new Set(characters.map((value) => signature(value))).size < values.length
  ) {
    const next = positions
      .filter((position) => !selected.includes(position))
      .map((position) => ({
        position,
        groups: new Set(characters.map((value) => signature(value, position)))
          .size,
      }))
      .sort(
        (left, right) =>
          right.groups - left.groups || left.position - right.position,
      )[0];
    if (next === undefined) break;
    selected.push(next.position);
  }
  selected.sort((left, right) => left - right);
  return characters.map((value) =>
    selected.map((position) => value[position] ?? "∅").join("·"),
  );
}

function directoryPath(path: string): string {
  return directorySegments(path).join("/");
}

function directorySegments(path: string): string[] {
  return path
    .split(/[/\\]/)
    .slice(0, -1)
    .filter((segment) => segment.length > 0);
}

function endsWithSegments(
  segments: readonly string[],
  tail: readonly string[],
): boolean {
  return (
    segments.length >= tail.length &&
    tail.every(
      (segment, index) =>
        segments[segments.length - tail.length + index] === segment,
    )
  );
}

export function FileContextMenu({
  file,
  x,
  y,
  onClose,
  onDismiss,
  onCloseOthers,
  onReload,
}: {
  file: OpenFile | null;
  x: number;
  y: number;
  onClose: () => void;
  onDismiss: () => void;
  onCloseOthers: () => void;
  onReload?: () => void;
}) {
  useEffect(() => {
    window.addEventListener("pointerdown", onDismiss, { once: true });
    window.addEventListener("blur", onDismiss, { once: true });
    return () => {
      window.removeEventListener("pointerdown", onDismiss);
      window.removeEventListener("blur", onDismiss);
    };
  }, [onDismiss]);

  if (file === null) return null;
  return (
    <div
      className="file-context-menu"
      role="menu"
      style={{
        left: Math.max(8, Math.min(x, window.innerWidth - 218)),
        top: Math.max(8, Math.min(y, window.innerHeight - 154)),
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {file.kind !== "file" && onReload !== undefined && (
        <button type="button" role="menuitem" onClick={onReload}>
          Reload dataset
        </button>
      )}
      <button type="button" role="menuitem" onClick={onClose}>
        Close
      </button>
      <button type="button" role="menuitem" onClick={onCloseOthers}>
        Close Others
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          void navigator.clipboard.writeText(file.path);
          onDismiss();
        }}
      >
        Copy Path
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          void revealOpenedSource(file.generation);
          onDismiss();
        }}
      >
        Reveal in file manager
      </button>
    </div>
  );
}
