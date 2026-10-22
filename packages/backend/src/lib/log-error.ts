// Error diagnostics without database row values, SQL parameters or arbitrary error properties.
// PostgreSQL may put values in its message as well as detail/where, including through a cause.
export interface LoggedError {
  [key: string]: unknown;
  type: string;
  message: string;
  code?: string;
  status?: number;
  receiptId?: number;
  stack: string;
  cause?: LoggedError;
}

export function logError(error: unknown, depth = 0, opaque = false): LoggedError {
  if (!(error instanceof Error)) return { type: "UnknownError", message: "Non-Error exception", stack: "" };
  const { code, status, receiptId } = error as Error & { code?: unknown; status?: unknown; receiptId?: unknown };
  // The query client and the queue use different PostgreSQL drivers.
  const postgres = error.name === "PostgresError" || error.constructor.name === "DatabaseError";
  // Providers can echo credentials in refusals; transport errors can quote a URL or response.
  const provider = error.constructor.name === "ProviderRejectedError";
  const unknownReceipt = error.constructor.name === "ReceiptUnknownError";
  const prefix = `${error.name}: ${error.message}`;
  const stack = error.stack?.startsWith(prefix)
    ? error.stack.slice(prefix.length).split("\n").filter((line) => /^\s+at /.test(line)).join("\n")
    : undefined;
  return {
    type: error.name === "Error" ? error.constructor.name : error.name,
    message: postgres ? "PostgreSQL request failed" : provider ? "Provider request rejected"
      : unknownReceipt ? "Paid request outcome unknown; inspect receipt" : opaque ? "Request failed" : error.message,
    ...(typeof code === "string" && /^[A-Z0-9_]{2,64}$/.test(code) ? { code } : {}),
    ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    ...(typeof receiptId === "number" && Number.isSafeInteger(receiptId) && receiptId > 0 ? { receiptId } : {}),
    stack: stack ?? "",
    ...(error.cause !== undefined && depth < 3 ? { cause: logError(error.cause, depth + 1, opaque || provider || unknownReceipt) } : {}),
  };
}

/** Worker diagnostics have stable identifiers, never job payloads, provider requests or credentials. */
export function logTaskError(error: unknown, context: {
  msg: string; job?: string; jobId?: string; runId?: number; sourceId?: string; projectId?: number;
  stage?: string; kind?: string; receiptId?: number | null; elapsedMs?: number; level?: "warn" | "error";
}) {
  console.error(JSON.stringify({ time: new Date().toISOString(), level: "error", release: process.env.AIHOT_RELEASE ?? "dev", ...context, err: logError(error) }));
}
