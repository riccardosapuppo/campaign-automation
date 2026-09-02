/**
 * The console.
 *
 * It holds no rules of its own. Every verdict on this screen, every reason
 * next to it, and every decision about whether a reply is an unsubscribe comes
 * from the service — which is the same code the tests run against. A screen
 * that works out for itself whether somebody may be written to is a second
 * implementation of the only thing that matters, and it will disagree with the
 * first one eventually.
 */

/**
 * Nothing here installs a service worker, and this makes sure nothing has.
 *
 * A service worker outlives the version that installed it, and it outlives the
 * page: it goes on answering from its own cache long after the code that put it
 * there is gone. A tool served on 127.0.0.1 shares an origin with every other
 * thing anybody has ever run on that port, so a worker left behind by an
 * unrelated project is enough to serve somebody a page that no longer exists.
 * The symptom is a stale screen that only Ctrl+F5 fixes, which sends people
 * looking at caching headers that were right all along.
 */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .getRegistrations()
    .then((workers) => Promise.all(workers.map((one) => one.unregister())))
    .then((undone) => {
      if (undone.length > 0) console.info(`unregistered ${undone.length} service worker(s) left on this origin`);
      return globalThis.caches?.keys().then((names) => Promise.all(names.map((one) => caches.delete(one))));
    })
    .catch(() => {
      /* a browser that will not say has nothing for us to undo */
    });
}

const $ = (id) => document.getElementById(id);

const state = { campaign: null, firstAllowed: null };

// -------------------------------------------------------------------- the list

async function refresh() {
  const said = await ask('/api/contacts');

  $('tally-contacts').textContent = said.allowed.length + said.refused.length;
  $('tally-allowed').textContent = said.allowed.length;
  $('tally-refused').textContent = said.refused.length;

  const body = $('contacts-body');
  body.replaceChildren();

  const everybody = [...said.refused, ...said.allowed];

  // The examples in the reply panel are there to show what a stop does, so
  // they are aimed at somebody a stop would change. Aiming them at the first
  // row on screen aims them at somebody already held back, and pressing one
  // then appears to do nothing at all.
  state.firstAllowed = said.allowed[0]?.address ?? null;
  $('reply-address').placeholder = state.firstAllowed ? `who replied — e.g. ${state.firstAllowed}` : 'who replied';

  // Step 1 of the campaign, kept in step with the list without being a second
  // copy of it: how many a campaign would reach, counted from the same answer.
  $('who-many').textContent = said.allowed.length;
  $('who-preview').replaceChildren(
    ...said.allowed.slice(0, 4).map((one) => {
      const li = document.createElement('li');
      li.textContent = one.address;
      return li;
    }),
    ...(said.allowed.length > 4
      ? [
          Object.assign(document.createElement('li'), {
            className: 'and-more',
            textContent: `and ${said.allowed.length - 4} more`,
          }),
        ]
      : [])
  );

  if (everybody.length === 0) {
    body.innerHTML = '<tr class="empty"><td colspan="4">Nobody yet. Import a spreadsheet, or use the sample list.</td></tr>';
    return;
  }

  // Held back first. The refusals are the answer somebody came here for; a
  // list sorted alphabetically buries them among four hundred that were fine.
  for (const one of everybody) {
    const row = document.createElement('tr');
    const may = Boolean(one.said?.ok);

    row.append(
      cell(who(one), 'address'),
      cell(pill(may ? 'may be written to' : 'held back', may ? 'yes' : 'no')),
      cell(one.said?.why ?? '', 'because'),
      cell(actions(one), 'right')
    );

    body.append(row);
  }

  $('known').replaceChildren(
    ...everybody.map((one) => Object.assign(document.createElement('option'), { value: one.address }))
  );
}

/**
 * The address, with the name under it.
 *
 * One column rather than two. They are the same fact, and separating them cost
 * the reason column the width it needed — which is the one column on this page
 * that has something to say.
 */
function who(one) {
  const wrap = document.createDocumentFragment();

  wrap.append(one.address);

  if (one.name) {
    const name = document.createElement('span');
    name.className = 'their-name';
    name.textContent = one.name;
    wrap.append(name);
  }

  return wrap;
}

function actions(one) {
  const wrap = document.createDocumentFragment();

  const history = Object.assign(document.createElement('button'), {
    type: 'button',
    className: 'link',
    textContent: 'history',
    onclick: () => showHistory(one.address),
  });

  wrap.append(history);

  if (!one.suppressed) {
    wrap.append(
      Object.assign(document.createElement('button'), {
        type: 'button',
        className: 'link',
        textContent: 'they asked to stop',
        onclick: async () => {
          await post('/api/suppress', { address: one.address, why: 'recorded by hand in the console' });
          refresh();
        },
      })
    );
  }

  return wrap;
}

// ---------------------------------------------------------------- one person

