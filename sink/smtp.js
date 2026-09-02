#!/usr/bin/env node
/**
 * An SMTP server that accepts mail and delivers it nowhere.
 *
 *     npm run sink
 *
 * So the project runs with nothing: no account, no provider, no key, and no
 * possibility of a test campaign reaching a real person. Everything it receives
 * is held in memory and shown at `http://127.0.0.1:3610`, and it is gone when
 * the process stops.
 *
 * It is a real server — a real socket speaking the real line protocol — because
 * a stub that returns success teaches the sender nothing. Half the things that
 * go wrong in SMTP are in the conversation: a line that is too long, a dot at
 * the start of a line, a `RCPT TO` refused while `MAIL FROM` was accepted, a
 * server that hangs up mid-message. A stub has none of them.
 *
 * **It refuses things on purpose.** An address at `refuses.invalid` is rejected
 * at `RCPT TO`, and one at `breaks.invalid` makes it hang up in the middle of
 * `DATA`. Those two paths are most of what a sender gets wrong, and without a
 * server willing to behave badly they are never exercised.
 *
 * Bound to localhost, always. An SMTP server listening on every interface is an
 * open relay, and an open relay found by anybody is a spam source with your
 * address on it.
 */

import http from 'node:http';
import net from 'node:net';

const PORT = Number(process.argv[2] ?? process.env.SINK_PORT ?? 3609);
const WEB = Number(process.env.SINK_WEB_PORT ?? 3610);
const HOST = '127.0.0.1';

/** Everything it has been given, newest first. Never written to disk. */
const received = [];

const server = net.createServer((socket) => {
  socket.setEncoding('utf8');

  let state = 'greeting';
  let envelope = fresh();
  let data = [];
  let rest = '';

  const say = (line) => socket.write(`${line}\r\n`);

  say('220 sink.invalid ESMTP — this server delivers nothing');

  socket.on('data', (chunk) => {
    rest += chunk;

    // Split on CRLF, and keep whatever came after the last one. A chunk
    // boundary lands wherever the network put it, which is routinely in the
    // middle of a line, and a parser that treats each chunk as a line breaks
    // on exactly the messages that are big enough to matter.
    const lines = rest.split('\r\n');
    rest = lines.pop() ?? '';

    for (const line of lines) {
      if (state === 'data') {
        // The one that hangs up: on the FIRST line of the body, not after a
        // timer. A timer races the sender — a fast client had already written
        // the whole message and got its 250 before the socket was destroyed,
        // so the path this exists to exercise never ran and the check passed
        // by not testing anything.
        if (envelope.to.some((one) => one.endsWith('@breaks.invalid'))) {
          socket.destroy();
          return;
        }

        // A single dot on its own line ends the message. Anything else that
        // starts with a dot had one added by the sender and has to have it
        // taken off — that is dot-stuffing, and getting it wrong silently
        // corrupts any message with a line starting in a full stop.
        if (line === '.') {
          const body = data.join('\r\n');
          received.unshift({ ...envelope, body, at: new Date().toISOString(), bytes: body.length });
          if (received.length > 500) received.pop();

          say('250 2.0.0 Ok: queued as nothing');
          state = 'ready';
          envelope = fresh();
          data = [];
          continue;
        }

        data.push(line.startsWith('..') ? line.slice(1) : line);
        continue;
      }

      const [verb, ...restOfLine] = line.split(' ');
      const argument = restOfLine.join(' ');

      switch (verb.toUpperCase()) {
        case 'EHLO':
          // A multi-line reply: every line but the last uses a dash. A client
          // that stops at the first line never learns what the server can do.
          say('250-sink.invalid at your service');
          say('250-SIZE 10485760');
          say('250 8BITMIME');
          state = 'ready';
          break;

        case 'HELO':
          say('250 sink.invalid');
          state = 'ready';
          break;

        case 'MAIL':
          envelope.from = address(argument);
          say('250 2.1.0 Ok');
          break;

        case 'RCPT': {
          const to = address(argument);

          // Refused on purpose, so a sender has something to handle.
          if (to.endsWith('@refuses.invalid')) {
            say('550 5.1.1 No such person here');
            break;
          }

          envelope.to.push(to);
          say('250 2.1.5 Ok');
          break;
        }

        case 'DATA':
          if (envelope.to.length === 0) {
            say('503 5.5.1 Nobody to send it to');
            break;
          }
          say('354 Go ahead, end with a dot on its own line');
          state = 'data';
          break;

        case 'RSET':
          envelope = fresh();
          data = [];
          state = 'ready';
          say('250 2.0.0 Ok');
          break;

        case 'NOOP':
          say('250 2.0.0 Ok');
          break;

        case 'QUIT':
          say('221 2.0.0 Goodbye');
          socket.end();
          break;

        default:
          say(`502 5.5.2 I do not know "${verb}"`);
      }
    }
  });

  socket.on('error', () => {
    /* A client that hangs up is not an event worth logging on a sink. */
  });
});

function fresh() {
  return { from: null, to: [] };
}

/** `FROM:<someone@example.invalid>` or `TO:<someone@example.invalid>`. */
function address(argument) {
  const inBrackets = argument.match(/<([^>]*)>/);
  return (inBrackets ? inBrackets[1] : argument.replace(/^(FROM|TO):/i, '')).trim();
}

server.listen(PORT, HOST, () => {
  say('listening', { smtp: `${HOST}:${PORT}`, web: `http://${HOST}:${WEB}` });
});

// ------------------------------------------------------------ what it caught

http
  .createServer((request, response) => {
    if (request.url === '/messages') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return response.end(JSON.stringify({ received }, null, 2));
    }

    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(page());
  })
  .listen(WEB, HOST);

function page() {
  const rows = received
    .map(
      (one) => `
      <article>
        <p class="to">${escape(one.to.join(', '))}</p>
        <p class="from">from ${escape(one.from ?? '')} · ${escape(one.at)} · ${one.bytes} bytes</p>
        <pre>${escape(one.body)}</pre>
      </article>`
    )
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>What the sink caught</title>
<style>
  body { margin:0; padding:1.5rem; background:#f4f5f7; color:#16202b;
         font:14px/1.55 system-ui, 'Segoe UI', sans-serif; }
  h1 { font-size:1.1rem; margin:0 0 .3rem; }
  .lede { color:#5a6672; margin:0 0 1.2rem; max-width:60ch; }
  article { background:#fff; border:1px solid #dde3e8; border-radius:10px;
            padding:.8rem 1rem; margin-bottom:.7rem; }
  .to { margin:0; font-weight:620; }
  .from { margin:0 0 .5rem; font-size:.8rem; color:#7d8b99; }
  pre { margin:0; padding:.6rem .7rem; background:#f7f9fa; border-radius:8px;
        font:12px/1.6 ui-monospace, Consolas, monospace; white-space:pre-wrap;
        overflow-wrap:anywhere; max-height:18rem; overflow:auto; }
  .none { color:#7d8b99; }
</style></head>
<body>
  <h1>What the sink caught</h1>
  <p class="lede">
    ${received.length} ${received.length === 1 ? 'message' : 'messages'}, held in memory and
    delivered nowhere. They are gone when this process stops.
  </p>
  ${rows || '<p class="none">Nothing yet. Run a campaign.</p>'}
</body></html>`;
}

function escape(text) {
  return String(text ?? '').replace(
    /[&<>"']/g,
    (one) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[one]
  );
}

function say(message, detail = {}) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), message, ...detail })}\n`);
}
