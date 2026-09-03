/**
 * Whether this person may be sent this message.
 *
 * This is the whole project. Everything else — importing a spreadsheet, filling
 * in a template, attaching a file, going at a sensible rate — is plumbing that
 * a hundred tools have. What separates a campaign tool from a spam script is
 * that the second one cannot answer this question, and this one cannot send
 * without answering it.
 *
 * The rules below are not advice and they are not a setting. `mayReceive` is
 * called by the only function in this project that emits anything, it is called
 * once per recipient with no batch shortcut, and it returns a refusal that has
 * to be handled. There is no flag that turns it off, because a flag that turns
 * it off is the flag that will be on in production.
 *
 * **What it is not.** This is not legal advice and does not make a campaign
 * lawful. It enforces four things that are necessary and are routinely skipped;
 * whether a particular basis is valid for a particular message in a particular
 * country is a question for somebody else. What it can do is make it impossible
 * to send *without having recorded an answer*.
 */

/**
 * Why somebody is allowed to be contacted.
 *
 * Two, and the difference matters. `consent` is somebody having said yes.
 * `legitimate-interest` is an existing relationship — a customer being told
 * about the thing they bought — and it does NOT stretch to marketing to
 * strangers, which is exactly the stretch every spam tool makes.
 */
export const BASES = ['consent', 'legitimate-interest'] as const;

/**
 * A person, and the only four things a send has to know about them.
 *
 * `suppressed` is a boolean and `basis` is a whole record rather than a flag,
 * and that asymmetry is deliberate: "they asked to stop" needs no detail to be
 * obeyed, and "they agreed" is worth nothing without when and where.
 */
export type Basis = {
  kind: (typeof BASES)[number] | string;
  recordedAt: string | null;
  source: string | null;
};

export type Contact = {
  address: string | null;
  name?: string | null;
  fields?: Record<string, unknown>;
  basis: Basis | null;
  suppressed: boolean;
  suppressedWhy: string | null;
};

export type Verdict = { ok: boolean; code: string; why: string };

export type When = { now?: number; staleAfterDays?: number };

/** How long a recorded consent is treated as still meaning something. */
export const STALE_AFTER_DAYS = 730;

/**
 * @typedef {object} Contact
 * @property {string} address        where the message would go
 * @property {object|null} basis     { kind, recordedAt, source, text }
 * @property {boolean} suppressed    they asked to stop, or a message bounced
 * @property {string|null} suppressedWhy
 */

export function mayReceive(
  contact: Contact | null | undefined,
  { now = Date.now(), staleAfterDays = STALE_AFTER_DAYS }: When = {}
): Verdict {
  if (!contact?.address) {
    return { ok: false, code: 'no-address', why: 'there is no address to send to' };
  }

  /**
   * Suppression first, before anything else is even looked at.
   *
   * Somebody who has asked to stop has asked to stop. Checking consent first
   * and suppression second is how a tool ends up reasoning "but they DID agree
   * once" about a person who unsubscribed last week — and the order of two
   * ifs is the whole difference.
   */
  if (contact.suppressed) {
    return {
      ok: false,
      code: 'suppressed',
      why: contact.suppressedWhy
        ? `they are on the suppression list: ${contact.suppressedWhy}`
        : 'they are on the suppression list',
    };
  }

  if (!contact.basis) {
    return {
      ok: false,
      code: 'no-basis',
      why: 'nothing was recorded about why this person may be contacted',
    };
  }

  if (!(BASES as readonly string[]).includes(contact.basis.kind)) {
    return {
      ok: false,
      code: 'unknown-basis',
      why: `"${contact.basis.kind}" is not a basis this recognises. It knows: ${BASES.join(', ')}`,
    };
  }

  if (!contact.basis.recordedAt) {
    return {
      ok: false,
      code: 'basis-undated',
      why: 'the basis has no date, so there is no way to tell whether it still holds',
    };
  }

  const recorded = Date.parse(contact.basis.recordedAt);

  if (Number.isNaN(recorded)) {
    return { ok: false, code: 'basis-undated', why: 'the date on the basis is not a date' };
  }

  /**
   * A basis recorded in the future is not a basis.
   *
   * It means a clock is wrong or somebody typed a date, and either way the one
   * thing that must not happen is treating it as fresh — which is what a naive
   * "is it older than two years" check does, since a date in the future is
   * never older than anything.
   */
  if (recorded > now) {
    return {
      ok: false,
      code: 'basis-in-the-future',
      why: 'the basis is dated in the future, so something recorded it wrongly',
    };
  }

  const days = Math.floor((now - recorded) / 86_400_000);

  if (days > staleAfterDays) {
    return {
      ok: false,
      code: 'basis-stale',
      why: `the last thing recorded was ${days} days ago, which is longer than this campaign treats as current`,
    };
  }

  if (!contact.basis.source) {
    return {
      ok: false,
      code: 'basis-unsourced',
      why: 'the basis does not say where it came from, so nobody could check it',
    };
  }

  return {
    ok: true,
    code: 'may-receive',
    why: `${contact.basis.kind}, recorded ${days} ${days === 1 ? 'day' : 'days'} ago from ${contact.basis.source}`,
  };
}

