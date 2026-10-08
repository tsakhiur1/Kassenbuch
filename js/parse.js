// Document understanding without a cloud AI: finds dates, totals, VAT, payslip lines and
// bank statement movements in the text (and, for PDFs and scans, the positions) of a document.
//
// A document is { text, lines: string[], rows: [{ page, y, items: [{ str, x, w }] }] }.

import { parseBetrag, RATES, todayIso, MONTHS_LONG, pad, fmt } from "./util.js";
import { suggest } from "./learn.js";

// ---------- low-level finders ----------

// Amounts need two decimals ("45.20", "1'234.50", "50.–") or Swiss thousands separators ("1'200"),
// so that dates, years, percentages and phone numbers are not mistaken for amounts.
const AMOUNT_RE = /(?<![\d.,'’])([-−])?((?:\d{1,3}(?:['’]\d{3})+|\d+)[.,](?:\d{2}|[-–]{1,2})|\d{1,3}(?:['’]\d{3})+)(?![.,]?\d)(-(?![\d]))?/g;

export function findAmounts(s) {
  const out = [];
  for (const m of String(s).matchAll(AMOUNT_RE)) {
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + 3);
    if (/^\s?%/.test(after)) continue;
    const v = parseBetrag(m[2]);
    if (v == null || v === 0) continue;
    out.push({ rappen: m[1] || m[3] ? -Math.abs(v) : v, index: m.index });
  }
  return out;
}

const MONTH_NAMES = {
  januar: 1, jan: 1, january: 1, februar: 2, feb: 2, february: 2, märz: 3, maerz: 3, mär: 3, mrz: 3, march: 3,
  april: 4, apr: 4, mai: 5, may: 5, juni: 6, jun: 6, june: 6, juli: 7, jul: 7, july: 7, august: 8, aug: 8,
  september: 9, sept: 9, sep: 9, oktober: 10, okt: 10, october: 10, oct: 10, november: 11, nov: 11,
  dezember: 12, dez: 12, december: 12, dec: 12,
};
const MONTH_RE = Object.keys(MONTH_NAMES).sort((a, b) => b.length - a.length).join("|");

function validDate(y, m, d) {
  if (y < 100) y += 2000;
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2000)) return null;
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  const maxIso = `${new Date().getFullYear() + 2}-12-31`;
  return iso <= maxIso ? iso : null;
}

export function findDates(s) {
  s = String(s);
  const out = [];
  const add = (index, iso) => { if (iso) out.push({ index, iso }); };
  for (const m of s.matchAll(/(?<!\d)(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4}|\d{2})(?!\d)/g)) add(m.index, validDate(+m[3], +m[2], +m[1]));
  for (const m of s.matchAll(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g)) add(m.index, validDate(+m[1], +m[2], +m[3]));
  for (const m of s.matchAll(new RegExp(`(?<!\\d)(\\d{1,2})\\.?\\s+(${MONTH_RE})\\.?\\s+(\\d{4})`, "gi"))) add(m.index, validDate(+m[3], MONTH_NAMES[m[2].toLowerCase()], +m[1]));
  for (const m of s.matchAll(/(?<!\d)(\d{1,2})\/(\d{1,2})\/(\d{4})(?!\d)/g)) add(m.index, validDate(+m[3], +m[2], +m[1]));
  return out.sort((a, b) => a.index - b.index);
}

const normIban = (s) => String(s).replace(/\s/g, "").toUpperCase();

// ---------- document type ----------

export function classify(doc) {
  const t = doc.text.toLowerCase();
  const lohn = ["lohnabrechnung", "bruttolohn", "nettolohn", "ahv", "alv", "bvg", "quellensteuer", "pensionskasse", "auszahlung", "lohnart", "salär"]
    .filter((k) => t.includes(k)).length;
  if (lohn >= 3) return "lohn";
  const movementRows = doc.rows.filter((r) => {
    const head = r.items.slice(0, 2).map((i) => i.str).join(" ");
    return findDates(head).length && findAmounts(r.items.map((i) => i.str).join(" ")).length;
  }).length;
  const statementWords = /(kontoauszug|kontobewegungen|buchungsdatum|kontostand|account statement|auszug nr|saldo)/.test(t);
  if ((statementWords && movementRows >= 3) || movementRows >= 10) return "kontoauszug";
  return "beleg";
}

