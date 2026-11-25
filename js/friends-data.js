// Friends, shared by the Friends page and the dashboard's friends strip: sending an invite, and
// following the cards of friends who share with you.
import { db, doc, getDoc, setDoc, deleteDoc, onSnapshot, collection, query, where, serverTimestamp, millis } from './cloud.js';
import { checkInvite } from './invite-check.js';

/** Sends (or sends again) an invite to a Google address. Returns the address; throws an Error with a readable message. */
export async function sendInvite(me, raw) {
  const { email, problem } = checkInvite(raw, me.email);
  if (problem) throw new Error(problem);
  const ref = doc(db, 'invites', `${me.uid}_${email}`);
  const old = await getDoc(ref).catch(() => null);
  if (old && old.exists()) await deleteDoc(ref); // a declined or old invite: send a fresh one
  await setDoc(ref, { from: me.uid, fromName: me.name, fromEmail: me.email, fromPhoto: me.photo, toEmail: email, status: 'pending', createdAt: serverTimestamp() });
  return email;
}

/**
 * Friends who share their card with you, live. Calls onChange({ following, cards, myCard }) after every
 * change: following = the shares where you're the viewer (oldest first; `pending` until the server has
 * them), cards = Map(uid → card), myCard = your own card.
 */
export function watchFriends(me, onChange, onError = () => {}) {
  let following = [];
  let myCard = null;
  const cards = new Map();
  const stops = new Map();
  const emit = () => onChange({ following, cards, myCard });

  /** A friend's card. Refused right after accepting (the server hasn't seen the share yet)? Try again shortly. */
  function watchCard(uid, tries = 0) {
    stops.set(uid, onSnapshot(doc(db, 'cards', uid), (d) => {
      if (d.exists()) cards.set(uid, d.data());
      emit();
    }, () => {
      stops.delete(uid);
      if (tries < 5 && following.some((s) => s.owner === uid)) setTimeout(() => !stops.has(uid) && watchCard(uid, tries + 1), 1500 * (tries + 1));
    }));
  }
  /** One live card listener per friend whose share the server has confirmed. */
  function follow(owners) {
    const want = new Set(owners);
    for (const [uid, stop] of stops) {
      if (!want.has(uid)) {
        stop();
        stops.delete(uid);
        cards.delete(uid);
      }
    }
    for (const uid of want) if (!stops.has(uid)) watchCard(uid);
  }

  onSnapshot(query(collection(db, 'shares'), where('viewer', '==', me.uid)), { includeMetadataChanges: true }, (snap) => {
    following = snap.docs.map((d) => ({ ...d.data(), pending: d.metadata.hasPendingWrites })).sort((a, b) => millis(a.createdAt) - millis(b.createdAt));
    follow(following.filter((s) => !s.pending).map((s) => s.owner));
    emit();
  }, onError);
  onSnapshot(doc(db, 'cards', me.uid), (d) => {
    myCard = d.exists() ? d.data() : null;
    emit();
  }, () => {});
}
