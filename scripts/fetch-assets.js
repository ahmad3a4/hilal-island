// Downloads the free fonts and azan recordings used by the app.
// Usage: node scripts/fetch-assets.js   (skips files that already exist)
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const UA = { 'User-Agent': 'Hilal/1.0 (desktop app; https://github.com/ahmad3a4/hilal-island)' };
const GF = 'https://raw.githubusercontent.com/google/fonts/main/ofl';

const FILES = [
  // Fonts (SIL Open Font License)
  [`${GF}/amiriquran/AmiriQuran-Regular.ttf`, 'assets/fonts/AmiriQuran-Regular.ttf'],
  [`${GF}/amiriquran/OFL.txt`, 'assets/fonts/AmiriQuran-OFL.txt'],
  [`${GF}/ibmplexsansarabic/IBMPlexSansArabic-Regular.ttf`, 'assets/fonts/IBMPlexSansArabic-Regular.ttf'],
  [`${GF}/ibmplexsansarabic/IBMPlexSansArabic-Medium.ttf`, 'assets/fonts/IBMPlexSansArabic-Medium.ttf'],
  [`${GF}/ibmplexsansarabic/IBMPlexSansArabic-SemiBold.ttf`, 'assets/fonts/IBMPlexSansArabic-SemiBold.ttf'],
  [`${GF}/ibmplexsansarabic/IBMPlexSansArabic-Bold.ttf`, 'assets/fonts/IBMPlexSansArabic-Bold.ttf'],
  [`${GF}/ibmplexsansarabic/OFL.txt`, 'assets/fonts/IBMPlexSansArabic-OFL.txt'],
  // Azan recordings from Wikimedia Commons (licenses in assets/audio/CREDITS.md)
  ['https://upload.wikimedia.org/wikipedia/commons/b/b0/Beautiful_adhan.ogg', 'assets/audio/azan-1.ogg'],
  ['https://upload.wikimedia.org/wikipedia/commons/8/86/Azan.ogg', 'assets/audio/azan-2.ogg'],
  ['https://upload.wikimedia.org/wikipedia/commons/7/7d/The_Adhan_-_Muslim_Call_to_Prayer_-_Aaqib_Azeez.mp3', 'assets/audio/azan-3.mp3'],
];

(async () => {
  for (const [url, rel] of FILES) {
    const dest = path.join(root, rel);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) { console.log(`ok    ${rel}`); continue; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const res = await fetch(url, { headers: UA });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    console.log(`saved ${rel} (${Math.round(buf.length / 1024)} KB)`);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