// ---------- receipts and invoices ----------

const TOTAL_STRONG = /(total|endbetrag|rechnungsbetrag|zu bezahlen|zahlbetrag|amount due|grand total|totalbetrag|gesamtbetrag|zu zahlen)/i;
const TOTAL_WEAK = /(gesamt|summe|betrag)/i;
const NOT_TOTAL = /(exkl|excl|ohne mwst|zwischentotal|zwischensumme|subtotal|netto|mwst-?betrag|steuerbetrag|davon mwst|inkl\. mwst \d)/i;

function findTotal(lines) {
  const strong = [], weak = [];
  lines.forEach((l, i) => {
    // QR-bill payment part: "Währung Betrag" then "CHF 1 234.50" (space as thousands separator)
    if (/währung\s+betrag|waehrung\s+betrag|currency\s+amount/i.test(l)) {
      const m = (l + " " + (lines[i + 1] || "")).match(/\b(CHF|EUR)\s+(\d{1,3}(?: \d{3})*\.\d{2})\b/);
      if (m) strong.push({ v: parseBetrag(m[2].replace(/ /g, "")), cur: m[1] });
      return;
    }
    const isStrong = TOTAL_STRONG.test(l), isWeak = !isStrong && TOTAL_WEAK.test(l);
    if ((!isStrong && !isWeak) || NOT_TOTAL.test(l)) return;
    let a = findAmounts(l);
    if (!a.length && lines[i + 1]) a = findAmounts(lines[i + 1]);
    const cur = /\bEUR\b|€/.test(l) ? "EUR" : /\bCHF\b|Fr\./.test(l) ? "CHF" : null;
    for (const x of a) (isStrong ? strong : weak).push({ v: Math.abs(x.rappen), cur });
  });
  const pick = strong.length ? strong : weak;
  if (pick.length) return pick.reduce((a, b) => (b.v > a.v ? b : a));
  const all = lines.flatMap((l) => findAmounts(l)).map((x) => Math.abs(x.rappen)).filter((v) => v < 1e9);
  return all.length ? { v: Math.max(...all), cur: null, guessed: true } : null;
}

function findDocDate(lines) {
  const skip = /(fällig|faellig|zahlbar bis|zahlungsfrist|valuta|lieferdatum|gültig bis|geburtsdatum|due)/i;
  for (const l of lines) {
    if (/(rechnungsdatum|belegdatum|kaufdatum|datum|date|ausgestellt)/i.test(l) && !skip.test(l)) {
      const d = findDates(l)[0];
      if (d) return d.iso;
    }
  }
  for (const l of lines) {
    if (skip.test(l)) continue;
    const d = findDates(l)[0];
    if (d && d.iso <= todayIso()) return d.iso;
  }
  return null;
}

function findVatRate(text, lines) {
  const vatLines = lines.filter((l) => /(mwst|mehrwertsteuer|tva|iva|\bvat\b|\bust\b|steuersatz)/i.test(l));
  const ratesIn = (arr) => [...new Set(arr.flatMap((l) => [...l.matchAll(/(\d{1,2}[.,]\d{1,2})\s?%/g)]
    .map((m) => parseFloat(m[1].replace(",", "."))).filter((r) => RATES.includes(r) && r > 0)))];
  let rates = ratesIn(vatLines);
  if (!rates.length) rates = ratesIn([text]);
  return { rates, hasVatWord: vatLines.length > 0 };
}

function findVendor(lines, firma) {
  const f = firma?.toLowerCase();
  const top = lines.slice(0, 14).map((l) => l.trim()).filter(Boolean);
  const noise = (l) => /(rechnung|quittung|beleg|datum|seite|page|invoice|kassenbon|kunden|tel\.?\s|telefon|fax|e-?mail|www\.|https?:|mwst|uid|che-?\d|iban|^\d)/i.test(l)
    || !/[a-zäöü]{3}/i.test(l) || (f && l.toLowerCase().includes(f));
  const corp = top.find((l) => /\b(ag|gmbh|sa|sàrl|sarl|klg|ltd|inc|llc|genossenschaft)\b\.?/i.test(l) && !noise(l));
  return (corp || top.find((l) => !noise(l)) || "").replace(/\s{2,}/g, " ").slice(0, 60);
}

