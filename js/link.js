// Link requests: a computer or the phone app asks to join your account with a 10-character code.
import { db, doc, getDoc, writeBatch, serverTimestamp, nameOf } from './cloud.js';

export const LINK_CODE = /^[2-9A-HJKMNP-Z]{10}$/;

/** The request behind a code, or null when it has expired, was used or doesn't exist. */
export async function readLink(code) {
  try {
    const d = await getDoc(doc(db, 'links', code));
    return d.exists() ? d.data() : null;
  } catch {
    return null;
  }
}

/** Say yes: the request and the device both become yours, in one write. */
export async function approveLink(user, code, link) {
  const b = writeBatch(db);
  b.update(doc(db, 'links', code), { owner: user.uid, ownerName: nameOf(user) });
  b.set(doc(db, 'devices', link.device), { owner: user.uid, kind: link.kind || 'pc', name: link.name || 'Computer', platform: link.platform || '', link: code, linkedAt: serverTimestamp() });
  await b.commit();
}
