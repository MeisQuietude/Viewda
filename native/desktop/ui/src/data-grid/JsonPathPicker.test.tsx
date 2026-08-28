import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import * as desktop from "../desktop";
import type { JsonSchemaInference, JsonSchemaNode } from "../desktop";
import { JsonPathPicker } from "./JsonPathPicker";

const inference: JsonSchemaInference = {
  isSampleDerived: true,
  sampleRowLimit: 512,
  sampleValueByteLimit: 8192,
  sampleValueCharacterLimit: 2048,
  sampleTotalByteLimit: 4_194_304,
  sampleArrowByteLimit: 5_719_040,
  sampledRowCount: 32,
  sampledValueBytes: 900,
  hasMoreRows: true,
  isTruncated: false,
  invalidValueCount: 0,
  oversizedValueCount: 0,
  nodes: [
    {
      segment: { field: "items" },
      observedTypes: ["array"],
      effectiveType: null,
      children: [
        {
          segment: { index: 0 },
          observedTypes: ["object"],
          effectiveType: null,
          children: [
            {
              segment: { field: "unit.price" },
              observedTypes: ["number"],
              effectiveType: "number",
              children: [],
            },
          ],
        },
      ],
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("marks the tree as sample-derived and searches without losing ancestors", async () => {
  vi.spyOn(desktop, "inferJsonSchema").mockResolvedValue(inference);
  const onChange = vi.fn();
  render(
    <JsonPathPicker
      generation={701}
      fieldPath={["payload"]}
      target={null}
      onChange={onChange}
    />,
  );

  expect(
    await screen.findByText(
      /Sample-derived fields from at most the first 512 rows/,
    ),
  ).toBeVisible();
  expect(screen.getByText(/Later rows may contain other fields/)).toBeVisible();

  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "unit.price" },
  });
  const tree = screen.getByRole("tree", { name: "Sampled JSON fields" });
  expect(within(tree).getAllByRole("treeitem")).toHaveLength(3);
  fireEvent.click(
    within(tree).getByRole("treeitem", {
      name: /items\[0\]\."unit\.price" number/,
    }),
  );

  expect(onChange).toHaveBeenLastCalledWith({
    path: [{ field: "items" }, { index: 0 }, { field: "unit.price" }],
    valueType: "number",
  });
});

it("accepts a valid manual path that is absent from the sample", async () => {
  vi.spyOn(desktop, "inferJsonSchema").mockResolvedValue(inference);
  const onChange = vi.fn();
  render(
    <JsonPathPicker
      generation={702}
      fieldPath={["payload"]}
      target={null}
      onChange={onChange}
    />,
  );
  await screen.findByText(/Sample-derived fields/);

  fireEvent.change(screen.getByRole("textbox", { name: "Manual JSON path" }), {
    target: { value: '"appears.later"[3]' },
  });

  expect(onChange).toHaveBeenLastCalledWith({
    path: [{ field: "appears.later" }, { index: 3 }],
    valueType: "text",
  });
});

it("does not repeat inference when an equal FieldPath array is recreated", async () => {
  const infer = vi
    .spyOn(desktop, "inferJsonSchema")
    .mockResolvedValue(inference);
  const { rerender } = render(
    <JsonPathPicker
      generation={703}
      fieldPath={["payload"]}
      target={null}
      onChange={vi.fn()}
    />,
  );
  await screen.findByText(/Sample-derived fields/);

  rerender(
    <JsonPathPicker
      generation={703}
      fieldPath={["payload"]}
      target={null}
      onChange={vi.fn()}
    />,
  );

  expect(infer).toHaveBeenCalledTimes(1);
});

it("reuses inference across unmount and reopen", async () => {
  const infer = vi
    .spyOn(desktop, "inferJsonSchema")
    .mockResolvedValue(inference);
  const first = render(
    <JsonPathPicker
      generation={704}
      sourceRevisionKey={JSON.stringify(["complete", 32])}
      fieldPath={["payload"]}
      target={null}
      onChange={vi.fn()}
    />,
  );
  await screen.findByText(/Sample-derived fields/);
  first.unmount();

  render(
    <JsonPathPicker
      generation={704}
      sourceRevisionKey={JSON.stringify(["complete", 32])}
      fieldPath={["payload"]}
      target={null}
      onChange={vi.fn()}
    />,
  );
  await screen.findByText(/Sample-derived fields/);
  expect(infer).toHaveBeenCalledTimes(1);
});

