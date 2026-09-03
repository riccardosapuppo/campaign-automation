/**
 * How a message actually leaves, and the one way it deliberately cannot.
 *
 * The tool this was rebuilt from sent its messages by **driving somebody's web
 * messaging client with a browser** — loading the site, restoring a saved
 * session, opening a chat by phone number, typing, pressing send. That is not
 * rebuilt here and it is not going to be, for two reasons that are worth
 * separating.
 *
 * The small one: it is against the terms of every messaging platform that has
 * them, and a tool for breaking them is not a thing to put a name on.
 *
 * The large one: a tool that pastes in a list of phone numbers and sends them
 * all a message is a spam machine pointed at people who never asked, whatever
 * the intention of whoever runs it. The rest of this project exists to make
 * that impossible; shipping the transport would put it back.
 *
 * So a transport is an interface, and the three below are the ones that can be
 * shipped honestly. Anything else — a provider's API, a real mail relay — is
 * somebody adding twenty lines against a documented service they have an
 * account with, which is a different act from finding it already written.
 */

import fs from 'node:fs';
import net from 'node:net';

/**
 * Every way a message can leave this program. There are three, and that is the
 * claim the README makes about it.
 *
 * Written down here, in one place, so it can be **asserted** rather than
 * described. The README paragraph explaining that the browser-driving transport
 * was left out on purpose is worth nothing on the day somebody adds a fourth
 * entry: a paragraph cannot fail. This list can — a test pins it, the service
 * refuses any name not in it, and continuous integration greps `src/` for a
 * browser driver. Three places, none of them prose.
 */
export const WHAT_THERE_IS = ['dry-run', 'file', 'smtp'];

/**
 * @typedef {object} Transport
 * @property {string} name
 * @property {(message: object) => Promise<{ why: string }>} send
 */

/**
 * Renders everything and sends nothing.
 *
 * The default, and the one to run first. A campaign that has never been
 * looked at should not be able to go out because somebody pressed the obvious
 * button.
 */
/** One message, as every transport receives it. */
export type Mail = {
  to: string;
  from: { name?: string | null; address: string };
  subject: string;
  body: string;
  at?: Date;
};
export type Transport = { send(mail: Mail): Promise<unknown> | unknown; name?: string };

/** The half of SMTP this speaks: say a line, expect a code, close. */
export type Reply = { code: number; line: string };

export type Talk = {
  say(line: string): Promise<unknown>;
  write(text: string): Promise<unknown>;
  expect(code: number, options?: { orFail?: boolean }): Promise<{ ok: boolean } & Reply>;
  close(): void;
};

export function dryRun({ onMessage = () => {} }: { onMessage?: (mail: Mail) => void } = {}) {
  return {
    name: 'dry-run',
    async send(message: Mail) {
      onMessage(message);
      return { why: 'nothing was sent: this is a dry run' };
    },
  };
}

/**
 * Writes each message to a folder, for somebody to read before anything goes.
 *
 * Which is what an approval step looks like when it is real rather than a
 * checkbox: the messages exist, as files, and a person opens a few.
 */
export function toFolder({ folder, io = fs }: { folder: string; io?: typeof fs }) {
  io.mkdirSync(folder, { recursive: true });

  let n = 0;

  return {
    name: 'file',
    async send(message: Mail) {
      n += 1;
      const safe = message.to.replace(/[^a-zA-Z0-9._@-]/g, '_');
      const file = `${String(n).padStart(4, '0')}-${safe}.eml`;

      io.writeFileSync(`${folder}/${file}`, asMail(message), 'utf8');
      return { why: `written to ${file}` };
    },
  };
}

/**
 * SMTP, spoken by hand.
 *
 * Written out rather than taken from a library because the conversation is the
 * part that goes wrong, and a service whose sending is a black box is a service
 * nobody can debug when a server starts refusing things at four in the
 * afternoon.
 *
 * Three things it gets right that are easy to get wrong, and all three are
 * tested against a server nobody here wrote:
 *
 *   - **Dot-stuffing.** A line beginning with a full stop has to be sent as
 *     two, because a lone dot ends the message. A body containing a line like
 *     "...and finally" silently truncates every message without it.
 *   - **Multi-line replies.** `EHLO` answers with several lines, each but the
 *     last marked with a dash. A reader that stops at the first is out of step
 *     for the rest of the conversation.
 *   - **A refusal at RCPT is not a failure of the connection.** One address the
 *     server will not take must not lose the others.
 */
export function smtp({ host = '127.0.0.1', port = 3609, from = null as string | null, timeoutMs = 10_000 } = {}) {
  return {
    name: 'smtp',

    async send(message: Mail) {
      const talk = await connect({ host, port, timeoutMs });

      try {
        await talk.expect(220);

        await talk.say('EHLO campaign.invalid');
        await talk.expect(250);

        await talk.say(`MAIL FROM:<${String(from ?? message.from.address).trim()}>`);
        await talk.expect(250);

        await talk.say(`RCPT TO:<${message.to.trim()}>`);
        const accepted = await talk.expect(250, { orFail: true });

        if (!accepted.ok) {
          // A refusal, not a fault: this address is no good and the connection
          // is fine. Said as a sentence, with the server's own words, because
          // "550 5.1.1 No such person here" is the useful part.
          await talk.say('QUIT');
          throw new Error(`the server would not take that address — ${accepted.line}`);
        }

        await talk.say('DATA');
        await talk.expect(354);

        await talk.write(`${asMail(message)}\r\n.\r\n`);
        const queued = await talk.expect(250, { orFail: true });

        if (!queued.ok) throw new Error(`the server would not take the message — ${queued.line}`);

        await talk.say('QUIT');
        return { why: queued.line };
      } finally {
        talk.close();
      }
    },
  };
}