async function showHistory(address) {
  const said = await ask(`/api/contacts/${encodeURIComponent(address)}`);

  $('history-address').textContent = address;

  const trail = document.createElement('ul');
  trail.className = 'trail';

  for (const basis of said.bases) {
    trail.append(
      item('basis', `${basis.kind} — ${basis.source}`, basis.recorded_at)
    );
  }

  if (said.suppression) {
    trail.append(item('suppression', `asked to stop — ${said.suppression.why}`, said.suppression.at));
  }

  for (const message of said.messages) {
    trail.append(item('message', `${message.campaign}: ${message.state} — ${message.why ?? ''}`, message.at));
  }

  if (trail.children.length === 0) {
    trail.append(item('message', 'nothing has ever been recorded about this address', ''));
  }

  const verdict = document.createElement('p');
  verdict.className = `verdict ${said.said.ok ? 'not' : 'stop'}`;
  verdict.textContent = said.said.ok ? `May be written to: ${said.said.why}` : `Held back: ${said.said.why}`;

  $('history-body').replaceChildren(verdict, trail);
  $('history').showModal();
}

function item(kind, text, when) {
  const li = document.createElement('li');
  li.className = kind;

  if (when) {
    const time = document.createElement('time');
    time.textContent = when;
    li.append(time);
  }

  li.append(document.createTextNode(text));
  return li;
}

// ------------------------------------------------------------------- import

$('csv').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  await importCsv(await file.text(), file.name);
  event.target.value = '';
});

$('load-sample').addEventListener('click', async () => {
  const csv = await fetch('/samples/contacts.csv').then((r) => (r.ok ? r.text() : null));

  if (csv === null) {
    $('import-said').textContent = 'the sample list is not being served — start the service from the project folder';
    return;
  }

  await importCsv(csv, 'samples/contacts.csv');
});

async function importCsv(text, name) {
  const said = await post('/api/import', text, { 'Content-Type': 'text/csv' });

  const trouble = said.trouble?.length ? ` — ${said.trouble.join('; ')}` : '';
  const skipped = said.skipped?.length ? `, ${said.skipped.length} row(s) skipped` : '';
  $('import-said').textContent = `${name}: ${said.imported} imported${skipped}${trouble}`;

  const list = $('columns-list');
  list.replaceChildren();

  for (const column of said.columns ?? []) {
    const li = document.createElement('li');
    li.innerHTML = `<b>${escape(column.title || '(no heading)')}</b> → ${escape(column.field)} · ${escape(column.why)}`;
    list.append(li);
  }

  $('columns').hidden = (said.columns ?? []).length === 0;
  refresh();
}

// -------------------------------------------------------------------- reply

$('reply-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  await sayReply($('reply-address').value, $('reply-text').value);
});

for (const button of document.querySelectorAll('[data-try]')) {
  button.addEventListener('click', () => {
    $('reply-text').value = button.dataset.try;
    if (!$('reply-address').value) $('reply-address').value = state.firstAllowed ?? '';
    sayReply($('reply-address').value, $('reply-text').value);
  });
}

async function sayReply(address, text) {
  if (!address) {
    $('reply-said').textContent = 'who replied?';
    return;
  }

  const said = await post('/api/reply', { address, text });

  $('reply-said').className = `verdict ${said.suppressed ? 'stop' : 'not'}`;
  $('reply-said').textContent = said.suppressed
    ? `Read as an unsubscribe — ${said.why}. ${address} will not be written to again.`
    : `Not an unsubscribe — ${said.why}. Nothing changed.`;

  refresh();
}

// ------------------------------------------------------------------ campaign

$('campaign-form').addEventListener('submit', async (event) => {
  event.preventDefault();

  const said = await post('/api/campaigns', {
    name: $('c-name').value,
    subject: $('c-subject').value,
    body: $('c-body').value,
    fromName: $('c-from-name').value,
    fromAddress: $('c-from-address').value,
  });

  state.campaign = said.campaign;

  $('steps').hidden = false;
  $('do-send').disabled = true;
  $('decide-said').textContent = 'sends nothing';
  $('send-said').textContent = '';
  $('messages-wrap').hidden = true;

  // Said before anything is worked out: which contacts this template cannot be
  // filled in for. Somebody reads this while deciding, not afterwards.
  const missing = said.missing ?? [];
  $('held-back').hidden = missing.length === 0;
  $('held-back-list').replaceChildren(
    ...missing.map((one) => {
      const li = document.createElement('li');
      li.innerHTML = `<code>{{${escape(one.field)}}}</code> is missing for ${one.howMany}: ${escape(one.forExample.join(', '))}${one.howMany > one.forExample.length ? ' …' : ''}`;
      return li;
    })
  );
  if (missing.length > 0) $('held-back').querySelector('h3').textContent = 'These will not send until the field is there';
});

$('do-decide').addEventListener('click', async () => {
  const said = await post(`/api/campaigns/${state.campaign.id}/decide`);

  $('decide-said').textContent = `${said.allowed} may be written to, ${said.refused} held back — nothing was sent`;
  $('do-send').disabled = said.allowed === 0;

  showRefusals(said.refusals);
  await showMessages();
});

