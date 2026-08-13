export type ProfileImportWarning = {
  type?: string;
  path?: string;
  message?: string;
};

export function normalizeProfileImportWarnings(warnings: unknown): ProfileImportWarning[] {
  if (!Array.isArray(warnings)) return [];
  return warnings.flatMap((warning) => {
    if (!warning || typeof warning !== "object") return [];
    const record = warning as { type?: unknown; path?: unknown; message?: unknown };
    const path = typeof record.path === "string" ? record.path : undefined;
    const message = typeof record.message === "string" ? record.message : undefined;
    const type = typeof record.type === "string" ? record.type : undefined;
    if (!path && !message) return [];
    return [{ type, path, message }];
  });
}

export function formatProfileImportWarningSummary(warnings: ProfileImportWarning[]) {
  const missingAssets = warnings.filter((warning) => warning.type === "missing_asset" || warning.path);
  const securityWarnings = warnings.length - missingAssets.length;
  return [
    missingAssets.length > 0
      ? `${missingAssets.length} asset file${missingAssets.length === 1 ? "" : "s"} missing from the ZIP. Imported the rest.`
      : "",
    securityWarnings > 0 ? `${securityWarnings} import security warning${securityWarnings === 1 ? "" : "s"}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function formatProfileImportWarningDetails(warnings: ProfileImportWarning[]) {
  const paths = warnings.map((warning) => warning.path).filter((path): path is string => !!path);
  const messages = warnings
    .filter((warning) => !warning.path)
    .map((warning) => warning.message)
    .filter((message): message is string => !!message);
  const missing =
    paths.length > 0
      ? `Missing: ${paths.slice(0, 3).join(", ")}${paths.length > 3 ? `, +${paths.length - 3} more` : ""}`
      : "";
  const security = `${messages.slice(0, 3).join(" ")}${messages.length > 3 ? ` +${messages.length - 3} more.` : ""}`;
  return [missing, security].filter(Boolean).join("\n");
}
