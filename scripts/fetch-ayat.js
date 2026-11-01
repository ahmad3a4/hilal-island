// Builds assets/data/ayat.json from the verified Tanzil Uthmani text (served by api.alquran.cloud).
// Only verse references live in this file; the Quran text itself is always downloaded,
// never typed by hand.
//
// Usage: node scripts/fetch-ayat.js
const fs = require('fs');
const path = require('path');

const REFS = [
  '2:152', '2:186', '2:153', '2:45', '2:156', '2:201', '2:250',
  '3:8', '3:16', '3:139', '3:173', '3:200',
  '4:28', '4:110', '4:147',
  '6:162',
  '7:23', '7:56', '7:205',
  '9:51', '9:129',
  '10:62',
  '11:6',
  '12:64', '12:86', '12:87',
  '13:28',
  '14:7', '14:40', '14:41',
  '15:49', '15:98-99',
  '16:18', '16:97', '16:128',
  '17:24', '17:80',
  '18:10', '18:46',
  '20:25-28', '20:46', '20:114',
  '21:35', '21:83', '21:87', '21:89',
  '23:118',
  '25:65', '25:74',
  '26:62', '26:83',
  '27:62',
  '28:24',
  '29:45', '29:69',
  '33:41-42', '33:56',
  '37:180-182',
  '39:10', '39:53',
  '40:44',
  '42:19',
  '47:7',
  '50:16',
  '52:48',
  '55:13', '55:26-27',
  '56:74',
  '59:22',
  '64:11',
  '65:3',
  '71:10-12',
  '73:8',
  '76:25',
  '87:14-15',
  '93:3', '93:5',
  '94:5-6', '94:7-8',
  '112:1-4',
];

const TASHKEEL = /[ؐ-ًؚ-ٰٟۖ-ۭ]/g;
const plainSurahName = (name) => name.replace(TASHKEEL, '').replace(/^سورة\s+/, '').trim();

(async () => {
  const url = 'https://api.alquran.cloud/v1/quran/quran-uthmani';
  console.log(`Downloading ${url} ...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { data } = await res.json();
  const surahs = new Map(data.surahs.map((s) => [s.number, s]));
  const stripBom = (t) => t.replace(/^﻿/, '');
  const basmala = stripBom(surahs.get(1).ayahs[0].text); // Al-Fatiha 1:1

  const items = REFS.map((ref) => {
    const [s, range] = ref.split(':');
    const [from, to = from] = range.split('-').map(Number);
    const surah = surahs.get(Number(s));
    const verses = [];
    for (let n = from; n <= to; n++) {
      const ayah = surah.ayahs.find((a) => a.numberInSurah === n);
      if (!ayah) throw new Error(`Missing ${s}:${n}`);
      let text = stripBom(ayah.text);
      // The API prefixes the first verse of each surah with the basmala; it is not part of the verse.
      if (n === 1 && Number(s) !== 1 && text.startsWith(basmala)) text = text.slice(basmala.length).trim();
      verses.push({ n, text: text.trim() });
    }
    return { id: ref, surah: Number(s), surahName: plainSurahName(surah.name), from, to, verses };
  });

  const out = {
    source: 'Tanzil Quran Text (Uthmani), https://tanzil.net - via api.alquran.cloud. Verbatim, unmodified.',
    notice: [
      'Tanzil Quran Text (Uthmani). Copyright (C) Tanzil Project. License: Creative Commons Attribution 3.0.',
      'This copy of the Quran text is carefully produced, highly verified and continuously monitored by a group of specialists at Tanzil Project.',
      'TERMS OF USE: Permission is granted to copy and distribute verbatim copies of this text, but CHANGING IT IS NOT ALLOWED.',
      'This Quran text can be used in any website or application, provided that its source (Tanzil Project) is clearly indicated, and a link is made to tanzil.net to enable users to keep track of changes.',
      'This copyright notice shall be included in all verbatim copies of the text, and shall be reproduced appropriately in all files derived from or containing substantial portion of this text.',
      'Please check updates at: https://tanzil.net/updates/',
    ],
    items,
  };
  const file = path.resolve(__dirname, '..', 'assets', 'data', 'ayat.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 1), 'utf8');
  const lengths = items.map((i) => ({ id: i.id, len: i.verses.map((v) => v.text.replace(TASHKEEL, '')).join(' ').length }));
  console.log(`Saved ${items.length} entries to ${path.relative(process.cwd(), file)}`);
  console.log('Longest:', lengths.sort((a, b) => b.len - a.len).slice(0, 6).map((l) => `${l.id}=${l.len}`).join(', '));
})().catch((e) => { console.error(e); process.exit(1); });