/**
 * The words that mean "stop", in two kinds, because one pattern gets it wrong
 * in both directions.
 *
 * **Bare keywords** — `stop`, `end`, `quit` — count only when they are the
 * whole message. That is how they work on every network that has them, and it
 * is what stops "non-stop until Friday" from unsubscribing a customer who was
 * telling you about their week. Matching `\bstop\b` anywhere seems obviously
 * right and quietly drops people.
 *
 * **Phrases** — "unsubscribe", "remove me", "take me off" — count wherever they
 * appear, because nobody writes those by accident.
 *
 * Under-matching is the failure with a fine attached: a tool that recognises
 * only one exact word keeps messaging people who asked it not to. Over-matching
 * silently loses a customer. Both are here, and both are tested.
 */
const ALONE = /^(stop|stopall|end|quit|cancel|unsub|unsubscribe|no)[.!]?$/i;

const PHRASES =
  /(unsubscrib\w*|opt[\s-]?out|remove me|take me off|no more (?:email|message|mail)\w*|disiscriv\w*|cancellam\w*|rimuovim\w*|non inviarmi)/i;

/**
 * @returns {{ yes: boolean, why: string }} — and the reason is not decoration.
 *
 * This decision is silently wrong in both directions. Miss a stop, and somebody
 * who has now asked twice keeps being written to. Read one that is not there,
 * and a customer who was answering a question is quietly taken off the list,
 * which nobody finds out about until they ask why they stopped hearing from
 * you. So it says which rule it matched and on which words, and whoever is
 * looking at the screen can see whether it matched the right thing.
 */
export function looksLikeStop(text: unknown): { yes: boolean; why: string } {
  const said = String(text ?? '').trim();

  if (ALONE.test(said)) return { yes: true, why: `the whole message is "${said}" and nothing else` };

  const phrase = said.match(PHRASES);
  if (phrase) return { yes: true, why: `it says "${phrase[0]}"` };

  return { yes: false, why: 'nothing in it asks to stop' };
}

/**
 * Sorting a list into who may be written to and who may not.
 *
 * Both halves come back. A tool that quietly drops the ones it will not send to
 * is a tool that leaves somebody wondering why four hundred contacts became
 * three hundred and twelve — and the answer to that question is the most
 * interesting thing in the whole run.
 */
export function sortOut(contacts: Contact[], options: When = {}) {
  const allowed: Array<{ contact: Contact; why: string }> = [];
  const refused: Array<{ contact: Contact; why: string; code: string }> = [];

  for (const contact of contacts) {
    const said = mayReceive(contact, options);
    if (said.ok) allowed.push({ contact, why: said.why });
    else refused.push({ contact, why: said.why, code: said.code });
  }

  return {
    allowed,
    refused,
    counted: refused.reduce<Record<string, number>>(
      (tally, one) => ({ ...tally, [one.code]: (tally[one.code] ?? 0) + 1 }),
      {}
    ),
  };
}
