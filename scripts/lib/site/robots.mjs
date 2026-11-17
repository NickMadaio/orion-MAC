/* Minimal robots.txt: the group for our agent (else "*"), longest matching rule wins, Allow beats Disallow on a tie. */

export function parseRobots(text, agent) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const at = line.indexOf(':');
    if (at < 1) continue;
    const key = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (current && (key === 'allow' || key === 'disallow')) {
      lastWasAgent = false;
      if (value) current.rules.push({ allow: key === 'allow', path: value });
    } else { lastWasAgent = false; }
  }
  const name = String(agent).toLowerCase();
  const named = groups.filter(group => group.agents.some(a => a !== '*' && name.includes(a)));
  const chosen = named.length ? named : groups.filter(group => group.agents.includes('*'));
  return Object.freeze({ rules: Object.freeze(chosen.flatMap(group => group.rules)) });
}

function matches(pattern, path) {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern).split('*')
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`).test(path);
}

export function isAllowedByRobots(robots, path) {
  let best = null;
  for (const rule of robots.rules) {
    if (!matches(rule.path, path)) continue;
    if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) best = rule;
  }
  return best ? best.allow : true;
}
