'use strict';
// Prayer time calculation using the standard astronomical formulas (the same
// approach as PrayTimes.org and the Adhan libraries). Everything is computed
// in UTC and returned as real Date objects, so daylight saving is handled by
// the Windows time zone automatically.

const METHODS = {
  Egyptian: { name: 'Egyptian General Authority of Survey', ar: 'الهيئة المصرية العامة للمساحة', fajr: 19.5, isha: 17.5, adjust: { dhuhr: 1 } },
  MWL: { name: 'Muslim World League', ar: 'رابطة العالم الإسلامي', fajr: 18, isha: 17, adjust: { dhuhr: 1 } },
  UmmAlQura: { name: 'Umm al-Qura, Makkah', ar: 'أم القرى، مكة المكرمة', fajr: 18.5, ishaMinutes: 90 },
  Karachi: { name: 'University of Islamic Sciences, Karachi', ar: 'جامعة العلوم الإسلامية، كراتشي', fajr: 18, isha: 18, adjust: { dhuhr: 1 } },
  ISNA: { name: 'Islamic Society of North America', ar: 'الجمعية الإسلامية لأمريكا الشمالية', fajr: 15, isha: 15, adjust: { dhuhr: 1 } },
  Dubai: { name: 'Dubai', ar: 'دبي', fajr: 18.2, isha: 18.2, adjust: { sunrise: -3, dhuhr: 3, asr: 3, maghrib: 3 } },
  Kuwait: { name: 'Kuwait', ar: 'الكويت', fajr: 18, isha: 17.5 },
  Qatar: { name: 'Qatar', ar: 'قطر', fajr: 18, ishaMinutes: 90 },
  Gulf: { name: 'Gulf Region', ar: 'منطقة الخليج', fajr: 19.5, ishaMinutes: 90 },
  Singapore: { name: 'Singapore, Malaysia, Indonesia', ar: 'سنغافورة وماليزيا وإندونيسيا', fajr: 20, isha: 18, adjust: { dhuhr: 1 } },
  Turkey: { name: 'Diyanet, Turkey', ar: 'رئاسة الشؤون الدينية، تركيا', fajr: 18, isha: 17, adjust: { sunrise: -7, dhuhr: 5, asr: 4, maghrib: 7 } },
  Tehran: { name: 'Institute of Geophysics, Tehran', ar: 'معهد الجيوفيزياء، طهران', fajr: 17.7, isha: 14, maghribAngle: 4.5 },
  France: { name: 'UOIF, France', ar: 'اتحاد المنظمات الإسلامية بفرنسا', fajr: 12, isha: 12 },
  Russia: { name: 'Muslims of Russia', ar: 'الإدارة الدينية لمسلمي روسيا', fajr: 16, isha: 15 },
  Algeria: { name: 'Algeria', ar: 'الجزائر', fajr: 18, isha: 17 },
  Tunisia: { name: 'Tunisia', ar: 'تونس', fajr: 18, isha: 18 },
  Morocco: { name: 'Morocco', ar: 'المغرب', fajr: 19, isha: 17 },
  Jordan: { name: 'Jordan', ar: 'الأردن', fajr: 18, isha: 18 },
};

const PRAYERS = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];
const AZAN_PRAYERS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
const NAMES_AR = { fajr: 'الفجر', sunrise: 'الشروق', dhuhr: 'الظهر', asr: 'العصر', maghrib: 'المغرب', isha: 'العشاء', jumuah: 'الجمعة' };
const NAMES_EN = { fajr: 'Fajr', sunrise: 'Sunrise', dhuhr: 'Dhuhr', asr: 'Asr', maghrib: 'Maghrib', isha: 'Isha', jumuah: "Jumu'ah" };
const HIJRI_MONTHS = ['محرم', 'صفر', 'ربيع الأول', 'ربيع الآخر', 'جمادى الأولى', 'جمادى الآخرة', 'رجب', 'شعبان', 'رمضان', 'شوال', 'ذو القعدة', 'ذو الحجة'];

// --- trigonometry in degrees ---
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const sin = (d) => Math.sin(rad(d));
const cos = (d) => Math.cos(rad(d));
const tan = (d) => Math.tan(rad(d));
const arcsin = (x) => deg(Math.asin(x));
const arccos = (x) => deg(Math.acos(x));
const arctan2 = (y, x) => deg(Math.atan2(y, x));
const arccot = (x) => deg(Math.atan(1 / x));
const fix = (a, b) => { const r = a - b * Math.floor(a / b); return r < 0 ? r + b : r; };
const fixAngle = (a) => fix(a, 360);
const fixHour = (a) => fix(a, 24);

