import {
  jsonStringCursor,
  readJsonStringChunk,
  sourceSlice,
  type JsonSource,
  type JsonStringCursor,
} from "./json-value";
import type { ValueSearchText } from "./value-format";

const TEXT_CHUNK_SIZE = 4_096;
const QUERY_PAGE_SIZE = 4_096;
const SNIPPET_SIZE = 96;
const SNIPPET_MATCH_SIZE = 64;

export interface WalkNode {
  depth: number;
  ordinal: number;
}

export interface TreeWalkAdapter<Node extends WalkNode> {
  childCount(node: Node): number;
  childAt(node: Node, index: number): Node | undefined;
}

interface WalkFrame<Node> {
  node: Node;
  entered: boolean;
  nextChild: number;
  childCount: number;
}

export interface TreeWalker<Node> {
  step(): { node?: Node };
  readonly done: boolean;
}

export class DepthFirstTreeWalker<Node extends WalkNode> {
  readonly #adapter: TreeWalkAdapter<Node>;
  readonly #stack: WalkFrame<Node>[];

  constructor(root: Node, adapter: TreeWalkAdapter<Node>) {
    this.#adapter = adapter;
    this.#stack = [this.#frame(root)];
  }

  step(): { node?: Node } {
    const frame = this.#stack.at(-1);
    if (frame === undefined) return {};
    if (!frame.entered) {
      frame.entered = true;
      return { node: frame.node };
    }
    if (frame.nextChild < frame.childCount) {
      const child = this.#adapter.childAt(frame.node, frame.nextChild);
      frame.nextChild += 1;
      if (child !== undefined) this.#stack.push(this.#frame(child));
    } else {
      this.#stack.pop();
    }
    return {};
  }

  get done(): boolean {
    return this.#stack.length === 0;
  }

  #frame(node: Node): WalkFrame<Node> {
    return {
      node,
      entered: false,
      nextChild: 0,
      childCount: this.#adapter.childCount(node),
    };
  }
}

export interface ParentLinkedWalkNode<Node> extends WalkNode {
  parent: Node | null;
}

/** Walks the same preorder sequence backwards without first indexing it. */
export class ReverseDepthFirstTreeWalker<
  Node extends ParentLinkedWalkNode<Node>,
> implements TreeWalker<Node> {
  readonly #adapter: TreeWalkAdapter<Node>;
  #phase:
    | { kind: "descend"; node: Node; nextChild: number | null }
    | { kind: "yield"; node: Node }
    | { kind: "predecessor"; parent: Node; nextSibling: number }
    | { kind: "done" };

  constructor(root: Node, adapter: TreeWalkAdapter<Node>) {
    this.#adapter = adapter;
    this.#phase = { kind: "descend", node: root, nextChild: null };
  }

  step(): { node?: Node } {
    const phase = this.#phase;
    if (phase.kind === "done") return {};
    if (phase.kind === "yield") {
      const parent = phase.node.parent;
      this.#phase =
        parent === null
          ? { kind: "done" }
          : {
              kind: "predecessor",
              parent,
              nextSibling: phase.node.ordinal - 1,
            };
      return { node: phase.node };
    }
    if (phase.kind === "predecessor") {
      if (phase.nextSibling < 0) {
        this.#phase = { kind: "yield", node: phase.parent };
        return {};
      }
      const ordinal = phase.nextSibling;
      phase.nextSibling -= 1;
      const sibling = this.#adapter.childAt(phase.parent, ordinal);
      if (sibling !== undefined) {
        this.#phase = {
          kind: "descend",
          node: sibling,
          nextChild: null,
        };
      }
      return {};
    }
    if (phase.nextChild === null) {
      phase.nextChild = this.#adapter.childCount(phase.node) - 1;
      return {};
    }
    if (phase.nextChild < 0) {
      this.#phase = { kind: "yield", node: phase.node };
      return {};
    }
    const ordinal = phase.nextChild;
    phase.nextChild -= 1;
    const child = this.#adapter.childAt(phase.node, ordinal);
    if (child !== undefined) {
      this.#phase = { kind: "descend", node: child, nextChild: null };
    }
    return {};
  }

  get done(): boolean {
    return this.#phase.kind === "done";
  }
}

export interface AllExpansionIndex {
  ordinals: readonly number[];
  parentIndices: readonly (number | null)[];
  subtreeEnds: readonly number[];
}

export class AllExpansionBuilder<Node extends WalkNode> {
  readonly #walker: DepthFirstTreeWalker<Node>;
  readonly #ordinals: number[] = [];
  readonly #parentIndices: Array<number | null> = [];
  readonly #subtreeEnds: number[] = [];
  readonly #open: number[] = [];
  #pendingNode: Node | null = null;

  constructor(root: Node, adapter: TreeWalkAdapter<Node>) {
    this.#walker = new DepthFirstTreeWalker(root, adapter);
  }

