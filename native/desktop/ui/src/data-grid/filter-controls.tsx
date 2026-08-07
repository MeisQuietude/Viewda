import { useEffect, useId, useRef, useState } from "react";

import type { DataFilter, DataFilterOperator, SchemaField } from "../desktop";
import {
  columnFilterKind,
  temporalFormatForField,
  type ColumnFilterKind,
  type TemporalFormat,
} from "./filter-query";

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
    { value: "greaterThan", label: "is after" },
    { value: "greaterThanOrEqual", label: "is on or after" },
    { value: "lessThan", label: "is before" },
    { value: "lessThanOrEqual", label: "is on or before" },
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
  const temporalFormat =
    kind === "temporal" ? temporalFormatForField(field) : null;
  const temporalHintId = useId();
  const valueResult = filterValueResult(
    field,
    kind,
    temporalFormat,
    operator,
    firstValue,
    secondValue,
  );
  const values = valueResult.values;
  const canApply = values !== null;
  const validationMessage = filterValidationMessage(
    kind,
    operator,
    firstValue,
    secondValue,
    values,
    valueResult.temporalError,
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
        temporalFormat={temporalFormat}
        temporalHintId={temporalHintId}
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
  temporalFormat,
  temporalHintId,
  operator,
  firstValue,
  secondValue,
  setFirstValue,
  setSecondValue,
}: {
  kind: ColumnFilterKind;
  temporalFormat: TemporalFormat | null;
  temporalHintId: string;
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
      <>
        <label>
          <span>Values, one per line</span>
          <textarea
            aria-describedby={
              temporalFormat === null ? undefined : temporalHintId
            }
            rows={4}
            value={firstValue}
            onChange={(event) => setFirstValue(event.target.value)}
          />
        </label>
        <TemporalFormatHint id={temporalHintId} format={temporalFormat} />
      </>
    );
  }
  if (operator === "range") {
    return (
      <>
        <div className="filter-range">
          <FilterInput
            label="From"
            kind={kind}
            temporalFormat={temporalFormat}
            temporalHintId={temporalHintId}
            value={firstValue}
            onChange={setFirstValue}
          />
          <FilterInput
            label="To"
            kind={kind}
            temporalFormat={temporalFormat}
            temporalHintId={temporalHintId}
            value={secondValue}
            onChange={setSecondValue}
          />
        </div>
        <TemporalFormatHint id={temporalHintId} format={temporalFormat} />
      </>
    );
  }
  return (
    <>
      <FilterInput
        label="Value"
        kind={kind}
        temporalFormat={temporalFormat}
        temporalHintId={temporalHintId}
        value={firstValue}
        onChange={setFirstValue}
      />
      <TemporalFormatHint id={temporalHintId} format={temporalFormat} />
    </>
  );
}

function FilterInput({
  label,
  kind,
  temporalFormat,
  temporalHintId,
  value,
  onChange,
}: {
  label: string;
  kind: ColumnFilterKind;
  temporalFormat: TemporalFormat | null;
  temporalHintId: string;
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
        aria-describedby={temporalFormat === null ? undefined : temporalHintId}
        type={temporalFormat?.valueKind === "date" ? "date" : "text"}
        inputMode={kind === "number" ? "decimal" : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

interface FilterValueResult {
  values: string[] | null;
  temporalError: string | null;
}

function filterValueResult(
  field: SchemaField,
  kind: ColumnFilterKind,
  temporalFormat: TemporalFormat | null,
  operator: DataFilterOperator,
  firstValue: string,
  secondValue: string,
): FilterValueResult {
  let values: string[] | null;
  if (operator === "isNull" || operator === "isNotNull") {
    return { values: [], temporalError: null };
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
    return { values: null, temporalError: null };
  }
  if (temporalFormat !== null && values !== null) {
    for (const value of values) {
      const temporalError = temporalValidationError(value, temporalFormat);
      if (temporalError !== null) {
        return { values: null, temporalError };
      }
    }
  }
  return { values, temporalError: null };
}

function filterValidationMessage(
  kind: ColumnFilterKind,
  operator: DataFilterOperator,
  firstValue: string,
  secondValue: string,
  values: string[] | null,
  temporalError: string | null,
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
    return temporalError;
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

function TemporalFormatHint({
  id,
  format,
}: {
  id: string;
  format: TemporalFormat | null;
}) {
  if (format === null) {
    return null;
  }
  return (
    <small id={id} className="filter-editor-hint">
      Format: {format.hint}
    </small>
  );
}

function temporalValidationError(
  value: string,
  format: TemporalFormat,
): string | null {
  if (format.valueKind === "date") {
    return dateValidationError(value);
  }

  let core = value;
  if (format.timezone === "UTC") {
    if (format.valueKind === "time" && core.endsWith("Z")) {
      return "Use a numeric offset (±HH:mm), not Z.";
    }
    const timezone =
      format.valueKind === "timestamp"
        ? /(Z|[+-](\d{2}):(\d{2}))$/.exec(core)
        : /([+-](\d{2}):(\d{2}))$/.exec(core);
    if (format.valueKind === "timestamp" && timezone === null) {
      return "Timezone suffix required: Z or ±HH:mm.";
    }
    if (
      timezone !== null &&
      timezone[2] !== undefined &&
      (Number(timezone[2]) > 23 || Number(timezone[3]!) > 59)
    ) {
      return "Invalid timezone offset.";
    }
    if (timezone !== null) {
      core = core.slice(0, -timezone[1]!.length);
    }
  } else if (/(?:Z|[+-]\d{2}:\d{2})$/.test(core)) {
    return "Timezone suffix not allowed.";
  }
  if (format.valueKind === "timestamp") {
    const separator = core.indexOf("T");
    if (separator === -1 || core.indexOf("T", separator + 1) !== -1) {
      return "Expected T between date and time.";
    }
    const dateError = dateValidationError(core.slice(0, separator));
    if (dateError !== null) {
      return dateError;
    }
    core = core.slice(separator + 1);
  }

  return timeValidationError(core);
}

function dateValidationError(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    return "Expected YYYY-MM-DD.";
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year === 0 || month < 1 || month > 12 || day < 1) {
    return "Invalid calendar date.";
  }
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= daysInMonth[month - 1]! ? null : "Invalid calendar date.";
}

function timeValidationError(value: string): string | null {
  const match = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d*))?$/.exec(value);
  if (match === null) {
    return "Expected HH:mm:ss with an optional fraction.";
  }
  if (
    match[4] !== undefined &&
    (match[4].length === 0 || match[4].length > 9)
  ) {
    return "Fraction must have 1–9 digits.";
  }
  return Number(match[1]) <= 23 &&
    Number(match[2]) <= 59 &&
    Number(match[3]) <= 59
    ? null
    : "Time must be within 00:00:00–23:59:59.";
}
