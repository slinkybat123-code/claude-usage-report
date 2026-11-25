// Deletes everything an account owns in the database. The Firestore functions are passed in, so
// the same code runs in the browser (Firebase from gstatic) and in the emulator tests (npm firebase).
// It has no imports for that reason.

/**
 * @param db    Firestore, signed in as the person being deleted
 * @param fs    { collection, query, where, getDocs, doc, writeBatch, deleteDoc }
 * @param uid   their user id
 * @param email their email address, lower case (invites sent to them)
 * @returns the number of documents deleted
 */
export async function deleteAccountData(db, fs, uid, email) {
  const { collection, query, where, getDocs, doc, writeBatch, deleteDoc } = fs;
  const refs = [];
  const add = (snap) => snap.forEach((d) => refs.push(d.ref));

  add(await getDocs(collection(db, 'users', uid, 'reports')));
  add(await getDocs(collection(db, 'users', uid, 'keys')));
  const devices = await getDocs(query(collection(db, 'devices'), where('owner', '==', uid)));
  add(devices);
  // A link code its computer hasn't picked up yet (usually already gone, so a refusal is fine).
  for (const d of devices.docs) {
    const code = d.data().link;
    if (code) await deleteDoc(doc(db, 'links', code)).catch(() => {});
  }
  add(await getDocs(query(collection(db, 'shares'), where('owner', '==', uid))));
  add(await getDocs(query(collection(db, 'shares'), where('viewer', '==', uid))));
  add(await getDocs(query(collection(db, 'invites'), where('from', '==', uid))));
  if (email) add(await getDocs(query(collection(db, 'invites'), where('toEmail', '==', email))));
  refs.push(doc(db, 'cards', uid), doc(db, 'users', uid));

  const unique = [...new Map(refs.map((r) => [r.path, r])).values()];
  for (let i = 0; i < unique.length; i += 400) {
    const batch = writeBatch(db);
    for (const r of unique.slice(i, i + 400)) batch.delete(r);
    await batch.commit();
  }
  return unique.length;
}
