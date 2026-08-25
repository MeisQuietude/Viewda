import { codePointSafePrefix } from "./unicode";

export type JsonNode =
  | JsonObjectNode
  | JsonArrayNode
  | JsonStringNode
  | JsonNumberNode
  | JsonBooleanNode
  | JsonNullNode;

export type JsonSource = string | ChunkedJsonSource;

/** Random-access text assembled incrementally without a full-string join. */
export class ChunkedJsonSource {
  readonly #chunks: string[] = [];
  readonly #offsets: number[] = [];
  #length = 0;
  #cachedChunk = 0;

  get length(): number {
    return this.#length;
  }

  append(text: string): void {
    if (text.length === 0) return;
    this.#offsets.push(this.#length);
    this.#chunks.push(text);
    this.#length += text.length;
  }

  charAt(index: number): string | undefined {
    const chunk = this.#chunkAt(index);
    return chunk === undefined
      ? undefined
      : this.#chunks[chunk]![index - this.#offsets[chunk]!];
  }

  codePointAt(index: number): number | undefined {
    const first = this.charAt(index);
    if (first === undefined) return undefined;
    const second = this.charAt(index + 1) ?? "";
    return `${first}${second}`.codePointAt(0);
  }

  slice(start: number, end: number): string {
    if (end <= start) return "";
    const output: string[] = [];
    let index = Math.max(0, start);
    const limit = Math.min(end, this.#length);
    while (index < limit) {
      const chunk = this.#chunkAt(index);
      if (chunk === undefined) break;
      const offset = this.#offsets[chunk]!;
      const text = this.#chunks[chunk]!;
      const chunkEnd = Math.min(limit, offset + text.length);
      output.push(text.slice(index - offset, chunkEnd - offset));
      index = chunkEnd;
    }
    return output.join("");
  }

  #chunkAt(index: number): number | undefined {
    if (index < 0 || index >= this.#length) return undefined;
    const cachedOffset = this.#offsets[this.#cachedChunk];
    const cached = this.#chunks[this.#cachedChunk];
    if (
      cachedOffset !== undefined &&
      cached !== undefined &&
      index >= cachedOffset &&
      index < cachedOffset + cached.length
    ) {
      return this.#cachedChunk;
    }
    let low = 0;
    let high = this.#offsets.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high + 1) / 2);
      if (this.#offsets[middle]! <= index) low = middle;
      else high = middle - 1;
    }
    this.#cachedChunk = low;
    return low;
  }
}

export interface JsonObjectNode {
  kind: "object";
  start: number;
  end: number;
  entries: JsonObjectEntry[];
}

export interface JsonObjectEntry {
  keyStart: number;
  keyEnd: number;
  value: JsonNode;
}

export interface JsonArrayNode {
  kind: "array";
  start: number;
  end: number;
  items: JsonNode[];
}

export interface JsonStringNode {
  kind: "string";
  start: number;
  end: number;
}

export interface JsonNumberNode {
  kind: "number";
  start: number;
  end: number;
}

export interface JsonBooleanNode {
  kind: "boolean";
  start: number;
  end: number;
  value: boolean;
}

export interface JsonNullNode {
  kind: "null";
  start: number;
  end: number;
}

export type JsonParseStep =
  | { status: "pending"; offset: number }
  | { status: "done"; offset: number; node: JsonNode }
  | { status: "metadataLimit"; offset: number }
  | { status: "invalid"; offset: number };

export const JSON_NODE_METADATA_LIMIT = 65_536;

type ObjectState = "keyOrEnd" | "key" | "colon" | "value" | "commaOrEnd";
type ArrayState = "valueOrEnd" | "value" | "commaOrEnd";

const COMPACT_OBJECT_KEY_OR_END = 1;
const COMPACT_OBJECT_KEY = 2;
const COMPACT_OBJECT_COLON = 3;
const COMPACT_OBJECT_VALUE = 4;
const COMPACT_OBJECT_COMMA_OR_END = 5;
const COMPACT_ARRAY_VALUE_OR_END = 6;
const COMPACT_ARRAY_VALUE = 7;
const COMPACT_ARRAY_COMMA_OR_END = 8;

type Frame =
  | {
      kind: "object";
      node: JsonObjectNode;
      state: ObjectState;
      keyStart?: number;
      keyEnd?: number;
    }
  | { kind: "array"; node: JsonArrayNode; state: ArrayState };

type Token =
  | {
      kind: "string";
      start: number;
      key: boolean;
      escaped: boolean;
      unicodeRemaining: number;
    }
  | { kind: "number"; start: number; state: NumberState }
  | {
      kind: "literal";
      start: number;
      expected: "true" | "false" | "null";
      offset: number;
    };

type NumberState =
  | "start"
  | "sign"
  | "zero"
  | "integer"
  | "fractionStart"
  | "fraction"
  | "exponentStart"
  | "exponentSign"
  | "exponent";

export interface IncrementalJsonParser {
  step(characterBudget: number): JsonParseStep;
}

export function createIncrementalJsonParser(
  source: JsonSource,
): IncrementalJsonParser {
  return new JsonParser(source);
}

class JsonParser implements IncrementalJsonParser {
  readonly #source: JsonSource;
  readonly #stack: Frame[] = [];
  #index = 0;
  #root: JsonNode | undefined;
  #token: Token | undefined;
  #invalid = false;
  #nodeCount = 0;
  #metadataLimited = false;
  #compactStack: Uint8Array | undefined;
  #compactDepth = 0;
  #compactRootComplete = false;

