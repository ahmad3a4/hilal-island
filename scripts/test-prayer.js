// Compares our prayer-time calculation with the public Aladhan API.
// Usage: node scripts/test-prayer.js
const { computeTimes, hijriDate } = require('../src/main/prayer');

const cases = [
  { name: 'Giza', lat: 30.0131, lon: 31.2089, tz: 'Africa/Cairo', method: 'Egyptian', aladhan: 5 },
  { name: 'Makkah', lat: 21.4225, lon: 39.8262, tz: 'Asia/Riyadh', method: 'UmmAlQura', aladhan: 4 },
  { name: 'London', lat: 51.5074, lon: -0.1278, tz: 'Europe/London', method: 'MWL', aladhan: 3 },
  { name: 'New York', lat: 40.7128, lon: -74.006, tz: 'America/New_York', method: 'ISNA', aladhan: 2 },
  { name: 'Karachi', lat: 24.8607, lon: 67.0011, tz: 'Asia/Karachi', method: 'Karachi', aladhan: 1 },
  { name: 'Kuala Lumpur', lat: 3.139, lon: 101.6869, tz: 'Asia/Kuala_Lumpur', method: 'Singapore', aladhan: 11 },
];
const dates = [new Date(2026, 10, 2, 12), new Date(2026, 5, 21, 12)];
const keys = [['fajr', 'Fajr'], ['sunrise', 'Sunrise'], ['dhuhr', 'Dhuhr'], ['asr', 'Asr'], ['maghrib', 'Maghrib'], ['isha', 'Isha']];

const toMinutes = (hhmm) => { const [h, m] = hhmm.slice(0, 5).split(':').map(Number); return h * 60 + m; };
const localHHMM = (date, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);

(async () => {
  let worst = 0;
  for (const day of dates) {
    const ds = `${String(day.getDate()).padStart(2, '0')}-${String(day.getMonth() + 1).padStart(2, '0')}-${day.getFullYear()}`;
    for (const c of cases) {
      const url = `https://api.aladhan.com/v1/timings/${ds}?latitude=${c.lat}&longitude=${c.lon}&method=${c.aladhan}&timezonestring=${encodeURIComponent(c.tz)}`;
      const res = await fetch(url);
      const ref = (await res.json()).data.timings;
      const ours = computeTimes(day, { lat: c.lat, lon: c.lon, method: c.method, asr: 'Standard', highLat: 'TwilightAngle' });
      const row = keys.map(([k, K]) => {
        const mine = localHHMM(ours[k], c.tz);
        const diff = toMinutes(mine) - toMinutes(ref[K]);
        worst = Math.max(worst, Math.abs(diff));
        return `${K} ${mine}${diff ? ` (${diff > 0 ? '+' : ''}${diff})` : ''}`;
      });
      console.log(`${ds} ${c.name.padEnd(12)} ${row.join('  ')}`);
    }
  }
  console.log(`\nLargest difference vs Aladhan: ${worst} min (Aladhan applies no Dhuhr offsets, some methods add +1..+5 min on purpose)`);
  console.log('Hijri today:', hijriDate(new Date()));
  console.log('Hijri 2026-10-29:', hijriDate(new Date(2026, 9, 29, 12)));
})().catch((e) => { console.error(e); process.exit(1); });

