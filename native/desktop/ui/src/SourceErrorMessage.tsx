import type { DatasetErrorDetail } from "./desktop";

export function SourceErrorMessage({
  error,
  onReload,
}: {
  error: DatasetErrorDetail;
  onReload?: () => void;
}) {
  if (error.code === "window") {
    return (
      <p className="source-error" role="alert">
        {datasetWindowErrorMessage(error.error.code)}
      </p>
    );
  }
  const partitionKey = error.key ?? "key";
  const messages: Partial<Record<typeof error.code, string>> = {
    noSourceOpen: "That source is no longer open.",
    notFound: "That file is no longer available. Choose it again.",
    permissionDenied:
      "Viewda cannot read that file. Check its permissions and try again.",
    memberPermissionDenied:
      onReload !== undefined
        ? "Viewda cannot read a dataset member. Check its permissions, then reload the dataset."
        : "Viewda cannot read a dataset member. Check its permissions and open the dataset again.",
    duplicatePartitionKey:
      onReload !== undefined
        ? `A dataset member repeats the Hive partition key “${partitionKey}”. Rename one of its ${partitionKey}=value folders, then reload the dataset.`
        : `A dataset member repeats the Hive partition key “${partitionKey}”. Rename one of its ${partitionKey}=value folders, then open the dataset again.`,
    sourceChanged:
      onReload !== undefined
        ? error.member === undefined
          ? "The dataset changed after it was opened. Reload the dataset."
          : "A dataset member changed after inspection. Reload the dataset."
        : error.member === undefined
          ? "That file changed after it was opened. Open it again."
          : "A dataset member changed after inspection. Reload the dataset.",
    notParquet: "That file is not Parquet. Choose a .parquet file.",
    corruptFooter:
      "The Parquet footer is damaged or incomplete. Choose another file.",
    unsupported: "Viewda cannot inspect that source yet. Choose another file.",
    noParquetFiles: "That folder contains no supported Parquet files.",
    cancelled: "Dataset inspection was cancelled.",
    schemaConflict: "Dataset columns cannot be combined into one table.",
    invalidMember:
      onReload === undefined
        ? "A dataset member is damaged or unsupported."
        : "A dataset member is damaged or unsupported. Reload the dataset.",
  };
  const details = [error.member, error.column, error.key]
    .filter((value) => value !== undefined)
    .join(" · ");
  const canReload =
    (error.code === "sourceChanged" ||
      error.code === "memberPermissionDenied" ||
      error.code === "duplicatePartitionKey" ||
      error.code === "invalidMember") &&
    onReload !== undefined;
  return (
    <p
      className={`source-error${canReload ? " source-error-with-action" : ""}`}
      role="alert"
    >
      <span>
        {messages[error.code] ?? messages.unsupported}
        {details === "" ? "" : ` (${details})`}
      </span>
      {canReload && (
        <button className="text-button" type="button" onClick={onReload}>
          Reload dataset
        </button>
      )}
    </p>
  );
}

function datasetWindowErrorMessage(code: string): string {
  if (code === "resourceExhausted") {
    return "There are not enough resources to inspect this dataset.";
  }
  if (code === "cancelled") return "Dataset inspection was cancelled.";
  if (code === "queryEngineUnavailable") {
    return "The packaged query engine could not start.";
  }
  return "Viewda could not read this dataset. Reload it or choose another source.";
}
