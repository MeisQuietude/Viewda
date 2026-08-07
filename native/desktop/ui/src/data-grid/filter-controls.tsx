import { useEffect, useRef, useState } from "react";

import type { DataFilter, DataFilterOperator, SchemaField } from "../desktop";
import { columnFilterKind, type ColumnFilterKind } from "./filter-query";

export interface FilterEditorRequest {
  sourceIndex: number;
  left: number;
  top: number;
  filterIndex?: number;
  initialFilter?: DataFilter;
  initialOperator?: DataFilterOperator;
  initialValue?: string;
}

interface OperatorOption {
  value: DataFilterOperator;
  label: string;
}

const OPERATOR_OPTIONS: Record<ColumnFilterKind, OperatorOption[]> = {
  boolean: [
    { value: "equals", label: "equals" },
    { value: "notEquals", label: "does not equal" },
    { value: "isNull", label: "is null" },
    { value: "isNotNull", label: "is not null" },
  ],
  number: [
    { value: "equals", label: "equals" },
    { value: "notEquals", label: "does not equal" },
    { value: "greaterThan", label: "is greater than" },
    { value: "greaterThanOrEqual", label: "is greater than or equal to" },
    { value: "lessThan", label: "is less than" },
    { value: "lessThanOrEqual", label: "is less than or equal to" },
    { value: "oneOf", label: "is one of" },
    { value: "range", label: "is between" },
    { value: "isNull", label: "is null" },
    { value: "isNotNull", label: "is not null" },
  ],
  text: [
    { value: "equals", label: "equals" },
    { value: "notEquals", label: "does not equal" },
    { value: "oneOf", label: "is one of" },
    { value: "textContains", label: "contains" },
    { value: "isNull", label: "is null" },
    { value: "isNotNull", label: "is not null" },
  ],
  temporal: [
    { value: "equals", label: "equals" },
    { value: "notEquals", label: "does not equal" },
    { value: "oneOf", label: "is one of" },
    { value: "range", label: "is between" },
    { value: "isNull", label: "is null" },
    { value: "isNotNull", label: "is not null" },
  ],
  nullOnly: [
    { value: "isNull", label: "is null" },
    { value: "isNotNull", label: "is not null" },
  ],
};

export function defaultFilterOperator(
  kind: ColumnFilterKind,
): DataFilterOperator {
  return OPERATOR_OPTIONS[kind][0]!.value;
}

export function FilterEditor({
  request,
  field,
  onApply,
  onCancel,
}: {
  request: FilterEditorRequest;
  field: SchemaField;
  onApply: (filter: DataFilter) => void;
  onCancel: () => void;
}) {
  const kind = columnFilterKind(field);
  const requestedOperator =
    request.initialFilter?.operator ?? request.initialOperator;
  const options = OPERATOR_OPTIONS[kind];
  const initialOperator =
    requestedOperator !== undefined &&
    options.some(({ value }) => value === requestedOperator)
      ? requestedOperator
      : defaultFilterOperator(kind);
  const initialValues = request.initialFilter?.values ?? [];
  const [operator, setOperator] = useState<DataFilterOperator>(initialOperator);
  const [firstValue, setFirstValue] = useState(
    request.initialValue ??
      (initialOperator === "oneOf"
        ? initialValues.join("\n")
        : initialValues[0]) ??
      (kind === "boolean" &&
      initialOperator !== "isNull" &&
      initialOperator !== "isNotNull"
        ? "true"
        : ""),
  );
  const [secondValue, setSecondValue] = useState(initialValues[1] ?? "");
  const editorRef = useRef<HTMLFormElement>(null);
  const values = filterValues(field, kind, operator, firstValue, secondValue);
  const canApply = values !== null;
  const validationMessage = filterValidationMessage(
    kind,
    operator,
    firstValue,
    secondValue,
    values,
    field,
  );

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!editorRef.current?.contains(event.target as Node)) {
        onCancel();
      }
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        onCancel();
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [onCancel]);

  return (
    <form
      ref={editorRef}
      className="filter-editor"
      aria-label={`Filter ${field.name}`}
      style={{ left: request.left, top: request.top }}
      onSubmit={(event) => {
        event.preventDefault();
        if (values !== null) {
          onApply({
            columnIndex: request.sourceIndex,
            operator,
            values,
          });
        }
      }}
    >
      <strong>{field.name}</strong>
      <label>
        <span>Condition</span>
        <select
          autoFocus
          value={operator}
          onChange={(event) => {
            const nextOperator = event.target.value as DataFilterOperator;
            setOperator(nextOperator);
            if (
              kind === "boolean" &&
              nextOperator !== "isNull" &&
              nextOperator !== "isNotNull" &&
              firstValue.length === 0
            ) {
              setFirstValue("true");
            }
          }}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <FilterValues
        kind={kind}
        operator={operator}
        firstValue={firstValue}
        secondValue={secondValue}
        setFirstValue={setFirstValue}
        setSecondValue={setSecondValue}
      />
      {validationMessage !== null && (
        <p className="filter-editor-error" role="alert">
          {validationMessage}
        </p>
      )}
      <div className="filter-editor-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" disabled={!canApply}>
          {request.filterIndex === undefined
            ? "Add condition"
            : "Save condition"}
        </button>
      </div>
    </form>
  );
}

