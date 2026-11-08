# Microsoft Store listing

Copy these into Partner Center → Store listings. English first, then Arabic.

## English (en-us)

**Product name:** Hilal

**Short description (max 270 characters):**
A Dynamic Island for Windows. Music, downloads, volume, FPS, battery levels and prayer times in one small island at the top of your screen.

**Description:**
Hilal puts a small, smooth island at the top of your screen, like the Dynamic Island on a phone. It shows what's happening right now and gets out of the way when you don't need it.

• Music: see what's playing in Spotify, YouTube or any player, with play, pause, skip and a progress bar.
• Downloads: copy a link and download it from the island, with speed and progress.
• Sound: a volume pop-up, a mixer for each app, scroll on the island to change the volume, and screen brightness.
• Microphone: mute with a shortcut you choose, with a small red mic over games while you're muted.
• Games: an FPS counter in the corner or inside the island, and how long you play each game.
• System: CPU, GPU, memory, network and disk at a glance.
• Bluetooth: battery levels of your earbuds and controllers, with a warning when they're low.
• Keyboard: a short pop-up when you switch typing language or turn on Caps Lock.
• Prayer times: accurate times for your city, the azan with your choice of voice, music paused for the azan, and short azkar and Quran verses during the day.

Hilal works offline, has no account and no ads, and sends nothing about you anywhere. It's free and open source.

**What's new in this version:**
Hilal 1.3.0: a pop-up for the keyboard language (Arabic, English and others) and Caps Lock.

**Features (one per line):**
Music controls for any player
Download links from the island
Volume pop-up and per-app sound mixer
Microphone mute shortcut
FPS counter for games
Play-time tracker
CPU, GPU, memory and network monitor
Bluetooth battery levels
Keyboard language and Caps Lock pop-ups
Prayer times, azan and azkar

**Search terms (max 7):** dynamic island, music widget, fps counter, volume mixer, prayer times, azan, battery

**Copyright:** Copyright (c) 2026 Ahmad

**Privacy policy URL:** https://github.com/ahmad3a4/hilal-island/blob/main/PRIVACY.md

**Website:** https://github.com/ahmad3a4/hilal-island

**Support contact:** https://github.com/ahmad3a4/hilal-island/issues

**Screenshots:** the images in `docs/screenshots/`.

## Arabic (ar-sa)

**اسم المنتج:** Hilal

**وصف قصير:**
جزيرة ديناميكية لويندوز: الموسيقى والتنزيلات والصوت وعدّاد الإطارات وبطاريات الأجهزة ومواقيت الصلاة في جزيرةٍ صغيرة أعلى الشاشة.

**الوصف:**
يضع هلال جزيرةً صغيرة وسلسة أعلى شاشتك، مثل الجزيرة الديناميكية في الهاتف. تعرض ما يحدث الآن، وتبتعد عن طريقك حين لا تحتاجها.

• الموسيقى: ما يُشغَّل الآن في Spotify أو YouTube أو أي مشغّل، مع التشغيل والإيقاف والتخطي وشريط التقدّم.
• التنزيلات: انسخ رابطاً ونزّله من الجزيرة، مع السرعة والتقدّم.
• الصوت: نافذة لمستوى الصوت، ومازج صوت لكل تطبيق، وتغيير الصوت بالتمرير على الجزيرة، وسطوع الشاشة.
• الميكروفون: كتم الصوت باختصارٍ تختاره، مع ميكروفون أحمر صغير فوق الألعاب وأنت مكتوم.
• الألعاب: عدّاد إطارات في الزاوية أو داخل الجزيرة، ومدة لعبك لكل لعبة.
• النظام: المعالج وكرت الشاشة والذاكرة والشبكة والأقراص بنظرة.
• البلوتوث: بطاريات السماعات وأذرع التحكم، مع تنبيهٍ حين تنخفض.
• لوحة المفاتيح: نافذة قصيرة حين تبدّل لغة الكتابة أو تشغّل Caps Lock.
• مواقيت الصلاة: أوقات دقيقة لمدينتك، والأذان بالصوت الذي تختاره، وإيقاف الموسيقى عند الأذان، وأذكار وآيات قصيرة خلال اليوم.

يعمل هلال دون إنترنت، بلا حساب ولا إعلانات، ولا يرسل أي شيء عنك. مجاني ومفتوح المصدر.

**الجديد في هذا الإصدار:**
هلال 1.3.0: نافذة للغة لوحة المفاتيح (العربية والإنجليزية وغيرها) ولـ Caps Lock.

## Notes for the certification team (Submission options → Notes for certification)

Hilal is a free, open-source desktop app (https://github.com/ahmad3a4/hilal-island). No account or test login is needed.
- runFullTrust: it's a Win32 (Electron) app with a small native helper (HilalHelper.exe) for Windows audio, media and device APIs.
- Keyboard hook: used only while the island is shown, to show the volume pop-up when the volume keys are pressed. It reads no other keys. The microphone mute shortcut is a normal global shortcut that the user picks.
- Mouse hook: installed only while the pointer is over the island, so the scroll wheel changes the volume.
- FPS counter: optional. When the user presses "Allow", Windows asks for administrator approval (UAC) to add the user to the built-in "Performance Log Users" group, which Windows requires to read game frame times (ETW). Nothing else is changed.
- Location: used only when the user presses Detect in Settings → Location, to calculate prayer times.
- Startup task: Hilal starts at sign-in; users can turn this off in Task Manager → Startup apps.
