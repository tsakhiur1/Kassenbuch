# Kassenbuch (App für Mac und PC)

Einnahmen, Ausgaben, Lohn und MWST für eine Beratung in der Schweiz, mit eigener KI.
Die App läuft vollständig auf deinem Computer: ohne Konto, ohne Server, ohne Claude und ohne Internet.

## Was die App kann

- **Erfassen:** Lohnabrechnungen, Rechnungen, Quittungen (PDF oder Foto), Kontoauszüge (CSV, camt.053 oder PDF)
  und E-Mails (.eml) ablegen. Die eingebaute KI liest sie und schlägt die Buchung vor. Du prüfst und bestätigst.
- **Eigene KI:** Texterkennung (Tesseract, deutsch), Erkennungsregeln für Schweizer Belege (Total, MWST 8.1/2.6/3.8 %,
  QR-Rechnung, AHV/IV/EO, ALV, BVG, NBU/KTG, Quellensteuer, Kontoauszug-Spalten) und ein lernender Einordner,
  der sich jede Korrektur merkt.
- **Übersicht:** Einnahmen, Ausgaben, Gewinn bzw. Saldo, MWST-Schuld (effektiv oder Saldosteuersatz), Lohn und Abzüge,
  Budgets, getrennt nach Geschäft und Privat, pro Monat, Quartal, Semester oder Jahr.
- **Wiederkehrend:** Miete, Krankenkasse, Abos einmal anlegen, die App bucht sie an jedem Termin selbst.
- **Abgleich:** Bewegungen im Kontoauszug, die schon gebucht sind, werden erkannt. Zahlungen offener Rechnungen markieren
  die Rechnung als bezahlt.
- **Export:** CSV für Excel und Treuhand (mit KMU-Kontonummern), alle Belege als ZIP.

## Sicherheit

- Alle Daten und Belege sind mit deinem Passwort verschlüsselt (AES-256-GCM, Schlüssel aus PBKDF2-SHA256 mit 600'000 Runden)
  und liegen nur im Browser-Speicher dieses Computers.
- Die App darf keine Verbindung zu anderen Servern aufbauen (Content-Security-Policy). Dokumente verlassen den Computer nie.
- Nach 15 Minuten ohne Aktivität sperrt sie sich (einstellbar).
- **Ohne Passwort sind die Daten nicht wiederherstellbar.** Erstelle unter „Einstellungen → Datensicherung“ regelmässig
  eine Sicherung (`.kassenbuch`, ebenfalls verschlüsselt) und lege sie an einem zweiten Ort ab.

## Installieren (privat, ohne Veröffentlichung)

`python3 launcher/build-zip.py` erstellt `Kassenbuch.zip` mit der App, einer Anleitung und je einer Startdatei
für Mac (`.command`) und Windows (`.bat` mit `tools/server.ps1`). Die Startdatei stellt die App nur auf diesem
Computer unter `http://localhost:8765` bereit und öffnet den Browser. Dort lässt sie sich als App installieren
(Chrome/Edge: Symbol „Installieren“ in der Adressleiste; Safari: Ablage → Zum Dock hinzufügen).
Danach startet sie aus dem eigenen Speicher, auch ohne Startdatei und ohne Internet.

Der Port 8765 darf sich nicht ändern: Der Browser ordnet die verschlüsselten Daten dieser Adresse zu.

## Aufbau

| Datei | Aufgabe |
|---|---|
| `index.html`, `app.css` | Oberfläche |
| `js/main.js` | Seiten, Dialoge, Sperrbildschirm |
| `js/vault.js` | Verschlüsselter Speicher, Sicherung |
| `js/extract.js` | PDF, Texterkennung, CSV, camt.053, E-Mail |
| `js/parse.js` | Erkennung von Belegen, Lohnabrechnungen, Kontoauszügen |
| `js/learn.js` | Lernender Einordner |
| `js/process.js` | Ablauf vom Dokument zum Buchungsvorschlag |
| `js/recurring.js` | Wiederkehrende Buchungen |
| `sw.js`, `manifest.webmanifest` | Offline-Betrieb und Installation |
| `vendor/` | pdf.js, Tesseract.js mit deutschem Sprachmodell, JSZip (Lizenzen im Ordner) |
