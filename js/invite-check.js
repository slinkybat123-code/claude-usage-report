// Who you can invite (Friends page and the dashboard's "Add a friend"). No imports, so the tests can load it.

/** The address as it will be stored (trimmed, lower case) and what's wrong with it, if anything. */
export function checkInvite(raw, mine) {
  const email = String(raw || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { email, problem: "That doesn't look like an email address." };
  if (email === String(mine || '').toLowerCase()) return { email, problem: "That's you. Invite a friend's address." };
  return { email, problem: null };
}