  run(nodeBudget: number): { visited: number; done: boolean } {
    let visited = 0;
    let steps = Math.max(1, nodeBudget);
    while (steps > 0) {
      if (this.#pendingNode !== null) {
        this.#closeOne();
        steps -= 1;
        if (this.#open.length > this.#pendingNode.depth) continue;
        this.#append(this.#pendingNode);
        this.#pendingNode = null;
        visited += 1;
        continue;
      }
      if (this.#walker.done) {
        if (this.#open.length === 0) break;
        this.#closeOne();
        steps -= 1;
        continue;
      }
      const { node } = this.#walker.step();
      steps -= 1;
      if (node === undefined) continue;
      if (this.#open.length > node.depth) {
        this.#pendingNode = node;
        continue;
      }
      this.#append(node);
      visited += 1;
    }
    return { visited, done: this.#done };
  }

  finish(): AllExpansionIndex {
    if (!this.#done) throw new Error("Expansion index is incomplete.");
    return {
      ordinals: this.#ordinals,
      parentIndices: this.#parentIndices,
      subtreeEnds: this.#subtreeEnds,
    };
  }

  get #done(): boolean {
    return (
      this.#walker.done && this.#pendingNode === null && this.#open.length === 0
    );
  }

  #append(node: Node): void {
    const index = this.#ordinals.length;
    this.#ordinals.push(node.ordinal);
    this.#parentIndices.push(
      node.depth === 0 ? null : (this.#open[node.depth - 1] ?? null),
    );
    this.#subtreeEnds.push(index + 1);
    this.#open.push(index);
  }

  #closeOne(): void {
    this.#subtreeEnds[this.#open.pop()!] = this.#ordinals.length;
  }
}

export interface CollapsedRange {
  start: number;
  end: number;
}

export function collapsedRanges(
  index: AllExpansionIndex,
  collapsed: ReadonlySet<number>,
): CollapsedRange[] {
  const ranges: CollapsedRange[] = [];
  for (const start of collapsed) {
    if (start < 0 || start >= index.ordinals.length) continue;
    let parent = index.parentIndices[start];
    let hiddenByParent = false;
    while (parent !== null && parent !== undefined) {
      if (collapsed.has(parent)) {
        hiddenByParent = true;
        break;
      }
      parent = index.parentIndices[parent];
    }
    if (!hiddenByParent) ranges.push({ start, end: index.subtreeEnds[start]! });
  }
  return ranges.sort((left, right) => left.start - right.start);
}

export function allVisibleSize(
  index: AllExpansionIndex,
  ranges: readonly CollapsedRange[],
): number {
  return ranges.reduce(
    (size, range) => size - Math.max(0, range.end - range.start - 1),
    index.ordinals.length,
  );
}

export function rawIndexAtVisibleIndex(
  index: AllExpansionIndex,
  ranges: readonly CollapsedRange[],
  visibleIndex: number,
): number | undefined {
  let remaining = visibleIndex;
  let rawStart = 0;
  for (const range of ranges) {
    const segment = range.start + 1 - rawStart;
    if (remaining < segment) return rawStart + remaining;
    remaining -= segment;
    rawStart = range.end;
  }
  const raw = rawStart + remaining;
  return raw < index.ordinals.length ? raw : undefined;
}

export function visibleIndexForRawIndex(
  ranges: readonly CollapsedRange[],
  rawIndex: number,
): number | undefined {
  let hidden = 0;
  for (const range of ranges) {
    if (rawIndex > range.start && rawIndex < range.end) return undefined;
    if (rawIndex >= range.end) hidden += range.end - range.start - 1;
    else break;
  }
  return rawIndex - hidden;
}

export interface SearchSnippet {
  before: string;
  match: string;
}

export interface TextMatchResult {
  done: boolean;
  matched: boolean;
  characters: number;
  snippet?: SearchSnippet;
}

export interface SearchSource {
  location: "key" | "value";
  text: ValueSearchText;
}

export interface TreeSearchAdapter<
  Node extends WalkNode,
> extends TreeWalkAdapter<Node> {
  searchSources(node: Node): readonly SearchSource[];
}

export interface TreeSearchMatch<Node> {
  node: Node;
  location: SearchSource["location"];
  snippet: SearchSnippet;
}

/**
 * Scans one depth-first tree without retaining matches. Query preparation,
 * node access, and text decoding all consume explicit per-chunk budgets.
 */
export class IncrementalTreeSearch<Node extends WalkNode> {
  readonly #walker: TreeWalker<Node>;
  readonly #adapter: TreeSearchAdapter<Node>;
  readonly #query: IncrementalQueryPattern;
  #node: Node | null = null;
  #sources: readonly SearchSource[] = [];
  #sourceIndex = 0;
  #matcher: IncrementalTextMatcher | null = null;
  #visited = 0;
  #characters = 0;

