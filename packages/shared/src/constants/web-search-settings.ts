import { z } from "zod";

export const WEB_SEARCH_PROVIDERS = ["duckduckgo", "searxng"] as const;
export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];

const searxngUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => /^https?:\/\//iu.test(value), "The SearXNG address must start with http:// or https://");

/** Server-wide backend for the web_search tool. Each provider's fields are kept while another is selected. */
export const webSearchSettingsSchema = z
  .object({
    provider: z.enum(WEB_SEARCH_PROVIDERS),
    searxngUrl: searxngUrlSchema.nullable(),
  })
  .strict()
  .refine((settings) => settings.provider !== "searxng" || settings.searxngUrl !== null, {
    message: "SearXNG needs an address",
    path: ["searxngUrl"],
  });
export type WebSearchSettings = z.infer<typeof webSearchSettingsSchema>;

/** One test search's outcome, for the Settings card. */
export interface WebSearchTestResult {
  ok: boolean;
  count: number;
  error?: string;
}
