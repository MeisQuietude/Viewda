import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { SchemaField } from "./desktop";
import { SchemaTreeNode } from "./SchemaTree";

afterEach(cleanup);

describe("SchemaTreeNode", () => {
  const listField: SchemaField = {
    name: "values",
    physicalType: "GROUP",
    logicalType: "List",
    children: [
      {
        name: "list",
        physicalType: "GROUP",
        logicalType: null,
        children: [
          {
            name: "element",
            physicalType: "INT64",
            logicalType: null,
            children: [],
          },
        ],
      },
    ],
  };

  it("collapses physical list and map wrappers into logical notation", () => {
    const mapField: SchemaField = {
      name: "labels",
      physicalType: "GROUP",
      logicalType: "Map",
      children: [
        {
          name: "key_value",
          physicalType: "GROUP",
          logicalType: null,
          children: [
            {
              name: "key",
              physicalType: "BYTE_ARRAY",
              logicalType: "String",
              children: [],
            },
            {
              name: "value",
              physicalType: "INT32",
              logicalType: null,
              children: [],
            },
          ],
        },
      ],
    };
    render(
      <ul>
        <SchemaTreeNode field={listField} mode="logical" />
        <SchemaTreeNode field={mapField} mode="logical" />
      </ul>,
    );

    expect(screen.getByText("list<int64>")).toBeInTheDocument();
    expect(screen.getByText("map<string, int32>")).toBeInTheDocument();
    expect(screen.queryByText("list", { selector: ".schema-name" })).toBeNull();
    expect(screen.queryByText("key_value")).toBeNull();
  });

  it("keeps struct fields as child nodes in logical mode", () => {
    const profile: SchemaField = {
      name: "profile",
      physicalType: "GROUP",
      logicalType: null,
      children: [
        {
          name: "name",
          physicalType: "BYTE_ARRAY",
          logicalType: "String",
          children: [],
        },
        {
          name: "age",
          physicalType: "INT64",
          logicalType: null,
          children: [],
        },
      ],
    };
    render(
      <ul aria-label="schema">
        <SchemaTreeNode field={profile} mode="logical" />
      </ul>,
    );
    const schema = screen.getByRole("list", { name: "schema" });
    expect(
      within(schema).getByText("struct<name: string, age: int64>"),
    ).toBeInTheDocument();
    expect(
      within(schema).getByText("name", { selector: ".schema-name" }),
    ).toBeInTheDocument();
    expect(
      within(schema).getByText("age", { selector: ".schema-name" }),
    ).toBeInTheDocument();
  });

  it("skips collection wrappers until it reaches nested struct fields", () => {
    const city: SchemaField = {
      name: "city",
      physicalType: "BYTE_ARRAY",
      logicalType: "String",
      children: [],
    };
    const address: SchemaField = {
      name: "address",
      physicalType: "GROUP",
      logicalType: null,
      children: [city],
    };
    const nestedList: SchemaField = {
      name: "matrix",
      physicalType: "GROUP",
      logicalType: "List",
      children: [
        {
          name: "list",
          physicalType: "GROUP",
          logicalType: null,
          children: [
            {
              name: "element",
              physicalType: "GROUP",
              logicalType: "List",
              children: [
                {
                  name: "list",
                  physicalType: "GROUP",
                  logicalType: null,
                  children: [{ ...address, name: "element" }],
                },
              ],
            },
          ],
        },
      ],
    };
    const mapOfLists: SchemaField = {
      name: "by_label",
      physicalType: "GROUP",
      logicalType: "Map",
      children: [
        {
          name: "key_value",
          physicalType: "GROUP",
          logicalType: null,
          children: [
            {
              name: "key",
              physicalType: "BYTE_ARRAY",
              logicalType: "String",
              children: [],
            },
            {
              name: "value",
              physicalType: "GROUP",
              logicalType: "List",
              children: [
                {
                  name: "list",
                  physicalType: "GROUP",
                  logicalType: null,
                  children: [{ ...address, name: "element" }],
                },
              ],
            },
          ],
        },
      ],
    };
    render(
      <ul aria-label="schema">
        <SchemaTreeNode field={nestedList} mode="logical" />
        <SchemaTreeNode field={mapOfLists} mode="logical" />
      </ul>,
    );

    expect(screen.getByText(/list<list<struct<city: string>>>/)).toBeVisible();
    expect(
      screen.getByText(/map<string, list<struct<city: string>>>/),
    ).toBeVisible();
    expect(
      screen.getAllByText("city", { selector: ".schema-name" }),
    ).toHaveLength(2);
    for (const wrapper of ["list", "element", "key_value"]) {
      expect(
        screen.queryByText(wrapper, { selector: ".schema-name" }),
      ).toBeNull();
    }
  });

  it("retains physical wrappers in Structure mode", () => {
    render(
      <ul aria-label="schema">
        <SchemaTreeNode field={listField} />
      </ul>,
    );

    expect(screen.getByText("GROUP · List")).toBeInTheDocument();
    expect(
      screen.getByText("list", { selector: ".schema-name" }),
    ).toBeInTheDocument();
    expect(screen.getByText("element")).toBeInTheDocument();
  });
});