  constructor(
    root: Node,
    adapter: TreeSearchAdapter<Node>,
    query: string,
    walker: TreeWalker<Node> = new DepthFirstTreeWalker(root, adapter),
  ) {
    this.#walker = walker;
    this.#adapter = adapter;
    this.#query = new IncrementalQueryPattern(query);
  }

  get visited(): number {
    return this.#visited;
  }

  get characters(): number {
    return this.#characters;
  }

  get done(): boolean {
    return this.#walker.done && this.#node === null;
  }

  run(
    nodeBudget: number,
    characterBudget: number,
    onMatch: (match: TreeSearchMatch<Node>) => boolean | void,
  ): {
    done: boolean;
    paused: boolean;
    visited: number;
    characters: number;
  } {
    let steps = Math.max(1, nodeBudget);
    let characters = Math.max(1, characterBudget);
    let paused = false;
    if (!this.#query.done) {
      const consumed = this.#query.run(characters);
      characters -= consumed;
      this.#characters += consumed;
      if (!this.#query.done || characters === 0) return this.#result(false);
    }

    while (!paused && steps > 0 && characters > 0) {
      if (this.#node === null) {
        const { node } = this.#walker.step();
        steps -= 1;
        if (node === undefined) continue;
        this.#node = node;
        this.#sources = this.#adapter.searchSources(node);
        this.#sourceIndex = 0;
        this.#matcher = null;
      }

      const source = this.#sources[this.#sourceIndex];
      if (source === undefined) {
        this.#finishNode();
        continue;
      }
      this.#matcher ??= new IncrementalTextMatcher(source.text, this.#query);
      const result = this.#matcher.run(Math.min(TEXT_CHUNK_SIZE, characters));
      characters -= result.characters;
      this.#characters += result.characters;
      if (result.matched) {
        const stop =
          onMatch({
            node: this.#node,
            location: source.location,
            snippet: result.snippet!,
          }) === true;
        this.#finishNode();
        if (stop) paused = true;
      } else if (result.done) {
        this.#sourceIndex += 1;
        this.#matcher = null;
      }
    }
    return this.#result(paused);
  }

  #result(paused: boolean): {
    done: boolean;
    paused: boolean;
    visited: number;
    characters: number;
  } {
    return {
      done: this.done,
      paused,
      visited: this.#visited,
      characters: this.#characters,
    };
  }

  #finishNode(): void {
    this.#visited += 1;
    this.#node = null;
    this.#sources = [];
    this.#sourceIndex = 0;
    this.#matcher = null;
  }
}

/** A paged, incrementally case-folded KMP pattern. */
export class IncrementalQueryPattern {
  readonly #source: string;
  readonly #characters: Uint16Array[] = [];
  readonly #fallbacks: Int32Array[] = [];
  #sourceOffset = 0;
  #length = 0;

  constructor(source: string) {
    this.#source = source;
  }

  get done(): boolean {
    return this.#sourceOffset >= this.#source.length;
  }

  get length(): number {
    return this.#length;
  }

  run(characterBudget: number): number {
    if (this.done) return 0;
    const end = safeChunkEnd(
      this.#source,
      this.#sourceOffset,
      Math.min(TEXT_CHUNK_SIZE, Math.max(1, characterBudget)),
      this.#source.length,
    );
    const raw = this.#source.slice(this.#sourceOffset, end);
    this.#sourceOffset += raw.length;
    visitFoldedCharacters(raw, (character) => {
      this.#append(character);
      return false;
    });
    return raw.length;
  }

  character(index: number): number {
    return this.#characters[Math.floor(index / QUERY_PAGE_SIZE)]![
      index % QUERY_PAGE_SIZE
    ]!;
  }

  fallback(index: number): number {
    return this.#fallbacks[Math.floor(index / QUERY_PAGE_SIZE)]![
      index % QUERY_PAGE_SIZE
    ]!;
  }

  #append(character: number): void {
    const pageIndex = Math.floor(this.#length / QUERY_PAGE_SIZE);
    if (this.#characters[pageIndex] === undefined) {
      this.#characters.push(new Uint16Array(QUERY_PAGE_SIZE));
      this.#fallbacks.push(new Int32Array(QUERY_PAGE_SIZE));
    }
    let fallback = this.#length === 0 ? 0 : this.fallback(this.#length - 1);
    while (fallback > 0 && this.character(fallback) !== character) {
      fallback = this.fallback(fallback - 1);
    }
    if (this.#length > 0 && this.character(fallback) === character) {
      fallback += 1;
    }
    this.#characters[pageIndex]![this.#length % QUERY_PAGE_SIZE] = character;
    this.#fallbacks[pageIndex]![this.#length % QUERY_PAGE_SIZE] = fallback;
    this.#length += 1;
  }
}

