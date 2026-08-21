import type { DatasetErrorDetail } from "./desktop";

export function SourceErrorMessage({ error }: { error: DatasetErrorDetail }) {
  if (error.code === "window") {
    return (
      <p className="source-error" role="alert">
        {datasetWindowErrorMessage(error.error.code)}
      </p>
    );
  }
  const messages: Partial<Record<typeof error.code, string>> = {
    noSourceOpen: "That source is no longer open.",
    notFound: "That file is no longer available. Choose it again.",
    permissionDenied:
      "Viewda cannot read that file. Check its permissions and try again.",
    sourceChanged:
      error.member === undefined
        ? "That file changed after it was opened. Open it again."
        : "A dataset member changed after inspection. Reload the dataset.",
    notParquet: "That file is not Parquet. Choose a .parquet file.",
    corruptFooter:
      "The Parquet footer is damaged or incomplete. Choose another file.",
    unsupported: "Viewda cannot inspect that source yet. Choose another file.",
    noParquetFiles: "That folder contains no supported Parquet files.",
    cancelled: "Dataset inspection was cancelled.",
    schemaConflict: "Dataset columns cannot be combined into one table.",
    invalidMember: "A dataset member is damaged or unsupported.",
  };
  const details = [error.member, error.column]
    .filter((value) => value !== undefined)
    .join(" · ");
  return (
    <p className="source-error" role="alert">
      {messages[error.code] ?? messages.unsupported}
      {details === "" ? "" : ` (${details})`}
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
