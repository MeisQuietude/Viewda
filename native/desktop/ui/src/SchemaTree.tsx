import type { SchemaField } from "./desktop";

export function SchemaTreeNode({
  field,
  selected = false,
  onSelect,
  mode = "physical",
}: {
  field: SchemaField;
  selected?: boolean;
  onSelect?: () => void;
  mode?: "logical" | "physical";
}) {
  const type =
    mode === "physical" ? physicalSchemaType(field) : logicalSchemaType(field);
  const children =
    mode === "physical" ? field.children : logicalChildren(field);
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
      {children.length > 0 && (
        <ul>
          {children.map((child, childIndex) => (
            <SchemaTreeNode key={childIndex} field={child} mode={mode} />
          ))}
        </ul>
      )}
    </li>
  );
}

function physicalSchemaType(field: SchemaField): string {
  return `${field.physicalType}${field.logicalType === null ? "" : ` · ${field.logicalType}`}`;
}

function logicalSchemaType(field: SchemaField): string {
  if (field.logicalType === "List") {
    const element = listElement(field);
    return `list<${element === undefined ? "unknown" : logicalSchemaType(element)}>`;
  }
  if (field.logicalType === "Map") {
    const [key, value] = mapFields(field);
    return `map<${key === undefined ? "unknown" : logicalSchemaType(key)}, ${
      value === undefined ? "unknown" : logicalSchemaType(value)
    }>`;
  }
  if (field.physicalType === "GROUP") {
    return `struct<${field.children
      .map((child) => `${child.name}: ${logicalSchemaType(child)}`)
      .join(", ")}>`;
  }
  if (field.logicalType !== null) return logicalScalarType(field.logicalType);
  switch (field.physicalType) {
    case "BOOLEAN":
      return "boolean";
    case "INT32":
      return "int32";
    case "INT64":
      return "int64";
    case "INT96":
      return "timestamp";
    case "FLOAT":
      return "float32";
    case "DOUBLE":
      return "float64";
    case "BYTE_ARRAY":
    case "FIXED_LEN_BYTE_ARRAY":
      return "binary";
    default:
      return field.physicalType.toLowerCase();
  }
}

function logicalScalarType(logicalType: string): string {
  const decimal = /^Decimal \(precision (\d+), scale (-?\d+)\)$/.exec(
    logicalType,
  );
  if (decimal !== null) return `decimal(${decimal[1]}, ${decimal[2]})`;
  const temporal = /^(Time|Timestamp) \(([^,]+), ([^)]+)\)$/.exec(logicalType);
  if (temporal !== null) {
    return `${temporal[1]!.toLowerCase()}[${temporalUnit(temporal[2]!)}, ${
      temporal[3]
    }]`;
  }
  if (/^U?Int\d+$/.test(logicalType)) return logicalType.toLowerCase();
  return logicalType === "String" ? "string" : logicalType.toLowerCase();
}

function temporalUnit(unit: string): string {
  if (unit === "milliseconds") return "ms";
  if (unit === "microseconds") return "us";
  if (unit === "nanoseconds") return "ns";
  return unit;
}

function logicalChildren(field: SchemaField): SchemaField[] {
  if (field.logicalType === "List") {
    return logicalStructChildren(listElement(field));
  }
  if (field.logicalType === "Map") {
    const [key, value] = mapFields(field);
    return [key, value].flatMap(logicalStructChildren);
  }
  return field.physicalType === "GROUP" ? field.children : [];
}

function logicalStructChildren(field: SchemaField | undefined): SchemaField[] {
  if (field === undefined) return [];
  if (field.logicalType === "List") {
    return logicalStructChildren(listElement(field));
  }
  if (field.logicalType === "Map") {
    return mapFields(field).flatMap(logicalStructChildren);
  }
  return field.physicalType === "GROUP" ? field.children : [];
}

function listElement(field: SchemaField): SchemaField | undefined {
  const child = field.children[0];
  return child?.physicalType === "GROUP" && child.children.length === 1
    ? child.children[0]
    : child;
}

function mapFields(
  field: SchemaField,
): [SchemaField | undefined, SchemaField | undefined] {
  const entries = field.children[0];
  const fields =
    entries?.physicalType === "GROUP" ? entries.children : field.children;
  return [fields[0], fields[1]];
}
