import {
  binary,
  decimal128,
  dictionary,
  int32,
  list,
  map,
  struct,
  tableFromArrays,
  tableToIPC,
  utf8,
  utf8View,
  binaryView,
  Batch,
  Column,
  tableFromColumns,
  type DataType,
} from "@uwdata/flechette";
import { describe, expect, it, vi } from "vitest";

import {
  decodeArrowWindow as decodeFieldWindow,
  windowArrowValue as windowFieldArrowValue,
  windowDataType as windowFieldDataType,
  windowValueAt,
  windowValue as windowFieldValue,
} from "./arrow-window";
import { formatCellValue, formatTypedCellValue } from "./format-cell";
import { arrowBinaryBytes } from "./arrow-value";
import {
  arrowTypedValue,
  typedValue,
  valueChildAt,
  valueChildCount,
  valueSearchText,
  valueToJson,
  type TypedValue,
  type ValueSearchText,
} from "./value-format";
import {
  AllExpansionBuilder,
  IncrementalTreeSearch,
  type TreeSearchAdapter,
} from "./value-tree-model";
import {
  createValueCopySerializer,
  createValueJsonSerializer,
} from "./value-json-serializer";
import { ChunkScheduler } from "./chunk-scheduler";

type ArrowWindow = ReturnType<typeof decodeFieldWindow>;

const fieldPath = (index: number) => [`column_${index}`];

function decodeArrowWindow(
  buffer: ArrayBuffer,
  rowOffset: number,
  sourceIndices: readonly number[],
): ArrowWindow {
  return decodeFieldWindow(buffer, rowOffset, sourceIndices.map(fieldPath));
}

function windowArrowValue(
  window: ArrowWindow,
  sourceIndex: number,
  rowIndex: number,
) {
  return windowFieldArrowValue(window, fieldPath(sourceIndex), rowIndex);
}

function windowDataType(window: ArrowWindow, sourceIndex: number) {
  return windowFieldDataType(window, fieldPath(sourceIndex));
}

function windowValue(
  window: ArrowWindow,
  sourceIndex: number,
  rowIndex: number,
) {
  return windowFieldValue(window, fieldPath(sourceIndex), rowIndex);
}

