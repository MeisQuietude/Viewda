import type { SchemaField } from "./desktop";

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
}: {
  field: RenderedSchemaField;
  selected?: boolean;
  onSelect?: () => void;
  leafOffset?: number;
  selectedLeaf?: number | null;
  onSelectLeaf?: (columnIndex: number) => void;
}) {
  const isLeaf = field.children.length === 0 && !field.hasUnloadedChildren;
  const leafIndex = field.leafIndex ?? leafOffset;
  const selectable =
    onSelect ??
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
      {selectable === undefined ? (
        <div className="schema-field">{content}</div>
      ) : (
        <button
          className="schema-field"
          type="button"
          aria-pressed={selected || (isLeaf && selectedLeaf === leafIndex)}
          onClick={selectable}
        >
          {content}
        </button>
      )}
      {field.children.length > 0 && (
        <ul>
          {field.children.map((child, childIndex) => (
            <SchemaTreeNode
              key={childIndex}
              field={child}
              leafOffset={childOffsets[childIndex] ?? leafOffset}
              selectedLeaf={selectedLeaf}
              onSelectLeaf={onSelectLeaf}
            />
          ))}
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
