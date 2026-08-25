import { describe, expect, it, vi } from "vitest";

import {
  AllExpansionBuilder,
  DepthFirstTreeWalker,
  IncrementalQueryPattern,
  IncrementalTextMatcher,
  IncrementalTreeSearch,
  ReverseDepthFirstTreeWalker,
  allVisibleSize,
  collapsedRanges,
  rawIndexAtVisibleIndex,
  visibleIndexForRawIndex,
  type TreeWalkAdapter,
} from "./value-tree-model";

interface Node {
  depth: number;
  ordinal: number;
  children: Node[];
}

const adapter: TreeWalkAdapter<Node> = {
  childCount: (node) => node.children.length,
  childAt: (node, index) => node.children[index],
};

describe("value tree traversal", () => {
  it("walks a wide tree incrementally without reading every child", () => {
    let childReads = 0;
    const root: Node = {
      depth: 0,
      ordinal: 0,
      children: new Proxy(Array.from({ length: 100_000 }), {
        get: (target, property, receiver) => {
          if (/^\d+$/.test(String(property))) childReads += 1;
          const index = Number(property);
          return Number.isInteger(index)
            ? {
                depth: 1,
                ordinal: index,
                children: [],
              }
            : Reflect.get(target, property, receiver);
        },
      }),
    };
    const walker = new DepthFirstTreeWalker(root, adapter);

    for (let index = 0; index < 250; index += 1) walker.step();

    expect(childReads).toBeLessThan(250);
    expect(walker.done).toBe(false);
  });

  it("builds an atomic index with constant-time size and collapsed ranges", () => {
    const root: Node = {
      depth: 0,
      ordinal: 0,
      children: [
        {
          depth: 1,
          ordinal: 0,
          children: [
            {
              depth: 2,
              ordinal: 0,
              children: [],
            },
          ],
        },
        { depth: 1, ordinal: 1, children: [] },
      ],
    };
    const builder = new AllExpansionBuilder(root, adapter);
    expect(builder.run(2)).toEqual({ visited: 1, done: false });
    expect(builder.run(10)).toEqual({ visited: 3, done: false });
    expect(builder.run(10)).toEqual({ visited: 0, done: true });
    const index = builder.finish();
    expect(index.ordinals).toEqual([0, 0, 0, 1]);
    expect(index.parentIndices).toEqual([null, 0, 1, 0]);
    const ranges = collapsedRanges(index, new Set([1]));
    expect(allVisibleSize(index, ranges)).toBe(3);
    expect(rawIndexAtVisibleIndex(index, ranges, 2)).toBe(3);
    expect(visibleIndexForRawIndex(ranges, 2)).toBeUndefined();
    expect(visibleIndexForRawIndex(ranges, 3)).toBe(2);
  });

  it("budgets deep sibling and final index unwinds one step at a time", () => {
    interface VirtualNode {
      branch: "root" | "first" | "shallow" | "final";
      depth: number;
      ordinal: number;
    }
    const depth = 10_000;
    let shallowReads = 0;
    const root: VirtualNode = { branch: "root", depth: 0, ordinal: 0 };
    const virtualAdapter: TreeWalkAdapter<VirtualNode> = {
      childCount: (node) =>
        node.branch === "root"
          ? 3
          : (node.branch === "first" || node.branch === "final") &&
              node.depth < depth
            ? 1
            : 0,
      childAt: (node, ordinal) => {
        if (node.branch === "root") {
          if (ordinal === 0) return { branch: "first", depth: 1, ordinal };
          if (ordinal === 1) {
            shallowReads += 1;
            return { branch: "shallow", depth: 1, ordinal };
          }
          return ordinal === 2
            ? { branch: "final", depth: 1, ordinal }
            : undefined;
        }
        return (node.branch === "first" || node.branch === "final") &&
          node.depth < depth &&
          ordinal === 0
          ? { branch: node.branch, depth: node.depth + 1, ordinal }
          : undefined;
      },
    };
    const builder = new AllExpansionBuilder(root, virtualAdapter);
    let totalVisited = 0;
    while (shallowReads === 0) totalVisited += builder.run(1).visited;
    expect(totalVisited).toBe(depth + 1);

    expect(builder.run(1)).toEqual({ visited: 0, done: false });
    for (let step = 0; step < 256; step += 1) {
      expect(builder.run(1)).toEqual({ visited: 0, done: false });
    }
    let siblingResult = { visited: 0, done: false };
    while (siblingResult.visited === 0) siblingResult = builder.run(1);
    expect(siblingResult).toEqual({ visited: 1, done: false });
    totalVisited += siblingResult.visited;

    while (totalVisited < depth * 2 + 2) {
      const result = builder.run(1);
      totalVisited += result.visited;
    }
    for (let step = 0; step < depth + 1; step += 1) {
      expect(builder.run(1).done).toBe(false);
    }
    for (let step = 0; step < 256; step += 1) {
      expect(builder.run(1)).toEqual({ visited: 0, done: false });
    }
    let finalizationSteps = 256;
    while (!builder.run(1).done) finalizationSteps += 1;
    expect(finalizationSteps).toBe(depth);
    expect(builder.finish().subtreeEnds[0]).toBe(depth * 2 + 2);
  });

  it("matches plain text across bounded case-insensitive chunks", () => {
    const query = preparedQuery("needle");
    const matcher = new IncrementalTextMatcher(
      { kind: "plain", text: `${"x".repeat(10_000)}Needle` },
      query,
    );
    let result = matcher.run(256);
    let chunks = 1;
    while (!result.done) {
      result = matcher.run(256);
      chunks += 1;
    }
    expect(result.matched).toBe(true);
    expect(result.snippet?.match).toContain("Needle");
    expect(chunks).toBeGreaterThan(10);
  });

  it("keeps sliced scalar reads inside their source span", () => {
    const source = '{"row":1,"group":1,"ok":false}';
    const start = source.indexOf("1");
    const matcher = new IncrementalTextMatcher(
      { kind: "slice", source, start, end: start + 1 },
      preparedQuery("ok"),
    );

    expect(matcher.run(source.length)).toEqual({
      done: true,
      matched: false,
      characters: 1,
    });
  });

  it("case-folds consistently when a contextual letter crosses chunks", () => {
    const query = preparedQuery(`${"x".repeat(4_095)}ΟΣ`);
    const matcher = new IncrementalTextMatcher(
      { kind: "plain", text: `${"x".repeat(4_095)}οσ` },
      query,
    );
    let result = matcher.run(4_096);
    while (!result.done) result = matcher.run(4_096);
    expect(result.matched).toBe(true);
  });

  it("case-folds a supplementary source character across a chunk boundary", () => {
    const matcher = new IncrementalTextMatcher(
      { kind: "plain", text: `${"x".repeat(4_095)}𐐀` },
      preparedQuery("𐐨"),
    );

    expect(matcher.run(4_096)).toMatchObject({
      done: true,
      matched: true,
      characters: 4_097,
    });
  });

  it("case-folds a supplementary query character across its preparation boundary", () => {
    const query = new IncrementalQueryPattern(`${"x".repeat(4_095)}𐐀`);
    expect(query.run(4_096)).toBe(4_097);
    expect(query.done).toBe(true);
    const matcher = new IncrementalTextMatcher(
      { kind: "plain", text: `${"x".repeat(4_095)}𐐨` },
      query,
    );

    expect(matcher.run(5_000)).toMatchObject({ done: true, matched: true });
  });

  it("never extends a supplementary pair beyond an explicit scalar span", () => {
    const source = `${"x".repeat(4_095)}\ud801\udc28`;
    const matcher = new IncrementalTextMatcher(
      { kind: "slice", source, start: 0, end: 4_096 },
      preparedQuery("𐐨"),
    );

    expect(matcher.run(4_096)).toEqual({
      done: true,
      matched: false,
      characters: 4_096,
    });
  });

  it("yields while searching one huge scalar and reports a node once", () => {
    const root: Node = {
      depth: 0,
      ordinal: 0,
      children: [],
    };
    const search = new IncrementalTreeSearch(
      root,
      {
        ...adapter,
        searchSources: () => [
          {
            location: "value" as const,
            text: {
              kind: "plain" as const,
              text: `${"x".repeat(100_000)}Needle`,
            },
          },
        ],
      },
      "needle",
    );
    const matches: string[] = [];

    const first = search.run(100, 4_096, (match) => {
      matches.push(match.snippet.match);
    });

    expect(first.done).toBe(false);
    expect(first.visited).toBe(0);
    expect(matches).toEqual([]);
    while (!search.done) {
      search.run(100, 4_096, (match) => {
        matches.push(match.snippet.match);
      });
    }
    expect(matches).toHaveLength(1);
    expect(matches[0]).toContain("Needle");
    expect(search.visited).toBe(1);
  });

  it("prepares a huge query and scans a scalar in bounded chunks", () => {
    const lower = vi.spyOn(String.prototype, "toLocaleLowerCase");
    const query = `${"X".repeat(100_000)}needle`;
    const root: Node = {
      depth: 0,
      ordinal: 0,
      children: [],
    };
    const search = new IncrementalTreeSearch(
      root,
      {
        ...adapter,
        searchSources: () => [
          {
            location: "value" as const,
            text: { kind: "plain" as const, text: query },
          },
        ],
      },
      query,
    );

    const first = search.run(100, 4_096, () => undefined);

    expect(first).toMatchObject({ done: false, visited: 0, characters: 4_096 });
    expect(
      lower.mock.instances.every((value) => String(value).length <= 4_096),
    ).toBe(true);
    while (!search.done) search.run(100, 4_096, () => undefined);
    expect(search.visited).toBe(1);
    lower.mockRestore();
  });

  it("walks and indexes a deeply nested tree without recursion", () => {
    const depth = 20_000;
    const nodes = Array.from({ length: depth + 1 }, (_value, index): Node => ({
      depth: index,
      ordinal: 0,
      children: [],
    }));
    for (let index = 0; index < depth; index += 1) {
      nodes[index]!.children.push(nodes[index + 1]!);
    }
    const builder = new AllExpansionBuilder(nodes[0]!, adapter);
    let visited = 0;
    while (true) {
      const result = builder.run(257);
      visited += result.visited;
      if (result.done) break;
    }
    const index = builder.finish();
    expect(visited).toBe(depth + 1);
    expect(index.ordinals).toHaveLength(depth + 1);
    expect(index.subtreeEnds[0]).toBe(depth + 1);
  });

  it("counts 100k matches and resumes navigation linearly by direction", () => {
    interface LinkedNode {
      depth: number;
      ordinal: number;
      parent: LinkedNode | null;
    }
    const childCount = 100_000;
    const root: LinkedNode = { depth: 0, ordinal: 0, parent: null };
    const linkedAdapter = {
      childCount: (node: LinkedNode) => (node.parent === null ? childCount : 0),
      childAt: (node: LinkedNode, ordinal: number): LinkedNode | undefined =>
        node.parent === null ? { depth: 1, ordinal, parent: node } : undefined,
      searchSources: (node: LinkedNode) =>
        node.parent === null
          ? []
          : [
              {
                location: "value" as const,
                text: { kind: "plain" as const, text: "match" },
              },
            ],
    };
    const forward = new IncrementalTreeSearch(root, linkedAdapter, "match");
    const reverse = new IncrementalTreeSearch(
      root,
      linkedAdapter,
      "match",
      new ReverseDepthFirstTreeWalker(root, linkedAdapter),
    );
    const exhaustive = new IncrementalTreeSearch(root, linkedAdapter, "match");
    let matches = 0;
    while (!exhaustive.done) {
      exhaustive.run(2_048, 32_768, () => {
        matches += 1;
      });
    }
    expect(matches).toBe(childCount);
    expect(exhaustive.visited).toBe(childCount + 1);
    const forwardOrdinals: number[] = [];
    const reverseOrdinals: number[] = [];

    for (let target = 0; target < 1_000; target += 1) {
      let forwardPaused = false;
      let reversePaused = false;
      while (!forwardPaused) {
        forwardPaused = forward.run(128, 4_096, ({ node }) => {
          forwardOrdinals.push(node.ordinal);
          return true;
        }).paused;
      }
      while (!reversePaused) {
        reversePaused = reverse.run(128, 4_096, ({ node }) => {
          reverseOrdinals.push(node.ordinal);
          return true;
        }).paused;
      }
    }

    expect(forward.visited).toBe(1_001);
    expect(reverse.visited).toBe(1_000);
    expect(forwardOrdinals).toEqual(
      Array.from({ length: 1_000 }, (_value, index) => index),
    );
    expect(reverseOrdinals).toEqual(
      Array.from({ length: 1_000 }, (_value, index) => childCount - index - 1),
    );
  });

  it("budgets a 100k reverse-wrap descent before yielding its first node", () => {
    interface DeepNode {
      depth: number;
      ordinal: number;
      parent: DeepNode | null;
    }
    const depth = 100_000;
    let childCalls = 0;
    const root: DeepNode = { depth: 0, ordinal: 0, parent: null };
    const deepAdapter = {
      childCount: (node: DeepNode) => (node.depth < depth ? 1 : 0),
      childAt: (node: DeepNode, ordinal: number): DeepNode | undefined => {
        childCalls += 1;
        return ordinal === 0 && node.depth < depth
          ? { depth: node.depth + 1, ordinal, parent: node }
          : undefined;
      },
      searchSources: (node: DeepNode) =>
        node.depth === depth
          ? [
              {
                location: "value" as const,
                text: { kind: "plain" as const, text: "last" },
              },
            ]
          : [],
    };
    const reverse = new ReverseDepthFirstTreeWalker(root, deepAdapter);
    expect(childCalls).toBe(0);
    const search = new IncrementalTreeSearch(
      root,
      deepAdapter,
      "last",
      reverse,
    );
    let matches = 0;

    const first = search.run(256, 4_096, () => {
      matches += 1;
      return true;
    });

    expect(first).toMatchObject({ paused: false, visited: 0 });
    expect(childCalls).toBeLessThanOrEqual(256);
    while (matches === 0) {
      search.run(2_048, 4_096, () => {
        matches += 1;
        return true;
      });
    }
    expect(matches).toBe(1);
    expect(search.visited).toBe(1);
  });

  it("budgets a 100k forward unwind before visiting a sibling", () => {
    interface MixedNode {
      branch: "root" | "deep" | "tail";
      depth: number;
      ordinal: number;
    }
    const depth = 100_000;
    let childCalls = 0;
    const root: MixedNode = { branch: "root", depth: 0, ordinal: 0 };
    const mixedAdapter: TreeWalkAdapter<MixedNode> = {
      childCount: (node) =>
        node.branch === "root"
          ? 2
          : node.branch === "deep" && node.depth < depth
            ? 1
            : 0,
      childAt: (node, ordinal) => {
        childCalls += 1;
        if (node.branch === "root") {
          if (ordinal === 0) return { branch: "deep", depth: 1, ordinal };
          return ordinal === 1
            ? { branch: "tail", depth: 1, ordinal }
            : undefined;
        }
        return node.branch === "deep" && node.depth < depth && ordinal === 0
          ? { branch: "deep", depth: node.depth + 1, ordinal }
          : undefined;
      },
    };
    const walker = new DepthFirstTreeWalker(root, mixedAdapter);
    let last: MixedNode | undefined;
    while (last?.branch !== "deep" || last.depth !== depth) {
      last = walker.step().node ?? last;
    }
    const callsBeforeUnwind = childCalls;
    const yielded: MixedNode[] = [];

    for (let step = 0; step < 256; step += 1) {
      const node = walker.step().node;
      if (node !== undefined) yielded.push(node);
    }

    expect(yielded).toEqual([]);
    expect(childCalls - callsBeforeUnwind).toBeLessThanOrEqual(256);
    while (last?.branch !== "tail") {
      const node = walker.step().node;
      if (node !== undefined) last = node;
    }
    expect(last).toMatchObject({ branch: "tail", ordinal: 1 });
  });
});

function preparedQuery(text: string): IncrementalQueryPattern {
  const query = new IncrementalQueryPattern(text);
  while (!query.done) query.run(4_096);
  return query;
}