  constructor(source: JsonSource) {
    this.#source = source;
  }

  step(characterBudget: number): JsonParseStep {
    const budget = Math.max(1, Math.floor(characterBudget));
    let consumed = 0;
    let operations = 0;
    while (
      !this.#invalid &&
      consumed < budget &&
      operations < budget * 4 + 32
    ) {
      operations += 1;
      const before = this.#index;
      this.#advance();
      consumed += this.#index - before;
      const complete = this.#result();
      if (complete !== undefined) return complete;
    }
    return this.#invalid
      ? { status: "invalid", offset: this.#index }
      : { status: "pending", offset: this.#index };
  }

  #advance(): void {
    if (this.#token !== undefined) {
      this.#advanceToken();
      return;
    }
    if (isWhitespace(sourceCharacter(this.#source, this.#index))) {
      this.#index += 1;
      return;
    }
    if (this.#compactStack !== undefined) {
      this.#advanceCompact();
      return;
    }
    if (this.#root !== undefined && this.#stack.length === 0) {
      if (this.#index < this.#source.length) this.#invalid = true;
      return;
    }
    const frame = this.#stack.at(-1);
    if (frame === undefined) {
      this.#startValue();
    } else if (frame.kind === "object") {
      this.#advanceObject(frame);
    } else {
      this.#advanceArray(frame);
    }
  }

  #advanceObject(frame: Extract<Frame, { kind: "object" }>): void {
    const character = sourceCharacter(this.#source, this.#index);
    if (frame.state === "keyOrEnd" || frame.state === "key") {
      if (frame.state === "keyOrEnd" && character === "}") {
        this.#closeContainer(frame.node);
      } else if (character === '"') {
        this.#token = {
          kind: "string",
          start: this.#index,
          key: true,
          escaped: false,
          unicodeRemaining: 0,
        };
        this.#index += 1;
      } else {
        this.#invalid = true;
      }
    } else if (frame.state === "colon") {
      if (character === ":") {
        frame.state = "value";
        this.#index += 1;
      } else {
        this.#invalid = true;
      }
    } else if (frame.state === "value") {
      this.#startValue();
    } else if (character === ",") {
      frame.state = "key";
      this.#index += 1;
    } else if (character === "}") {
      this.#closeContainer(frame.node);
    } else {
      this.#invalid = true;
    }
  }

  #advanceArray(frame: Extract<Frame, { kind: "array" }>): void {
    const character = sourceCharacter(this.#source, this.#index);
    if (frame.state === "valueOrEnd") {
      if (character === "]") this.#closeContainer(frame.node);
      else this.#startValue();
    } else if (frame.state === "value") {
      this.#startValue();
    } else if (character === ",") {
      frame.state = "value";
      this.#index += 1;
    } else if (character === "]") {
      this.#closeContainer(frame.node);
    } else {
      this.#invalid = true;
    }
  }

  #startValue(): void {
    if (
      this.#compactStack !== undefined ||
      this.#nodeCount >= JSON_NODE_METADATA_LIMIT
    ) {
      this.#enterCompactMode();
      this.#startCompactValue();
      return;
    }
    const start = this.#index;
    const character = sourceCharacter(this.#source, start);
    if (character === "{") {
      const node: JsonObjectNode = {
        kind: "object",
        start,
        end: 0,
        entries: [],
      };
      this.#completeValue(node);
      this.#stack.push({ kind: "object", node, state: "keyOrEnd" });
      this.#index += 1;
    } else if (character === "[") {
      const node: JsonArrayNode = { kind: "array", start, end: 0, items: [] };
      this.#completeValue(node);
      this.#stack.push({ kind: "array", node, state: "valueOrEnd" });
      this.#index += 1;
    } else if (character === '"') {
      this.#token = {
        kind: "string",
        start,
        key: false,
        escaped: false,
        unicodeRemaining: 0,
      };
      this.#index += 1;
    } else if (character === "-" || isDigit(character)) {
      this.#token = { kind: "number", start, state: "start" };
    } else if (character === "t" || character === "f" || character === "n") {
      this.#token = {
        kind: "literal",
        start,
        expected:
          character === "t" ? "true" : character === "f" ? "false" : "null",
        offset: 0,
      };
    } else {
      this.#invalid = true;
    }
  }

  #advanceToken(): void {
    const token = this.#token;
    if (token?.kind === "string") this.#advanceString(token);
    else if (token?.kind === "number") this.#advanceNumber(token);
    else if (token?.kind === "literal") this.#advanceLiteral(token);
  }