export class IncrementalTextMatcher {
  readonly #source: ValueSearchText;
  readonly #query: IncrementalQueryPattern;
  #offset = 0;
  #jsonCursor: JsonStringCursor | null = null;
  #utf8Decoder: TextDecoder | null = null;
  #matchedPrefix = 0;
  #context = "";
  #done = false;

  constructor(source: ValueSearchText, query: IncrementalQueryPattern) {
    this.#source = source;
    this.#query = query;
    if (!query.done) throw new Error("Search query is not prepared.");
    if (source.kind === "jsonString") {
      this.#jsonCursor = jsonStringCursor(
        source.source,
        source.start,
        source.end,
      );
    } else if (source.kind === "utf8") {
      this.#utf8Decoder = new TextDecoder();
    }
  }

  run(characterBudget: number): TextMatchResult {
    if (this.#done) return { done: true, matched: false, characters: 0 };
    const chunk = this.#read(Math.max(1, characterBudget));
    let snippet: SearchSnippet | undefined;
    let processedCharacters = chunk.text.length;
    visitFoldedCharacters(chunk.text, (character, originalEnd) => {
      while (
        this.#matchedPrefix > 0 &&
        this.#query.character(this.#matchedPrefix) !== character
      ) {
        this.#matchedPrefix = this.#query.fallback(this.#matchedPrefix - 1);
      }
      if (this.#query.character(this.#matchedPrefix) === character) {
        this.#matchedPrefix += 1;
      }
      if (this.#matchedPrefix === this.#query.length) {
        processedCharacters = originalEnd;
        const context =
          `${this.#context}${chunk.text.slice(0, originalEnd)}`.slice(
            -SNIPPET_SIZE,
          );
        const matchLength = Math.min(
          SNIPPET_MATCH_SIZE,
          this.#query.length,
          context.length,
        );
        snippet = {
          before: context.slice(0, -matchLength),
          match: context.slice(-matchLength),
        };
        return true;
      }
      return false;
    });
    if (snippet !== undefined) {
      this.#done = true;
      return {
        done: true,
        matched: true,
        characters: processedCharacters,
        snippet,
      };
    }
    this.#context = `${this.#context}${chunk.text}`.slice(-SNIPPET_SIZE);
    this.#done = chunk.done;
    return {
      done: chunk.done,
      matched: false,
      characters: chunk.text.length,
    };
  }

  #read(characterBudget: number): { text: string; done: boolean } {
    if (this.#source.kind === "jsonString") {
      return readJsonStringChunk(this.#jsonCursor!, characterBudget);
    }
    if (this.#source.kind === "utf8") {
      const start = this.#source.start + this.#offset;
      const end = Math.min(this.#source.end, start + characterBudget);
      this.#offset += end - start;
      const done = start >= this.#source.end || end >= this.#source.end;
      return {
        text: this.#utf8Decoder!.decode(
          this.#source.bytes.subarray(start, end),
          { stream: !done },
        ),
        done,
      };
    }
    const length =
      this.#source.kind === "plain"
        ? this.#source.text.length
        : this.#source.end - this.#source.start;
    const start =
      (this.#source.kind === "plain" ? 0 : this.#source.start) + this.#offset;
    const source: string | JsonSource =
      this.#source.kind === "plain" ? this.#source.text : this.#source.source;
    const text = sourceSlice(
      source,
      start,
      safeChunkEnd(
        source,
        start,
        characterBudget,
        start + length - this.#offset,
      ),
    );
    this.#offset += text.length;
    return { text, done: this.#offset >= length };
  }
}

function safeChunkEnd(
  source: JsonSource,
  start: number,
  characterBudget: number,
  sourceLimit: number,
): number {
  const end = Math.min(sourceLimit, start + Math.max(1, characterBudget));
  if (end >= sourceLimit) return end;
  const boundary = sourceSlice(source, end - 1, end + 1);
  const before = boundary.charCodeAt(0);
  const after = boundary.charCodeAt(1);
  return before >= 0xd800 &&
    before <= 0xdbff &&
    after >= 0xdc00 &&
    after <= 0xdfff
    ? end + 1
    : end;
}

function visitFoldedCharacters(
  text: string,
  visit: (character: number, originalEnd: number) => boolean,
): void {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 65 && code <= 90) {
      if (visit(code + 32, index + 1)) return;
      continue;
    }
    const next = text.charCodeAt(index + 1);
    const width =
      code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
        ? 2
        : 1;
    const character = text.slice(index, index + width);
    const folded = code < 128 ? character : character.toLocaleLowerCase();
    for (let foldedIndex = 0; foldedIndex < folded.length; foldedIndex += 1) {
      if (visit(folded.charCodeAt(foldedIndex), index + width)) return;
    }
    index += width - 1;
  }
}
