'use strict';
// Cities for the location picker. Coordinates are city centers (accurate to well
// under a minute of prayer time). `method` is the usual calculation method there.

const C = (name, ar, country, lat, lon, method) => ({ id: `${country}-${name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, ar, country, lat, lon, method });

const CITIES = [
  // Egypt
  C('Cairo', 'القاهرة', 'EG', 30.0444, 31.2357, 'Egyptian'),
  C('Giza', 'الجيزة', 'EG', 30.0131, 31.2089, 'Egyptian'),
  C('6th of October', 'السادس من أكتوبر', 'EG', 29.9285, 30.9188, 'Egyptian'),
  C('Shubra El Kheima', 'شبرا الخيمة', 'EG', 30.1286, 31.2422, 'Egyptian'),
  C('Alexandria', 'الإسكندرية', 'EG', 31.2001, 29.9187, 'Egyptian'),
  C('Port Said', 'بورسعيد', 'EG', 31.2653, 32.3019, 'Egyptian'),
  C('Suez', 'السويس', 'EG', 29.9668, 32.5498, 'Egyptian'),
  C('Ismailia', 'الإسماعيلية', 'EG', 30.5965, 32.2715, 'Egyptian'),
  C('Damietta', 'دمياط', 'EG', 31.4175, 31.8144, 'Egyptian'),
  C('Mansoura', 'المنصورة', 'EG', 31.0409, 31.3785, 'Egyptian'),
  C('Tanta', 'طنطا', 'EG', 30.7865, 31.0004, 'Egyptian'),
  C('Zagazig', 'الزقازيق', 'EG', 30.5877, 31.502, 'Egyptian'),
  C('Banha', 'بنها', 'EG', 30.466, 31.1848, 'Egyptian'),
  C('Shibin El Kom', 'شبين الكوم', 'EG', 30.5527, 31.009, 'Egyptian'),
  C('Kafr El Sheikh', 'كفر الشيخ', 'EG', 31.1107, 30.9388, 'Egyptian'),
  C('Damanhur', 'دمنهور', 'EG', 31.0341, 30.4682, 'Egyptian'),
  C('Faiyum', 'الفيوم', 'EG', 29.3084, 30.8428, 'Egyptian'),
  C('Beni Suef', 'بني سويف', 'EG', 29.0661, 31.0994, 'Egyptian'),
  C('Minya', 'المنيا', 'EG', 28.1099, 30.7503, 'Egyptian'),
  C('Asyut', 'أسيوط', 'EG', 27.1783, 31.1859, 'Egyptian'),
  C('Sohag', 'سوهاج', 'EG', 26.5591, 31.6957, 'Egyptian'),
  C('Qena', 'قنا', 'EG', 26.1551, 32.716, 'Egyptian'),
  C('Luxor', 'الأقصر', 'EG', 25.6872, 32.6396, 'Egyptian'),
  C('Aswan', 'أسوان', 'EG', 24.0889, 32.8998, 'Egyptian'),
  C('Hurghada', 'الغردقة', 'EG', 27.2579, 33.8116, 'Egyptian'),
  C('Sharm El Sheikh', 'شرم الشيخ', 'EG', 27.9158, 34.33, 'Egyptian'),
  C('Marsa Matruh', 'مرسى مطروح', 'EG', 31.3543, 27.2373, 'Egyptian'),
  C('Arish', 'العريش', 'EG', 31.1316, 33.7984, 'Egyptian'),
  // Saudi Arabia & Gulf
  C('Makkah', 'مكة المكرمة', 'SA', 21.4225, 39.8262, 'UmmAlQura'),
  C('Madinah', 'المدينة المنورة', 'SA', 24.4672, 39.6111, 'UmmAlQura'),
  C('Riyadh', 'الرياض', 'SA', 24.7136, 46.6753, 'UmmAlQura'),
  C('Jeddah', 'جدة', 'SA', 21.4858, 39.1925, 'UmmAlQura'),
  C('Dammam', 'الدمام', 'SA', 26.4207, 50.0888, 'UmmAlQura'),
  C('Taif', 'الطائف', 'SA', 21.2703, 40.4158, 'UmmAlQura'),
  C('Abha', 'أبها', 'SA', 18.2164, 42.5053, 'UmmAlQura'),
  C('Tabuk', 'تبوك', 'SA', 28.3835, 36.5662, 'UmmAlQura'),
  C('Dubai', 'دبي', 'AE', 25.2048, 55.2708, 'Dubai'),
  C('Abu Dhabi', 'أبوظبي', 'AE', 24.4539, 54.3773, 'Dubai'),
  C('Sharjah', 'الشارقة', 'AE', 25.3463, 55.4209, 'Dubai'),
  C('Kuwait City', 'مدينة الكويت', 'KW', 29.3759, 47.9774, 'Kuwait'),
  C('Doha', 'الدوحة', 'QA', 25.2854, 51.531, 'Qatar'),
  C('Manama', 'المنامة', 'BH', 26.2285, 50.586, 'Gulf'),
  C('Muscat', 'مسقط', 'OM', 23.588, 58.3829, 'Gulf'),
  // Levant, Iraq, Yemen
  C('Amman', 'عمّان', 'JO', 31.9454, 35.9284, 'Jordan'),
  C('Jerusalem', 'القدس', 'PS', 31.7683, 35.2137, 'Jordan'),
  C('Gaza', 'غزة', 'PS', 31.5017, 34.4668, 'Egyptian'),
  C('Beirut', 'بيروت', 'LB', 33.8938, 35.5018, 'MWL'),
  C('Damascus', 'دمشق', 'SY', 33.5138, 36.2765, 'MWL'),
  C('Aleppo', 'حلب', 'SY', 36.2021, 37.1343, 'MWL'),
  C('Baghdad', 'بغداد', 'IQ', 33.3152, 44.3661, 'MWL'),
  C('Basra', 'البصرة', 'IQ', 30.5085, 47.7804, 'MWL'),
  C('Erbil', 'أربيل', 'IQ', 36.1911, 44.0092, 'MWL'),
  C("Sana'a", 'صنعاء', 'YE', 15.3694, 44.191, 'UmmAlQura'),
  C('Aden', 'عدن', 'YE', 12.7855, 45.0187, 'UmmAlQura'),
  // North & East Africa
  C('Khartoum', 'الخرطوم', 'SD', 15.5007, 32.5599, 'Egyptian'),
  C('Tripoli', 'طرابلس', 'LY', 32.8872, 13.1913, 'Egyptian'),
  C('Benghazi', 'بنغازي', 'LY', 32.1194, 20.0868, 'Egyptian'),
  C('Tunis', 'تونس', 'TN', 36.8065, 10.1815, 'Tunisia'),
  C('Algiers', 'الجزائر', 'DZ', 36.7538, 3.0588, 'Algeria'),
  C('Oran', 'وهران', 'DZ', 35.6971, -0.6308, 'Algeria'),
  C('Casablanca', 'الدار البيضاء', 'MA', 33.5731, -7.5898, 'Morocco'),
  C('Rabat', 'الرباط', 'MA', 34.0209, -6.8416, 'Morocco'),
  C('Marrakesh', 'مراكش', 'MA', 31.6295, -7.9811, 'Morocco'),
  C('Fes', 'فاس', 'MA', 34.0181, -5.0078, 'Morocco'),
  C('Nouakchott', 'نواكشوط', 'MR', 18.0735, -15.9582, 'MWL'),
  C('Mogadishu', 'مقديشو', 'SO', 2.0469, 45.3182, 'MWL'),
  C('Nairobi', 'نيروبي', 'KE', -1.2921, 36.8219, 'MWL'),
  C('Lagos', 'لاغوس', 'NG', 6.5244, 3.3792, 'MWL'),
  C('Kano', 'كانو', 'NG', 12.0022, 8.592, 'MWL'),
  C('Dakar', 'داكار', 'SN', 14.7167, -17.4677, 'MWL'),
  C('Johannesburg', 'جوهانسبرغ', 'ZA', -26.2041, 28.0473, 'MWL'),
  C('Cape Town', 'كيب تاون', 'ZA', -33.9249, 18.4241, 'MWL'),
  // Turkey, Iran, South & Southeast Asia
  C('Istanbul', 'إسطنبول', 'TR', 41.0082, 28.9784, 'Turkey'),
  C('Ankara', 'أنقرة', 'TR', 39.9334, 32.8597, 'Turkey'),
  C('Tehran', 'طهران', 'IR', 35.6892, 51.389, 'Tehran'),
  C('Karachi', 'كراتشي', 'PK', 24.8607, 67.0011, 'Karachi'),
  C('Lahore', 'لاهور', 'PK', 31.5204, 74.3587, 'Karachi'),
  C('Islamabad', 'إسلام آباد', 'PK', 33.6844, 73.0479, 'Karachi'),
  C('Kabul', 'كابل', 'AF', 34.5553, 69.2075, 'Karachi'),
  C('Delhi', 'دلهي', 'IN', 28.6139, 77.209, 'Karachi'),
  C('Mumbai', 'مومباي', 'IN', 19.076, 72.8777, 'Karachi'),
  C('Hyderabad', 'حيدر آباد', 'IN', 17.385, 78.4867, 'Karachi'),
  C('Dhaka', 'دكا', 'BD', 23.8103, 90.4125, 'Karachi'),
  C('Kuala Lumpur', 'كوالالمبور', 'MY', 3.139, 101.6869, 'Singapore'),
  C('Singapore', 'سنغافورة', 'SG', 1.3521, 103.8198, 'Singapore'),
  C('Jakarta', 'جاكرتا', 'ID', -6.2088, 106.8456, 'Singapore'),
  // Europe
  C('London', 'لندن', 'GB', 51.5074, -0.1278, 'MWL'),
  C('Birmingham', 'برمنغهام', 'GB', 52.4862, -1.8904, 'MWL'),
  C('Manchester', 'مانشستر', 'GB', 53.4808, -2.2426, 'MWL'),
  C('Paris', 'باريس', 'FR', 48.8566, 2.3522, 'MWL'),
  C('Marseille', 'مرسيليا', 'FR', 43.2965, 5.3698, 'MWL'),
  C('Berlin', 'برلين', 'DE', 52.52, 13.405, 'MWL'),
  C('Munich', 'ميونخ', 'DE', 48.1351, 11.582, 'MWL'),
  C('Amsterdam', 'أمستردام', 'NL', 52.3676, 4.9041, 'MWL'),
  C('Brussels', 'بروكسل', 'BE', 50.8503, 4.3517, 'MWL'),
  C('Vienna', 'فيينا', 'AT', 48.2082, 16.3738, 'MWL'),
  C('Rome', 'روما', 'IT', 41.9028, 12.4964, 'MWL'),
  C('Madrid', 'مدريد', 'ES', 40.4168, -3.7038, 'MWL'),
  C('Stockholm', 'ستوكهولم', 'SE', 59.3293, 18.0686, 'MWL'),
  C('Oslo', 'أوسلو', 'NO', 59.9139, 10.7522, 'MWL'),
  C('Copenhagen', 'كوبنهاغن', 'DK', 55.6761, 12.5683, 'MWL'),
  C('Moscow', 'موسكو', 'RU', 55.7558, 37.6173, 'Russia'),
  // Americas & Oceania
  C('New York', 'نيويورك', 'US', 40.7128, -74.006, 'ISNA'),
  C('Chicago', 'شيكاغو', 'US', 41.8781, -87.6298, 'ISNA'),
  C('Dearborn', 'ديربورن', 'US', 42.3223, -83.1763, 'ISNA'),
  C('Houston', 'هيوستن', 'US', 29.7604, -95.3698, 'ISNA'),
  C('Los Angeles', 'لوس أنجلوس', 'US', 34.0522, -118.2437, 'ISNA'),
  C('Toronto', 'تورونتو', 'CA', 43.6532, -79.3832, 'ISNA'),
  C('Montreal', 'مونتريال', 'CA', 45.5017, -73.5673, 'ISNA'),
  C('Sydney', 'سيدني', 'AU', -33.8688, 151.2093, 'MWL'),
  C('Melbourne', 'ملبورن', 'AU', -37.8136, 144.9631, 'MWL'),
];

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function nearestCity(lat, lon) {
  let best = null;
  for (const c of CITIES) {
    const d = haversineKm({ lat, lon }, c);
    if (!best || d < best.distanceKm) best = { ...c, distanceKm: d };
  }
  return best;
}

module.exports = { CITIES, nearestCity };
