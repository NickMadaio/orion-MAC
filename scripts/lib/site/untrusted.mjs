/*
 Text from the web is DATA. Every string that came from a remote host is wrapped
 so a later step cannot mistake it for a command, a step name or a recipient.
 Code that needs the text unwraps it explicitly and only ever puts it in a field.
*/
export const tainted = value => Object.freeze({ untrusted: true, value: String(value) });

export const isTainted = value => Boolean(value) && value.untrusted === true && typeof value.value === 'string';

export function unwrap(value) {
  if (!isTainted(value)) throw new TypeError('expected an untrusted-data wrapper');
  return value.value;
}