  #advanceString(token: Extract<Token, { kind: "string" }>): void {
    const character = sourceCharacter(this.#source, this.#index);
    if (character === undefined) {
      this.#invalid = true;
      return;
    }
    if (token.unicodeRemaining > 0) {
      if (!/[0-9a-f]/i.test(character)) this.#invalid = true;
      else {
        token.unicodeRemaining -= 1;
        this.#index += 1;
      }
      return;
    }
    if (token.escaped) {
      if (character === "u") token.unicodeRemaining = 4;
      else if (!'"\\/bfnrt'.includes(character)) {
        this.#invalid = true;
        return;
      }
      token.escaped = false;
      this.#index += 1;
      return;
    }
    if (character === "\\") {
      token.escaped = true;
      this.#index += 1;
    } else if (character === '"') {
      this.#index += 1;
      this.#token = undefined;
      if (token.key) {
        if (this.#compactStack !== undefined) {
          if (
            this.#compactTop() !== COMPACT_OBJECT_KEY_OR_END &&
            this.#compactTop() !== COMPACT_OBJECT_KEY
          ) {
            this.#invalid = true;
            return;
          }
          this.#setCompactTop(COMPACT_OBJECT_COLON);
          return;
        }
        const frame = this.#stack.at(-1);
        if (frame?.kind !== "object") {
          this.#invalid = true;
          return;
        }
        frame.keyStart = token.start;
        frame.keyEnd = this.#index;
        frame.state = "colon";
      } else {
        if (this.#completeCompactScalar()) return;
        this.#completeValue({
          kind: "string",
          start: token.start,
          end: this.#index,
        });
      }
    } else if (character.charCodeAt(0) < 0x20) {
      this.#invalid = true;
    } else {
      this.#index += 1;
    }
  }

