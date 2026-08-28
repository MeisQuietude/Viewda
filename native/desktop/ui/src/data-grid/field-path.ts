import type { FieldPath, SchemaField } from "../desktop";

const SIMPLE_SEGMENT = /^[A-Za-z0-9_]+$/;

export function fieldPathKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

export function sameFieldPath(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((segment, index) => segment === right[index])
  );
}

export function fieldPathStartsWith(
  path: readonly string[],
  ancestor: readonly string[],
): boolean {
  return (
    ancestor.length <= path.length &&
    ancestor.every((segment, index) => segment === path[index])
  );
}

export function formatFieldPath(path: readonly string[]): string {
  return path.map(formatFieldPathSegment).join(".");
}

export function formatFieldPathSegment(segment: string): string {
  return SIMPLE_SEGMENT.test(segment)
    ? segment
    : `"${segment.replaceAll('"', '""')}"`;
}

export function formatSqlFieldPath(path: readonly string[]): string {
  return path.map((segment) => `"${segment.replaceAll('"', '""')}"`).join(".");
}

export function resolveSchemaField(
  schema: readonly SchemaField[],
  path: readonly string[],
): SchemaField | undefined {
  const [root, ...descendants] = path;
  let matches = schema.filter((candidate) => candidate.name === root);
  if (matches.length !== 1) return undefined;
  let field = matches[0]!;
  for (const segment of descendants) {
    matches = field.children.filter((candidate) => candidate.name === segment);
    if (matches.length !== 1) return undefined;
    field = matches[0]!;
  }
  return field;
}

export function topLevelFieldPaths(
  schema: readonly SchemaField[],
): FieldPath[] {
  return schema.map((field) => [field.name]);
}
