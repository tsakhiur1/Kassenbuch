// From a dropped file to review items: reads the file, recognizes what it is and pre-fills the bookings.

import { readPdf, readImage, readEml, parseCsv, parseCamt, decodeText, textToDoc } from "./extract.js";
import { classify, parseBeleg, parseLohn, parseStatement, parseCsvRows, categorizeRows } from "./parse.js";
import { daysBetween } from "./util.js";

const ext = (name) => (String(name).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || "";

export async function processFile(file, ctx, onProgress = () => {}, depth = 0) {
  const e = ext(file.name), type = file.type || "";
  if (e === "msg") throw new Error("Outlook-Dateien im .msg-Format kann die App nicht lesen. Speichere den PDF-Anhang direkt, oder lade die Mail in Outlook im Web als .eml herunter.");

  if (e === "eml" || type === "message/rfc822") {
    if (depth > 0) return [];
    onProgress("E-Mail wird gelesen …");
    const mail = readEml(new Uint8Array(await file.arrayBuffer()));
    const out = [];
    for (const f of mail.files) {
      for (const item of await processFile(f, ctx, onProgress, depth + 1)) out.push({ ...item, name: `${mail.subject || file.name} · ${f.name}` });
    }
    if (out.length) return out;
    if (!mail.body.trim()) throw new Error("Diese E-Mail hat weder einen PDF-Anhang noch lesbaren Text.");
    return [fromDoc(textToDoc(`${mail.from}\n${mail.subject}\n${mail.body}`), ctx, { name: mail.subject || file.name, file: null })];
  }

  if (e === "csv" || type === "text/csv") {
    onProgress("Kontoauszug wird gelesen …");
    const rows = parseCsvRows(parseCsv(decodeText(new Uint8Array(await file.arrayBuffer()))));
    if (!rows.length) throw new Error("In der CSV-Datei wurden keine Bewegungen gefunden.");
    return [{ kind: "auszug", name: file.name, rows: categorizeRows(rows, ctx.learn), konto: {}, file: null }];
  }

  if (e === "xml" || /\/xml$/.test(type)) {
    onProgress("Kontoauszug wird gelesen …");
    const st = parseCamt(decodeText(new Uint8Array(await file.arrayBuffer())));
    const hinweis = st.waehrung !== "CHF" ? `Das Konto lautet auf ${st.waehrung}. Die Beträge werden ohne Umrechnung übernommen.` : "";
    return [{ kind: "auszug", name: file.name, rows: categorizeRows(st.rows, ctx.learn), konto: st.konto, hinweis, file: null }];
  }

  let doc;
  if (e === "pdf" || type === "application/pdf") { onProgress("PDF wird gelesen …"); doc = await readPdf(file, onProgress); }
  else if (/^image\//.test(type) || ["jpg", "jpeg", "png", "webp", "heic", "heif"].includes(e)) {
    try { doc = await readImage(file, onProgress); }
    catch (err) {
      // Safari can decode iPhone HEIC photos, most other browsers cannot
      if (/hei[cf]/i.test(e + type)) throw new Error("Dieses HEIC-Foto kann der Browser nicht öffnen. Öffne das Kassenbuch auf dem iPhone, oder stelle in den iPhone-Einstellungen unter Kamera → Formate auf „Maximale Kompatibilität“ um.");
      throw err;
    }
  } else throw new Error("Dieser Dateityp wird nicht unterstützt. Möglich sind PDF, JPG, PNG, CSV, camt.053 (.xml) und E-Mails (.eml).");

  if (!doc.text.trim()) throw new Error("Auf diesem Dokument wurde kein Text erkannt. Bei Fotos hilft ein schärferes, gerade aufgenommenes Bild.");
  return [fromDoc(doc, ctx, { name: file.name, file })];
}

function fromDoc(doc, ctx, { name, file }) {
  const kind = classify(doc);
  if (kind === "kontoauszug") {
    const rows = parseStatement(doc);
    if (rows.length) {
      const unsure = rows.filter((r) => r.unsicher).length;
      return {
        kind: "auszug", name, file, preview: doc.preview, rows: categorizeRows(rows, ctx.learn), konto: {},
        hinweis: unsure ? `Bei ${unsure} Bewegungen war nicht klar, ob Belastung oder Gutschrift. Sie sind als Ausgabe markiert, bitte prüfen.` : "",
      };
    }
  }
  const fields = kind === "lohn" ? parseLohn(doc, ctx) : parseBeleg(doc, ctx);
  if (doc.ocr) fields.warnings.push("Mit Texterkennung gelesen: Zahlen bitte mit dem Bild vergleichen.");
  return { ...fields, name, file, preview: doc.preview };
}

// Same direction and amount at most 3 days apart: most likely already booked.
// A movement matching an open invoice (from a customer or to a supplier) is its payment:
// it marks the invoice paid instead of booking the amount twice.
export function markDupes(rows, data) {
  const existing = Object.entries(data.tx).map(([id, t]) => ({ id, ...t }));
  const openInvoices = existing.filter((t) => t.status === "offen");
  const used = new Set();
  for (const r of rows) {
    r.dup = existing.some((t) => t.typ === r.typ && t.betragCent === r.betragCent && Math.abs(daysBetween(t.datum, r.datum)) <= 3 && t.status !== "offen");
    r.matchId = null;
    if (!r.dup) {
      const inv = openInvoices.find((t) => !used.has(t.id) && t.typ === r.typ && t.betragCent === r.betragCent && t.datum <= r.datum);
      if (inv) { used.add(inv.id); r.matchId = inv.id; r.matchLabel = inv.beleg || inv.partner || inv.datum; }
    }
    r.checked = !r.dup;
  }
  return rows;
}
