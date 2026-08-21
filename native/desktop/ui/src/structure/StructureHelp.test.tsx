import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { StructureHelp } from "./StructureHelp";

afterEach(cleanup);

describe("StructureHelp", () => {
  it("connects a keyboard-focusable term to its interpretation card", () => {
    render(<StructureHelp term="Bloom filter" />);

    const term = screen.getByText("Bloom filter");
    fireEvent.focus(term);
    const card = screen.getByRole("tooltip");
    expect(term).toHaveAttribute("tabindex", "0");
    expect(term).toHaveAttribute("aria-describedby", card.id);
    expect(card).toHaveTextContent("A negative answer is definitive");
  });
});