it("refetches when content identity or source row count changes", async () => {
  const infer = vi
    .spyOn(desktop, "inferJsonSchema")
    .mockResolvedValue(inference);
  const { rerender } = render(
    <JsonPathPicker
      generation={708}
      sourceRevisionKey={JSON.stringify(["early-sample", 32])}
      fieldPath={["payload"]}
      target={null}
      onChange={vi.fn()}
    />,
  );
  await screen.findByText(/Sample-derived fields/);

  rerender(
    <JsonPathPicker
      generation={708}
      sourceRevisionKey={JSON.stringify(["complete", 32])}
      fieldPath={["payload"]}
      target={null}
      onChange={vi.fn()}
    />,
  );
  await waitFor(() => expect(infer).toHaveBeenCalledTimes(2));

  rerender(
    <JsonPathPicker
      generation={708}
      sourceRevisionKey={JSON.stringify(["complete", 64])}
      fieldPath={["payload"]}
      target={null}
      onChange={vi.fn()}
    />,
  );
  await waitFor(() => expect(infer).toHaveBeenCalledTimes(3));
});

it("shares one in-flight inference between concurrent pickers", async () => {
  let resolveInference: ((value: JsonSchemaInference) => void) | undefined;
  const pending = new Promise<JsonSchemaInference>((resolve) => {
    resolveInference = resolve;
  });
  const infer = vi.spyOn(desktop, "inferJsonSchema").mockReturnValue(pending);
  render(
    <>
      <JsonPathPicker
        generation={705}
        fieldPath={["payload"]}
        target={null}
        onChange={vi.fn()}
      />
      <JsonPathPicker
        generation={705}
        fieldPath={["payload"]}
        target={null}
        onChange={vi.fn()}
      />
    </>,
  );

  expect(infer).toHaveBeenCalledTimes(1);
  resolveInference?.(inference);
  expect(await screen.findAllByText(/Sample-derived fields/)).toHaveLength(2);
});

it("evicts a failed inference so reopening can retry", async () => {
  const infer = vi
    .spyOn(desktop, "inferJsonSchema")
    .mockRejectedValueOnce(new Error("unavailable"))
    .mockResolvedValueOnce(inference);
  const first = render(
    <JsonPathPicker
      generation={706}
      fieldPath={["payload"]}
      target={null}
      onChange={vi.fn()}
    />,
  );
  await screen.findByRole("alert");
  first.unmount();

  render(
    <JsonPathPicker
      generation={706}
      fieldPath={["payload"]}
      target={null}
      onChange={vi.fn()}
    />,
  );
  await screen.findByText(/Sample-derived fields/);
  expect(infer).toHaveBeenCalledTimes(2);
});

it("moves roving focus through virtualized container rows", async () => {
  let child: JsonSchemaNode = {
    segment: { field: "leaf" },
    observedTypes: ["number"],
    effectiveType: "number" as const,
    children: [],
  };
  for (let depth = 15; depth >= 0; depth -= 1) {
    child = {
      segment: { field: `level_${depth}` },
      observedTypes: ["object"],
      effectiveType: null,
      children: [child],
    };
  }
  vi.spyOn(desktop, "inferJsonSchema").mockResolvedValue({
    ...inference,
    nodes: [child],
  });
  const onChange = vi.fn();
  render(
    <JsonPathPicker
      generation={707}
      fieldPath={["payload"]}
      target={null}
      onChange={onChange}
    />,
  );
  await screen.findByText(/Sample-derived fields/);

  const search = screen.getByRole("searchbox");
  fireEvent.keyDown(search, { key: "ArrowDown" });
  expect(document.activeElement).toHaveAttribute("aria-disabled", "true");
  fireEvent.click(document.activeElement!);
  expect(onChange).not.toHaveBeenCalled();

  for (let index = 0; index < 16; index += 1) {
    const previous = document.activeElement;
    fireEvent.keyDown(previous!, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).not.toBe(previous));
  }
  expect(document.activeElement).toHaveAttribute("aria-disabled", "false");
  fireEvent.click(document.activeElement!);
  expect(onChange).toHaveBeenLastCalledWith({
    path: [
      ...Array.from({ length: 16 }, (_, index) => ({
        field: `level_${index}`,
      })),
      { field: "leaf" },
    ],
    valueType: "number",
  });
});
