import { describe, expect, it } from "vitest";

import type { SchemaField } from "../desktop";
import {
  fieldPathKey,
  fieldPathStartsWith,
  formatFieldPath,
  formatSqlFieldPath,
  resolveSchemaField,
  sameFieldPath,
} from "./field-path";

describe("field paths", () => {
  const schema: SchemaField[] = [
    {
      name: "profile.with.dot",
      physicalType: "GROUP",
      logicalType: null,
      children: [
        {
          name: 'postal"code',
          physicalType: "INT32",
          logicalType: null,
          children: [],
        },
      ],
    },
  ];

  it("keeps segment arrays as identity and uses quoting only for presentation", () => {
    const path = ["profile.with.dot", 'postal"code'];

    expect(fieldPathKey(path)).toBe('["profile.with.dot","postal\\"code"]');
    expect(formatFieldPath(path)).toBe('"profile.with.dot"."postal""code"');
    expect(formatSqlFieldPath(path)).toBe('"profile.with.dot"."postal""code"');
    expect(sameFieldPath(path, ["profile.with.dot", 'postal"code'])).toBe(true);
    expect(sameFieldPath(path, ["profile", "with", "dot", 'postal"code'])).toBe(
      false,
    );
  });

  it("resolves and compares ancestors by exact segments", () => {
    const path = ["profile.with.dot", 'postal"code'];

    expect(resolveSchemaField(schema, path)?.physicalType).toBe("INT32");
    expect(fieldPathStartsWith(path, ["profile.with.dot"])).toBe(true);
    expect(fieldPathStartsWith(path, ["profile"])).toBe(false);
  });

  it("rejects ambiguous and case-mismatched schema paths", () => {
    const duplicate = [schema[0]!, { ...schema[0]! }];

    expect(resolveSchemaField(duplicate, ["profile.with.dot"])).toBeUndefined();
    expect(
      resolveSchemaField(schema, ["Profile.with.dot", 'postal"code']),
    ).toBeUndefined();
  });
});