function julian(year, month, day) {
  if (month <= 2) { year -= 1; month += 12; }
  const A = Math.floor(year / 100);
  const B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (year + 4716)) + Math.floor(30.6001 * (month + 1)) + day + B - 1524.5;
}

function sunPosition(jd) {
  const D = jd - 2451545.0;
  const g = fixAngle(357.529 + 0.98560028 * D);
  const q = fixAngle(280.459 + 0.98564736 * D);
  const L = fixAngle(q + 1.915 * sin(g) + 0.020 * sin(2 * g));
  const e = 23.439 - 0.00000036 * D;
  const RA = arctan2(cos(e) * sin(L), cos(L)) / 15;
  return { decl: arcsin(sin(e) * sin(L)), eqt: q / 15 - fixHour(RA) };
}

/**
 * Raw prayer times for one calendar day, as hours of "local solar time".
 */
function solarTimes(y, m, d, lat, lon, method, asrFactor, highLat) {
  const jDate = julian(y, m, d) - lon / (15 * 24);
  const midDay = (t) => fixHour(12 - sunPosition(jDate + t).eqt);
  const sunAngleTime = (angle, t, beforeNoon) => {
    const decl = sunPosition(jDate + t).decl;
    const v = (-sin(angle) - sin(decl) * sin(lat)) / (cos(decl) * cos(lat));
    if (v < -1 || v > 1) return NaN; // the sun never reaches this angle today
    const h = arccos(v) / 15;
    return midDay(t) + (beforeNoon ? -h : h);
  };
  const asrTime = (factor, t) => {
    const decl = sunPosition(jDate + t).decl;
    return sunAngleTime(-arccot(factor + tan(Math.abs(lat - decl))), t, false);
  };

  const guess = { fajr: 5, sunrise: 6, dhuhr: 12, asr: 13, sunset: 18, maghrib: 18, isha: 18 };
  let t = { ...guess };
  for (let i = 0; i < 2; i++) {
    const p = {};
    for (const k of Object.keys(t)) p[k] = (Number.isFinite(t[k]) ? t[k] : guess[k]) / 24;
    t = {
      fajr: sunAngleTime(method.fajr, p.fajr, true),
      sunrise: sunAngleTime(0.833, p.sunrise, true),
      dhuhr: midDay(p.dhuhr),
      asr: asrTime(asrFactor, p.asr),
      sunset: sunAngleTime(0.833, p.sunset, false),
      maghrib: sunAngleTime(method.maghribAngle || 0.833, p.maghrib, false),
      isha: method.isha ? sunAngleTime(method.isha, p.isha, false) : NaN,
    };
  }

  // High latitudes: Fajr/Isha may not exist or be unreasonably far from sunrise/sunset.
  const night = fixHour(t.sunrise - t.sunset);
  const portion = (angle) => {
    if (highLat === 'SeventhOfTheNight') return night / 7;
    if (highLat === 'MiddleOfTheNight') return night / 2;
    return (night * angle) / 60; // TwilightAngle (default, same as Aladhan)
  };
  if (Number.isFinite(t.sunrise) && Number.isFinite(t.sunset)) {
    const fp = portion(method.fajr);
    if (!Number.isFinite(t.fajr) || fixHour(t.sunrise - t.fajr) > fp) t.fajr = t.sunrise - fp;
    if (method.isha) {
      const ip = portion(method.isha);
      if (!Number.isFinite(t.isha) || fixHour(t.isha - t.sunset) > ip) t.isha = t.sunset + ip;
    }
    if (method.maghribAngle) {
      const mp = portion(method.maghribAngle);
      if (!Number.isFinite(t.maghrib) || fixHour(t.maghrib - t.sunset) > mp) t.maghrib = t.sunset + mp;
    }
  }
  return t;
}

/**
 * Prayer times for the calendar day that contains `day` (local time).
 * @returns {{fajr: Date, sunrise: Date, dhuhr: Date, asr: Date, maghrib: Date, isha: Date, sunset: Date}}
 */
