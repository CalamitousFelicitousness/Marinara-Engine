import DOMPurify from "dompurify";
import { stripSheetCommandTags, stripClockCommandTags } from "@marinara-engine/shared";
import { escapeStandaloneGameNarrationAngleLines } from "../../lib/game-tag-parser";
import { HTML_SAFE_DIALOGUE_QUOTE_PATTERN_SOURCE } from "../../lib/dialogue-quotes";
import { translate } from "../../localization/i18n";

function commandBadge(className: string, label: string, detail?: string): string {
  return `<span class="inline-flex max-w-full flex-wrap items-center gap-1 rounded px-1.5 py-0.5 text-xs ${className}">${label}${
    detail ? ` <span class="opacity-75">${detail}</span>` : ""
  }</span>`;
}

function parseCommandAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,\s]+))/g;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(source)) !== null) {
    attrs[match[1]!] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
}

function formatSignedNumber(value: string): string {
  const numeric = Number(value.trim());
  if (!Number.isFinite(numeric)) return value.trim();
  return numeric > 0 ? `+${numeric}` : String(numeric);
}

export function formatNarration(content: string, boldDialogue = true): string {
  // Sheet commands get no badge: the Engine has already applied them and the sheet shows the
  // result, so leaving them in would narrate the bookkeeping twice. Stripped here as well as in
  // the tag parser because this formatter is also handed content that never passed through it
  // (a translated turn, a storyboard line).
  let html = escapeStandaloneGameNarrationAngleLines(stripClockCommandTags(stripSheetCommandTags(content)))
    .replace(/\[combat_result]\s*([\s\S]*?)\s*\[\/combat_result]/gi, (_match, recap: string) => {
      const cleaned = recap.trim();
      return `${commandBadge("bg-[var(--marinara-chat-chrome-highlight-bg)] text-[var(--marinara-chat-chrome-panel-text)] ring-1 ring-[var(--marinara-chat-chrome-button-border)]", "⚔ Combat Result")}${
        cleaned ? `\n${cleaned}` : ""
      }`;
    })
    // What the Engine did when the player used an item, which the Game Master narrates.
    .replace(/\[item_used]\s*([\s\S]*?)\s*\[\/item_used]/gi, (_match, report: string) => {
      const cleaned = report.trim();
      return `${commandBadge("bg-[var(--marinara-chat-chrome-highlight-bg)] text-[var(--marinara-chat-chrome-panel-text)] ring-1 ring-[var(--marinara-chat-chrome-button-border)]", translate("game.narration.itemUsed"))}${
        cleaned ? `\n${cleaned}` : ""
      }`;
    })
    .replace(
      /\[dice:\s*((?:\d+)?d\d+(?:[+-]\d+)?)\s*=\s*(-?\d+)(?:\s*\([^\]]+\))?\]/gi,
      (_match, notation: string, total: string) =>
        commandBadge(
          "bg-[var(--marinara-chat-chrome-highlight-bg)] text-[var(--marinara-chat-chrome-panel-muted)] font-mono",
          "🎲",
          `${notation} → ${total}`,
        ),
    )
    .replace(/\[qte_bonus:\s*(-?\d+)\]/gi, (_match, bonus: string) =>
      commandBadge(
        "bg-[var(--marinara-chat-chrome-highlight-bg)] text-[var(--marinara-chat-chrome-panel-text)] ring-1 ring-[var(--marinara-chat-chrome-button-border)]",
        "⏱ QTE Bonus",
        formatSignedNumber(bonus),
      ),
    )
    .replace(/\[qte_result:\s*([^\]]+)\]/gi, (_match, rawAttrs: string) => {
      const attrs = parseCommandAttributes(rawAttrs);
      const status = attrs.status === "fail" ? "Fail" : attrs.status === "success" ? "Success" : "Result";
      const modifier = attrs.modifier ? formatSignedNumber(attrs.modifier) : "";
      return commandBadge(
        "bg-[var(--marinara-chat-chrome-highlight-bg)] text-[var(--marinara-chat-chrome-panel-text)] ring-1 ring-[var(--marinara-chat-chrome-button-border)]",
        `⏱ QTE ${status}`,
        modifier,
      );
    })
    .replace(/\[skill_check:\s*([^\]]+)\]/gi, (_match, rawAttrs: string) => {
      const attrs = parseCommandAttributes(rawAttrs);
      const skill = attrs.skill || "Skill";
      // A check that names its ladder step instead of a number shows the step's own name.
      const dc = attrs.dc ? `DC ${attrs.dc}` : attrs.difficulty || "";
      const total = attrs.total ? `total ${attrs.total}` : "";
      const result = attrs.result ? attrs.result.replace(/_/g, " ") : "";
      return commandBadge(
        "bg-[var(--marinara-chat-chrome-highlight-bg)] text-[var(--marinara-chat-chrome-panel-text)] ring-1 ring-[var(--marinara-chat-chrome-button-border)]",
        "🎯 Skill Check",
        [skill, dc, total, result].filter(Boolean).join(" · "),
      );
    })
    .replace(/\[combat:\s*([^\]]+)\]/gi, (_match, rawAttrs: string) => {
      const attrs = parseCommandAttributes(rawAttrs);
      return commandBadge(
        "bg-[var(--marinara-chat-chrome-highlight-bg)] text-[var(--marinara-chat-chrome-panel-text)] ring-1 ring-[var(--marinara-chat-chrome-button-border)]",
        "⚔ Combat",
        attrs.enemies || rawAttrs.trim(),
      );
    })
    .replace(/\[status:\s*([^\]]+)\]/gi, (_match, rawAttrs: string) => {
      const attrs = parseCommandAttributes(rawAttrs);
      const modifier = attrs.modifier ? `${attrs.stat || "modifier"} ${formatSignedNumber(attrs.modifier)}` : "";
      const turns = attrs.turns || attrs.duration ? `${attrs.turns || attrs.duration} turns` : "";
      return commandBadge(
        "bg-[var(--destructive)]/15 text-[var(--destructive)] ring-1 ring-[var(--destructive)]/20",
        "✦ Status",
        [attrs.effect || attrs.name || "Effect", attrs.target ? `on ${attrs.target}` : "", turns, modifier]
          .filter(Boolean)
          .join(" · "),
      );
    })
    .replace(/\[element_attack:\s*([^\]]+)\]/gi, (_match, rawAttrs: string) => {
      const attrs = parseCommandAttributes(rawAttrs);
      return commandBadge(
        "bg-[var(--marinara-chat-chrome-highlight-bg)] text-[var(--marinara-chat-chrome-panel-text)] ring-1 ring-[var(--marinara-chat-chrome-button-border)]",
        "✦ Element",
        [attrs.element, attrs.target ? `on ${attrs.target}` : ""].filter(Boolean).join(" · ") || rawAttrs.trim(),
      );
    })
    .replace(/\[qte:\s*([^\]]+)\]/gi, (_match, body: string) =>
      commandBadge(
        "bg-[var(--marinara-chat-chrome-highlight-bg)] text-[var(--marinara-chat-chrome-panel-text)] ring-1 ring-[var(--marinara-chat-chrome-button-border)]",
        "⏱ QTE",
        body.trim(),
      ),
    )
    .replace(/\[choices:\s*([^\]]+)\]/gi, (_match, body: string) =>
      commandBadge(
        "bg-[var(--marinara-chat-chrome-highlight-bg)] text-[var(--marinara-chat-chrome-panel-text)] ring-1 ring-[var(--marinara-chat-chrome-button-border)]",
        "☑ Choices",
        body.trim(),
      ),
    )
    .replace(/\[inventory:\s*([^\]]+)\]/gi, (_match, rawAttrs: string) => {
      const attrs = parseCommandAttributes(rawAttrs);
      return commandBadge(
        "bg-[var(--marinara-chat-chrome-highlight-bg)] text-[var(--marinara-chat-chrome-panel-text)] ring-1 ring-[var(--marinara-chat-chrome-button-border)]",
        "🎒 Inventory",
        [attrs.action, attrs.item].filter(Boolean).join(": "),
      );
    })
    .replace(/\[loot:\s*([^\]]+)\]/gi, (_match, rawAttrs: string) => {
      const attrs = parseCommandAttributes(rawAttrs);
      return commandBadge(
        "bg-[var(--marinara-chat-chrome-highlight-bg)] text-[var(--marinara-chat-chrome-panel-text)] ring-1 ring-[var(--marinara-chat-chrome-button-border)]",
        translate("game.narration.loot"),
        attrs.table || rawAttrs.trim(),
      );
    })
    .replace(/\[map:\s*([^\]]*)\]/gi, (_match, rawAttrs: string) => {
      const attrs = parseCommandAttributes(rawAttrs);
      // A reveal opens a closed place to the party, not a map.
      const reveal = /^\s*reveal\b/iu.test(rawAttrs) || attrs.action === "reveal";
      return commandBadge(
        "bg-[var(--marinara-chat-chrome-highlight-bg)] text-[var(--marinara-chat-chrome-panel-text)] ring-1 ring-[var(--marinara-chat-chrome-button-border)]",
        reveal ? translate("game.narration.siteOpened") : `▦ ${translate("game.narration.placeMap")}`,
        attrs.name || rawAttrs.trim(),
      );
    })
    .replace(/\[map_update:\s*([^\]]+)\]/gi, (_match, rawAttrs: string) => {
      const attrs = parseCommandAttributes(rawAttrs);
      return commandBadge(
        "bg-[var(--marinara-chat-chrome-highlight-bg)] text-[var(--marinara-chat-chrome-panel-text)] ring-1 ring-[var(--marinara-chat-chrome-button-border)]",
        "🗺 Map",
        attrs.new_location || rawAttrs.trim(),
      );
    })
    .replace(/\[reputation:\s*([^\]]+)\]/gi, (_match, rawAttrs: string) => {
      const attrs = parseCommandAttributes(rawAttrs);
      return commandBadge(
        "bg-[var(--marinara-chat-chrome-highlight-bg)] text-[var(--marinara-chat-chrome-panel-text)] ring-1 ring-[var(--marinara-chat-chrome-button-border)]",
        "◆ Reputation",
        [attrs.npc, attrs.action].filter(Boolean).join(": "),
      );
    })
    .replace(/\[party_change:\s*([^\]]+)\]/gi, (_match, rawAttrs: string) => {
      const attrs = parseCommandAttributes(rawAttrs);
      return commandBadge(
        "bg-[var(--marinara-chat-chrome-highlight-bg)] text-[var(--marinara-chat-chrome-panel-text)] ring-1 ring-[var(--marinara-chat-chrome-button-border)]",
        "👥 Party",
        [attrs.change, attrs.character].filter(Boolean).join(": "),
      );
    })
    .replace(/\[party_add:\s*([^\]]+)\]/gi, (_match, rawAttrs: string) => {
      const attrs = parseCommandAttributes(rawAttrs);
      return commandBadge(
        "bg-[var(--marinara-chat-chrome-highlight-bg)] text-[var(--marinara-chat-chrome-panel-text)] ring-1 ring-[var(--marinara-chat-chrome-button-border)]",
        "👥 Party",
        attrs.character || rawAttrs.trim(),
      );
    })
    .replace(/\[session_end:\s*([^\]]+)\]/gi, (_match, rawAttrs: string) => {
      const attrs = parseCommandAttributes(rawAttrs);
      return commandBadge(
        "bg-[var(--marinara-chat-chrome-highlight-bg)] text-[var(--marinara-chat-chrome-panel-text)] ring-1 ring-[var(--marinara-chat-chrome-button-border)]",
        "🏁 Session End",
        attrs.reason,
      );
    })
    .replace(/\[(music|sfx|bg|ambient):\s*([^\]]+)\]/gi, (_match, kind: string, body: string) =>
      commandBadge(
        "bg-[var(--marinara-chat-chrome-highlight-bg)] text-[var(--marinara-chat-chrome-panel-text)] ring-1 ring-[var(--marinara-chat-chrome-button-border)]",
        kind.toUpperCase(),
        body.trim(),
      ),
    )
    .replace(/\[direction:\s*([^\]]+)\]/gi, (_match, body: string) =>
      commandBadge(
        "bg-[var(--marinara-chat-chrome-highlight-bg)] text-[var(--marinara-chat-chrome-panel-text)] ring-1 ring-[var(--marinara-chat-chrome-button-border)]",
        "Direction",
        body.trim(),
      ),
    )
    .replace(/\[widget:\s*([^\]]+)\]/gi, (_match, body: string) =>
      commandBadge(
        "bg-[var(--marinara-chat-chrome-highlight-bg)] text-[var(--marinara-chat-chrome-panel-text)] ring-1 ring-[var(--marinara-chat-chrome-button-border)]",
        "Widget",
        body.trim(),
      ),
    )
    .replace(/\[dialogue:\s*([^\]]+)\]/gi, (_match, rawAttrs: string) => {
      const attrs = parseCommandAttributes(rawAttrs);
      return commandBadge(
        "bg-[var(--marinara-chat-chrome-highlight-bg)] text-[var(--marinara-chat-chrome-panel-text)] ring-1 ring-[var(--marinara-chat-chrome-button-border)]",
        "Dialogue",
        attrs.npc || rawAttrs.trim(),
      );
    })
    .replace(/\[state:\s*(\w+)\]/gi, (_match, state: string) =>
      commandBadge(
        "bg-[var(--marinara-chat-chrome-highlight-bg)] text-[var(--marinara-chat-chrome-panel-text)]",
        "⚡ State",
        state,
      ),
    )
    .replace(/(^|\n)[ \t]*-#(?:[ \t]+([^\n]*))?(?=\n|$)/g, '$1<small class="mari-md-subtext">$2</small>')
    .replace(/\*\*(.+?)\*\*/gs, "<strong>$1</strong>")
    .replace(/__(.+?)__/gs, '<u class="mari-md-underline">$1</u>')
    .replace(/\*(.+?)\*/gs, "<em>$1</em>")
    .replace(/\n/g, "<br />");

  if (boldDialogue) {
    const narrationQuoteRe = new RegExp(`(?<![=\\w])(?:${HTML_SAFE_DIALOGUE_QUOTE_PATTERN_SOURCE})`, "g");
    html = html.replace(narrationQuoteRe, (match) => `<strong>${match}</strong>`);
  }

  // `title` is allowed so the one-request dice marker can carry its roll breakdown as a
  // hover. It is an inert text attribute: no script, no URL, no style.
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ["strong", "em", "u", "small", "br", "span"],
    ALLOWED_ATTR: ["class", "title"],
  });
}