  #advanceNumber(token: Extract<Token, { kind: "number" }>): void {
    const character = sourceCharacter(this.#source, this.#index);
    const finish = () => {
      this.#token = undefined;
      if (this.#completeCompactScalar()) return;
      this.#completeValue({
        kind: "number",
        start: token.start,
        end: this.#index,
      });
    };
    if (character === undefined) {
      if (isCompleteNumberState(token.state)) finish();
      else this.#invalid = true;
      return;
    }
    if (token.state === "start") {
      if (character === "-") token.state = "sign";
      else if (character === "0") token.state = "zero";
      else if (isNonZeroDigit(character)) token.state = "integer";
      else this.#invalid = true;
      if (!this.#invalid) this.#index += 1;
    } else if (token.state === "sign") {
      if (character === "0") token.state = "zero";
      else if (isNonZeroDigit(character)) token.state = "integer";
      else this.#invalid = true;
      if (!this.#invalid) this.#index += 1;
    } else if (token.state === "zero" || token.state === "integer") {
      if (token.state === "integer" && isDigit(character)) this.#index += 1;
      else if (character === ".") {
        token.state = "fractionStart";
        this.#index += 1;
      } else if (character === "e" || character === "E") {
        token.state = "exponentStart";
        this.#index += 1;
      } else if (isDelimiter(character)) finish();
      else this.#invalid = true;
    } else if (token.state === "fractionStart") {
      if (isDigit(character)) {
        token.state = "fraction";
        this.#index += 1;
      } else this.#invalid = true;
    } else if (token.state === "fraction") {
      if (isDigit(character)) this.#index += 1;
      else if (character === "e" || character === "E") {
        token.state = "exponentStart";
        this.#index += 1;
      } else if (isDelimiter(character)) finish();
      else this.#invalid = true;
    } else if (token.state === "exponentStart") {
      if (character === "+" || character === "-") {
        token.state = "exponentSign";
        this.#index += 1;
      } else if (isDigit(character)) {
        token.state = "exponent";
        this.#index += 1;
      } else this.#invalid = true;
    } else if (token.state === "exponentSign") {
      if (isDigit(character)) {
        token.state = "exponent";
        this.#index += 1;
      } else this.#invalid = true;
    } else if (isDigit(character)) this.#index += 1;
    else if (isDelimiter(character)) finish();
    else this.#invalid = true;
  }

  #advanceLiteral(token: Extract<Token, { kind: "literal" }>): void {
    const character = sourceCharacter(this.#source, this.#index);
    if (character !== token.expected[token.offset]) {
      this.#invalid = true;
      return;
    }
    token.offset += 1;
    this.#index += 1;
    if (token.offset === token.expected.length) {
      this.#token = undefined;
      if (this.#completeCompactScalar()) return;
      this.#completeValue(
        token.expected === "null"
          ? { kind: "null", start: token.start, end: this.#index }
          : {
              kind: "boolean",
              start: token.start,
              end: this.#index,
              value: token.expected === "true",
            },
      );
    }
  }

  #completeValue(node: JsonNode): void {
    this.#nodeCount += 1;
    const frame = this.#stack.at(-1);
    if (frame === undefined) {
      if (this.#root === undefined) this.#root = node;
      else this.#invalid = true;
    } else if (frame.kind === "array" && frame.state !== "commaOrEnd") {
      frame.node.items.push(node);
      frame.state = "commaOrEnd";
    } else if (
      frame.kind === "object" &&
      frame.state === "value" &&
      frame.keyStart !== undefined &&
      frame.keyEnd !== undefined
    ) {
      frame.node.entries.push({
        keyStart: frame.keyStart,
        keyEnd: frame.keyEnd,
        value: node,
      });
      frame.keyStart = undefined;
      frame.keyEnd = undefined;
      frame.state = "commaOrEnd";
    } else {
      this.#invalid = true;
    }
  }

  #closeContainer(node: JsonObjectNode | JsonArrayNode): void {
    node.end = this.#index + 1;
    this.#index += 1;
    if (this.#stack.pop()?.node !== node) this.#invalid = true;
  }

  #completeCompactScalar(): boolean {
    if (
      this.#compactStack === undefined &&
      this.#nodeCount < JSON_NODE_METADATA_LIMIT
    ) {
      return false;
    }
    this.#enterCompactMode();
    this.#completeCompactValue();
    return true;
  }

  #enterCompactMode(): void {
    if (this.#compactStack !== undefined) return;
    this.#metadataLimited = true;
    this.#compactRootComplete = this.#root !== undefined;
    // Exact validation still needs one state per open container. Past the UI
    // metadata limit, one byte per level replaces retained nodes and frames.
    this.#compactStack = new Uint8Array(Math.max(16, this.#stack.length));
    for (const frame of this.#stack) {
      this.#pushCompact(
        frame.kind === "object"
          ? compactObjectState(frame.state)
          : compactArrayState(frame.state),
      );
    }
    this.#stack.length = 0;
    this.#root = undefined;
  }