$('do-send').addEventListener('click', async () => {
  $('do-send').disabled = true;
  $('send-said').textContent = 'sending…';

  const waiting = (await ask(`/api/campaigns/${state.campaign.id}`)).messages.filter(
    (one) => one.state === 'allowed' || one.state === 'sending'
  ).length;

  openTheProgress(waiting);

  // The request does not come back until the whole run has finished, so the
  // progress cannot be read from it. It is read from the campaign, which the
  // service updates as it goes — a row per person, written before the send and
  // updated after, which is exactly what that shape is for.
  const watching = watchTheProgress(waiting);

  try {
    const said = await post(`/api/campaigns/${state.campaign.id}/send`, {
      transport: $('transport').value,
      perMinute: Number($('rate').value),
    });

    $('send-said').textContent = said.error
      ? said.error
      : `${said.sent} sent, ${said.failed} would not go, ${said.dropped} dropped because something changed` +
        (said.stopped ? ' — stopped on request, the rest is still waiting' : '');
  } finally {
    clearInterval(watching);
    $('sending').close();
  }

  await showMessages();
  refresh();

  /**
   * Pressable again if, and only if, there is something left.
   *
   * Disabling it while a run is going is right; leaving it disabled afterwards
   * was right too, back when a run always emptied the queue. A stop leaves
   * people still waiting — and a screen that will not send them is a stop
   * button that quietly ends the campaign instead of pausing it.
   */
  const left = (await ask(`/api/campaigns/${state.campaign.id}`)).messages.filter(
    (one) => one.state === 'allowed'
  ).length;

  $('do-send').disabled = left === 0;
  if (left > 0) $('send-said').textContent += ` — ${left} still waiting, press Send again to carry on`;
});

/**
 * The progress window, while it goes out.
 *
 * Traced from the original, which had exactly this and was right to: a bar,
 * this many of that many, who is being written to at this moment, and a way
 * out. Fifteen minutes is long enough to notice the wrong subject line.
 */
function openTheProgress(total) {
  $('to-send').textContent = total;
  $('sent-so-far').textContent = '0';
  $('bar-done').style.width = '0%';
  $('to-whom').textContent = ' ';
  $('do-stop').disabled = false;
  $('do-stop').textContent = 'Stop sending';
  $('sending').showModal();
}

function watchTheProgress(total) {
  return setInterval(async () => {
    const said = await ask(`/api/campaigns/${state.campaign.id}`);
    const done = said.messages.filter((one) => one.state === 'sent' || one.state === 'failed').length;
    const now = said.messages.find((one) => one.state === 'sending');

    $('sent-so-far').textContent = done;
    $('bar-done').style.width = total > 0 ? `${Math.round((done / total) * 100)}%` : '0%';
    $('to-whom').textContent = now ? now.address : ' ';
  }, 200);
}

$('do-stop').addEventListener('click', async () => {
  $('do-stop').disabled = true;
  $('do-stop').textContent = 'stopping after this one…';

  await post(`/api/campaigns/${state.campaign.id}/stop`);
});

function showRefusals(refusals) {
  const entries = Object.entries(refusals ?? {});

  $('held-back').hidden = entries.length === 0;
  $('held-back').querySelector('h3').textContent = 'Held back, and why';
  $('held-back-list').replaceChildren(
    ...entries.map(([code, howMany]) => {
      const li = document.createElement('li');
      li.innerHTML = `<code>${escape(code)}</code> — ${howMany}`;
      return li;
    })
  );
}

async function showMessages() {
  const said = await ask(`/api/campaigns/${state.campaign.id}`);
  const body = $('messages-body');

  body.replaceChildren();

  for (const message of said.messages) {
    const row = document.createElement('tr');
    row.append(
      cell(message.address, 'address'),
      cell(message.state, 'state'),
      cell(message.why ?? '', 'because'),
      cell(message.subject ?? '—')
    );
    body.append(row);
  }

  $('messages-wrap').hidden = said.messages.length === 0;
}

// -------------------------------------------------------------------- small

function cell(what, className = '') {
  const td = document.createElement('td');
  if (className) td.className = className;
  td.append(typeof what === 'string' ? document.createTextNode(what) : what);
  return td;
}

function pill(text, kind) {
  const span = document.createElement('span');
  span.className = `answer ${kind}`;
  span.textContent = text;
  return span;
}

/**
 * Everything the screen knows, it asked for.
 *
 * The method is named rather than guessed from whether there is a body. The
 * first version worked it out — no body meant GET — and every POST that sends
 * nothing, of which "work out who may be written to" is one, quietly went out
 * as a GET, hit no route, came back as a page of HTML, and failed while
 * parsing. The button simply never became pressable.
 */
async function ask(url) {
  return (await fetch(url)).json();
}

async function post(url, body = {}, headers = { 'Content-Type': 'application/json' }) {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

  return response.json();
}

function escape(text) {
  return String(text ?? '').replace(
    /[&<>"']/g,
    (one) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[one]
  );
}

refresh();
