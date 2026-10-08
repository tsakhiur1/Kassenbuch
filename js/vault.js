// Encrypted local storage. Everything (bookings, settings, learned rules, receipts) is
// encrypted with AES-GCM using a key derived from the user's password (PBKDF2-SHA256).
// Nothing readable is ever written to disk, and nothing leaves the computer.

const DB_NAME = "kassenbuch";
const ITERATIONS = 600000;
const VERIFY_TEXT = "kassenbuch-ok";
const enc = new TextEncoder(), dec = new TextDecoder();

let key = null; // CryptoKey while unlocked

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      if (!db.objectStoreNames.contains("files")) db.createObjectStore("files");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
let dbPromise = null;
const db = () => (dbPromise ||= openDb());

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("Speichern abgebrochen"));
  });
}
const get = (store, k) => tx(store, "readonly", (s) => s.get(k));
const put = (store, k, v) => tx(store, "readwrite", (s) => s.put(v, k));
const del = (store, k) => tx(store, "readwrite", (s) => s.delete(k));
const keys = (store) => tx(store, "readonly", (s) => s.getAllKeys());

async function deriveKey(password, salt, iterations) {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, base,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function seal(k, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, bytes));
  return { iv, ct };
}
const open = (k, box) => crypto.subtle.decrypt({ name: "AES-GCM", iv: box.iv }, k, box.ct);

export const isUnlocked = () => !!key;
export async function hasVault() { return !!(await get("meta", "vault")); }

export function emptyData() {
  return {
    version: 1,
    tx: {},          // id -> booking
    recurring: {},   // id -> template
    settings: { firma: "", ibans: [], mwst: "effektiv", saldoSatz: null, budgets: {}, lastBackup: null },
    learn: { merchants: {}, nb: { docs: 0, labels: {}, tokens: {} } },
  };
}

export async function createVault(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  key = await deriveKey(password, salt, ITERATIONS);
  const verifier = await seal(key, enc.encode(VERIFY_TEXT));
  await put("meta", "vault", { salt, iterations: ITERATIONS, verifier, created: new Date().toISOString() });
  const data = emptyData();
  await saveData(data);
  return data;
}

export async function unlock(password) {
  const vault = await get("meta", "vault");
  if (!vault) throw new Error("Kein Kassenbuch auf diesem Computer.");
  const k = await deriveKey(password, vault.salt, vault.iterations);
  try {
    if (dec.decode(await open(k, vault.verifier)) !== VERIFY_TEXT) throw new Error();
  } catch (_) {
    const err = new Error("Das Passwort stimmt nicht.");
    err.code = "wrong_password";
    throw err;
  }
  key = k;
  const box = await get("meta", "data");
  return box ? { ...emptyData(), ...JSON.parse(dec.decode(await open(key, box))) } : emptyData();
}

export function lock() { key = null; }

export async function saveData(data) {
  if (!key) throw new Error("Das Kassenbuch ist gesperrt.");
  await put("meta", "data", await seal(key, enc.encode(JSON.stringify(data))));
}

export async function putFile(id, blob, name) {
  if (!key) throw new Error("Das Kassenbuch ist gesperrt.");
  const box = await seal(key, new Uint8Array(await blob.arrayBuffer()));
  await put("files", id, { ...box, type: blob.type || "application/octet-stream", name: name || "", size: blob.size });
}

export async function getFile(id) {
  const rec = await get("files", id);
  if (!rec || !key) return null;
  return { blob: new Blob([await open(key, rec)], { type: rec.type }), name: rec.name };
}

export const deleteFile = (id) => del("files", id);
export const fileIds = () => keys("files");

export async function changePassword(oldPassword, newPassword, data) {
  const vault = await get("meta", "vault");
  const oldKey = await deriveKey(oldPassword, vault.salt, vault.iterations);
  try { await open(oldKey, vault.verifier); } catch (_) {
    const err = new Error("Das bisherige Passwort stimmt nicht."); err.code = "wrong_password"; throw err;
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const newKey = await deriveKey(newPassword, salt, ITERATIONS);
  // re-encrypt every receipt first, then switch the vault
  for (const id of await fileIds()) {
    const rec = await get("files", id);
    const plain = await open(oldKey, rec);
    await put("files", id, { ...rec, ...(await seal(newKey, new Uint8Array(plain))) });
  }
  key = newKey;
  await put("meta", "vault", { salt, iterations: ITERATIONS, verifier: await seal(newKey, enc.encode(VERIFY_TEXT)), created: vault.created });
  await saveData(data);
}

// ---------- backup: the encrypted records as they are, so a backup is as safe as the vault ----------
const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const boxOut = (b) => ({ iv: b64(new Uint8Array(b.iv)), ct: b64(new Uint8Array(b.ct)) });
const boxIn = (b) => ({ iv: unb64(b.iv), ct: unb64(b.ct) });

export async function exportBackup() {
  const vault = await get("meta", "vault"), data = await get("meta", "data");
  const files = {};
  for (const id of await fileIds()) {
    const rec = await get("files", id);
    files[id] = { ...boxOut(rec), type: rec.type, name: rec.name, size: rec.size };
  }
  return JSON.stringify({
    format: "kassenbuch-backup", version: 1, created: new Date().toISOString(),
    vault: { salt: b64(new Uint8Array(vault.salt)), iterations: vault.iterations, verifier: boxOut(vault.verifier), created: vault.created },
    data: boxOut(data), files,
  });
}

// Checks the password against the backup before replacing anything on this computer.
export async function importBackup(text, password) {
  let b;
  try { b = JSON.parse(text); } catch (_) { throw new Error("Diese Datei ist keine Kassenbuch-Sicherung."); }
  if (b?.format !== "kassenbuch-backup") throw new Error("Diese Datei ist keine Kassenbuch-Sicherung.");
  const salt = unb64(b.vault.salt);
  const k = await deriveKey(password, salt, b.vault.iterations);
  try { await open(k, boxIn(b.vault.verifier)); } catch (_) {
    const err = new Error("Das Passwort passt nicht zu dieser Sicherung."); err.code = "wrong_password"; throw err;
  }
  await wipe();
  await put("meta", "vault", { salt, iterations: b.vault.iterations, verifier: boxIn(b.vault.verifier), created: b.vault.created });
  await put("meta", "data", boxIn(b.data));
  for (const [id, f] of Object.entries(b.files || {})) await put("files", id, { ...boxIn(f), type: f.type, name: f.name, size: f.size });
  key = k;
  return { ...emptyData(), ...JSON.parse(dec.decode(await open(k, boxIn(b.data)))) };
}

export async function wipe() {
  await tx("meta", "readwrite", (s) => s.clear());
  await tx("files", "readwrite", (s) => s.clear());
  key = null;
}

// Ask the browser not to evict our data under storage pressure.
export async function persist() {
  try { return navigator.storage?.persist ? await navigator.storage.persist() : false; } catch (_) { return false; }
}
