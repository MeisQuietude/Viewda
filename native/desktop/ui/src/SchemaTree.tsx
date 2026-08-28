import type { FieldPath, SchemaField } from "./desktop";

export interface RenderedSchemaField extends SchemaField {
  hasUnloadedChildren?: boolean;
  leafIndex?: number | null;
  children: RenderedSchemaField[];
}

// Physical wrapper nodes are part of the inspected Parquet schema. Keep them
// visible instead of collapsing the tree into a lossy notation such as List<T>.
export function SchemaTreeNode({
  field,
  selected = false,
  onSelect,
  leafOffset = 0,
  selectedLeaf,
  onSelectLeaf,
  fieldPath = [field.name],
  selectedPath,
  addressable = true,
  pathActionDisabledReason,
  pathActionDisabledDescriptionId,
  onSelectPath,
  onFlattenPath,
}: {
  field: RenderedSchemaField;
  selected?: boolean;
  onSelect?: () => void;
  leafOffset?: number;
  selectedLeaf?: number | null;
  onSelectLeaf?: (columnIndex: number) => void;
  fieldPath?: FieldPath;
  selectedPath?: FieldPath | null;
  addressable?: boolean;
  pathActionDisabledReason?: string;
  pathActionDisabledDescriptionId?: string;
  onSelectPath?: (fieldPath: FieldPath, field: SchemaField) => void;
  onFlattenPath?: (fieldPath: FieldPath) => void;
}) {
  const isLeaf = field.children.length === 0 && !field.hasUnloadedChildren;
  const duplicateChildren = duplicateFieldNames(field.children);
  const pathActionUnavailable =
    onSelectPath !== undefined && pathActionDisabledReason !== undefined;
  const leafIndex = field.leafIndex ?? leafOffset;
  const selectable =
    onSelect ??
    (addressable && onSelectPath !== undefined
      ? () => onSelectPath(fieldPath, field)
      : undefined) ??
    (isLeaf && onSelectLeaf !== undefined
      ? () => onSelectLeaf(leafIndex)
      : undefined);
  const childOffsets = leafOffsets(field.children, leafOffset);
  const type = schemaType(field);
  const content = (
    <>
      <span className="schema-name">{field.name}</span>
      <span className="schema-type" title={type}>
        {type}
      </span>
    </>
  );

  return (
    <li>
      {selectable === undefined && !pathActionUnavailable ? (
        <div className="schema-field">{content}</div>
      ) : (
        <button
          className="schema-field"
          type="button"
          disabled={pathActionUnavailable}
          title={pathActionDisabledReason}
          aria-describedby={
            pathActionUnavailable ? pathActionDisabledDescriptionId : undefined
          }
          aria-pressed={
            selected ||
            (isLeaf && selectedLeaf === leafIndex) ||
            samePath(selectedPath, fieldPath)
          }
          onClick={selectable}
        >
          {content}
        </button>
      )}
      {addressable && isStructField(field) && onFlattenPath !== undefined && (
        <button
          className="schema-flatten-action"
          type="button"
          disabled={
            pathActionDisabledReason !== undefined || duplicateChildren.size > 0
          }
          title={
            pathActionDisabledReason ??
            (duplicateChildren.size > 0
              ? "Flatten is unavailable because this struct contains duplicate child names."
              : undefined)
          }
          aria-describedby={
            pathActionDisabledReason === undefined
              ? undefined
              : pathActionDisabledDescriptionId
          }
          onClick={() => onFlattenPath(fieldPath)}
        >
          {duplicateChildren.size > 0
            ? "Flatten unavailable: duplicate child names"
            : "Flatten to columns"}
        </button>
      )}
      {field.children.length > 0 && (
        <ul>
          {field.children.map((child, childIndex) => {
            const duplicateReason = duplicateChildren.has(child.name)
              ? `Path actions are unavailable because this struct contains multiple fields named ${JSON.stringify(child.name)}.`
              : undefined;
            return (
              <SchemaTreeNode
                key={childIndex}
                field={child}
                leafOffset={childOffsets[childIndex] ?? leafOffset}
                selectedLeaf={selectedLeaf}
                onSelectLeaf={onSelectLeaf}
                fieldPath={[...fieldPath, child.name]}
                selectedPath={selectedPath}
                addressable={
                  addressable &&
                  isStructField(field) &&
                  duplicateReason === undefined
                }
                pathActionDisabledReason={
                  pathActionDisabledReason ?? duplicateReason
                }
                pathActionDisabledDescriptionId={
                  pathActionDisabledDescriptionId
                }
                onSelectPath={onSelectPath}
                onFlattenPath={onFlattenPath}
              />
            );
          })}
        </ul>
      )}
      {field.hasUnloadedChildren && (
        <p className="schema-continuation">
          More nested fields are not loaded yet.
        </p>
      )}
    </li>
  );
}

function isStructField(field: SchemaField): boolean {
  return (
    field.physicalType === "GROUP" &&
    !field.logicalType?.startsWith("List") &&
    !field.logicalType?.startsWith("Map") &&
    field.children.length > 0
  );
}

function samePath(
  left: readonly string[] | null | undefined,
  right: readonly string[],
): boolean {
  return (
    left !== null &&
    left !== undefined &&
    left.length === right.length &&
    left.every((segment, index) => segment === right[index])
  );
}

function leafCount(field: RenderedSchemaField): number {
  return field.children.length === 0
    ? 1
    : field.children.reduce((count, child) => count + leafCount(child), 0);
}

function leafOffsets(
  fields: readonly RenderedSchemaField[],
  start: number,
): number[] {
  let offset = start;
  return fields.map((field) => {
    const current = offset;
    offset += leafCount(field);
    return current;
  });
}

function schemaType(field: SchemaField): string {
  return `${field.physicalType}${field.logicalType === null ? "" : ` · ${field.logicalType}`}`;
}

function duplicateFieldNames(
  fields: readonly SchemaField[],
): ReadonlySet<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const field of fields) {
    if (seen.has(field.name)) duplicates.add(field.name);
    else seen.add(field.name);
  }
  return duplicates;
}
