// Turns files into text with positions: PDF text layers (pdf.js), scans and photos (Tesseract OCR),
// CSV exports, ISO 20022 camt.053 statements and e-mails (.eml). All libraries ship with the app,
// so documents never leave this computer.

import { parseBetrag } from "./util.js";

const here = (p) => new URL(p, document.baseURI).href;
const PDFJS = "vendor/pdfjs/pdf.min.js";
const TESSERACT = "vendor/tesseract/tesseract.min.js";

const scripts = new Map();
export function loadScript(src) {
  if (!scripts.has(src)) {
    const p = new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = src; el.onload = resolve;
      el.onerror = () => { scripts.delete(src); reject(new Error("Ein Programmteil konnte nicht geladen werden: " + src)); };
      document.head.appendChild(el);
    });
    scripts.set(src, p);
  }
  return scripts.get(src);
}

async function pdfjs() {
  await loadScript(PDFJS);
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = here("vendor/pdfjs/pdf.worker.min.js");
  return window.pdfjsLib;
}

// ---------- OCR ----------
let ocrWorker = null, ocrProgress = () => {};
async function ocr() {
  if (!ocrWorker) {
    await loadScript(TESSERACT);
    ocrWorker = window.Tesseract.createWorker("deu", 1, {
      workerPath: here("vendor/tesseract/worker.min.js"),
      corePath: here("vendor/tesseract/core"),
      langPath: here("vendor/tesseract/lang"),
      gzip: true,
      logger: (m) => { if (m.status === "recognizing text") ocrProgress(m.progress); },
    }).catch((e) => { ocrWorker = null; throw e; });
  }
  return ocrWorker;
}

// Recognize an image or canvas and return rows of words with their positions.
async function ocrRows(image, page, onProgress) {
  ocrProgress = onProgress || (() => {});
  const worker = await ocr();
  const { data } = await worker.recognize(image, {}, { text: true, blocks: true });
  const lines = data.lines?.length ? data.lines
    : (data.blocks || []).flatMap((b) => (b.paragraphs || []).flatMap((p) => p.lines || []));
  return lines.map((l) => ({
    page, y: l.bbox.y0,
    items: (l.words || []).filter((w) => w.text.trim()).map((w) => ({ str: w.text, x: w.bbox.x0, w: w.bbox.x1 - w.bbox.x0 })),
  })).filter((r) => r.items.length);
}

// Words on one visual line are joined; a gap wider than about two characters becomes a column break.
function rowsToDoc(rows) {
  const lines = rows.map((r) => {
    let s = "", prevEnd = null;
    for (const it of r.items) {
      if (prevEnd != null) s += it.x - prevEnd > 12 ? "   " : " ";
      s += it.str; prevEnd = it.x + (it.w || it.str.length * 5);
    }
    return s.trim();
  }).filter(Boolean);
  return { text: lines.join("\n"), lines, rows };
}

export async function readPdf(file, onProgress = () => {}) {
  const lib = await pdfjs();
  const doc = await lib.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    isEvalSupported: false,
    standardFontDataUrl: here("vendor/pdfjs/standard_fonts/"),
  }).promise;
  const pages = Math.min(doc.numPages, 30);
  let rows = [], chars = 0;
  for (let p = 1; p <= pages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = tc.items.filter((i) => i.str && i.str.trim())
      .map((i) => ({ str: i.str.trim(), x: i.transform[4], y: vp.height - i.transform[5], w: i.width }));
    chars += items.reduce((a, i) => a + i.str.length, 0);
    items.sort((a, b) => a.y - b.y || a.x - b.x);
    for (const it of items) {
      const row = rows.find((r) => r.page === p && Math.abs(r.y - it.y) <= 3);
      if (row) row.items.push(it); else rows.push({ page: p, y: it.y, items: [it] });
    }
  }
  rows.forEach((r) => r.items.sort((a, b) => a.x - b.x));
  rows.sort((a, b) => a.page - b.page || a.y - b.y);
  let preview = null;
  // A scan has (almost) no text layer: read it with OCR instead.
  if (chars < 40 * pages) {
    rows = [];
    const ocrPages = Math.min(doc.numPages, 10);
    for (let p = 1; p <= ocrPages; p++) {
      onProgress(`Texterkennung Seite ${p} von ${ocrPages} …`);
      const canvas = await renderPage(doc, p, 2.2);
      if (p === 1) preview = canvas.toDataURL("image/jpeg", 0.6);
      rows.push(...await ocrRows(canvas, p, (x) => onProgress(`Texterkennung Seite ${p} von ${ocrPages}: ${Math.round(x * 100)} %`)));
    }
  } else {
    preview = (await renderPage(doc, 1, 0.8)).toDataURL("image/jpeg", 0.6);
  }
  return { ...rowsToDoc(rows), preview, ocr: chars < 40 * pages };
}

