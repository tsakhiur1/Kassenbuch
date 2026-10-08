// Money, dates and small helpers. Amounts are kept in Rappen (integers).

const chf = new Intl.NumberFormat("de-CH", { style: "currency", currency: "CHF" });
const chf0 = new Intl.NumberFormat("de-CH", { style: "currency", currency: "CHF", maximumFractionDigits: 0 });

export const fmt = (rappen) => chf.format(rappen / 100);
export const fmt0 = (rappen) => chf0.format(rappen / 100);

export const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
export const MONTHS_LONG = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

// Current Swiss VAT rates first; the 2018–2023 rates stay bookable for older receipts.
export const RATES = [8.1, 2.6, 3.8, 0, 7.7, 2.5, 3.7];

export const pad = (n) => String(n).padStart(2, "0");
export const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayIso = () => isoOf(new Date());
export const dmy = (iso) => (iso ? iso.split("-").reverse().join(".") : "");
export const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Accepts "1'234.50", "1’234.50", "1234,50", "Fr. 50.–", "CHF 1 234", "-45.20"; returns Rappen or null.
export function parseBetrag(input) {
  let s = String(input ?? "").trim().replace(/SFr\.?|CHF|Fr\.|EUR|€/gi, "").replace(/[\s'’  ]/g, "");
  s = s.replace(/[.,][-–—]+$/, "");
  const neg = /^[-−–]/.test(s) || /-$/.test(s);
  s = s.replace(/^[-−–]/, "").replace(/-$/, "");
  if (!s) return null;
  const last = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
  if (last >= 0 && s.length - last - 1 <= 2) s = s.slice(0, last).replace(/[.,]/g, "") + "." + s.slice(last + 1);
  else s = s.replace(/[.,]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const v = Math.round(parseFloat(s) * 100);
  return neg ? -v : v;
}

export const vatOf = (brutto, rate) => (rate ? Math.round(brutto - brutto / (1 + rate / 100)) : 0);
export const nettoOf = (t) => t.betragCent - vatOf(t.betragCent, t.ustSatz || 0);

export function addMonths(iso, months, dayOfMonth) {
  const [y, m] = iso.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12), nm = total % 12;
  const last = new Date(ny, nm + 1, 0).getDate();
  return `${ny}-${pad(nm + 1)}-${pad(Math.min(dayOfMonth, last))}`;
}

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
