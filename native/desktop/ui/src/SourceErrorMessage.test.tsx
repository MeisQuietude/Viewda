import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { SourceErrorMessage } from "./SourceErrorMessage";

afterEach(cleanup);

it("explains how to recover from an unreadable dataset member", () => {
  const onReload = vi.fn();
  render(
    <SourceErrorMessage
      error={{
        code: "memberPermissionDenied",
        member: "year=2026/private.parquet",
      }}
      onReload={onReload}
    />,
  );

  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent(
    "Viewda cannot read a dataset member. Check its permissions, then reload the dataset. (year=2026/private.parquet)",
  );
  fireEvent.click(
    within(alert).getByRole("button", { name: "Reload dataset" }),
  );

  expect(onReload).toHaveBeenCalledOnce();
});

it("offers reload after a dataset member becomes invalid", () => {
  const onReload = vi.fn();
  render(
    <SourceErrorMessage
      error={{ code: "invalidMember", member: "broken.parquet" }}
      onReload={onReload}
    />,
  );

  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent(
    "A dataset member is damaged or unsupported. Reload the dataset. (broken.parquet)",
  );
  fireEvent.click(
    within(alert).getByRole("button", { name: "Reload dataset" }),
  );
  expect(onReload).toHaveBeenCalledOnce();
});

it("identifies a repeated Hive key and explains how to recover", () => {
  const onReload = vi.fn();
  render(
    <SourceErrorMessage
      error={{
        code: "duplicatePartitionKey",
        key: "year",
        member: "year=2026/year=2025/part.parquet",
      }}
      onReload={onReload}
    />,
  );

  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent(
    "A dataset member repeats the Hive partition key “year”. Rename one of its year=value folders, then reload the dataset. (year=2026/year=2025/part.parquet · year)",
  );
  fireEvent.click(
    within(alert).getByRole("button", { name: "Reload dataset" }),
  );
  expect(onReload).toHaveBeenCalledOnce();
});