  #advanceCompact(): void {
    if (this.#compactDepth === 0) {
      if (this.#compactRootComplete) {
        if (this.#index < this.#source.length) this.#invalid = true;
      } else {
        this.#startCompactValue();
      }
      return;
    }
    const state = this.#compactTop();
    const character = sourceCharacter(this.#source, this.#index);
    if (state === COMPACT_OBJECT_KEY_OR_END || state === COMPACT_OBJECT_KEY) {
      if (state === COMPACT_OBJECT_KEY_OR_END && character === "}") {
        this.#popCompact();
        this.#index += 1;
      } else if (character === '"') {
        this.#token = {
          kind: "string",
          start: this.#index,
          key: true,
          escaped: false,
          unicodeRemaining: 0,
        };
        this.#index += 1;
      } else {
        this.#invalid = true;
      }
    } else if (state === COMPACT_OBJECT_COLON) {
      if (character === ":") {
        this.#setCompactTop(COMPACT_OBJECT_VALUE);
        this.#index += 1;
      } else {
        this.#invalid = true;
      }
    } else if (state === COMPACT_OBJECT_VALUE) {
      this.#startCompactValue();
    } else if (state === COMPACT_OBJECT_COMMA_OR_END) {
      if (character === ",") {
        this.#setCompactTop(COMPACT_OBJECT_KEY);
        this.#index += 1;
      } else if (character === "}") {
        this.#popCompact();
        this.#index += 1;
      } else {
        this.#invalid = true;
      }
    } else if (state === COMPACT_ARRAY_VALUE_OR_END) {
      if (character === "]") {
        this.#popCompact();
        this.#index += 1;
      } else {
        this.#startCompactValue();
      }
    } else if (state === COMPACT_ARRAY_VALUE) {
      this.#startCompactValue();
    } else if (state === COMPACT_ARRAY_COMMA_OR_END) {
      if (character === ",") {
        this.#setCompactTop(COMPACT_ARRAY_VALUE);
        this.#index += 1;
      } else if (character === "]") {
        this.#popCompact();
        this.#index += 1;
      } else {
        this.#invalid = true;
      }
    } else {
      this.#invalid = true;
    }
  }

  #startCompactValue(): void {
    const character = sourceCharacter(this.#source, this.#index);
    if (character === "{") {
      this.#completeCompactValue();
      if (!this.#invalid) this.#pushCompact(COMPACT_OBJECT_KEY_OR_END);
      this.#index += 1;
    } else if (character === "[") {
      this.#completeCompactValue();
      if (!this.#invalid) this.#pushCompact(COMPACT_ARRAY_VALUE_OR_END);
      this.#index += 1;
    } else if (character === '"') {
      this.#token = {
        kind: "string",
        start: this.#index,
        key: false,
        escaped: false,
        unicodeRemaining: 0,
      };
      this.#index += 1;
    } else if (character === "-" || isDigit(character)) {
      this.#token = { kind: "number", start: this.#index, state: "start" };
    } else if (character === "t" || character === "f" || character === "n") {
      this.#token = {
        kind: "literal",
        start: this.#index,
        expected:
          character === "t" ? "true" : character === "f" ? "false" : "null",
        offset: 0,
      };
    } else {
      this.#invalid = true;
    }
  }

