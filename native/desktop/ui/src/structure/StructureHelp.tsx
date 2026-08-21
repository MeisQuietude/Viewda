import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const HELP = {
  "Row groups":
    "A row group is a batch of rows stored together. For example, a filter can skip the whole batch when its statistics show no matching values.",
  "Rows per group":
    "This is the average number of rows in each row group. For example, 1 million rows across 10 groups is about 100,000 rows per group.",
  Storage:
    "Column data on disk sums compressed page data in column chunks; Before compression sums those pages before codec compression. File on disk also includes separately stored Bloom filters, page indexes, footer metadata and file framing, so it can differ.",
  "Parquet metadata version":
    "This is the integer version stored in Parquet metadata, not a semantic version with major and minor parts. The writer is recorded separately when available.",
  "Compression ratio":
    "Compression ratio compares bytes before compression with bytes stored for column data. For example, ×3 means 3 MB became 1 MB on disk.",
  Codec:
    "A codec is the compression algorithm used for a column chunk. Common examples are Zstandard, Snappy and Gzip.",
  Encodings:
    "Encodings describe how values are represented before compression. For example, dictionary encoding can replace repeated strings with small integer codes.",
  Statistics:
    "Statistics store facts such as minimum, maximum and null count for a column chunk. A reader can use them to skip row groups that cannot match a filter.",
  "Bloom filter":
    "A bloom filter quickly proves that a value is absent from a column chunk. For example, it can skip a row group that cannot contain one requested ID.",
  "Page index":
    "A page index records boundaries and statistics inside a column chunk. It can let a reader skip individual pages instead of reading the whole chunk.",
  Footer:
    "The footer is the metadata block at the end of a Parquet file. It contains the schema and tells readers where row groups and column chunks are stored.",
  "Key-value metadata":
    "Key-value metadata is extra writer-defined information in the footer. For example, a framework may store its logical schema there as JSON.",
  Ratio:
    "Ratio colors group chunks by how much compression reduced their size. For example, ×4 means the original column data was four times larger than the stored chunk.",
  "Stats & bloom":
    "This view shows whether each chunk has statistics; a dot marks a bloom filter. Both can help readers skip data for selective filters.",
} as const;

export type StructureHelpTerm = keyof typeof HELP;

export function StructureHelp({
  term,
  children,
  button,
}: {
  term: StructureHelpTerm;
  children?: ReactNode;
  button?: { pressed: boolean; onClick: () => void };
}) {
  const helpId = useId();
  const anchor = useRef<HTMLElement>(null);
  const card = useRef<HTMLSpanElement>(null);
  const suppressFocusOpen = useRef(false);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const show = () => {
    const bounds = anchor.current?.getBoundingClientRect();
    if (bounds !== undefined) {
      setPosition({ top: bounds.bottom + 7, left: bounds.left });
    }
  };
  const isInsideHelp = (target: EventTarget | null) =>
    target instanceof Node &&
    (anchor.current?.contains(target) === true ||
      card.current?.contains(target) === true);
  const hideAfterFocus = (event: FocusEvent<HTMLElement>) => {
    if (!isInsideHelp(event.relatedTarget)) setPosition(null);
  };
  const hideAfterPointer = (event: MouseEvent<HTMLElement>) => {
    if (!isInsideHelp(event.relatedTarget)) setPosition(null);
  };
  const hideOnEscape = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    setPosition(null);
    suppressFocusOpen.current = true;
    anchor.current?.focus();
    suppressFocusOpen.current = false;
  };
  useLayoutEffect(() => {
    const bounds = card.current?.getBoundingClientRect();
    if (position === null || bounds === undefined) {
      return;
    }
    const margin = 8;
    const left = Math.min(
      Math.max(margin, position.left),
      Math.max(margin, window.innerWidth - bounds.width - margin),
    );
    const top =
      bounds.bottom <= window.innerHeight - margin
        ? position.top
        : Math.max(
            margin,
            (anchor.current?.getBoundingClientRect().top ?? position.top) -
              bounds.height -
              7,
          );
    if (left !== position.left || top !== position.top) {
      setPosition({ left, top });
    }
  }, [position]);
  const anchorProps = {
    "aria-describedby": position === null ? undefined : helpId,
    onFocus: () => {
      if (!suppressFocusOpen.current) show();
    },
    onBlur: hideAfterFocus,
    onMouseEnter: show,
    onMouseLeave: hideAfterPointer,
    onKeyDown: hideOnEscape,
  };
  return (
    <>
      {button === undefined ? (
        <span className="structure-help-label">
          {children ?? term}
          <button
            ref={anchor as React.RefObject<HTMLButtonElement>}
            className="structure-help-info"
            type="button"
            aria-label={`About ${term}`}
            {...anchorProps}
          >
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="6" />
              <path d="M8 7v4" />
              <path d="M8 5h.01" />
            </svg>
          </button>
        </span>
      ) : (
        <button
          ref={anchor as React.RefObject<HTMLButtonElement>}
          className="structure-help"
          type="button"
          aria-pressed={button.pressed}
          onClick={button.onClick}
          {...anchorProps}
        >
          {children ?? term}
        </button>
      )}
      {position !== null &&
        createPortal(
          <span
            ref={card}
            id={helpId}
            className="structure-help-card"
            role="tooltip"
            tabIndex={0}
            style={position}
            onFocus={show}
            onBlur={hideAfterFocus}
            onMouseEnter={show}
            onMouseLeave={hideAfterPointer}
            onKeyDown={hideOnEscape}
          >
            {HELP[term]}
          </span>,
          document.body,
        )}
    </>
  );
}
