import { DigitRoll, Flag } from "./ui";
import { useConnection } from "./connect/connection";

/* The address you appear as, on every page, the way an anti-detect browser
   shows the IP in use with its place: in the title bar, the exit's flag, address and city
   while connected, what is happening while it connects, and "Not connected"
   otherwise. Pressing it opens Connect. Solid, with a hairline: nothing
   see-through. A new state rises into the pill, a new address rolls its
   digits over, and the dot beats while something is happening. */

export default function IpPill({ onOpen }: { onOpen: () => void }) {
  const { card } = useConnection();
  const h = card.status?.health;
  const { phase, failing } = card;
  const tone = phase === "on" && !failing && h?.ok ? "ok" : phase === "off" ? "off" : "warn";
  const busy = phase === "connecting" || phase === "rotating" || phase === "leaving";
  const words =
    phase === "connecting"
      ? "Connecting…"
      : phase === "rotating"
        ? "Changing the exit…"
        : phase === "leaving"
          ? "Disconnecting…"
          : phase === "off"
            ? "Not connected"
            : failing
              ? "Not answering"
              : h?.ok && h.exit_ip
                ? null
                : "Connected";
  const where = [h?.city, h?.country_code?.toUpperCase()].filter(Boolean).join(", ");
  return (
    <button
      type="button"
      className="ux-ippill"
      data-tone={tone}
      data-busy={busy || undefined}
      onClick={onOpen}
      title={words ?? `You appear as ${h?.exit_ip}${where ? `, ${where}` : ""}${h?.asn_org ? ` (${h.asn_org})` : ""}`}
    >
      <i className="dot" />
      {/* Keyed by what it says: a new state rises in; a new address keeps the key and rolls. */}
      <span key={words ?? "address"} className="said">
        {words ?? (
          <>
            {h?.country_code && <Flag cc={h.country_code.toLowerCase()} />}
            <span className="ip num">{h?.exit_ip && <DigitRoll text={h.exit_ip} />}</span>
            {h?.city && <span className="where">{h.city}</span>}
          </>
        )}
      </span>
    </button>
  );
}
