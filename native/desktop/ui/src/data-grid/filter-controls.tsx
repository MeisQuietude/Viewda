import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import {
  cancelTextValueSuggestions,
  getTextValueSuggestions,
  type DataFilter,
  type DataFilterOperator,
  type SchemaField,
  type TextValueSuggestions,
} from "../desktop";
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

const SUGGESTION_DEBOUNCE_MS = 150;
const MATCH_CASE_DESCRIPTION =
  "Match case: match uppercase and lowercase exactly";

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
    { value: "notContains", label: "does not contain" },
    { value: "startsWith", label: "starts with" },
    { value: "endsWith", label: "ends with" },
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
  sourceGeneration,
  nextSuggestionRevision,
  onApply,
  onCancel,
}: {
  request: FilterEditorRequest;
  field: SchemaField;
  sourceGeneration: number;
  nextSuggestionRevision: () => number;
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
  const [matchCase, setMatchCase] = useState(
    request.initialFilter?.matchCase ?? false,
  );
  const [textValueTouched, setTextValueTouched] = useState(
    request.initialFilter !== undefined || request.initialValue !== undefined,
  );
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
  const suggestions = useTextValueSuggestions({
    enabled:
      kind === "text" &&
      operator !== "oneOf" &&
      operator !== "isNull" &&
      operator !== "isNotNull",
    sourceGeneration,
    columnIndex: request.sourceIndex,
    prefix: firstValue,
    operator,
    nextSuggestionRevision,
  });
  const canApply =
    values !== null &&
    (kind !== "text" ||
      operator === "isNull" ||
      operator === "isNotNull" ||
      textValueTouched);
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
        if (canApply && values !== null) {
          onApply({
            columnIndex: request.sourceIndex,
            operator,
            values,
            ...(isSubstringOperator(operator) && matchCase
              ? { matchCase: true }
              : {}),
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
        setFirstValue={(value) => {
          setFirstValue(value);
          if (kind === "text") {
            setTextValueTouched(true);
          }
        }}
        setSecondValue={setSecondValue}
        matchCase={matchCase}
        setMatchCase={setMatchCase}
        suggestions={suggestions.result}
        suggestionsLoading={suggestions.loading}
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
  matchCase,
  setMatchCase,
  suggestions,
  suggestionsLoading,
}: {
  kind: ColumnFilterKind;
  temporalFormat: TemporalFormat | null;
  temporalHintId: string;
  operator: DataFilterOperator;
  firstValue: string;
  secondValue: string;
  setFirstValue: (value: string) => void;
  setSecondValue: (value: string) => void;
  matchCase: boolean;
  setMatchCase: (value: boolean) => void;
  suggestions: TextValueSuggestions | null;
  suggestionsLoading: boolean;
}) {
  const matchCaseTooltipId = useId();

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
      <div
        className={
          isSubstringOperator(operator) ? "filter-value-row" : undefined
        }
      >
        <FilterInput
          label="Value"
          kind={kind}
          temporalFormat={temporalFormat}
          temporalHintId={temporalHintId}
          value={firstValue}
          onChange={setFirstValue}
          suggestions={kind === "text" ? suggestions : undefined}
          suggestionsLoading={kind === "text" ? suggestionsLoading : undefined}
          suggestionOperator={kind === "text" ? operator : undefined}
        />
        {isSubstringOperator(operator) && (
          <button
            type="button"
            className="match-case-toggle"
            aria-label="Match case"
            aria-describedby={matchCaseTooltipId}
            aria-pressed={matchCase}
            onClick={() => setMatchCase(!matchCase)}
          >
            Aa
            <span
              id={matchCaseTooltipId}
              className="match-case-tooltip"
              role="tooltip"
            >
              {MATCH_CASE_DESCRIPTION}
            </span>
          </button>
        )}
      </div>
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
  suggestions,
  suggestionsLoading,
  suggestionOperator,
}: {
  label: string;
  kind: ColumnFilterKind;
  temporalFormat: TemporalFormat | null;
  temporalHintId: string;
  value: string;
  onChange: (value: string) => void;
  suggestions?: TextValueSuggestions | null;
  suggestionsLoading?: boolean;
  suggestionOperator?: DataFilterOperator;
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
  if (suggestionOperator !== undefined) {
    return (
      <TextSuggestionInput
        label={label}
        value={value}
        suggestions={suggestions ?? null}
        loading={suggestionsLoading ?? false}
        operator={suggestionOperator}
        onChange={onChange}
      />
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

function TextSuggestionInput({
  label,
  value,
  suggestions,
  loading,
  operator,
  onChange,
}: {
  label: string;
  value: string;
  suggestions: TextValueSuggestions | null;
  loading: boolean;
  operator: DataFilterOperator;
  onChange: (value: string) => void;
}) {
  const inputId = useId();
  const suggestionListId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionPopupRef = useRef<HTMLDivElement>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [openUpward, setOpenUpward] = useState(false);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
  const visibleSuggestions = (suggestions?.values ?? []).filter((suggestion) =>
    suggestionMatchesInput(suggestion, value, operator),
  );
  const showSuggestions = suggestionsOpen && visibleSuggestions.length > 0;
  const showSuggestionPanel =
    suggestionsOpen && (loading || suggestions !== null);
  const emptyMessage =
    !loading && suggestions !== null && visibleSuggestions.length === 0
      ? suggestions.isPartial
        ? `No matches in the first ${suggestions.scanLimit.toLocaleString("en-US")} rows`
        : "No matching values"
      : null;
  const selectedSuggestionIndex =
    activeSuggestionIndex < visibleSuggestions.length
      ? activeSuggestionIndex
      : -1;

  useEffect(() => {
    setActiveSuggestionIndex(-1);
  }, [suggestions, value]);

  useLayoutEffect(() => {
    if (!showSuggestionPanel) {
      return;
    }
    const updatePlacement = () => {
      const inputBounds = inputRef.current?.getBoundingClientRect();
      const popupBounds = suggestionPopupRef.current?.getBoundingClientRect();
      if (inputBounds === undefined || popupBounds === undefined) {
        return;
      }
      setOpenUpward(
        window.innerHeight - inputBounds.bottom < popupBounds.height + 2,
      );
    };
    updatePlacement();
    window.addEventListener("resize", updatePlacement);
    return () => window.removeEventListener("resize", updatePlacement);
  }, [emptyMessage, loading, showSuggestionPanel, visibleSuggestions.length]);

  const selectSuggestion = (suggestion: string) => {
    onChange(suggestion);
    setSuggestionsOpen(false);
  };

  return (
    <div className="filter-input">
      <label htmlFor={inputId}>{label}</label>
      <div className="filter-input-control">
        <input
          ref={inputRef}
          id={inputId}
          aria-autocomplete="list"
          aria-busy={loading}
          aria-controls={suggestionListId}
          aria-expanded={showSuggestionPanel}
          aria-activedescendant={
            showSuggestions && selectedSuggestionIndex >= 0
              ? `${suggestionListId}-${selectedSuggestionIndex}`
              : undefined
          }
          role="combobox"
          type="text"
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={value}
          onBlur={() => setSuggestionsOpen(false)}
          onFocus={() => setSuggestionsOpen(true)}
          onChange={(event) => {
            onChange(event.target.value);
            setSuggestionsOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && showSuggestionPanel) {
              event.preventDefault();
              event.stopPropagation();
              setSuggestionsOpen(false);
              setActiveSuggestionIndex(-1);
              return;
            }
            if (visibleSuggestions.length === 0) {
              return;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setSuggestionsOpen(true);
              setActiveSuggestionIndex((current) => {
                const currentIndex =
                  current < visibleSuggestions.length ? current : -1;
                if (event.key === "ArrowDown") {
                  return (currentIndex + 1) % visibleSuggestions.length;
                }
                return currentIndex <= 0
                  ? visibleSuggestions.length - 1
                  : currentIndex - 1;
              });
            } else if (
              event.key === "Enter" &&
              showSuggestions &&
              selectedSuggestionIndex >= 0
            ) {
              event.preventDefault();
              selectSuggestion(visibleSuggestions[selectedSuggestionIndex]!);
            }
          }}
        />
        {showSuggestionPanel && (
          <div
            ref={suggestionPopupRef}
            className={`filter-suggestion-popup${openUpward ? " is-upward" : ""}`}
          >
            {loading && (
              <div className="filter-suggestion-loading" role="status">
                <span>Loading suggestions…</span>
                <div
                  className="filter-suggestion-progress"
                  role="progressbar"
                  aria-label="Loading suggestions"
                />
              </div>
            )}
            {emptyMessage !== null && (
              <div className="filter-suggestion-empty" role="status">
                {emptyMessage}
              </div>
            )}
            <div
              id={suggestionListId}
              className="filter-suggestion-list"
              role="listbox"
            >
              {visibleSuggestions.map((suggestion, index) => (
                <button
                  key={suggestion}
                  id={`${suggestionListId}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={index === selectedSuggestionIndex}
                  onMouseEnter={() => setActiveSuggestionIndex(index)}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => selectSuggestion(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function suggestionMatchesInput(
  suggestion: string,
  input: string,
  operator: DataFilterOperator,
): boolean {
  const candidate = suggestion.toLowerCase();
  const query = input.toLowerCase();
  if (operator === "textContains" || operator === "notContains") {
    return candidate.includes(query);
  }
  if (operator === "endsWith") {
    return candidate.endsWith(query);
  }
  return candidate.startsWith(query);
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
  if (kind !== "text" && values?.some((value) => value.length === 0)) {
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

function isSubstringOperator(operator: DataFilterOperator): boolean {
  return (
    operator === "textContains" ||
    operator === "notContains" ||
    operator === "startsWith" ||
    operator === "endsWith"
  );
}

function useTextValueSuggestions({
  enabled,
  sourceGeneration,
  columnIndex,
  prefix,
  operator,
  nextSuggestionRevision,
}: {
  enabled: boolean;
  sourceGeneration: number;
  columnIndex: number;
  prefix: string;
  operator: DataFilterOperator;
  nextSuggestionRevision: () => number;
}): { result: TextValueSuggestions | null; loading: boolean } {
  const [result, setResult] = useState<{
    result: TextValueSuggestions | null;
    loading: boolean;
  }>({ result: null, loading: false });
  const activeRevisionRef = useRef<number | null>(null);

  useEffect(() => {
    setResult({ result: null, loading: false });
  }, [columnIndex, sourceGeneration]);

  useEffect(() => {
    if (!enabled) {
      setResult({ result: null, loading: false });
      activeRevisionRef.current = null;
      return;
    }

    setResult((current) => ({ ...current, loading: true }));
    let revision: number | null = null;
    let started = false;
    const timer = window.setTimeout(() => {
      const currentRevision = nextSuggestionRevision();
      revision = currentRevision;
      activeRevisionRef.current = currentRevision;
      started = true;
      void getTextValueSuggestions(
        sourceGeneration,
        currentRevision,
        columnIndex,
        prefix,
        operator,
      ).then(
        (suggestions) => {
          if (activeRevisionRef.current === currentRevision) {
            setResult({ result: suggestions, loading: false });
          }
        },
        () => {
          if (activeRevisionRef.current === currentRevision) {
            setResult({ result: null, loading: false });
          }
        },
      );
    }, SUGGESTION_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      if (revision !== null && activeRevisionRef.current === revision) {
        activeRevisionRef.current = null;
      }
      if (started && revision !== null) {
        void cancelTextValueSuggestions(sourceGeneration, revision).catch(
          () => undefined,
        );
      }
    };
  }, [
    columnIndex,
    enabled,
    nextSuggestionRevision,
    operator,
    prefix,
    sourceGeneration,
  ]);

  return result;
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