describe("decodeArrowWindow", () => {
  it("keeps nested field paths as structured projection identities", () => {
    const bytes = tableToIPC(tableFromArrays({ leaf: [7] }), {
      format: "stream",
    });
    const fieldPaths = [["root.with.dot", 'leaf"quoted']];

    const window = decodeFieldWindow(
      Uint8Array.from(bytes!).buffer,
      0,
      fieldPaths,
    );

    expect(window.fieldPaths).toEqual(fieldPaths);
    expect(windowFieldValue(window, fieldPaths[0]!, 0)).toBe(7);
  });

  it("keeps duplicate identity columns available by physical source offset", () => {
    const bytes = tableToIPC(tableFromArrays({ first: [7], second: [11] }), {
      format: "stream",
    });
    const duplicatePaths = [["duplicate"], ["duplicate"]];

    const window = decodeFieldWindow(
      Uint8Array.from(bytes!).buffer,
      0,
      duplicatePaths,
      { allowDuplicateTopLevelIdentity: true },
    );

    expect(windowFieldValue(window, duplicatePaths[0]!, 0)).toBe(7);
    expect(windowValueAt(window, 1, 0)).toBe(11);
  });

  it("rejects duplicate paths outside the explicit top-level identity fallback", () => {
    const bytes = tableToIPC(tableFromArrays({ first: [7], second: [11] }), {
      format: "stream",
    });

    expect(() =>
      decodeFieldWindow(Uint8Array.from(bytes!).buffer, 0, [
        ["duplicate"],
        ["duplicate"],
      ]),
    ).toThrow("The data window projection contains a duplicate column.");
    expect(() =>
      decodeFieldWindow(
        Uint8Array.from(bytes!).buffer,
        0,
        [
          ["root", "duplicate"],
          ["root", "duplicate"],
        ],
        { allowDuplicateTopLevelIdentity: true },
      ),
    ).toThrow("The data window projection contains a duplicate column.");
  });

  it("keeps null UTF-8 and binary distinct from empty values", () => {
    const bytes = tableToIPC(
      tableFromArrays(
        { text: [null, ""], payload: [null, new Uint8Array()] },
        { types: { text: utf8(), payload: binary() } },
      ),
      { format: "stream" },
    );
    const window = decodeArrowWindow(Uint8Array.from(bytes!).buffer, 0, [0, 1]);

    const nullText = arrowTypedValue(windowArrowValue(window, 0, 0)!);
    const emptyText = arrowTypedValue(windowArrowValue(window, 0, 1)!);
    const nullBinary = arrowTypedValue(windowArrowValue(window, 1, 0)!);
    const emptyBinary = arrowTypedValue(windowArrowValue(window, 1, 1)!);

    expect(formatTypedCellValue(nullText, false).displayData).toBe("null");
    expect(formatTypedCellValue(emptyText, false).displayData).toBe("");
    expect(formatTypedCellValue(nullBinary, false).displayData).toBe("null");
    expect(formatTypedCellValue(emptyBinary, false).displayData).toBe(
      "binary · 0 B",
    );
    const copied = [
      { value: nullBinary, format: "raw" as const },
      { value: emptyBinary, format: "raw" as const },
      { value: nullBinary, format: "json" as const },
    ].map((request) => {
      const serializer = createValueCopySerializer(request);
      let result = serializer.stepUntil(Infinity);
      while (result.status === "pending") {
        result = serializer.stepUntil(Infinity);
      }
      if (result.status !== "done") throw result.error;
      return result.text;
    });
    expect(copied).toEqual(["", "", "null"]);
  });

  it("reuses cached dictionary values and keeps views on Arrow refs", () => {
    const bytes = tableToIPC(
      tableFromArrays(
        { dictionary_text: ["alpha", "beta", "alpha"] },
        { types: { dictionary_text: dictionary(utf8()) } },
      ),
      { format: "stream" },
    );
    const window = decodeArrowWindow(Uint8Array.from(bytes!).buffer, 0, [0]);

    const dictionaryValue = arrowTypedValue(windowArrowValue(window, 0, 1)!);
    expect(dictionaryValue).toMatchObject({ kind: "value", value: "beta" });
    expect(valueToJson(dictionaryValue)).toBe('"beta"');
    const fakeBatch = (value: unknown) =>
      ({
        nullCount: 0,
        isValid: () => true,
        at: () => value,
      }) as unknown as Batch<unknown>;
    expect(
      arrowTypedValue({
        batch: fakeBatch("viewed"),
        index: 0,
        dataType: utf8View(),
      }),
    ).toMatchObject({
      kind: "arrow",
    });
    expect(
      formatTypedCellValue(
        arrowTypedValue({
          batch: fakeBatch(new Uint8Array([1, 2, 3])),
          index: 0,
          dataType: binaryView(),
        }),
        false,
      ).displayData,
    ).toBe("binary · 3 B");
  });

  it("decodes short, long, and null Utf8View and BinaryView IPC values", () => {
    const longText = `prefix-${"界".repeat(20)}`;
    const longBinary = Uint8Array.from(
      { length: 32 },
      (_value, index) => index,
    );
    const table = tableFromColumns({
      text: viewColumn(utf8View(), [
        null,
        new TextEncoder().encode("short"),
        new TextEncoder().encode(longText),
      ]),
      payload: viewColumn(binaryView(), [
        null,
        new Uint8Array([1, 2, 3]),
        longBinary,
      ]),
    });
    const bytes = tableToIPC(table, { format: "stream" });
    const window = decodeArrowWindow(Uint8Array.from(bytes!).buffer, 0, [0, 1]);

    expect(windowDataType(window, 0)?.typeId).toBe(utf8View().typeId);
    expect(windowDataType(window, 1)?.typeId).toBe(binaryView().typeId);
    expect([0, 1, 2].map((row) => windowValue(window, 0, row))).toEqual([
      null,
      "short",
      longText,
    ]);
    expect(windowValue(window, 1, 0)).toBeNull();
    expect(windowValue(window, 1, 1)).toEqual(new Uint8Array([1, 2, 3]));
    expect(windowValue(window, 1, 2)).toEqual(longBinary);
    const nullText = arrowTypedValue(windowArrowValue(window, 0, 0)!);
    const shortText = arrowTypedValue(windowArrowValue(window, 0, 1)!);
    const nullBinary = arrowTypedValue(windowArrowValue(window, 1, 0)!);
    const shortBinary = arrowTypedValue(windowArrowValue(window, 1, 1)!);
    expect(
      [nullText, shortText, nullBinary, shortBinary].map((value) => value.kind),
    ).toEqual(["arrow", "arrow", "arrow", "arrow"]);
    expect(valueToJson(nullText)).toBe("null");
    expect(valueToJson(shortText)).toBe('"short"');
    expect(valueToJson(nullBinary)).toBe("null");
    expect(valueToJson(shortBinary)).toBe('"AQID"');
    expect(completeRawCopy(nullText)).toBe("");
    expect(completeRawCopy(nullBinary)).toBe("");
  });

  it("rejects invalid external BinaryView descriptor bounds", () => {
    const column = viewColumn(binaryView(), [new Uint8Array(32)]);
    const batch = column.data[0]!;
    const descriptors = batch.values as Uint8Array;
    new DataView(
      descriptors.buffer,
      descriptors.byteOffset,
      descriptors.byteLength,
    ).setInt32(12, 64, true);

    expect(
      arrowBinaryBytes({ batch, index: 0, dataType: binaryView() }),
    ).toBeNull();
  });

  it("reads big-endian external View descriptors at their exact byte range", () => {
    const payload = Uint8Array.from({ length: 13 }, (_value, index) => index);
    const external = new Uint8Array(payload.length + 5);
    external.set(payload, 3);
    const descriptors = new Uint8Array(16);
    const descriptor = new DataView(descriptors.buffer);
    descriptor.setInt32(0, payload.length, false);
    descriptor.setInt32(8, 0, false);
    descriptor.setInt32(12, 3, false);
    const batch = Object.assign(
      new Batch<unknown>({
        length: 1,
        nullCount: 0,
        type: binaryView(),
        values: descriptors,
      }),
      { data: [external] },
    );

    expect(
      arrowBinaryBytes({
        batch,
        index: 0,
        dataType: binaryView(),
        littleEndian: false,
      }),
    ).toEqual(payload);
  });

  it("copies real multi-megabyte views incrementally without eager at()", async () => {
    vi.useFakeTimers();
    try {
      // The eight-byte prefix makes a 16 KiB decoder chunk split a UTF-8 code point.
      const text = `prefix--${"界".repeat(700_000)}-tail`;
      const payload = Uint8Array.from(
        { length: 2 * 1024 * 1024 },
        (_value, index) => index % 251,
      );
      const table = tableFromColumns({
        text: viewColumn(utf8View(), [null, new TextEncoder().encode(text)]),
        payload: viewColumn(binaryView(), [null, payload]),
      });
      const bytes = tableToIPC(table, { format: "stream" });
      const window = decodeArrowWindow(
        Uint8Array.from(bytes!).buffer,
        0,
        [0, 1],
      );
      const textRef = windowArrowValue(window, 0, 1)!;
      const payloadRef = windowArrowValue(window, 1, 1)!;
      const textAt = vi.spyOn(textRef.batch, "at");
      const payloadAt = vi.spyOn(payloadRef.batch, "at");
      const textValue = arrowTypedValue(textRef);
      const payloadValue = arrowTypedValue(payloadRef);

      expect(textValue).toMatchObject({ kind: "arrow" });
      expect(payloadValue).toMatchObject({ kind: "arrow" });
      expectIncrementalRawCopy(textValue, text);
      expectIncrementalRawCopy(payloadValue, expectedBase64(payload));
      expectCappedRawCopy(textValue);
      expectCappedRawCopy(payloadValue);

      await expectCancelableRawCopy(textValue);
      expect(textAt).not.toHaveBeenCalled();
      expect(payloadAt).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("copies cached string and binary dictionary values incrementally", async () => {
    vi.useFakeTimers();
    try {
      const text = `prefix-${"x".repeat(256 * 1024)}-tail`;
      const payload = Uint8Array.from(
        { length: 384 * 1024 },
        (_value, index) => index % 239,
      );
      const bytes = tableToIPC(
        tableFromArrays(
          {
            text: [null, text, "short", text],
            payload: [null, payload, new Uint8Array([1, 2]), payload],
          },
          {
            types: {
              text: dictionary(utf8()),
              payload: dictionary(binary()),
            },
          },
        ),
        { format: "stream" },
      );
      const window = decodeArrowWindow(
        Uint8Array.from(bytes!).buffer,
        0,
        [0, 1],
      );
      const textOuter = windowArrowValue(window, 0, 1)!;
      const payloadOuter = windowArrowValue(window, 1, 1)!;
      const textValue = arrowTypedValue(textOuter);
      const payloadValue = arrowTypedValue(payloadOuter);

      expect(textValue).toMatchObject({ kind: "value" });
      expect(payloadValue).toMatchObject({ kind: "value" });
      expectIncrementalRawCopy(textValue, text);
      expectIncrementalRawCopy(payloadValue, expectedBase64(payload));
      expectCappedRawCopy(textValue);
      expectCappedRawCopy(payloadValue);
      await expectCancelableRawCopy(textValue);
      await expectCancelableRawCopy(payloadValue);
      expect(
        completeRawCopy(arrowTypedValue(windowArrowValue(window, 0, 0)!)),
      ).toBe("");
      expect(
        completeRawCopy(arrowTypedValue(windowArrowValue(window, 1, 0)!)),
      ).toBe("");
      expect(
        completeRawCopy(arrowTypedValue(windowArrowValue(window, 0, 2)!)),
      ).toBe("short");
      expect(
        completeRawCopy(arrowTypedValue(windowArrowValue(window, 1, 2)!)),
      ).toBe("AQI=");
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps decimal128 integers exact and in digit notation across 2^64", () => {
    const twoTo64 = 1n << 64n;
    const values = [twoTo64 - 1n, twoTo64, twoTo64 + 1n, 10n ** 38n - 1n];
    const table = tableFromArrays(
      { wideInteger: values },
      {
        types: { wideInteger: decimal128(38, 0) },
        useDecimalInt: true,
      },
    );
    const bytes = tableToIPC(table, { format: "stream" });
    expect(bytes).not.toBeNull();

    const window = decodeArrowWindow(Uint8Array.from(bytes!).buffer, 0, [7]);
    const type = windowDataType(window, 7);
    expect(type).toBeDefined();
    const decoded = values.map((_value, row) => windowValue(window, 7, row));
    const presentations = decoded.map((value) => formatCellValue(value, type!));

    expect(decoded).toEqual(values);
    expect(presentations.map(({ displayData }) => displayData)).toEqual(
      values.map(String),
    );
    expect(presentations.map(({ copyData }) => copyData)).toEqual(
      values.map(String),
    );
    expect(
      presentations.every(({ displayData }) => /^\d+$/.test(displayData)),
    ).toBe(true);
    expect(windowDataType(window, 0)).toBeUndefined();
  });

  it("rejects a projection that cannot describe the decoded fields", () => {
    const bytes = tableToIPC(tableFromArrays({ value: [1] }), {
      format: "stream",
    });

    expect(() =>
      decodeArrowWindow(Uint8Array.from(bytes!).buffer, 0, [1, 2]),
    ).toThrow("does not match");
  });

  it("formats five-level values decoded through the real Arrow boundary", () => {
    const nestedType = struct({
      level2: list(
        struct({
          level3: struct({
            level4: list(struct({ level5: utf8() })),
          }),
        }),
      ),
    });
    const value = {
      level2: [{ level3: { level4: [{ level5: "leaf" }] } }],
    };
    const table = tableFromArrays(
      { nested: [value] },
      { types: { nested: nestedType } },
    );
    const bytes = tableToIPC(table, { format: "stream" });
    expect(bytes).not.toBeNull();

    const window = decodeArrowWindow(Uint8Array.from(bytes!).buffer, 0, [3]);
    const type = windowDataType(window, 3);
    const decoded = windowValue(window, 3, 0);
    expect(type).toBeDefined();
    expect(decoded).toEqual(value);
    expect(formatCellValue(decoded, type!)).toMatchObject({
      displayData: "{level2: […]}",
      copyData: JSON.stringify(value),
    });

    let child = valueChildAt(typedValue(decoded, type!), 0);
    for (const ordinal of [0, 0, 0, 0, 0]) {
      expect(child).toBeDefined();
      child = valueChildAt(child!.value, ordinal);
    }
    expect(child).toMatchObject({ label: "level5" });
    expect(child?.value).toMatchObject({ value: "leaf" });
  });

  it("preserves duplicate Arrow map keys as ordered entries", () => {
    const type = map(utf8(), int32());
    const entries = [
      ["duplicate", 1],
      ["duplicate", 2],
      ["tail", 3],
    ];
    const bytes = tableToIPC(
      tableFromArrays({ mapped: [entries] }, { types: { mapped: type } }),
      { format: "stream" },
    );
    const window = decodeArrowWindow(Uint8Array.from(bytes!).buffer, 0, [4]);
    const decoded = windowValue(window, 4, 0);
    const decodedType = windowDataType(window, 4)!;

    expect(decoded).toEqual(entries);
    expect(decoded).not.toBeInstanceOf(Map);
    expect(valueToJson(typedValue(decoded, decodedType))).toBe(
      '[["duplicate",1],["duplicate",2],["tail",3]]',
    );
    expect(valueChildAt(typedValue(decoded, decodedType), 0)?.label).toBe(
      "duplicate",
    );
    expect(
      valueChildAt(typedValue(decoded, decodedType), 1)?.value,
    ).toMatchObject({ value: 2 });
  });

  it("labels and searches cached dictionary string map keys", () => {
    const type = map(dictionary(utf8()), int32());
    const entries = [
      ["en", 1],
      ['quote"key', 2],
      ["en", 3],
    ];
    const bytes = tableToIPC(
      tableFromArrays({ mapped: [entries] }, { types: { mapped: type } }),
      { format: "stream" },
    );
    const window = decodeArrowWindow(Uint8Array.from(bytes!).buffer, 0, [5]);
    const rootValue = arrowTypedValue(windowArrowValue(window, 5, 0)!);
    const first = valueChildAt(rootValue, 0);
    const escaped = valueChildAt(rootValue, 1);

    expect(first).toMatchObject({
      label: "en",
      labelSearch: { kind: "plain", text: "en" },
    });
    expect(escaped?.label).toBe('quote"key');

    const root: ValueNode = {
      depth: 0,
      ordinal: 0,
      value: rootValue,
      keyText: null,
    };
    const adapter: TreeSearchAdapter<ValueNode> = {
      childCount: (node) => valueChildCount(node.value),
      childAt: (node, index) => {
        const child = valueChildAt(node.value, index);
        return child === undefined
          ? undefined
          : {
              depth: node.depth + 1,
              ordinal: index,
              value: child.value,
              keyText: child.labelSearch ?? null,
            };
      },
      searchSources: (node) =>
        node.keyText === null ? [] : [{ location: "key", text: node.keyText }],
    };
    const search = new IncrementalTreeSearch(root, adapter, "en");
    let matches = 0;
    while (!search.done) {
      search.run(16, 4_096, () => {
        matches += 1;
      });
    }
    expect(matches).toBe(2);
  });

  it("keeps 100k Arrow map child access, expansion, and search linear", () => {
    const type = map(utf8(), int32());
    const entries = Array.from({ length: 100_000 }, (_value, index) => [
      `key-${index}`,
      index,
    ]);
    const bytes = tableToIPC(
      tableFromArrays({ mapped: [entries] }, { types: { mapped: type } }),
      { format: "stream" },
    );
    const window = decodeArrowWindow(Uint8Array.from(bytes!).buffer, 0, [9]);
    const arrow = windowArrowValue(window, 9, 0)!;
    const rootValue = arrowTypedValue(arrow);
    const valueBatch = arrow.batch.children[0]!.children[1]!;
    const scalarReads = vi.spyOn(valueBatch, "at");

    expect(valueChildCount(rootValue)).toBe(100_000);
    expect(valueChildAt(rootValue, 99_999)?.label).toBe("key-99999");
    expect(valueChildAt(rootValue, 1)?.label).toBe("key-1");
    expect(valueChildAt(rootValue, 50_000)?.label).toBe("key-50000");
    expect(scalarReads).not.toHaveBeenCalled();
    expect(formatTypedCellValue(rootValue, false).displayData).toMatch(
      /^\{100000\}/,
    );

    const root: ValueNode = {
      depth: 0,
      ordinal: 0,
      value: rootValue,
      keyText: null,
    };
    const adapter: TreeSearchAdapter<ValueNode> = {
      childCount: (node) => valueChildCount(node.value),
      childAt: (node, index) => {
        const child = valueChildAt(node.value, index);
        return child === undefined
          ? undefined
          : {
              depth: node.depth + 1,
              ordinal: index,
              value: child.value,
              keyText: child.labelSearch ?? null,
            };
      },
      searchSources: (node) => {
        const sources = [];
        if (node.keyText !== null) {
          sources.push({ location: "key" as const, text: node.keyText });
        }
        const valueText = valueSearchText(node.value);
        if (valueText !== null) {
          sources.push({ location: "value" as const, text: valueText });
        }
        return sources;
      },
    };
    const expansion = new AllExpansionBuilder(root, adapter);
    const firstExpansionChunk = expansion.run(256);
    expect(firstExpansionChunk.done).toBe(false);
    expect(firstExpansionChunk.visited).toBeGreaterThan(0);
    expect(scalarReads.mock.calls.length).toBeLessThan(10);
    while (!expansion.run(2_048).done) {
      // The staged index consumes the map in bounded linear chunks.
    }
    expect(expansion.finish().ordinals).toHaveLength(100_001);

    const search = new IncrementalTreeSearch(root, adapter, "key-99999");
    let matches = 0;
    search.run(256, 4_096, () => {
      matches += 1;
    });
    expect(scalarReads.mock.calls.length).toBeLessThan(300);
    while (!search.done) {
      search.run(2_048, 32_768, () => {
        matches += 1;
      });
    }
    expect(search.visited).toBe(100_001);
    expect(matches).toBe(1);
    expect(scalarReads.mock.calls.length).toBeLessThanOrEqual(100_010);
  }, 10_000);

  it("opens and starts copying a 100k Arrow list without reading its tail", () => {
    const values = Array.from({ length: 100_000 }, (_value, index) => index);
    const bytes = tableToIPC(
      tableFromArrays(
        { values: [values] },
        { types: { values: list(int32()) } },
      ),
      { format: "stream" },
    );
    const window = decodeArrowWindow(Uint8Array.from(bytes!).buffer, 0, [2]);
    const arrow = windowArrowValue(window, 2, 0)!;
    const childReads = vi.spyOn(arrow.batch.children[0]!, "at");
    const value = arrowTypedValue(arrow);

    expect(valueChildCount(value)).toBe(100_000);
    expect(
      formatTypedCellValue(value, false).displayData.length,
    ).toBeLessThanOrEqual(120);
    expect(childReads.mock.calls.length).toBeLessThan(64);

    const serializer = createValueJsonSerializer(value);
    expect(serializer.stepUntil(0, () => 0).status).toBe("pending");
    expect(childReads.mock.calls.length).toBeLessThan(64);
  });

  it("decodes giant Arrow UTF-8 incrementally across multibyte boundaries", () => {
    const text = `prefix-${"界".repeat(20_000)}-tail`;
    const bytes = tableToIPC(
      tableFromArrays({ text: [text] }, { types: { text: utf8() } }),
      { format: "stream" },
    );
    const window = decodeArrowWindow(Uint8Array.from(bytes!).buffer, 0, [1]);
    const arrow = windowArrowValue(window, 1, 0)!;
    const at = vi.spyOn(arrow.batch, "at");
    const value = arrowTypedValue(arrow);

    expect(formatTypedCellValue(value, false).displayData).toMatch(/^prefix-/);
    expect(at).not.toHaveBeenCalled();
    const serializer = createValueJsonSerializer(value);
    let result = serializer.stepUntil(0, () => 0);
    expect(result.status).toBe("pending");
    while (result.status === "pending") {
      result = serializer.stepUntil(0, () => 0);
    }
    expect(result).toEqual({ status: "done", text: JSON.stringify(text) });
    expect(at).not.toHaveBeenCalled();
  });

  it("never cuts an Arrow UTF-8 preview inside an astral code point", () => {
    const text = `${"a".repeat(8_191)}😀tail`;
    const bytes = tableToIPC(
      tableFromArrays({ text: [text] }, { types: { text: utf8() } }),
      { format: "stream" },
    );
    const window = decodeArrowWindow(Uint8Array.from(bytes!).buffer, 0, [0]);
    const display = formatTypedCellValue(
      arrowTypedValue(windowArrowValue(window, 0, 0)!),
      false,
    ).displayData;

    expect(display.endsWith("…")).toBe(true);
    expect(display).not.toContain("\ud83d");
    expect(display).not.toContain("�");
  });
});

function expectIncrementalRawCopy(value: TypedValue, expected: string): void {
  const serializer = createValueCopySerializer({ value, format: "raw" });
  let steps = 0;
  let result = serializer.stepUntil(Infinity, () => 0, 1);
  while (result.status === "pending") {
    const previousUnits = serializer.units;
    result = serializer.stepUntil(Infinity, () => 0, 1);
    expect(serializer.units - previousUnits).toBeLessThanOrEqual(1);
    steps += 1;
  }
  expect(result).toEqual({ status: "done", text: expected });
  expect(steps).toBeGreaterThan(10);
}

function completeRawCopy(value: TypedValue): string {
  const serializer = createValueCopySerializer({ value, format: "raw" });
  let result = serializer.stepUntil(Infinity, () => 0, 1);
  while (result.status === "pending") {
    result = serializer.stepUntil(Infinity, () => 0, 1);
  }
  if (result.status !== "done") throw result.error;
  return result.text;
}

function expectCappedRawCopy(value: TypedValue): void {
  const serializer = createValueCopySerializer({ value, format: "raw" }, 128);
  let result = serializer.stepUntil(Infinity, () => 0, 1);
  while (result.status === "pending") {
    result = serializer.stepUntil(Infinity, () => 0, 1);
  }
  expect(result.status).toBe("limit");
  expect(serializer.units).toBeLessThan(10);
}

async function expectCancelableRawCopy(value: TypedValue): Promise<void> {
  const serializer = createValueCopySerializer({ value, format: "raw" });
  const scheduler = new ChunkScheduler({ now: () => 0, maxUnits: 1 });
  scheduler.start({
    runChunk: (deadline, maxUnits) =>
      serializer.stepUntil(deadline, () => 0, maxUnits).status !== "pending",
  });
  await vi.advanceTimersToNextTimerAsync();
  const unitsAtCancel = serializer.units;
  scheduler.cancel();
  await vi.runAllTimersAsync();
  expect(unitsAtCancel).toBeGreaterThan(0);
  expect(serializer.units).toBe(unitsAtCancel);
}

function expectedBase64(bytes: Uint8Array): string {
  return JSON.parse(valueToJson(typedValue(bytes, binary()))) as string;
}

function viewColumn(
  dataType: DataType,
  values: readonly (Uint8Array | null)[],
): Column<unknown> {
  const descriptors = new Uint8Array(values.length * 16);
  const descriptorView = new DataView(descriptors.buffer);
  const validity = new Uint8Array(Math.ceil(values.length / 8));
  const data: Uint8Array[] = [];
  let nullCount = 0;
  values.forEach((value, index) => {
    if (value === null) {
      nullCount += 1;
      return;
    }
    const validityByte = index >> 3;
    validity[validityByte] = (validity[validityByte] ?? 0) | (1 << (index & 7));
    const descriptor = index * 16;
    descriptorView.setInt32(descriptor, value.length, true);
    if (value.length <= 12) {
      descriptors.set(value, descriptor + 4);
    } else {
      descriptors.set(value.subarray(0, 4), descriptor + 4);
      descriptorView.setInt32(descriptor + 8, data.length, true);
      descriptorView.setInt32(descriptor + 12, 0, true);
      data.push(value);
    }
  });
  const batch = Object.assign(
    new Batch<unknown>({
      length: values.length,
      nullCount,
      type: dataType,
      validity,
      values: descriptors,
    }),
    { data },
  );
  return new Column([batch], dataType);
}

interface ValueNode {
  depth: number;
  ordinal: number;
  value: TypedValue;
  keyText: ValueSearchText | null;
}
