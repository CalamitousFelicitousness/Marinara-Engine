import { prepareImageAttachment } from "./chat-attachment-images";

export const PDF_ATTACHMENT_MIME_TYPE = "application/pdf";
export const CHAT_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
export const CHAT_ATTACHMENT_ACCEPT =
  "image/*,application/pdf,.pdf,.txt,.md,.markdown,.json,.jsonl,.csv,.log,.xml,.yaml,.yml";

const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  "csv",
  "json",
  "jsonl",
  "log",
  "markdown",
  "md",
  "txt",
  "xml",
  "yaml",
  "yml",
]);

function getFileExtension(fileName: string): string {
  const match = fileName.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] ?? "";
}

export function inferAttachmentType(file: File): string {
  const extension = getFileExtension(file.name);
  if (extension === "pdf") return PDF_ATTACHMENT_MIME_TYPE;
  if (file.type) return file.type;
  if (extension === "json" || extension === "jsonl") return "application/json";
  if (extension === "csv") return "text/csv";
  if (extension === "md" || extension === "markdown") return "text/markdown";
  if (extension === "xml") return "application/xml";
  if (extension === "yaml" || extension === "yml") return "application/yaml";
  if (extension === "txt" || extension === "log") return "text/plain";
  return "application/octet-stream";
}

export function isSupportedChatAttachment(file: File): boolean {
  if (file.type.startsWith("image/")) return true;
  if (file.type.startsWith("text/")) return true;
  const type = inferAttachmentType(file);
  if (type === PDF_ATTACHMENT_MIME_TYPE) return true;
  if (
    type === "application/json" ||
    type === "application/xml" ||
    type === "application/yaml" ||
    type === "application/x-yaml"
  ) {
    return true;
  }
  return TEXT_ATTACHMENT_EXTENSIONS.has(getFileExtension(file.name));
}

export function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

/** Images go through the composer's resize/compress path; other files are read as-is. */
export async function prepareChatAttachment(file: File): Promise<{ type: string; data: string; name: string }> {
  const name = file.name || "pasted-file";
  if (file.type.startsWith("image/")) {
    const prepared = await prepareImageAttachment(file, name);
    return { type: prepared.type, data: prepared.data, name: prepared.name };
  }
  return { type: inferAttachmentType(file), data: await readFileAsDataUrl(file), name };
}
