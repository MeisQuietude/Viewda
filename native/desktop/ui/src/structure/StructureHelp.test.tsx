import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { StructureHelp } from "./StructureHelp";

afterEach(cleanup);

describe("StructureHelp", () => {
  it("connects a compact info button to a concise example", () => {
    render(<StructureHelp term="Bloom filter" />);

    const info = screen.getByRole("button", { name: "About Bloom filter" });
    fireEvent.focus(info);
    const card = screen.getByRole("tooltip");
    expect(screen.getByText("Bloom filter")).toBeInTheDocument();
    expect(info).toHaveAttribute("aria-describedby", card.id);
    expect(card).toHaveTextContent(
      "For example, it can skip a row group that cannot contain one requested ID.",
    );
  });

  it("stays open while pointer or focus transfers to the tooltip and closes on Escape", () => {
    render(<StructureHelp term="Storage" />);

    const info = screen.getByRole("button", { name: "About Storage" });
    fireEvent.mouseEnter(info);
    const card = screen.getByRole("tooltip");
    fireEvent.mouseLeave(info, { relatedTarget: card });
    expect(card).toBeInTheDocument();
    fireEvent.focus(card);
    fireEvent.keyDown(card, { key: "Escape" });

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(info).toHaveFocus();
  });

  it("explains exactly which stored structures make whole-file bytes differ", () => {
    render(<StructureHelp term="Storage" />);
    fireEvent.focus(screen.getByRole("button", { name: "About Storage" }));

    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Column data on disk sums compressed page data in column chunks",
    );
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "separately stored Bloom filters, page indexes, footer metadata and file framing",
    );
  });
});
