import type { ReactNode } from "react";

const HELP = {
  "Row groups":
    "Row groups are horizontal partitions written independently. Large groups reduce scheduling overhead; smaller groups give filters more chances to skip data. They become costly when a query must open many tiny groups. Consider the writer's row-group target for the expected scan pattern.",
  "Rows per group":
    "Rows per group describes the average shape of the file. Different row widths make the same count occupy different bytes. Very small groups add metadata and scheduling work; very large groups reduce selective skipping. Choose the writer's target from row width and query pattern.",
  "Compression ratio":
    "Compression ratio compares uncompressed bytes with stored bytes. A ratio near one is normal for encoded or incompressible values; a larger ratio means fewer bytes reach storage. The useful target depends on CPU and I/O costs. Consider the codec and value distribution together.",
  Codec:
    "Codec is the compression algorithm recorded for each column chunk. One codec across a file is normal; mixed codecs can reflect deliberate per-column choices or merged writers. Codec choice becomes a problem only when its CPU and size tradeoff conflicts with the workload.",
  Encodings:
    "Encodings describe how values are represented before compression. Dictionary, run-length and delta encodings suit different distributions. Multiple encodings in one chunk are normal. A mismatch can increase bytes or decoding work. Consider writer settings after checking the column's value shape.",
  Statistics:
    "Statistics are per-chunk min/max and counts recorded by the writer. Filters use them to skip row groups without reading data. Missing statistics are harmless for full scans but make filtered queries read more data. Usually fixed by a writer setting or newer writer version.",
  "Bloom filter":
    "A bloom filter is a compact membership index for a column chunk. A negative answer is definitive; a positive answer can be a false match. Missing filters are normal for broad scans. They help selective equality filters when their storage and writer cost is acceptable.",
  "Page index":
    "A page index records page boundaries and optional statistics inside a column chunk. Readers can skip pages more precisely than whole row groups. Missing indexes are normal when readers do not use them. They matter for selective scans over large chunks and require writer support.",
  Footer:
    "The footer stores schema and physical layout metadata at the end of a Parquet file. Readers fetch it before planning a query. A large footer is normal for wide files or many row groups. It becomes costly when every open must parse excessive metadata.",
  "Key-value metadata":
    "Key-value metadata is writer-defined information stored in the footer. Frameworks often place schema or provenance JSON there. Large entries increase footer size and open cost. Remove them only when consumers do not rely on their keys or values.",
  Ratio:
    "The Ratio lens groups chunks by compression ratio. Cooler colors mean more size reduction; hotter colors mean stored and uncompressed sizes are close. Either can be normal. Use it to locate where storage bytes remain concentrated before changing codecs or encodings.",
  "Stats & bloom":
    "The Stats & bloom lens shows whether chunks carry statistics and marks bloom filters with a dot. Missing metadata is normal for full scans. It matters for selective filters because readers lose opportunities to skip work. Consider the query pattern before changing writer settings.",
} as const;

export type StructureHelpTerm = keyof typeof HELP;

export function StructureHelp({
  term,
  children,
}: {
  term: StructureHelpTerm;
  children?: ReactNode;
}) {
  return (
    <span className="structure-help" tabIndex={0} title={HELP[term]}>
      {children ?? term}
    </span>
  );
}
