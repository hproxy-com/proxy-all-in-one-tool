import { answerLines, fraudLabel, fraudService, fraudTone, headline, type FraudSet } from "../lib/fraud";
import { InfoTip } from "./ui";

/* A fraud score as the screens show it (lib/fraud.ts): the highest score any
   service turned on gave, in its colour, with that service's own word. Which
   service said it, and what every other one said, sits behind the "i" on
   Connect and on the tooltip in the checker, so the badge itself carries no
   service's name. No score shows the reason, never a made-up one. */

const TONE_TEXT = { ok: "text-ok", warn: "text-warn", danger: "text-danger" } as const;

/** What a fraud score is and what each service said: the words of every "i"
    that explains one. */
export function FraudExplained({ set }: { set?: FraudSet }) {
  return (
    <>
      <p>
        How risky sites may think this address is, from 0 to 100. <b>Lower is better.</b>
      </p>
      {set && (
        <dl>
          {set.answers.map(({ service, row }) => (
            <div key={service} className="contents">
              <dt>{fraudService(service).name}</dt>
              <dd>{row.score ? fraudLabel(row.score) : (row.error ?? "No answer")}</dd>
            </div>
          ))}
        </dl>
      )}
      {set && set.answers.length > 1 && <p>The highest score shows.</p>}
    </>
  );
}

/** Connect's card: one line under the address you appear as. */
export function FraudChip({ set }: { set: FraudSet }) {
  const row = headline(set);
  const info = (
    <InfoTip label="the fraud score">
      <FraudExplained set={set} />
    </InfoTip>
  );
  if (!row.score) {
    return (
      <span className="ux-fraud" data-tone="none">
        No fraud score
        {info}
      </span>
    );
  }
  return (
    <span className="ux-fraud" data-tone={fraudTone(row.score.score)}>
      <i />
      Fraud score <b className="num">{fraudLabel(row.score)}</b>
      {info}
    </span>
  );
}

/** A table cell: the number in its colour; a mark with the reason when there is none. */
export function FraudCell({ set }: { set: FraudSet }) {
  const row = headline(set);
  const lines = answerLines(set).join("\n");
  if (!row.score) {
    return (
      <span className="quiet" title={lines}>
        n/a
      </span>
    );
  }
  return (
    <b className={`num ${TONE_TEXT[fraudTone(row.score.score)]}`} title={lines}>
      {row.score.score}
    </b>
  );
}

/** The detail sheet: every service's score in words, each with who said it. */
export function FraudFact({ set }: { set: FraudSet }) {
  return (
    <span className="flex flex-col">
      {set.answers.map(({ service, row }) =>
        row.score ? (
          <span key={service}>
            <span className={TONE_TEXT[fraudTone(row.score.score)]}>{fraudLabel(row.score)}</span>
            <span className="text-[13px] font-semibold text-ink-mute"> at {fraudService(service).name}</span>
          </span>
        ) : (
          <span key={service} className="text-[13px] font-semibold text-danger">
            {fraudService(service).name}: {row.error ?? "no answer"}
          </span>
        ),
      )}
    </span>
  );
}