function computeTimes(day, opts) {
  const method = METHODS[opts.method] || METHODS.Egyptian;
  const asrFactor = opts.asr === 'Hanafi' ? 2 : 1;
  const y = day.getFullYear();
  const m = day.getMonth() + 1;
  const d = day.getDate();
  const t = solarTimes(y, m, d, opts.lat, opts.lon, method, asrFactor, opts.highLat);

  if (method.ishaMinutes) {
    const ramadanExtra = method === METHODS.UmmAlQura && opts.ramadan ? 30 : 0;
    t.isha = t.maghrib + (method.ishaMinutes + ramadanExtra) / 60;
  }

  const base = Date.UTC(y, m - 1, d);
  const out = {};
  for (const key of [...PRAYERS, 'sunset']) {
    const minutes = ((method.adjust && method.adjust[key]) || 0) + ((opts.adjust && opts.adjust[key]) || 0);
    const utcHours = t[key] - opts.lon / 15;
    const ms = base + utcHours * 3600e3 + minutes * 60e3;
    // Round to the nearest minute, like mosque timetables do.
    out[key] = new Date(Math.round(ms / 60e3) * 60e3);
  }
  return out;
}

function hijriDate(date, offsetDays = 0) {
  const shifted = new Date(date.getTime() + offsetDays * 86400e3);
  try {
    const parts = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', {
      day: 'numeric', month: 'numeric', year: 'numeric',
    }).formatToParts(shifted);
    const get = (type) => parseInt((parts.find((p) => p.type === type) || {}).value, 10);
    const day = get('day');
    const month = get('month');
    const year = get('year') || get('relatedYear');
    if (!day || !month || !year) return null;
    return { day, month, year, monthName: HIJRI_MONTHS[month - 1], text: `${day} ${HIJRI_MONTHS[month - 1]} ${year}` };
  } catch {
    return null;
  }
}

/**
 * Everything the UI needs: today's list, the next prayer and the Hijri date.
 */
function getDaySchedule(now, opts) {
  const hijri = hijriDate(now, opts.hijriOffset || 0);
  const ramadan = !!hijri && hijri.month === 9;
  const today = computeTimes(now, { ...opts, ramadan });
  const tomorrowDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12);
  const tomorrow = computeTimes(tomorrowDay, { ...opts, ramadan });
  const isFriday = now.getDay() === 5;

  const list = PRAYERS.map((key) => ({
    key,
    name: key === 'dhuhr' && isFriday ? NAMES_AR.jumuah : NAMES_AR[key],
    nameEn: key === 'dhuhr' && isFriday ? NAMES_EN.jumuah : NAMES_EN[key],
    time: today[key].getTime(),
    azan: AZAN_PRAYERS.includes(key),
  }));

  let next = list.find((p) => p.time > now.getTime());
  if (!next) {
    next = { key: 'fajr', name: NAMES_AR.fajr, nameEn: NAMES_EN.fajr, time: tomorrow.fajr.getTime(), azan: true, tomorrow: true };
  }
  const method = METHODS[opts.method] || METHODS.Egyptian;
  return {
    list,
    next,
    tomorrowFajr: tomorrow.fajr.getTime(),
    hijri,
    method: { id: opts.method, name: method.name, ar: method.ar },
    computedAt: now.getTime(),
  };
}

/** Upcoming azan events (today + tomorrow) for the scheduler. */
function upcomingAzans(now, opts) {
  const hijri = hijriDate(now, opts.hijriOffset || 0);
  const ramadan = !!hijri && hijri.month === 9;
  const events = [];
  for (let offset = 0; offset <= 1; offset++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 12);
    const times = computeTimes(day, { ...opts, ramadan });
    const isFriday = day.getDay() === 5;
    for (const key of AZAN_PRAYERS) {
      events.push({
        key,
        name: key === 'dhuhr' && isFriday ? NAMES_AR.jumuah : NAMES_AR[key],
        nameEn: key === 'dhuhr' && isFriday ? NAMES_EN.jumuah : NAMES_EN[key],
        time: times[key].getTime(),
        dayKey: `${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}`,
      });
    }
  }
  return events.filter((e) => e.time > now.getTime() - 60e3).sort((a, b) => a.time - b.time);
}

module.exports = { METHODS, PRAYERS, AZAN_PRAYERS, NAMES_AR, NAMES_EN, computeTimes, hijriDate, getDaySchedule, upcomingAzans };
