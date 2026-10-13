// ──────────────────────────────────────────────
// Avatar setup on each avatar agent's Agent editor page (lane: base)
// ──────────────────────────────────────────────
// Pick a character or persona, turn its avatar on or off, choose the active kind and the lip sync,
// blink and idle-motion switches, preview it, then show AVATAR_KIND_SETUP_PANELS for the kinds this
// agent owns (AVATAR_KIND_AGENT) and, on the 2D page, AVATAR_GENERATION_PANEL. Not in Sprite Cards.
//
// Contract stub until the base lane fills it in. It already shows the mood reader's download (director lane),
// which both avatar agents' pages keep: avatar-director.regression.ts checks this file renders <AvatarModelStatus />.
import type { AvatarAgentSetupProps } from "../contract";
import { AvatarModelStatus } from "../director/AvatarModelStatus";

export function AvatarAgentSetup(_props: AvatarAgentSetupProps) {
  return <AvatarModelStatus />;
}