function connect({ host, port, timeoutMs }: { host: string; port: number; timeoutMs: number }): Promise<Talk> {
  return new Promise<Talk>((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs);

    let buffer = '';
    let waiting: { resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null;

    const settle = () => {
      if (!waiting) return;

      // A reply is finished when a line has a SPACE after its code rather than
      // a dash. Anything before that is a continuation, and treating the first
      // line as the whole reply desynchronises everything after it.
      const lines = buffer.split('\r\n').filter(Boolean);
      const last = lines.at(-1);
      if (!last || !/^\d{3} /.test(last)) return;

      const reply = { code: Number(last.slice(0, 3)), line: lines.join(' | ') };
      buffer = '';

      const { resolve: done } = waiting;
      waiting = null;
      done(reply);
    };

    socket.on('data', (chunk) => {
      buffer += chunk;
      settle();
    });

    socket.on('timeout', () => {
      socket.destroy();
      waiting?.reject(new Error(`${host}:${port} stopped answering after ${timeoutMs} ms`));
      waiting = null;
    });

    socket.on('error', (error) => {
      waiting?.reject(error);
      waiting = null;
      reject(error);
    });

    // A server that hangs up mid-message leaves a promise nobody will ever
    // settle, and a campaign that stops with no error at all.
    socket.on('close', () => {
      waiting?.reject(new Error('the server hung up in the middle of the conversation'));
      waiting = null;
    });

    const read = (): Promise<Reply> =>
      new Promise((done, fail) => {
        waiting = { resolve: done, reject: fail };
        settle();
      });

    socket.once('connect', () =>
      resolve({
        say: (line: string) => new Promise((done) => socket.write(`${line}\r\n`, done)),
        write: (text: string) => new Promise((done) => socket.write(text, done)),

        async expect(code: number, { orFail = false }: { orFail?: boolean } = {}) {
          const reply = await read();

          if (reply.code === code || (code === 250 && reply.code === 251)) {
            return { ok: true, ...reply };
          }

          if (orFail) return { ok: false, ...reply };
          throw new Error(`expected ${code} and the server said: ${reply.line}`);
        },

        close: () => socket.destroy(),
      })
    );
  });
}

/**
 * The message, as a mail.
 *
 * Dot-stuffing happens here, once, on the way out — not in the socket code,
 * where it would be applied to the commands as well.
 */
export function asMail({ to, from, subject, body, at = new Date() }: Mail): string {
  const name = from.name ? `${asHeader(from.name)} ` : '';

  const headers = [
    `From: ${name}<${from.address}>`,
    `To: ${to}`,
    `Subject: ${asHeader(subject)}`,
    `Date: ${at.toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
  ];

  const stuffed = String(body ?? '')
    .split(/\r?\n/)
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');

  return `${headers.join('\r\n')}\r\n\r\n${stuffed}`;
}

/**
 * A header value that may have a person's name in it.
 *
 * Mail headers are ASCII. A body can be UTF-8 because the `Content-Type` says
 * so, but a header has nowhere to say it, so `Subject: Perché?` is not a
 * subject with an accent in it — it is bytes that every reader interprets for
 * itself, which is why "Perché" arrives as "PerchÃ©" in one client and
 * "Perch?" in another.
 *
 * RFC 2047 is the way to say it: base64 inside `=?UTF-8?B?…?=`. The chunking
 * matters — an encoded word may be at most 75 characters including the
 * markers, and a single long one is silently mangled rather than rejected.
 *
 * Anything already ASCII is left exactly as it was, so the common case stays
 * readable to anybody looking at the raw message.
 */
export function asHeader(text: unknown): string {
  const said = String(text ?? '');
  if (!/[^ -~]/.test(said)) return said;

  // 75 characters, less `=?UTF-8?B?` and `?=`, rounded down to a multiple of 4
  // so each chunk is whole base64 rather than a fragment of it.
  const room = Math.floor((75 - '=?UTF-8?B?'.length - '?='.length) / 4) * 4;

  // Split by characters, not bytes: cutting UTF-8 in the middle of a character
  // produces a replacement mark in the middle of somebody's name.
  const words = [];
  let piece = '';

  for (const character of said) {
    const next = piece + character;
    if (Buffer.from(next, 'utf8').toString('base64').length > room) {
      words.push(piece);
      piece = character;
    } else {
      piece = next;
    }
  }

  if (piece) words.push(piece);

  // Folded onto continuation lines, which is how a long header is wrapped.
  return words.map((one) => `=?UTF-8?B?${Buffer.from(one, 'utf8').toString('base64')}?=`).join('\r\n ');
}