function findInvoiceNo(text) {
  const m = text.match(/(?:rechnungs?[-\s]?(?:nr|nummer)|beleg[-\s]?(?:nr|nummer)|invoice\s*(?:no|number|#)|rechnung\s*#|quittung\s*nr)\.?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/.]{2,24})/i);
  return m ? m[1].replace(/[.]$/, "") : "";
}

export function parseBeleg(doc, ctx) {
  const { lines, text } = doc;
  const low = text.toLowerCase();
  const warnings = [];
  const total = findTotal(lines);
  if (!total) warnings.push("Kein Betrag gefunden.");
  else if (total.guessed) warnings.push("Kein „Total“ gefunden, der grösste Betrag wurde genommen.");
  const eurCount = (text.match(/\bEUR\b|€/g) || []).length, chfCount = (text.match(/\bCHF\b|\bFr\./g) || []).length;
  const waehrung = total?.cur || (eurCount > chfCount ? "EUR" : "CHF");
  const datum = findDocDate(lines);
  if (!datum) warnings.push("Kein Datum gefunden.");

  const { rates, hasVatWord } = findVatRate(text, lines);
  let ustSatz = rates[0] ?? 0;
  if (rates.length > 1) {
    ustSatz = rates.includes(8.1) ? 8.1 : rates[0];
    warnings.push(`Mehrere MWST-Sätze (${rates.join(" %, ")} %): ${ustSatz} % gewählt, bitte prüfen.`);
  }
  if (!rates.length && !hasVatWord) warnings.push("Keine MWST auf dem Beleg gefunden, 0 % angenommen.");
  if (waehrung !== "CHF") warnings.push(`Betrag in ${waehrung}: bitte in CHF umrechnen.${ustSatz === 0 ? " Bei ausländischen Dienstleistungen die Bezugsteuer prüfen." : ""}`);

  const partner = findVendor(lines, ctx.firma);
  const ibans = (ctx.ibans || []).map(normIban).filter(Boolean);
  const textIban = normIban(text);
  const firma = (ctx.firma || "").trim().toLowerCase();
  const zahlbarAn = text.match(/(konto\s*\/\s*zahlbar an|zahlbar an|account\s*\/\s*payable to)[\s\S]{0,160}/i)?.[0]?.toLowerCase() || "";
  const typ = (ibans.some((i) => textIban.includes(i)) || (firma && zahlbarAn.includes(firma))) ? "einnahme" : "ausgabe";

  const paid = /(bezahlt|quittung|kassenbon|kartenzahlung|twint|bar bezahlt|rückgeld|rueckgeld|\bpaid\b|zahlung erhalten|visa|mastercard|maestro|debitkarte|postfinance card)/i.test(low);
  const invoice = /(zahlbar|fällig|faellig|zahlungsfrist|zahlteil|empfangsschein|einzahlungsschein|payable|due date)/i.test(low);
  const status = paid ? "bezahlt" : invoice ? "offen" : "bezahlt";

  const s = suggest(ctx.learn, { text: text.slice(0, 800), partner, typ, fallbackBereich: "geschaeft" });
  const bereich = s.bereich;
  if (bereich === "privat") ustSatz = 0;
  return {
    kind: "beleg", typ, bereich, datum, betragCent: total?.v || null, waehrung, ustSatz,
    kategorie: s.kategorie, quelle: s.quelle, partner, beleg: findInvoiceNo(text), status, notiz: "", warnings,
  };
}

// ---------- payslips ----------

const LOHN_FIELDS = [
  ["bruttolohn", /(brutto\s*lohn|bruttolohn|bruttosal[aä]r|total\s+brutto|lohn\s+brutto|bruttoeinkommen)/i],
  ["ahvIvEo", /(ahv\s*\/?\s*iv\s*\/?\s*eo|ahv-?beitrag|\bahv\b)/i],
  ["alv", /(\balv\b|arbeitslosenvers)/i],
  ["bvg", /(\bbvg\b|pensionskasse|berufliche vorsorge)/i],
  ["nbuKtg", /(\bnbu\b|nichtberufsunfall|\bktg\b|krankentaggeld|\buvg\b)/i],
  ["quellensteuer", /quellensteuer/i],
  ["nettolohn", /(netto\s*lohn|nettolohn|nettosal[aä]r|total\s+netto)/i],
  ["auszahlung", /(auszahlung|ausbezahlt|auszahlungsbetrag|überweisung|zahlbetrag)/i],
];

export function parseLohn(doc, ctx) {
  const { lines, text } = doc;
  const lohn = { monat: "", bruttolohn: 0, ahvIvEo: 0, alv: 0, bvg: 0, nbuKtg: 0, quellensteuer: 0, uebrigeAbzuege: 0, nettolohn: 0, auszahlung: 0 };
  const used = new Set();
  for (const [field, re] of LOHN_FIELDS) {
    lines.forEach((l, i) => {
      if (!re.test(l) || used.has(i)) return;
      const a = findAmounts(l);
      if (!a.length) return;
      const v = Math.abs(a[a.length - 1].rappen); // the amount column is the last number on the line
      if (field === "nbuKtg") { lohn.nbuKtg += v; used.add(i); }
      else if (!lohn[field]) { lohn[field] = v; used.add(i); }
    });
  }
  const m = text.match(new RegExp(`(${MONTH_RE})\\.?\\s+(\\d{4})`, "i"));
  if (m) lohn.monat = `${m[2]}-${pad(MONTH_NAMES[m[1].toLowerCase()])}`;
  const dates = findDates(text);
  const pay = lines.find((l) => /(auszahlung|valuta|zahltag|ausbezahlt am)/i.test(l) && findDates(l).length);
  let datum = pay ? findDates(pay)[0].iso : null;
  if (!lohn.monat && dates.length) lohn.monat = dates[0].iso.slice(0, 7);
  if (!datum && lohn.monat) {
    const [y, mo] = lohn.monat.split("-").map(Number);
    datum = `${lohn.monat}-${pad(new Date(y, mo, 0).getDate())}`;
  }
  const warnings = [];
  const abz = lohn.ahvIvEo + lohn.alv + lohn.bvg + lohn.nbuKtg + lohn.quellensteuer;
  if (!lohn.nettolohn && lohn.bruttolohn) lohn.nettolohn = lohn.bruttolohn - abz;
  const diff = lohn.bruttolohn - abz - lohn.nettolohn;
  if (lohn.bruttolohn && lohn.nettolohn && Math.abs(diff) > 100) {
    if (diff > 0) {
      lohn.uebrigeAbzuege = diff;
      warnings.push(`Weitere Abzüge von ${fmt(diff)} angenommen (z. B. Kantine oder Parkplatz), bitte prüfen.`);
    } else warnings.push("Der Nettolohn ist höher als Brutto minus Abzüge (z. B. Zulagen), bitte prüfen.");
  }
  if (!lohn.bruttolohn) warnings.push("Bruttolohn nicht gefunden.");
  if (!lohn.auszahlung && !lohn.nettolohn) warnings.push("Auszahlungsbetrag nicht gefunden.");
  const monatLabel = lohn.monat ? `${MONTHS_LONG[+lohn.monat.slice(5) - 1]} ${lohn.monat.slice(0, 4)}` : "";
  return {
    kind: "lohn", typ: "einnahme", bereich: "privat", kategorie: "Lohn", quelle: "regel", ustSatz: 0, waehrung: "CHF",
    datum, betragCent: lohn.auszahlung || lohn.nettolohn || null, partner: findVendor(lines, ctx.firma),
    beleg: "", status: "bezahlt", notiz: `Lohn ${monatLabel}`.trim(), lohn, monatLabel, warnings,
  };
}

// ---------- bank statements (PDF or scan, using the column positions) ----------

const BALANCE = /(saldo|übertrag|uebertrag|kontostand|anfangsbestand|schlussbestand|total\s+(?:belastung|gutschrift|umsatz))/i;

function nearestColumn(cols, cx) {
  let best = null, dist = Infinity;
  for (const [name, x] of Object.entries(cols)) if (Math.abs(x - cx) < dist) { dist = Math.abs(x - cx); best = name; }
  return best;
}

export function parseStatement(doc) {
  const out = [];
  let cols = null, prevSaldo = null, last = null;
  for (const row of doc.rows) {
    const line = row.items.map((i) => i.str).join(" ");
    const hdr = {};
    for (const it of row.items) {
      const s = it.str.toLowerCase(), cx = it.x + (it.w || 0) / 2;
      if (/^(belastung|lastschrift|soll|debit|ausgang|abgang|belastungen)$/.test(s)) hdr.debit = cx;
      else if (/^(gutschrift|haben|credit|eingang|zugang|gutschriften)$/.test(s)) hdr.credit = cx;
      else if (/^(saldo|kontostand|balance)$/.test(s)) hdr.saldo = cx;
      else if (/^(betrag|amount)$/.test(s)) hdr.amount = cx;
    }
    if ((hdr.debit && hdr.credit) || (hdr.amount && /datum|date/i.test(line))) { cols = hdr; continue; }

    const head = row.items.slice(0, 2).map((i) => i.str).join(" ");
    const dates = findDates(head);
    const amts = [];
    for (const it of row.items) for (const a of findAmounts(it.str)) amts.push({ ...a, cx: it.x + (it.w || 0) / 2 });
    if (dates.length && amts.length) {
      if (BALANCE.test(line) && amts.length <= 2) { prevSaldo = amts[amts.length - 1].rappen; last = null; continue; }
      let value = null, saldo = null, unsicher = false;
      if (cols) {
        for (const a of amts) {
          const col = nearestColumn(cols, a.cx);
          if (col === "debit") value = -Math.abs(a.rappen);
          else if (col === "credit") value = Math.abs(a.rappen);
          else if (col === "saldo") saldo = a.rappen;
          else if (col === "amount") value = a.rappen;
        }
      }
      if (value == null) {
        if (amts.length >= 2) saldo = amts[amts.length - 1].rappen;
        const first = amts[0].rappen;
        if (first < 0) value = first;
        else if (saldo != null && prevSaldo != null && Math.abs(Math.abs(saldo - prevSaldo) - first) <= 1) value = saldo - prevSaldo;
        else { value = -first; unsicher = true; }
      }
      if (saldo != null) prevSaldo = saldo;
      const words = row.items.map((i) => i.str).filter((s) => !findDates(s).length && !findAmounts(s).length && !/^(chf|eur)$/i.test(s.trim()));
      last = { datum: dates[0].iso, betragCent: Math.abs(value), typ: value > 0 ? "einnahme" : "ausgabe", text: words.join(" ").replace(/\s+/g, " ").trim().slice(0, 140), partner: "", unsicher, page: row.page, y: row.y };
      if (last.betragCent) out.push(last);
    } else if (last && !dates.length && !amts.length && line.trim() && row.page === last.page && Math.abs(row.y - last.y) < 40 && !BALANCE.test(line)) {
      // multi-line booking text continues below the first line
      last.text = `${last.text} ${line.trim()}`.slice(0, 140);
      last.y = row.y;
    }
  }
  return out.map(({ page, y, ...r }) => r);
}

// ---------- CSV exports from e-banking, without AI ----------

const H_DATE = /^(buchungsdatum|datum|date|booking date|abschlussdatum|transaktionsdatum|buchungstag|valuta(datum)?|value date)$/i;
const H_AMOUNT = /^(betrag|amount|betrag \(chf\)|betrag chf|umsatz|transaktionsbetrag)$/i;
const H_DEBIT = /^(belastung|lastschrift|soll|debit|ausgang|belastungen|belastung \(chf\))$/i;
const H_CREDIT = /^(gutschrift|haben|credit|eingang|gutschriften|gutschrift \(chf\))$/i;
const H_TEXT = /^(buchungstext|text|beschreibung|description|details|mitteilung|avisierungstext|verwendungszweck|zahlungszweck|booking text|transaktion)$/i;
const H_PARTNER = /^(empfänger|empfaenger|auftraggeber|zahlungsempfänger|gegenpartei|name|beguenstigter|begünstigter|counterparty|händler|haendler)$/i;
const H_SALDO = /^(saldo|kontostand|balance)$/i;

export function parseCsvRows(rows) {
  // header row: the first row naming a date column and an amount (or debit/credit) column
  let h = -1, map = null;
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const cells = rows[i].map((c) => c.trim().replace(/^"|"$/g, ""));
    const find = (re) => cells.findIndex((c) => re.test(c));
    const m = { date: find(H_DATE), amount: find(H_AMOUNT), debit: find(H_DEBIT), credit: find(H_CREDIT), saldo: find(H_SALDO), partner: find(H_PARTNER) };
    // prefer the booking date over the value date when both exist
    const booking = cells.findIndex((c) => /^(buchungsdatum|datum|date|booking date|buchungstag|abschlussdatum|transaktionsdatum)$/i.test(c));
    if (booking >= 0) m.date = booking;
    m.text = cells.map((c, k) => (H_TEXT.test(c) ? k : -1)).filter((k) => k >= 0);
    if (m.date >= 0 && (m.amount >= 0 || m.debit >= 0 || m.credit >= 0)) { h = i; map = m; break; }
  }
  if (!map) {
    map = guessColumns(rows);
    h = map ? map.headerRow : -1;
  }
  if (!map) throw new Error("In der CSV-Datei wurden keine Spalten für Datum und Betrag gefunden.");
  const out = [];
  for (const r of rows.slice(h + 1)) {
    const datum = findDates(r[map.date] || "")[0]?.iso;
    if (!datum) continue;
    let v = null;
    if (map.amount >= 0) v = parseBetrag(r[map.amount]);
    else {
      const d = map.debit >= 0 ? parseBetrag(r[map.debit]) : null, c = map.credit >= 0 ? parseBetrag(r[map.credit]) : null;
      v = c ? Math.abs(c) : d ? -Math.abs(d) : null;
    }
    if (!v) continue;
    const text = (map.text.length ? map.text : []).map((k) => (r[k] || "").trim()).filter(Boolean).join(" · ");
    const partner = map.partner >= 0 ? (r[map.partner] || "").trim() : "";
    out.push({ datum, betragCent: Math.abs(v), typ: v > 0 ? "einnahme" : "ausgabe", text: (text || partner).slice(0, 140), partner: partner.slice(0, 80), unsicher: false });
  }
  return out;
}

// No recognizable header: pick the column that is mostly dates, mostly amounts and mostly text.
function guessColumns(rows) {
  const sample = rows.slice(0, 60);
  const width = Math.max(...sample.map((r) => r.length));
  const score = (k, test) => sample.filter((r) => r[k] && test(r[k])).length;
  let date = -1, amount = -1, text = -1, best = [0, 0, 0];
  for (let k = 0; k < width; k++) {
    const d = score(k, (c) => findDates(c).length > 0), a = score(k, (c) => parseBetrag(c) != null && /[.,]\d{2}\s*$/.test(c.trim())), t = score(k, (c) => /[a-zäöü]{4}/i.test(c));
    if (d > best[0]) { best[0] = d; date = k; }
    if (a > best[1] && k !== date) { best[1] = a; amount = k; }
    if (t > best[2]) { best[2] = t; text = k; }
  }
  if (date < 0 || amount < 0 || best[0] < 2) return null;
  const headerRow = sample.findIndex((r) => findDates(r[date] || "").length) - 1;
  return { headerRow, date, amount, debit: -1, credit: -1, text: text >= 0 ? [text] : [], partner: -1 };
}

// ---------- shared: sort statement lines with the learning model ----------

export function categorizeRows(rows, learn) {
  for (const r of rows) {
    const s = suggest(learn, { text: r.text, partner: r.partner, typ: r.typ, fallbackBereich: "privat" });
    r.kategorie = s.kategorie; r.bereich = s.bereich; r.quelle = r.unsicher ? "unsicher" : s.quelle;
  }
  return rows;
}
