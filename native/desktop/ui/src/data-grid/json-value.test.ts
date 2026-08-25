import { describe, expect, it } from "vitest";

import {
  ChunkedJsonSource,
  createIncrementalJsonParser,
  decodeJsonString,
  decodeJsonStringPrefix,
  jsonNodeRaw,
  jsonStringCursor,
  JSON_NODE_METADATA_LIMIT,
  readJsonStringChunk,
  type JsonParseStep,
} from "./json-value";

describe("incremental JSON parsing", () => {
  it("preserves wide numbers, escapes, and duplicate-key order by source span", () => {
    const source =
      ' {"name":"a\\u0062","wide":123456789012345678901234567890,"name":false} ';
    const result = parse(source, 3);
    expect(result.status).toBe("done");
    if (result.status !== "done" || result.node.kind !== "object") return;

    expect(
      result.node.entries.map((entry) =>
        decodeJsonString(source, entry.keyStart, entry.keyEnd),
      ),
    ).toEqual(["name", "wide", "name"]);
    expect(
      result.node.entries.map((entry) => jsonNodeRaw(source, entry.value)),
    ).toEqual(['"a\\u0062"', "123456789012345678901234567890", "false"]);
  });

  it.each([
    [" -0 ", "-0", "number"],
    ["1.2300e+400", "1.2300e+400", "number"],
    [' "root\\nstring" ', '"root\\nstring"', "string"],
    [' "" ', '""', "string"],
    [" true ", "true", "boolean"],
    ["null", "null", "null"],
    ["{}", "{}", "object"],
    ["[]", "[]", "array"],
  ])("preserves scalar root %j", (source, raw, kind) => {
    const result = parse(source, 1);
    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(result.node.kind).toBe(kind);
    expect(jsonNodeRaw(source, result.node)).toBe(raw);
  });

  it("keeps integer-looking keys, surrogate escapes, and root whitespace", () => {
    const source = '\n { "1": "\\uD83D\\uDE00", "\\u0061": -0 }\t';
    const result = parse(source, 1);
    expect(result.status).toBe("done");
    if (result.status !== "done" || result.node.kind !== "object") return;
    expect(
      result.node.entries.map((entry) =>
        decodeJsonString(source, entry.keyStart, entry.keyEnd),
      ),
    ).toEqual(["1", "a"]);
    expect(
      decodeJsonString(
        source,
        result.node.entries[0]!.value.start,
        result.node.entries[0]!.value.end,
      ),
    ).toBe("😀");
  });

  it("does not split a decoded surrogate pair at the prefix boundary", () => {
    const source = '"a\\uD83D\\uDE00tail"';

    expect(decodeJsonStringPrefix(source, 0, source.length, 2)).toEqual({
      text: "a",
      truncated: true,
    });
    expect(decodeJsonStringPrefix(source, 0, source.length, 3)).toEqual({
      text: "a😀",
      truncated: true,
    });
  });

  it("parses tokens split at every incremental boundary", () => {
    const source = '{"escaped":"a\\\\b\\"c\\u03b2","number":-12.30e-4}';
    for (let budget = 1; budget <= source.length; budget += 1) {
      const result = parse(source, budget);
      expect(result.status, `budget ${budget}`).toBe("done");
      if (result.status === "done") {
        expect(jsonNodeRaw(source, result.node)).toBe(source);
      }
    }
  });

  it("parses escapes, surrogate pairs, exponents, and UTF-8 split across rope chunks", () => {
    const source = new ChunkedJsonSource();
    const text = '{"escape":"\\uD83D\\uDE00","exponent":-12.30e-4,"utf8":"界"}';
    const bytes = new TextEncoder().encode(text);
    const decoder = new TextDecoder();
    for (let offset = 0; offset < bytes.length; offset += 2) {
      source.append(
        decoder.decode(
          bytes.subarray(offset, Math.min(bytes.length, offset + 2)),
          {
            stream: offset + 2 < bytes.length,
          },
        ),
      );
    }

    const parser = createIncrementalJsonParser(source);
    let result = parser.step(1);
    while (result.status === "pending") result = parser.step(1);

    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(jsonNodeRaw(source, result.node)).toBe(text);
  });

  it("rejects a malformed tail split into its own rope chunk", () => {
    const source = new ChunkedJsonSource();
    source.append('{"ok":true');
    source.append(",]");
    const parser = createIncrementalJsonParser(source);
    let result = parser.step(2);
    while (result.status === "pending") result = parser.step(2);
    expect(result.status).toBe("invalid");
  });

  it.each(["", " ", "[1,]", '{"a" 1}', '"unterminated', "01", "true false"])(
    "rejects malformed JSON %j without throwing",
    (source) => {
      expect(parse(source, 2).status).toBe("invalid");
    },
  );

  it("does bounded work on the first chunk of a wide value", () => {
    const source = `[${Array.from({ length: 100_000 }, (_value, index) => index).join(",")}]`;
    const parser = createIncrementalJsonParser(source);

    const first = parser.step(128);

    expect(first).toMatchObject({ status: "pending" });
    expect(first.offset).toBeLessThanOrEqual(128);
  });

  it("validates dense JSON without retaining unbounded node metadata", () => {
    const source = `[${"0,".repeat(JSON_NODE_METADATA_LIMIT)}0]`;
    const result = parse(source, 4_096);

    expect(result).toEqual({
      status: "metadataLimit",
      offset: source.length,
    });
  });

  it("validates a million nested containers with compact post-limit state", () => {
    const depth = 1_000_000;
    const source = `${"[".repeat(depth)}0${"]".repeat(depth)}`;

    expect(parse(source, 65_536)).toEqual({
      status: "metadataLimit",
      offset: source.length,
    });
  });

  it("rejects a malformed tail after switching to compact validation", () => {
    const depth = JSON_NODE_METADATA_LIMIT + 1_000;
    const source = `${"[".repeat(depth)}0${"]".repeat(depth - 1)}}`;

    expect(parse(source, 16_384).status).toBe("invalid");
  });

  it("decodes escaped scalar text in bounded chunks", () => {
    const source = '"alpha\\n\\u03b2eta"';
    const cursor = jsonStringCursor(source, 0, source.length);
    const chunks: string[] = [];
    let done = false;
    while (!done) {
      const chunk = readJsonStringChunk(cursor, 4);
      chunks.push(chunk.text);
      done = chunk.done;
    }

    expect(chunks.join("")).toBe("alpha\nβeta");
    expect(chunks.length).toBeGreaterThan(1);
  });
});

function parse(source: string, budget: number): JsonParseStep {
  const parser = createIncrementalJsonParser(source);
  let result = parser.step(budget);
  let iterations = 0;
  while (result.status === "pending" && iterations <= source.length + 10) {
    result = parser.step(budget);
    iterations += 1;
  }
  return result;
}