function FilterValues({
  kind,
  operator,
  firstValue,
  secondValue,
  setFirstValue,
  setSecondValue,
}: {
  kind: ColumnFilterKind;
  operator: DataFilterOperator;
  firstValue: string;
  secondValue: string;
  setFirstValue: (value: string) => void;
  setSecondValue: (value: string) => void;
}) {
  if (operator === "isNull" || operator === "isNotNull") {
    return null;
  }
  if (operator === "oneOf") {
    return (
      <label>
        <span>Values, one per line</span>
        <textarea
          rows={4}
          value={firstValue}
          onChange={(event) => setFirstValue(event.target.value)}
        />
      </label>
    );
  }
  if (operator === "range") {
    return (
      <div className="filter-range">
        <FilterInput
          label="From"
          kind={kind}
          value={firstValue}
          onChange={setFirstValue}
        />
        <FilterInput
          label="To"
          kind={kind}
          value={secondValue}
          onChange={setSecondValue}
        />
      </div>
    );
  }
  return (
    <FilterInput
      label="Value"
      kind={kind}
      value={firstValue}
      onChange={setFirstValue}
    />
  );
}

function FilterInput({
  label,
  kind,
  value,
  onChange,
}: {
  label: string;
  kind: ColumnFilterKind;
  value: string;
  onChange: (value: string) => void;
}) {
  if (kind === "boolean") {
    return (
      <label>
        <span>{label}</span>
        <select
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      </label>
    );
  }

  return (
    <label>
      <span>{label}</span>
      <input
        inputMode={kind === "number" ? "decimal" : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function filterValues(
  field: SchemaField,
  kind: ColumnFilterKind,
  operator: DataFilterOperator,
  firstValue: string,
  secondValue: string,
): string[] | null {
  let values: string[] | null;
  if (operator === "isNull" || operator === "isNotNull") {
    return [];
  }
  if (operator === "oneOf") {
    values = firstValue
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    values = values.length > 0 ? values : null;
  } else if (operator === "range") {
    values = [firstValue, secondValue];
  } else {
    values = [firstValue];
  }
  if ((kind === "number" || kind === "temporal") && values !== null) {
    values = values.map((value) => value.trim());
  }
  if (values?.some((value) => value.length === 0)) {
    values = null;
  }
  if (
    kind === "number" &&
    values?.some(
      (value) =>
        !(
          isIntegerField(field)
            ? /^[+-]?\d+$/
            : /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i
        ).test(value.trim()),
    )
  ) {
    return null;
  }
  return values;
}

function filterValidationMessage(
  kind: ColumnFilterKind,
  operator: DataFilterOperator,
  firstValue: string,
  secondValue: string,
  values: string[] | null,
  field: SchemaField,
): string | null {
  if (
    values !== null ||
    operator === "isNull" ||
    operator === "isNotNull" ||
    (firstValue.length === 0 && secondValue.length === 0)
  ) {
    return null;
  }
  if (operator === "range" && secondValue.length === 0) {
    return "Enter both range values.";
  }
  if (kind === "temporal") {
    return "Enter a date or time value.";
  }
  if (kind === "number") {
    return isIntegerField(field) ? "Enter an integer." : "Enter a number.";
  }
  return null;
}

function isIntegerField(field: SchemaField): boolean {
  return (
    !field.logicalType?.startsWith("Decimal") &&
    (field.physicalType === "INT32" || field.physicalType === "INT64")
  );
}
