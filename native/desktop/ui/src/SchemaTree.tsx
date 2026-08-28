import type { FieldPath, SchemaField } from "./desktop";
import {
  fieldPathKey,
  formatFieldPath,
  formatFieldPathSegment,
  sameFieldPath,
} from "./data-grid/field-path";

export const LIST_MAP_COLUMN_REASON =
  "Fields inside a list or map cannot be used as columns.";

export interface RenderedSchemaField extends SchemaField {
  hasUnloadedChildren?: boolean;
  leafIndex?: number | null;
  children: RenderedSchemaField[];
}

export interface SchemaPathMenuRequest {
  fieldPath: FieldPath;
  flattened: boolean;
  disabledReason?: string;
  trigger: HTMLElement;
  clientX: number;
  clientY: number;
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
  flattenedPathKeys,
  onSelectPath,
  onOpenPathMenu,
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
  flattenedPathKeys?: ReadonlySet<string>;
  onSelectPath?: (fieldPath: FieldPath, field: SchemaField) => void;
  onOpenPathMenu?: (request: SchemaPathMenuRequest) => void;
}) {
  const isLeaf = field.children.length === 0 && !field.hasUnloadedChildren;
  const duplicateChildren = duplicateFieldNames(field.children);
  const flattened = flattenedPathKeys?.has(fieldPathKey(fieldPath)) ?? false;
  const flattenDisabledReason =
    pathActionDisabledReason ??
    (!flattened && duplicateChildren.size > 0
      ? "Flatten is unavailable because this struct contains duplicate child names."
      : undefined);
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
  const pathMenuAvailable =
    addressable && isStructField(field) && onOpenPathMenu !== undefined;
  const openPathMenu = (
    trigger: HTMLElement,
    clientX: number,
    clientY: number,
  ) => {
    onOpenPathMenu?.({
      fieldPath,
      flattened,
      disabledReason: flattenDisabledReason,
      trigger,
      clientX,
      clientY,
    });
  };

  return (
    <li>
      {selectable === undefined && !pathActionUnavailable ? (
        <div className="schema-field">{content}</div>
      ) : (
        <button
          className="schema-field"
          type="button"
          disabled={pathActionUnavailable && !pathMenuAvailable}
          aria-disabled={pathActionUnavailable || undefined}
          title={pathActionDisabledReason}
          aria-label={
            pathActionUnavailable
              ? `${formatFieldPath(fieldPath)}. ${pathActionDisabledReason}`
              : undefined
          }
          aria-pressed={
            selected ||
            (isLeaf && selectedLeaf === leafIndex) ||
            (selectedPath !== null &&
              selectedPath !== undefined &&
              sameFieldPath(selectedPath, fieldPath))
          }
          onClick={pathActionUnavailable ? undefined : selectable}
          onContextMenu={(event) => {
            if (!pathMenuAvailable) return;
            event.preventDefault();
            event.stopPropagation();
            openPathMenu(event.currentTarget, event.clientX, event.clientY);
          }}
          onKeyDown={(event) => {
            if (
              !pathMenuAvailable ||
              (event.key !== "ContextMenu" &&
                !(event.shiftKey && event.key === "F10"))
            ) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            const bounds = event.currentTarget.getBoundingClientRect();
            openPathMenu(event.currentTarget, bounds.left, bounds.bottom);
          }}
        >
          {content}
        </button>
      )}
      {addressable && isListOrMapField(field) && field.children.length > 0 && (
        <p className="schema-continuation">{LIST_MAP_COLUMN_REASON}</p>
      )}
      {field.children.length > 0 && (
        <ul>
          {field.children.map((child, childIndex) => {
            const duplicateReason = duplicateChildren.has(child.name)
              ? `This field cannot be selected because its parent contains multiple fields named ${formatFieldPathSegment(child.name)}.`
              : undefined;
            const containerReason = isListOrMapField(field)
              ? LIST_MAP_COLUMN_REASON
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
                  pathActionDisabledReason ?? duplicateReason ?? containerReason
                }
                flattenedPathKeys={flattenedPathKeys}
                onSelectPath={onSelectPath}
                onOpenPathMenu={onOpenPathMenu}
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

function isListOrMapField(field: SchemaField): boolean {
  return (
    field.logicalType?.startsWith("List") === true ||
    field.logicalType?.startsWith("Map") === true
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
