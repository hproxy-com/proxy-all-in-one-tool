import { fraudDetail, fraudLabel, fraudTone, type FraudRow } from "../lib/fraud";

/* A fraud score as the screens show it (lib/fraud.ts): the number in its
   colour, the service's own word beside it, and who said it. Everything else
   the service said (what it takes the address for, its reason) is on the
   tooltip. No score shows the sentence that says why, never a made-up one. */

const TONE_TEXT = { ok: "text-ok", warn: "text-warn", danger: "text-danger" } as const;

/** Connect's card: one line under the address you appear as. */
export function FraudChip({ row }: { row: FraudRow }) {
  if (!row.score) {
    return (
      <span className="ux-fraud" data-tone="none" title={row.error ?? undefined}>
        {row.error ?? "No fraud score"}
      </span>
    );
  }
  const s = row.score;
  return (
    <span className="ux-fraud" data-tone={fraudTone(s.score)} title={fraudDetail(s)}>
      <i />
      Fraud score <b className="num">{fraudLabel(s)}</b>
      <span className="by">{s.service}</span>
    </span>
  );
}

/** A table cell: the number in its colour; a mark with the reason when there is none. */
export function FraudCell({ row }: { row: FraudRow }) {
  if (!row.score) {
    return (
      <span className="quiet" title={row.error ?? undefined}>
        n/a
      </span>
    );
  }
  return (
    <b className={`num ${TONE_TEXT[fraudTone(row.score.score)]}`} title={fraudDetail(row.score)}>
      {row.score.score}
    </b>
  );
}

/** The detail sheet: the score in words, with who said it. */
export function FraudFact({ row }: { row: FraudRow }) {
  if (!row.score) return <span className="text-[14px] font-semibold text-danger">{row.error}</span>;
  const s = row.score;
  return (
    <span title={fraudDetail(s)}>
      <span className={TONE_TEXT[fraudTone(s.score)]}>{fraudLabel(s)}</span>
      <span className="text-[13px] font-semibold text-ink-mute"> at {s.service}</span>
    </span>
  );
}