async function renderPage(doc, p, scale) {
  const page = await doc.getPage(p);
  const vp = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return canvas;
}

export async function readImage(file, onProgress = () => {}) {
  const bitmap = await createImageBitmap(file);
  // phone photos are large; about 2500 px on the long side is plenty for OCR
  const scale = Math.min(1, 2500 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  onProgress("Texterkennung …");
  const rows = await ocrRows(canvas, 1, (x) => onProgress(`Texterkennung: ${Math.round(x * 100)} %`));
  const preview = canvas.toDataURL("image/jpeg", 0.5);
  return { ...rowsToDoc(rows), preview, ocr: true };
}

// ---------- text files ----------
export function decodeText(u8) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(u8); } catch (_) { return new TextDecoder("windows-1252").decode(u8); }
}

export function parseCsv(text) {
  const head = text.slice(0, 4000);
  const d = [";", "\t", ","].map((c) => [c, head.split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === d) { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(f); rows.push(row); row = []; f = "";
    } else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}

// ISO 20022 camt.053 / camt.054, the standard export of Swiss banks.
export function parseCamt(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("Die XML-Datei ist kein lesbarer Kontoauszug.");
  const q = (el, path) => {
    let cur = el ? [el] : [];
    for (const name of path.split("/")) {
      cur = cur.flatMap((x) => [...x.children].filter((c) => c.localName === name));
      if (!cur.length) return null;
    }
    return cur[0];
  };
  const t = (el, path) => q(el, path)?.textContent.trim() || "";
  const entries = [...doc.getElementsByTagNameNS("*", "Ntry")];
  if (!entries.length) throw new Error("In der XML-Datei wurden keine Kontobewegungen (camt.053) gefunden.");
  const stmt = doc.getElementsByTagNameNS("*", "Stmt")[0] || doc.getElementsByTagNameNS("*", "Ntfctn")[0] || doc.getElementsByTagNameNS("*", "Rpt")[0];
  let waehrung = "CHF";
  const rows = entries.map((e) => {
    const amt = q(e, "Amt");
    const c = parseBetrag(amt?.textContent || "");
    if (amt?.getAttribute("Ccy")) waehrung = amt.getAttribute("Ccy");
    const credit = t(e, "CdtDbtInd") === "CRDT";
    const datum = (t(e, "BookgDt/Dt") || t(e, "BookgDt/DtTm") || t(e, "ValDt/Dt")).slice(0, 10);
    const tx = q(e, "NtryDtls/TxDtls");
    const party = credit ? "Dbtr" : "Cdtr";
    const partner = tx ? (t(tx, `RltdPties/${party}/Nm`) || t(tx, `RltdPties/${party}/Pty/Nm`)) : "";
    const text = [t(e, "AddtlNtryInf"), tx ? t(tx, "RmtInf/Ustrd") : "", tx ? t(tx, "AddtlTxInf") : ""].filter(Boolean).join(" · ");
    if (!c || !/^\d{4}-\d{2}-\d{2}$/.test(datum)) return null;
    return { datum, betragCent: Math.abs(c), typ: credit ? "einnahme" : "ausgabe", text: (text || partner).slice(0, 140), partner: partner.slice(0, 80), unsicher: false };
  }).filter(Boolean);
  return { rows, waehrung, konto: { iban: t(stmt, "Acct/Id/IBAN"), bank: t(stmt, "Acct/Svcr/FinInstnId/Nm") } };
}

// ---------- e-mails (.eml, e.g. downloaded from Outlook on the web) ----------
const bytesToBin = (u8) => { let out = ""; for (let i = 0; i < u8.length; i += 0x8000) out += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return out; };
const binToBytes = (bin) => Uint8Array.from(bin, (c) => c.charCodeAt(0) & 0xff);
const b64 = (t) => { try { return atob(t.replace(/[^A-Za-z0-9+/]/g, "")); } catch (_) { return ""; } };
const qp = (t) => t.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const decodeAs = (bytes, charset) => { try { return new TextDecoder(charset || "utf-8").decode(bytes); } catch (_) { return new TextDecoder("utf-8").decode(bytes); } };

function decodeWords(v) {
  let s = String(v || "");
  if (/[\x80-\xff]/.test(s)) s = decodeAs(binToBytes(s), "utf-8");
  return s.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=(\s+(?==\?))?/g, (_, cs, e, body) =>
    decodeAs(binToBytes(e.toUpperCase() === "B" ? b64(body) : qp(body.replace(/_/g, " "))), cs.split("*")[0]));
}
function mimeParam(h, name) {
  h = String(h || "");
  const ext = new RegExp("(?:^|;)\\s*" + name + "\\*0?\\*?=\\s*(\"[^\"]*\"|[^;]+)", "i").exec(h);
  if (ext) {
    const v = ext[1].trim().replace(/^"|"$/g, ""), parts = v.split("'");
    try { return parts.length >= 3 ? decodeURIComponent(parts.slice(2).join("'")) : decodeURIComponent(v); } catch (_) { return v; }
  }
  const m = new RegExp("(?:^|;)\\s*" + name + "=\\s*(?:\"([^\"]*)\"|([^;\\s]+))", "i").exec(h);
  return m ? decodeWords(m[1] ?? m[2]) : "";
}
function splitPart(raw) {
  const m = /\r?\n\r?\n/.exec(raw);
  const head = (m ? raw.slice(0, m.index) : raw).replace(/\r?\n[ \t]+/g, " ");
  const headers = {};
  for (const line of head.split(/\r?\n/)) {
    const c = line.indexOf(":");
    if (c > 0) { const k = line.slice(0, c).trim().toLowerCase(); if (!(k in headers)) headers[k] = line.slice(c + 1).trim(); }
  }
  return { headers, body: m ? raw.slice(m.index + m[0].length) : "" };
}
function walk(part, out, depth) {
  if (depth > 8) return;
  const ct = part.headers["content-type"] || "text/plain";
  const type = ct.split(";")[0].trim().toLowerCase();
  if (type.startsWith("multipart/")) {
    const boundary = mimeParam(ct, "boundary");
    if (!boundary) return;
    for (const piece of part.body.split("--" + boundary).slice(1)) {
      if (piece.startsWith("--")) break;
      walk(splitPart(piece.replace(/^\r?\n/, "")), out, depth + 1);
    }
    return;
  }
  if (type === "message/rfc822") return walk(splitPart(part.body), out, depth + 1);
  const encd = (part.headers["content-transfer-encoding"] || "").trim().toLowerCase();
  const bin = encd === "base64" ? b64(part.body) : encd === "quoted-printable" ? qp(part.body) : part.body;
  const disp = part.headers["content-disposition"] || "";
  const name = mimeParam(disp, "filename") || mimeParam(ct, "name");
  const attachment = /^\s*attachment/i.test(disp) || !!name;
  if (type === "application/pdf" || /\.pdf$/i.test(name)) out.files.push(new File([binToBytes(bin)], name || "anhang.pdf", { type: "application/pdf" }));
  else if (/^image\/(jpeg|png|webp)$/.test(type) && bin.length > 40000) out.files.push(new File([binToBytes(bin)], name || "bild." + type.split("/")[1], { type }));
  else if (type === "text/plain" && !attachment) out.text += decodeAs(binToBytes(bin), mimeParam(ct, "charset")) + "\n";
  else if (type === "text/html" && !attachment) out.html += decodeAs(binToBytes(bin), mimeParam(ct, "charset"));
}
function htmlToText(html) {
  const marked = html.replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d)[^>]*>/gi, "$&\n").replace(/<\/t[dh]>/gi, "$&   ");
  const doc = new DOMParser().parseFromString(marked, "text/html");
  doc.querySelectorAll("style,script,head").forEach((n) => n.remove());
  return (doc.body?.textContent || "").replace(/[\t\u00a0]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}
export function readEml(u8) {
  const top = splitPart(bytesToBin(u8));
  const out = { text: "", html: "", files: [] };
  walk(top, out, 0);
  return {
    subject: decodeWords(top.headers.subject || ""), from: decodeWords(top.headers.from || ""),
    body: (out.text.trim() || htmlToText(out.html)).slice(0, 30000), files: out.files,
  };
}

// Plain text (an e-mail body) as a document with one row per line.
export function textToDoc(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return { text: lines.join("\n"), lines, rows: lines.map((l, i) => ({ page: 1, y: i * 14, items: l.split(/\s{2,}/).map((s, k) => ({ str: s, x: k * 200, w: s.length * 6 })) })) };
}

