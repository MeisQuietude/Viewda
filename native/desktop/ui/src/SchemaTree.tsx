import type { SchemaField } from "./desktop";

// Physical wrapper nodes are part of the inspected Parquet schema. Keep them
// visible instead of collapsing the tree into a lossy notation such as List<T>.
export function SchemaTreeNode({
  field,
  selected = false,
  onSelect,
}: {
  field: SchemaField;
  selected?: boolean;
  onSelect?: () => void;
}) {
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
      {onSelect === undefined ? (
        <div className="schema-field">{content}</div>
      ) : (
        <button
          className="schema-field"
          type="button"
          aria-pressed={selected}
          onClick={onSelect}
        >
          {content}
        </button>
      )}
      {field.children.length > 0 && (
        <ul>
          {field.children.map((child, childIndex) => (
            <SchemaTreeNode key={childIndex} field={child} />
          ))}
        </ul>
      )}
    </li>
  );
}

function schemaType(field: SchemaField): string {
  return `${field.physicalType}${field.logicalType === null ? "" : ` · ${field.logicalType}`}`;
}
