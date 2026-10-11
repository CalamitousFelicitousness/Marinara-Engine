import { useEffect } from "react";
import { Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { useUIStore } from "../../stores/ui.store";
import { translate } from "../../localization/i18n";

const CHIBI_PROFESSOR_MARI_IMAGE = "/sprites/mari/chibi-professor-mari.webp";
const SHINY_CHIBI_PROFESSOR_MARI_IMAGE = "/sprites/mari/chibi-professor-mari-shiny.webp";
const CHIBI_PROFESSOR_MARI_SEEN_KEY = "marinara:chibi-professor-mari-toast-seen";
const CHIBI_PROFESSOR_MARI_ROLL_CHANCE = 0.001;
/** Of the rare visits, 1 in 27 is the shiny one. */
const SHINY_CHIBI_PROFESSOR_MARI_CHANCE = 1 / 27;
const CHIBI_PROFESSOR_MARI_ROLL_COOLDOWN_MS = 3_000;
const CHIBI_PROFESSOR_MARI_TOAST_DURATION_MS = 18_000;

function hasSeenChibiProfessorMari() {
  try {
    return window.sessionStorage.getItem(CHIBI_PROFESSOR_MARI_SEEN_KEY) === "true";
  } catch {
    return false;
  }
}

function rememberChibiProfessorMari() {
  try {
    window.sessionStorage.setItem(CHIBI_PROFESSOR_MARI_SEEN_KEY, "true");
  } catch {
    // Ignore storage failures; the toast is still allowed to appear.
  }
}

function showChibiProfessorMariToast() {
  rememberChibiProfessorMari();
  const shiny = Math.random() < SHINY_CHIBI_PROFESSOR_MARI_CHANCE;
  toast.custom(
    (toastId) => (
      <div className="relative flex max-w-[360px] gap-3 pr-8 text-[var(--foreground)]">
        <button
          type="button"
          onClick={() => toast.dismiss(toastId)}
          className="absolute right-0 top-0 rounded-full p-1 text-foreground/45 transition-colors hover:bg-foreground/10 hover:text-foreground focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/60"
          aria-label={translate("ui.chibiProfessorMari.dismiss")}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        {shiny && (
          <>
            <Sparkles
              className="pointer-events-none absolute left-0 top-1 h-4 w-4 text-[var(--primary)] motion-safe:animate-pulse"
              aria-hidden="true"
            />
            <Sparkles
              className="pointer-events-none absolute bottom-2 left-16 h-3 w-3 text-[var(--primary)] motion-safe:animate-pulse"
              aria-hidden="true"
            />
          </>
        )}
        <img
          src={shiny ? SHINY_CHIBI_PROFESSOR_MARI_IMAGE : CHIBI_PROFESSOR_MARI_IMAGE}
          alt={translate("ui.chibiProfessorMari.alt")}
          className="h-24 w-20 shrink-0 self-center object-contain drop-shadow-[0_4px_10px_rgb(0_0_0/0.25)]"
          onError={(event) => {
            event.currentTarget.hidden = true;
          }}
        />
        <div className="space-y-2 text-sm leading-relaxed">
          {shiny && (
            <p className="flex items-center gap-1.5 font-bold text-[var(--primary)]">
              <Sparkles className="h-4 w-4 shrink-0 motion-safe:animate-pulse" aria-hidden="true" />
              {translate("ui.chibiProfessorMari.shiny")}
              <Sparkles className="h-4 w-4 shrink-0 motion-safe:animate-pulse" aria-hidden="true" />
            </p>
          )}
          <p>{translate("ui.chibiProfessorMari.visit")}</p>
          <p>{translate("ui.chibiProfessorMari.fortune")}</p>
          <p>{translate("ui.chibiProfessorMari.loved")}</p>
        </div>
      </div>
    ),
    { duration: CHIBI_PROFESSOR_MARI_TOAST_DURATION_MS },
  );
}

export function ChibiProfessorMariEasterEgg() {
  const enabled = useUIStore((s) => s.chibiProfessorMariEnabled);

  useEffect(() => {
    if (!enabled) return;

    let seen = hasSeenChibiProfessorMari();
    let lastRollAt = 0;

    const handleScroll = () => {
      if (seen || document.visibilityState !== "visible") return;

      const now = Date.now();
      if (now - lastRollAt < CHIBI_PROFESSOR_MARI_ROLL_COOLDOWN_MS) return;
      lastRollAt = now;

      if (Math.random() > CHIBI_PROFESSOR_MARI_ROLL_CHANCE) return;

      seen = true;
      showChibiProfessorMariToast();
    };

    const scrollOptions: AddEventListenerOptions = { capture: true, passive: true };
    document.addEventListener("scroll", handleScroll, scrollOptions);

    return () => {
      document.removeEventListener("scroll", handleScroll, scrollOptions);
    };
  }, [enabled]);

  return null;
}