  #completeCompactValue(): void {
    if (this.#compactDepth === 0) {
      if (this.#compactRootComplete) this.#invalid = true;
      else this.#compactRootComplete = true;
      return;
    }
    const state = this.#compactTop();
    if (state === COMPACT_OBJECT_VALUE) {
      this.#setCompactTop(COMPACT_OBJECT_COMMA_OR_END);
    } else if (
      state === COMPACT_ARRAY_VALUE_OR_END ||
      state === COMPACT_ARRAY_VALUE
    ) {
      this.#setCompactTop(COMPACT_ARRAY_COMMA_OR_END);
    } else {
      this.#invalid = true;
    }
  }

  #pushCompact(state: number): void {
    let stack = this.#compactStack!;
    if (this.#compactDepth === stack.length) {
      const expanded = new Uint8Array(stack.length * 2);
      expanded.set(stack);
      this.#compactStack = stack = expanded;
    }
    stack[this.#compactDepth] = state;
    this.#compactDepth += 1;
  }

  #popCompact(): void {
    this.#compactDepth -= 1;
  }

  #compactTop(): number {
    return this.#compactStack![this.#compactDepth - 1]!;
  }

  #setCompactTop(state: number): void {
    this.#compactStack![this.#compactDepth - 1] = state;
  }

  #result(): JsonParseStep | undefined {
    if (this.#invalid) return { status: "invalid", offset: this.#index };
    if (
      this.#compactStack !== undefined &&
      this.#compactRootComplete &&
      this.#compactDepth === 0 &&
      this.#token === undefined &&
      this.#index >= this.#source.length
    ) {
      return { status: "metadataLimit", offset: this.#index };
    }
    if (
      this.#root !== undefined &&
      this.#stack.length === 0 &&
      this.#token === undefined &&
      this.#index >= this.#source.length
    ) {
      return this.#metadataLimited
        ? { status: "metadataLimit", offset: this.#index }
        : { status: "done", offset: this.#index, node: this.#root };
    }
    if (
      this.#index >= this.#source.length &&
      this.#root === undefined &&
      this.#token === undefined
    ) {
      return { status: "invalid", offset: this.#index };
    }
    return undefined;
  }
}

function compactObjectState(state: ObjectState): number {
  return state === "keyOrEnd"
    ? COMPACT_OBJECT_KEY_OR_END
    : state === "key"
      ? COMPACT_OBJECT_KEY
      : state === "colon"
        ? COMPACT_OBJECT_COLON
        : state === "value"
          ? COMPACT_OBJECT_VALUE
          : COMPACT_OBJECT_COMMA_OR_END;
}

function compactArrayState(state: ArrayState): number {
  return state === "valueOrEnd"
    ? COMPACT_ARRAY_VALUE_OR_END
    : state === "value"
      ? COMPACT_ARRAY_VALUE
      : COMPACT_ARRAY_COMMA_OR_END;
}

export function decodeJsonString(
  source: JsonSource,
  start: number,
  end: number,
): string {
  return JSON.parse(sourceSlice(source, start, end)) as string;
}

export function decodeJsonStringPrefix(
  source: JsonSource,
  start: number,
  end: number,
  limit: number,
): { text: string; truncated: boolean } {
  const output: string[] = [];
  let length = 0;
  let index = start + 1;
  const contentEnd = Math.max(index, end - 1);
  while (index < contentEnd && length < limit) {
    const decoded = decodeCharacter(source, index, contentEnd);
    output.push(decoded.value);
    length += decoded.value.length;
    index = decoded.next;
  }
  return {
    text: codePointSafePrefix(output.join(""), limit),
    truncated: index < contentEnd || length > limit,
  };
}

export function jsonNodeRaw(source: JsonSource, node: JsonNode): string {
  return sourceSlice(source, node.start, node.end);
}

export function jsonNodeType(node: JsonNode): string {
  return `JSON ${node.kind}`;
}

export interface JsonStringCursor {
  source: JsonSource;
  index: number;
  end: number;
}

export function jsonStringCursor(
  source: JsonSource,
  start: number,
  end: number,
): JsonStringCursor {
  return { source, index: start + 1, end: Math.max(start + 1, end - 1) };
}

export function readJsonStringChunk(
  cursor: JsonStringCursor,
  characterBudget: number,
): { text: string; done: boolean } {
  const output: string[] = [];
  const stop = Math.min(
    cursor.end,
    cursor.index + Math.max(1, characterBudget),
  );
  while (cursor.index < cursor.end && cursor.index < stop) {
    const decoded = decodeCharacter(cursor.source, cursor.index, cursor.end);
    output.push(decoded.value);
    cursor.index = decoded.next;
  }
  return { text: output.join(""), done: cursor.index >= cursor.end };
}

function decodeCharacter(
  source: JsonSource,
  index: number,
  end: number,
): { value: string; next: number } {
  if (sourceCharacter(source, index) !== "\\") {
    const codePoint = sourceCodePointAt(source, index);
    const value =
      codePoint === undefined ? "" : String.fromCodePoint(codePoint);
    return { value, next: Math.min(end, index + Math.max(1, value.length)) };
  }
  const escape = sourceCharacter(source, index + 1);
  if (escape === "u") {
    const first = Number.parseInt(
      sourceSlice(source, index + 2, index + 6),
      16,
    );
    if (
      first >= 0xd800 &&
      first <= 0xdbff &&
      sourceCharacter(source, index + 6) === "\\" &&
      sourceCharacter(source, index + 7) === "u"
    ) {
      const second = Number.parseInt(
        sourceSlice(source, index + 8, index + 12),
        16,
      );
      if (second >= 0xdc00 && second <= 0xdfff) {
        return {
          value: String.fromCodePoint(
            0x10000 + ((first - 0xd800) << 10) + second - 0xdc00,
          ),
          next: index + 12,
        };
      }
    }
    return { value: String.fromCharCode(first), next: index + 6 };
  }
  const simple: Record<string, string> = {
    '"': '"',
    "\\": "\\",
    "/": "/",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
  };
  return { value: simple[escape ?? ""] ?? "", next: index + 2 };
}

export function sourceSlice(
  source: JsonSource,
  start: number,
  end: number,
): string {
  return typeof source === "string"
    ? source.slice(start, end)
    : source.slice(start, end);
}

function sourceCharacter(
  source: JsonSource,
  index: number,
): string | undefined {
  return typeof source === "string" ? source[index] : source.charAt(index);
}

function sourceCodePointAt(
  source: JsonSource,
  index: number,
): number | undefined {
  return typeof source === "string"
    ? source.codePointAt(index)
    : source.codePointAt(index);
}

function isWhitespace(character: string | undefined): boolean {
  return (
    character === " " ||
    character === "\n" ||
    character === "\r" ||
    character === "\t"
  );
}

function isDigit(character: string | undefined): boolean {
  return character !== undefined && character >= "0" && character <= "9";
}

function isNonZeroDigit(character: string | undefined): boolean {
  return character !== undefined && character >= "1" && character <= "9";
}

function isDelimiter(character: string): boolean {
  return (
    isWhitespace(character) ||
    character === "," ||
    character === "]" ||
    character === "}"
  );
}

function isCompleteNumberState(state: NumberState): boolean {
  return (
    state === "zero" ||
    state === "integer" ||
    state === "fraction" ||
    state === "exponent"
  );
}
