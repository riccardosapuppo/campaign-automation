/**
 * Filling a template in, and refusing to guess.
 *
 * `Hello {{name}}, your order {{fields.order}} is ready.`
 *
 * The interesting decision is what happens when a field is missing, and there
 * are three answers. Two of them are wrong and both are common:
 *
 *   - **Leave the placeholder.** Four hundred people are told "Hello
 *     {{name}}". Everybody has had one of these.
 *   - **Put in an empty string.** "Hello ," goes out, and nobody notices
 *     because nothing looked broken at any point.
 *   - **Say which field is missing, for which contact, before anything is
 *     sent.** Which is what this does.
 *
 * A missing field is not an error at fill time — it is reported, and the
 * campaign refuses to send a message that has one. That is the difference
 * between finding out during the review and finding out from a customer.
 */

import type { Contact } from '../rules/permission.ts';

const FIELD = /\{\{\s*([a-zA-Z0-9_.]+)\s*(?:\|\s*([^}]*?))?\s*\}\}/g;

/**
 * @returns {{ text: string, missing: string[], used: string[] }}
 */
export function fill(template: unknown, contact: Contact) {
  const missing: string[] = [];
  const used: string[] = [];

  const text = String(template ?? '').replace(FIELD, (whole, name, fallback) => {
    const value = look(contact, name);

    if (value !== undefined && value !== null && String(value).trim() !== '') {
      used.push(name);
      return String(value);
    }

    /**
     * A fallback written into the template.
     *
     * `{{name | there}}` gives "Hello there" rather than nothing, and it is the
     * author saying out loud what should happen — which is different from a
     * tool deciding on their behalf. Only a fallback the template asked for
     * counts; there is no default default.
     */
    if (fallback !== undefined) {
      used.push(`${name} (fell back)`);
      return fallback;
    }

    missing.push(name);
    return whole;
  });

  return { text, missing: [...new Set(missing)], used: [...new Set(used)] };
}

/**
 * `fields.order` on a contact, without letting a template walk anywhere else.
 *
 * Only `name`, `address` and things under `fields` — which is what an import
 * put there. A template is written by whoever runs the campaign and read by a
 * program that also holds the consent records; `{{basis.source}}` in a subject
 * line would put somebody's consent trail in an email, and `{{constructor}}`
 * is the older trick.
 */
function look(contact: Contact, name: string) {
  if (name === 'name' || name === 'address') return contact?.[name];

  if (name.startsWith('fields.')) {
    const key = name.slice('fields.'.length);
    // Own property only: `fields.toString` would otherwise be a function.
    return Object.hasOwn(contact?.fields ?? {}, key) ? contact.fields?.[key] : undefined;
  }

  // A bare name is looked for in the imported fields, because that is what
  // somebody writing `{{company}}` means.
  return Object.hasOwn(contact?.fields ?? {}, name) ? contact.fields?.[name] : undefined;
}

/**
 * Every field a template asks for, so a campaign can be checked against an
 * import before anybody presses anything.
 */
export function fieldsIn(template: unknown): string[] {
  return [...new Set([...String(template ?? '').matchAll(FIELD)].map((one) => one[1]))];
}

/**
 * Which contacts a template cannot be filled in for.
 *
 * Run over the whole list before a campaign is worked out, so "sixteen of these
 * have no company name" is something somebody reads while deciding, rather than
 * discovering afterwards.
 */
export function whoIsMissingSomething(template: unknown, contacts: Contact[]) {
  const trouble = new Map();

  for (const contact of contacts) {
    const { missing } = fill(template, contact);
    if (missing.length === 0) continue;

    for (const field of missing) {
      if (!trouble.has(field)) trouble.set(field, []);
      trouble.get(field).push(contact.address);
    }
  }

  return [...trouble.entries()].map(([field, addresses]) => ({
    field,
    howMany: addresses.length,
    // A few, not all of them. A list of four hundred addresses in an error
    // message is a message nobody reads.
    forExample: addresses.slice(0, 3),
  }));
}
