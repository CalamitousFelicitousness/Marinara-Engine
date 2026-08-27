// ──────────────────────────────────────────────
// Secret Field Attributes
// ──────────────────────────────────────────────
// Spread onto API-key and admin-secret inputs.
//
// A bare <input type="password"> reads to a password manager as a login field,
// so 1Password, LastPass, and Dashlane offer to save an API key as a website
// password. The prompt fires on any interaction near the field, which in
// practice means every voice-list refresh or connection test.
//
// These are hints, not a contract: extensions can ignore them, and the set is
// per vendor. autoComplete alone does not stop a save prompt.
//   data-1p-ignore   1Password, excludes the field
//   data-lpignore    LastPass
//   data-form-type   Dashlane and 1Password, marks the form as not a login
export const SECRET_FIELD_PROPS = {
  autoComplete: "off",
  "data-1p-ignore": true,
  "data-lpignore": "true",
  "data-form-type": "other",
} as const;
