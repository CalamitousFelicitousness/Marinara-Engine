import { saveExportFile } from "./file-download";

export function sanitizeExportFilenamePart(value: string | null | undefined, fallback = "export") {
  const normalized = (value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return normalized || fallback;
}

export function downloadJsonFile(data: unknown, filename: string) {
  void saveExportFile(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }), filename);
}
