// HilalHelper: the native bridge for Hilal.
//
// Written in C# 5 on purpose so it compiles with the csc.exe that ships with
// Windows (.NET Framework 4.x) - no SDK needed. See scripts/build-helper.js.
//
// Protocol (stdin/stdout, one message per line):
//   in : tab-separated commands, e.g.  "toggle\t<sessionId>"  "pauseall"  "mute\t123,456"
//   out: one JSON object per line, ASCII only (non-ASCII is \u-escaped).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using Windows.Devices.Geolocation;
using Windows.Foundation;
using Windows.Media.Control;
using Windows.Storage.Streams;

namespace HilalHelper
{
    static class Program
    {
        [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

        [MTAThread]
        static int Main(string[] args)
        {
            // Measure windows and monitors in real pixels, so the fullscreen check is right on scaled displays.
            try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); }
            catch { try { SetProcessDPIAware(); } catch { } }
            try { AudioMuter.RecoverFromCrash(); } catch (Exception ex) { Out.Log("recover: " + ex.Message); }
            Media.Start();
            Sound.Start();
            FullscreenWatcher.Start();
            Out.Send("{\"type\":\"ready\"}");

            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                line = line.Trim();
                if (line.Length == 0) continue;
                if (line == "quit") break;
                try { Commands.Handle(line); }
                catch (Exception ex) { Out.Log("command failed: " + line + " -> " + ex.Message); }
            }

            // Parent closed the pipe or asked us to quit: never leave other apps muted.
            try { AudioMuter.UnmuteAll(); } catch { }
            return 0;
        }
    }

    static class Commands
    {
        public static void Handle(string line)
        {
            string[] p = line.Split('\t');
            string cmd = p[0];
            string arg = p.Length > 1 ? p[1] : "";
            switch (cmd)
            {
                case "ping": Out.Send("{\"type\":\"pong\"}"); break;
                case "refresh": Media.Kick(); break;
                case "toggle":
                case "play":
                case "pause":
                case "next":
                case "prev":
                    Media.Control(cmd, arg); break;
                case "seek":
                    Media.Seek(arg, p.Length > 2 ? double.Parse(p[2], CultureInfo.InvariantCulture) : 0); break;
                case "pauseall": Media.PauseAll(); break;
                case "resume":
                    var ids = new List<string>();
                    for (int i = 1; i < p.Length; i++) if (p[i].Length > 0) ids.Add(p[i]);
                    Media.Resume(ids);
                    break;
                case "mute": AudioMuter.MuteOthers(ParsePids(arg)); break;
                case "unmute": AudioMuter.UnmuteAll(); Out.Send("{\"type\":\"unmuted\"}"); break;
                case "locate": ThreadPool.QueueUserWorkItem(delegate { Locator.Locate(); }); break;
                case "fgsave": Foreground.Save(); break;
                case "fgrestore": Foreground.Restore(); break;
                case "volget": Sound.SendMaster("query"); break;
                case "vol": Sound.SetMaster(ParseFloat(arg)); break;
                case "volmute": Sound.SetMute(arg == "1"); break;
                case "volstep": Sound.Step(int.Parse(arg, CultureInfo.InvariantCulture), p.Length > 2 ? p[2] : "key"); break;
                case "volkeys": VolumeKeys.Enable(arg == "1"); break;
                case "wheelzone": WheelZone.Set(p); break;
                case "mixer": Sound.SendMixer(true); break;
                case "mixerwatch": Sound.Watch(arg == "1"); break;
                case "appvol": Sound.SetApp(uint.Parse(arg, CultureInfo.InvariantCulture), ParseFloat(p.Length > 2 ? p[2] : "1")); break;
                case "appmute": Sound.MuteApp(uint.Parse(arg, CultureInfo.InvariantCulture), p.Length > 2 && p[2] == "1"); break;
                case "brightness": Brightness.Query(); break;
                case "setbrightness": Brightness.Set(int.Parse(arg, CultureInfo.InvariantCulture)); break;
                default: Out.Log("unknown command: " + cmd); break;
            }
        }

        static float ParseFloat(string v)
        {
            float f = float.Parse(v, CultureInfo.InvariantCulture);
            return f < 0 ? 0 : f > 1 ? 1 : f;
        }

        static HashSet<uint> ParsePids(string csv)
        {
            var set = new HashSet<uint>();
            foreach (string s in csv.Split(','))
            {
                uint v;
                if (uint.TryParse(s.Trim(), out v)) set.Add(v);
            }
            return set;
        }
    }

    // ------------------------------------------------------------------ media

    static class Media
    {
        static GlobalSystemMediaTransportControlsSessionManager manager;
        static Timer timer;
        static int busy;
        static int again;
        static string lastJson = "";

        // Thumbnails are sent once per track (keyed by app+title+artist+album).
        // Some apps update the artwork a moment after the title, so we re-check a few times.
        static readonly Dictionary<string, string> sentThumbHash = new Dictionary<string, string>();
        static readonly Dictionary<string, int> thumbChecks = new Dictionary<string, int>();
        static readonly HashSet<object> hooked = new HashSet<object>();

        public static void Start()
        {
            try
            {
                manager = Async.Await(GlobalSystemMediaTransportControlsSessionManager.RequestAsync(), 10000);
            }
            catch (Exception ex)
            {
                Out.Log("media unavailable: " + ex.Message);
                return;
            }
            // Events give instant updates; if they fail for some reason the 1-second poll still keeps things fresh.
            try
            {
                manager.SessionsChanged += delegate { Kick(); };
                manager.CurrentSessionChanged += delegate { Kick(); };
            }
            catch (Exception ex) { Out.Log("media events unavailable: " + ex.Message); }
            timer = new Timer(delegate { Refresh(); }, null, 100, 1000);
        }

        public static void Kick()
        {
            ThreadPool.QueueUserWorkItem(delegate { Refresh(); });
        }

        static void Refresh()
        {
            if (Interlocked.CompareExchange(ref busy, 1, 0) != 0) { again = 1; return; }
            try
            {
                do { again = 0; RefreshOnce(); } while (again == 1);
            }
            catch (Exception ex) { Out.Log("media refresh: " + ex.Message); }
            finally { Interlocked.Exchange(ref busy, 0); }
        }

        static void RefreshOnce()
        {
            if (manager == null) return;
            var sessions = manager.GetSessions();
            string currentAumid = null;
            try
            {
                var cur = manager.GetCurrentSession();
                if (cur != null) currentAumid = cur.SourceAppUserModelId;
            }
            catch { }

            var counts = new Dictionary<string, int>();
            var parts = new List<string>();
            string currentId = null;
            foreach (var s in sessions)
            {
                try
                {
                    string aumid = s.SourceAppUserModelId ?? "";
                    string id = MakeId(counts, aumid);
                    if (currentId == null && aumid == currentAumid) currentId = id;
                    Hook(s);
                    parts.Add(Describe(s, id, aumid));
                }
                catch (Exception ex) { Out.Log("session: " + ex.Message); }
            }

            var sb = new StringBuilder();
            sb.Append("{\"type\":\"media\",\"current\":").Append(Json.Str(currentId));
            sb.Append(",\"sessions\":[").Append(string.Join(",", parts.ToArray())).Append("]}");
            string json = sb.ToString();
            if (json != lastJson)
            {
                lastJson = json;
                Out.Send(json);
            }
        }

        static string MakeId(Dictionary<string, int> counts, string aumid)
        {
            int n;
            counts.TryGetValue(aumid, out n);
            counts[aumid] = n + 1;
            return n == 0 ? aumid : aumid + "#" + n;
        }

        static void Hook(GlobalSystemMediaTransportControlsSession s)
        {
            lock (hooked)
            {
                if (hooked.Contains(s)) return;
                hooked.Add(s);
            }
            try
            {
                s.MediaPropertiesChanged += delegate { Kick(); };
                s.PlaybackInfoChanged += delegate { Kick(); };
            }
            catch { }
        }

        static string Describe(GlobalSystemMediaTransportControlsSession s, string id, string aumid)
        {
            var info = s.GetPlaybackInfo();
            var c = info.Controls;
            var tl = s.GetTimelineProperties();

            GlobalSystemMediaTransportControlsSessionMediaProperties props = null;
            try { props = Async.Await(s.TryGetMediaPropertiesAsync(), 3000); } catch { }
            string title = props != null ? (props.Title ?? "") : "";
            string artist = props != null ? (props.Artist ?? "") : "";
            string album = props != null ? (props.AlbumTitle ?? "") : "";
            if (artist.Length == 0 && props != null) artist = props.AlbumArtist ?? "";

            string thumbKey = null;
            if (props != null && props.Thumbnail != null)
            {
                thumbKey = Hash(aumid + "|" + title + "|" + artist + "|" + album);
                MaybeSendThumb(thumbKey, props.Thumbnail);
            }

            double dur = (tl.EndTime - tl.StartTime).TotalSeconds;
            double pos = (tl.Position - tl.StartTime).TotalSeconds;
            long upd = 0;
            try { upd = tl.LastUpdatedTime.ToUnixTimeMilliseconds(); } catch { }

            var sb = new StringBuilder();
            sb.Append("{\"id\":").Append(Json.Str(id));
            sb.Append(",\"aumid\":").Append(Json.Str(aumid));
            sb.Append(",\"title\":").Append(Json.Str(title));
            sb.Append(",\"artist\":").Append(Json.Str(artist));
            sb.Append(",\"album\":").Append(Json.Str(album));
            sb.Append(",\"status\":").Append(Json.Str(StatusName(info.PlaybackStatus)));
            sb.Append(",\"pos\":").Append(Json.Num(pos));
            sb.Append(",\"dur\":").Append(Json.Num(dur));
            sb.Append(",\"upd\":").Append(upd.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"canPlay\":").Append(Json.Bool(c.IsPlayEnabled));
            sb.Append(",\"canPause\":").Append(Json.Bool(c.IsPauseEnabled));
            sb.Append(",\"canNext\":").Append(Json.Bool(c.IsNextEnabled));
            sb.Append(",\"canPrev\":").Append(Json.Bool(c.IsPreviousEnabled));
            sb.Append(",\"canSeek\":").Append(Json.Bool(c.IsPlaybackPositionEnabled));
            sb.Append(",\"thumb\":").Append(Json.Str(thumbKey));
            sb.Append("}");
            return sb.ToString();
        }

        static void MaybeSendThumb(string key, IRandomAccessStreamReference reference)
        {
            int checks;
            thumbChecks.TryGetValue(key, out checks);
            if (checks >= 4) return;
            thumbChecks[key] = checks + 1;
            if (thumbChecks.Count > 200) thumbChecks.Clear();

            try
            {
                var stream = Async.Await(reference.OpenReadAsync(), 3000);
                ulong size = stream.Size;
                if (size == 0 || size > 4 * 1024 * 1024) return;
                var reader = new DataReader(stream);
                Async.Await(reader.LoadAsync((uint)size), 3000);
                var bytes = new byte[size];
                reader.ReadBytes(bytes);
                string hash = Hash(Convert.ToBase64String(bytes));
                string previous;
                if (sentThumbHash.TryGetValue(key, out previous) && previous == hash) return;
                sentThumbHash[key] = hash;
                if (sentThumbHash.Count > 200) sentThumbHash.Clear();
                string mime = string.IsNullOrEmpty(stream.ContentType) ? "image/png" : stream.ContentType;
                Out.Send("{\"type\":\"thumb\",\"key\":" + Json.Str(key) + ",\"data\":" +
                         Json.Str("data:" + mime + ";base64," + Convert.ToBase64String(bytes)) + "}");
            }
            catch (Exception ex) { Out.Log("thumb: " + ex.Message); }
        }

        static string StatusName(GlobalSystemMediaTransportControlsSessionPlaybackStatus s)
        {
            switch (s)
            {
                case GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing: return "playing";
                case GlobalSystemMediaTransportControlsSessionPlaybackStatus.Paused: return "paused";
                case GlobalSystemMediaTransportControlsSessionPlaybackStatus.Stopped: return "stopped";
                case GlobalSystemMediaTransportControlsSessionPlaybackStatus.Changing: return "changing";
                case GlobalSystemMediaTransportControlsSessionPlaybackStatus.Opened: return "opened";
                default: return "closed";
            }
        }

        static GlobalSystemMediaTransportControlsSession Find(string id)
        {
            if (manager == null) return null;
            if (string.IsNullOrEmpty(id)) return manager.GetCurrentSession();
            var counts = new Dictionary<string, int>();
            foreach (var s in manager.GetSessions())
            {
                string aumid = s.SourceAppUserModelId ?? "";
                if (MakeId(counts, aumid) == id) return s;
            }
            return null;
        }

        public static void Control(string cmd, string id)
        {
            var s = Find(id);
            if (s == null) { Out.Log("no media session for " + id); return; }
            switch (cmd)
            {
                case "toggle": Async.Await(s.TryTogglePlayPauseAsync(), 3000); break;
                case "play": Async.Await(s.TryPlayAsync(), 3000); break;
                case "pause": Async.Await(s.TryPauseAsync(), 3000); break;
                case "next": Async.Await(s.TrySkipNextAsync(), 3000); break;
                case "prev": Async.Await(s.TrySkipPreviousAsync(), 3000); break;
            }
            Kick();
        }

        public static void Seek(string id, double seconds)
        {
            var s = Find(id);
            if (s == null) return;
            var tl = s.GetTimelineProperties();
            long ticks = tl.StartTime.Ticks + (long)(seconds * 10000000.0);
            Async.Await(s.TryChangePlaybackPositionAsync(ticks), 3000);
            Kick();
        }

        // Pauses everything that is playing and reports which apps were paused,
        // so they can optionally be resumed after the azan.
        public static void PauseAll()
        {
            var paused = new List<string>();
            if (manager != null)
            {
                foreach (var s in manager.GetSessions())
                {
                    try
                    {
                        if (s.GetPlaybackInfo().PlaybackStatus != GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing) continue;
                        bool ok = Async.Await(s.TryPauseAsync(), 3000);
                        if (ok) paused.Add(Json.Str(s.SourceAppUserModelId ?? ""));
                        else Out.Log("pause refused by " + s.SourceAppUserModelId);
                    }
                    catch (Exception ex) { Out.Log("pause: " + ex.Message); }
                }
            }
            Out.Send("{\"type\":\"pausedall\",\"ids\":[" + string.Join(",", paused.ToArray()) + "]}");
            Kick();
        }

        public static void Resume(List<string> aumids)
        {
            if (manager == null) return;
            foreach (var s in manager.GetSessions())
            {
                try
                {
                    if (!aumids.Contains(s.SourceAppUserModelId ?? "")) continue;
                    if (s.GetPlaybackInfo().PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Paused)
                        Async.Await(s.TryPlayAsync(), 3000);
                }
                catch (Exception ex) { Out.Log("resume: " + ex.Message); }
            }
            Kick();
        }

        static string Hash(string s)
        {
            using (var sha = SHA1.Create())
            {
                byte[] h = sha.ComputeHash(Encoding.UTF8.GetBytes(s));
                var sb = new StringBuilder();
                for (int i = 0; i < 8; i++) sb.Append(h[i].ToString("x2"));
                return sb.ToString();
            }
        }
    }

    // ------------------------------------------------------------- fullscreen

    // Is a fullscreen app in front of the main screen right now?
    // Windows' own answer (SHQueryUserNotificationState) keeps saying "fullscreen game" for as
    // long as a game is running, even after you Alt+Tab away from it, so we look at the window
    // that is actually in front instead: borderless and covering the whole primary monitor.
    static class FullscreenWatcher
    {
        [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
        [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hwnd);
        [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd, int index);
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);
        [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
        [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
        [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
        [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);

        [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

        const int GWL_STYLE = -16;
        const int WS_CAPTION = 0x00C00000;
        const int DWMWA_CLOAKED = 14;

        static Timer timer;
        static int last = -1;

        public static void Start()
        {
            timer = new Timer(delegate { Check(); }, null, 300, 700);
        }

        static void Check()
        {
            int state = 0;
            try { SHQueryUserNotificationState(out state); } catch { }
            bool front = false;
            try { front = ForegroundCoversMainScreen(); } catch { }
            // 4 = "presentation mode", which you switch on yourself in Windows
            int fs = (front || state == 4) ? 1 : 0;
            if (fs == last) return;
            last = fs;
            Out.Send("{\"type\":\"fullscreen\",\"value\":" + (fs == 1 ? "true" : "false") + ",\"state\":" + state
                + ",\"window\":" + Json.Str(DescribeForeground()) + "}");
        }

        // For Hilal's activity log: which window was in front when this changed.
        static string DescribeForeground()
        {
            try
            {
                IntPtr fg = GetForegroundWindow();
                if (fg == IntPtr.Zero) return "none";
                var cls = new StringBuilder(128);
                GetClassName(fg, cls, cls.Capacity);
                uint pid;
                GetWindowThreadProcessId(fg, out pid);
                string exe = "?";
                try { exe = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { }
                RECT r;
                GetWindowRect(fg, out r);
                return exe + " (" + cls + ") " + r.Left + "," + r.Top + " " + (r.Right - r.Left) + "x" + (r.Bottom - r.Top)
                    + (IsIconic(fg) ? " minimized" : "");
            }
            catch { return "?"; }
        }

        static bool ForegroundCoversMainScreen()
        {
            IntPtr fg = GetForegroundWindow();
            if (fg == IntPtr.Zero || fg == GetShellWindow() || !IsWindowVisible(fg) || IsIconic(fg)) return false;
            var cls = new StringBuilder(128);
            GetClassName(fg, cls, cls.Capacity);
            string name = cls.ToString();
            if (name == "Progman" || name == "WorkerW" || name == "Shell_TrayWnd" || name == "Shell_SecondaryTrayWnd") return false;
            int cloaked;
            if (DwmGetWindowAttribute(fg, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) return false;
            // A maximized window with a title bar is just a big window, not fullscreen.
            if (IsZoomed(fg) && (GetWindowLong(fg, GWL_STYLE) & WS_CAPTION) == WS_CAPTION) return false;
            // Fullscreen on another monitor doesn't cover the island, which lives on the main one.
            IntPtr monitor = MonitorFromWindow(fg, 0 /* MONITOR_DEFAULTTONULL */);
            IntPtr primary = MonitorFromPoint(new POINT(), 1 /* MONITOR_DEFAULTTOPRIMARY */);
            if (monitor == IntPtr.Zero || monitor != primary) return false;
            var info = new MONITORINFO();
            info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
            RECT r;
            if (!GetMonitorInfo(monitor, ref info) || !GetWindowRect(fg, out r)) return false;
            return r.Left <= info.rcMonitor.Left && r.Top <= info.rcMonitor.Top
                && r.Right >= info.rcMonitor.Right && r.Bottom >= info.rcMonitor.Bottom;
        }
    }

    // ------------------------------------------------------------- foreground

    // The island never steals focus, except while you type in one of its text boxes.
    // We remember which window you were using and hand focus back afterwards.
    static class Foreground
    {
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
        [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);

        static IntPtr saved = IntPtr.Zero;

        public static void Save()
        {
            saved = GetForegroundWindow();
            Out.Send("{\"type\":\"fg\",\"saved\":" + (saved != IntPtr.Zero ? "true" : "false") + "}");
        }

        public static void Restore()
        {
            if (saved != IntPtr.Zero && IsWindow(saved)) SetForegroundWindow(saved);
            saved = IntPtr.Zero;
        }
    }

    // --------------------------------------------------------------- location

    static class Locator
    {
        public static void Locate()
        {
            try
            {
                var access = Async.Await(Geolocator.RequestAccessAsync(), 15000);
                if (access != GeolocationAccessStatus.Allowed)
                    throw new Exception("Location access is off. Turn it on in Settings > Privacy & security > Location.");
                var g = new Geolocator();
                g.DesiredAccuracy = PositionAccuracy.Default;
                var pos = Async.Await(g.GetGeopositionAsync(TimeSpan.FromMinutes(30), TimeSpan.FromSeconds(12)), 16000);
                var p = pos.Coordinate.Point.Position;
                Out.Send("{\"type\":\"location\",\"ok\":true,\"lat\":" + Json.Num(p.Latitude) + ",\"lon\":" + Json.Num(p.Longitude) +
                         ",\"acc\":" + Json.Num(pos.Coordinate.Accuracy) + "}");
            }
            catch (Exception ex)
            {
                Out.Send("{\"type\":\"location\",\"ok\":false,\"error\":" + Json.Str(ex.Message) + "}");
            }
        }
    }

    // ------------------------------------------------------------------ sound

    // Master volume (with change notifications), per-app volumes for the mixer and their live levels.
    // Everything works on the default output device and follows it when you switch devices.
    static class Sound
    {
        // Changes we make carry this id, so our own change notifications can be told apart.
        public static Guid HilalContext = new Guid("6c1f3c9e-6a4b-4d1e-9a51-48a5e1a1b7d2");

        static readonly object Gate = new object();
        static IMMDeviceEnumerator enumerator;
        static IAudioEndpointVolume endpoint;
        static IAudioMeterInformation endpointMeter;
        static IAudioSessionManager2 sessionManager;
        static VolumeCallback callback;
        static DeviceWatcher deviceWatcher;
        static string deviceName = "";
        static List<AppAudio> apps = new List<AppAudio>();
        static Timer watchTimer;
        static int watchTicks;
        static string lastMixer = "";
        static readonly Dictionary<string, string> descriptions = new Dictionary<string, string>();

        [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT pv);
        [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder name, ref int size);

        class AppAudio
        {
            public uint Pid;
            public bool IsSystem;
            public bool Active;
            public string Name = "";
            public string Path = "";
            public readonly List<ISimpleAudioVolume> Volumes = new List<ISimpleAudioVolume>();
            public readonly List<IAudioMeterInformation> Meters = new List<IAudioMeterInformation>();
        }

        public static void Start()
        {
            try
            {
                enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
                deviceWatcher = new DeviceWatcher();
                enumerator.RegisterEndpointNotificationCallback(deviceWatcher);
            }
            catch (Exception ex) { Out.Log("sound: " + ex.Message); }
            Attach();
        }

        // (Re)connects to the default output device.
        public static void Attach()
        {
            lock (Gate)
            {
                try { if (endpoint != null && callback != null) endpoint.UnregisterControlChangeNotify(callback); } catch { }
                endpoint = null;
                endpointMeter = null;
                sessionManager = null;
                apps = new List<AppAudio>();
                deviceName = "";
                if (enumerator == null) return;
                try
                {
                    IMMDevice device;
                    enumerator.GetDefaultAudioEndpoint(0 /* eRender */, 0 /* eConsole */, out device);
                    deviceName = FriendlyName(device);
                    object o;
                    Guid iid = typeof(IAudioEndpointVolume).GUID;
                    device.Activate(ref iid, 23, IntPtr.Zero, out o);
                    endpoint = (IAudioEndpointVolume)o;
                    iid = typeof(IAudioMeterInformation).GUID;
                    device.Activate(ref iid, 23, IntPtr.Zero, out o);
                    endpointMeter = (IAudioMeterInformation)o;
                    iid = typeof(IAudioSessionManager2).GUID;
                    device.Activate(ref iid, 23, IntPtr.Zero, out o);
                    sessionManager = (IAudioSessionManager2)o;
                    if (callback == null) callback = new VolumeCallback();
                    endpoint.RegisterControlChangeNotify(callback);
                }
                catch (Exception ex) { Out.Log("sound device: " + ex.Message); }
            }
            SendMaster("device");
            lastMixer = "";
            if (watchTimer != null) SendMixer(true);
        }

        static string FriendlyName(IMMDevice device)
        {
            try
            {
                IPropertyStore store;
                device.OpenPropertyStore(0 /* STGM_READ */, out store);
                var key = new PROPERTYKEY { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
                PROPVARIANT v;
                store.GetValue(ref key, out v);
                string name = v.vt == 31 /* VT_LPWSTR */ ? Marshal.PtrToStringUni(v.p) : "";
                PropVariantClear(ref v);
                return name ?? "";
            }
            catch { return ""; }
        }

        public static string DeviceName { get { return deviceName; } }

        public static void SendMaster(string source)
        {
            float level = 0;
            bool muted = false;
            bool ok = false;
            lock (Gate)
            {
                if (endpoint != null)
                {
                    try { endpoint.GetMasterVolumeLevelScalar(out level); endpoint.GetMute(out muted); ok = true; } catch { }
                }
            }
            SendVolume(ok, level, muted, source);
        }

        public static void SendVolume(bool ok, float level, bool muted, string source)
        {
            Out.Send("{\"type\":\"volume\",\"ok\":" + Json.Bool(ok) + ",\"level\":" + Json.Num(Math.Round(level, 3)) + ",\"muted\":" + Json.Bool(muted)
                + ",\"device\":" + Json.Str(deviceName) + ",\"source\":" + Json.Str(source) + "}");
        }

        // One press of a volume key (dir +1 / -1), or mute on/off (dir 0). Steps of 2%, like Windows.
        public static void Step(int dir, string source)
        {
            lock (Gate)
            {
                if (endpoint == null) return;
                Guid ctx = HilalContext;
                try
                {
                    bool muted;
                    endpoint.GetMute(out muted);
                    if (dir == 0)
                    {
                        endpoint.SetMute(!muted, ref ctx);
                    }
                    else
                    {
                        float v;
                        endpoint.GetMasterVolumeLevelScalar(out v);
                        int units = (int)Math.Round(v * 50) + (dir > 0 ? 1 : -1);
                        if (units < 0) units = 0;
                        if (units > 50) units = 50;
                        endpoint.SetMasterVolumeLevelScalar(units / 50f, ref ctx);
                        if (muted) endpoint.SetMute(false, ref ctx);
                    }
                }
                catch (Exception ex) { Out.Log("volume: " + ex.Message); }
            }
            SendMaster(source);
        }

        public static void SetMaster(float level)
        {
            lock (Gate)
            {
                if (endpoint == null) return;
                Guid ctx = HilalContext;
                try
                {
                    endpoint.SetMasterVolumeLevelScalar(level, ref ctx);
                    bool muted;
                    endpoint.GetMute(out muted);
                    if (muted && level > 0) endpoint.SetMute(false, ref ctx);
                }
                catch (Exception ex) { Out.Log("volume: " + ex.Message); }
            }
            SendMaster("island");
        }

        public static void SetMute(bool mute)
        {
            lock (Gate)
            {
                if (endpoint == null) return;
                Guid ctx = HilalContext;
                try { endpoint.SetMute(mute, ref ctx); } catch (Exception ex) { Out.Log("volume: " + ex.Message); }
            }
            SendMaster("island");
        }

        // ------------------------------------------------------------ mixer

        static void RefreshApps()
        {
            var list = new List<AppAudio>();
            if (sessionManager == null) { apps = list; return; }
            IAudioSessionEnumerator sessions;
            sessionManager.GetSessionEnumerator(out sessions);
            int n;
            sessions.GetCount(out n);
            for (int i = 0; i < n; i++)
            {
                try
                {
                    IAudioSessionControl2 ctl;
                    sessions.GetSession(i, out ctl);
                    int state;
                    ctl.GetState(out state);
                    if (state == 2) continue; // expired
                    bool system = ctl.IsSystemSoundsSession() == 0;
                    uint pid = 0;
                    if (!system) { try { ctl.GetProcessId(out pid); } catch { } }
                    AppAudio app = null;
                    foreach (var a in list) if (a.Pid == pid && a.IsSystem == system) { app = a; break; }
                    if (app == null)
                    {
                        app = new AppAudio { Pid = pid, IsSystem = system };
                        if (system) app.Name = "System sounds";
                        else Describe(app, ctl);
                        list.Add(app);
                    }
                    if (state == 1) app.Active = true;
                    var vol = ctl as ISimpleAudioVolume;
                    if (vol != null) app.Volumes.Add(vol);
                    var meter = ctl as IAudioMeterInformation;
                    if (meter != null) app.Meters.Add(meter);
                }
                catch (Exception ex) { Out.Log("audio session: " + ex.Message); }
            }
            apps = list;
        }

        static void Describe(AppAudio app, IAudioSessionControl2 ctl)
        {
            IntPtr h = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, app.Pid);
            if (h != IntPtr.Zero)
            {
                var sb = new StringBuilder(1024);
                int size = sb.Capacity;
                if (QueryFullProcessImageName(h, 0, sb, ref size)) app.Path = sb.ToString();
                CloseHandle(h);
            }
            string name = null;
            if (app.Path.Length > 0)
            {
                lock (descriptions)
                {
                    if (!descriptions.TryGetValue(app.Path, out name))
                    {
                        try { name = FileVersionInfo.GetVersionInfo(app.Path).FileDescription; } catch { }
                        if (name != null) name = name.Trim();
                        descriptions[app.Path] = name;
                    }
                }
            }
            if (string.IsNullOrEmpty(name))
            {
                try
                {
                    IntPtr p;
                    ctl.GetDisplayName(out p);
                    string display = p != IntPtr.Zero ? Marshal.PtrToStringUni(p) : null;
                    if (p != IntPtr.Zero) Marshal.FreeCoTaskMem(p);
                    if (!string.IsNullOrEmpty(display) && display[0] != '@') name = display;
                }
                catch { }
            }
            if (string.IsNullOrEmpty(name) && app.Path.Length > 0) name = System.IO.Path.GetFileNameWithoutExtension(app.Path);
            app.Name = string.IsNullOrEmpty(name) ? "App " + app.Pid : name;
        }

        public static void SendMixer(bool force)
        {
            var sb = new StringBuilder();
            lock (Gate)
            {
                try { RefreshApps(); } catch (Exception ex) { Out.Log("mixer: " + ex.Message); }
                sb.Append("{\"type\":\"mixer\",\"device\":").Append(Json.Str(deviceName)).Append(",\"apps\":[");
                bool first = true;
                foreach (var a in apps)
                {
                    float level = 1;
                    bool muted = false;
                    try { if (a.Volumes.Count > 0) { a.Volumes[0].GetMasterVolume(out level); a.Volumes[0].GetMute(out muted); } } catch { }
                    if (!first) sb.Append(',');
                    first = false;
                    sb.Append("{\"pid\":").Append(a.Pid)
                      .Append(",\"name\":").Append(Json.Str(a.Name))
                      .Append(",\"path\":").Append(Json.Str(a.Path))
                      .Append(",\"volume\":").Append(Json.Num(Math.Round(level, 3)))
                      .Append(",\"muted\":").Append(Json.Bool(muted))
                      .Append(",\"active\":").Append(Json.Bool(a.Active))
                      .Append(",\"system\":").Append(Json.Bool(a.IsSystem)).Append('}');
                }
                sb.Append("]}");
            }
            string json = sb.ToString();
            if (!force && json == lastMixer) return;
            lastMixer = json;
            Out.Send(json);
        }

        // While the Sound tab is open: live levels ten times a second, the app list every second.
        public static void Watch(bool on)
        {
            lock (Gate)
            {
                if (watchTimer != null) { watchTimer.Dispose(); watchTimer = null; }
                if (!on) return;
                watchTicks = 0;
                watchTimer = new Timer(delegate { Tick(); }, null, 0, 100);
            }
        }

        static void Tick()
        {
            if (watchTicks++ % 10 == 0) SendMixer(watchTicks == 1);
            var sb = new StringBuilder();
            lock (Gate)
            {
                if (watchTimer == null) return;
                float master = 0;
                try { if (endpointMeter != null) endpointMeter.GetPeakValue(out master); } catch { }
                sb.Append("{\"type\":\"peaks\",\"master\":").Append(Json.Num(Math.Round(master, 3))).Append(",\"apps\":{");
                bool first = true;
                foreach (var a in apps)
                {
                    float peak = 0;
                    foreach (var m in a.Meters)
                    {
                        float v;
                        try { m.GetPeakValue(out v); if (v > peak) peak = v; } catch { }
                    }
                    if (!first) sb.Append(',');
                    first = false;
                    sb.Append('"').Append(a.IsSystem ? "system" : a.Pid.ToString(CultureInfo.InvariantCulture)).Append("\":").Append(Json.Num(Math.Round(peak, 3)));
                }
                sb.Append("}}");
            }
            Out.Send(sb.ToString());
        }

        static AppAudio Find(uint pid, bool system)
        {
            foreach (var a in apps) if (a.IsSystem == system && (system || a.Pid == pid)) return a;
            RefreshApps();
            foreach (var a in apps) if (a.IsSystem == system && (system || a.Pid == pid)) return a;
            return null;
        }

        // pid 0 means the system sounds.
        public static void SetApp(uint pid, float level)
        {
            lock (Gate)
            {
                var a = Find(pid, pid == 0);
                if (a == null) return;
                Guid ctx = HilalContext;
                foreach (var v in a.Volumes)
                {
                    try
                    {
                        v.SetMasterVolume(level, ref ctx);
                        bool muted;
                        v.GetMute(out muted);
                        if (muted && level > 0) v.SetMute(false, ref ctx);
                    }
                    catch { }
                }
            }
        }

        public static void MuteApp(uint pid, bool mute)
        {
            lock (Gate)
            {
                var a = Find(pid, pid == 0);
                if (a == null) return;
                Guid ctx = HilalContext;
                foreach (var v in a.Volumes) { try { v.SetMute(mute, ref ctx); } catch { } }
            }
            SendMixer(true);
        }
    }

    [ComVisible(true)]
    class VolumeCallback : IAudioEndpointVolumeCallback
    {
        public int OnNotify(IntPtr data)
        {
            try
            {
                var n = (AUDIO_VOLUME_NOTIFICATION_DATA)Marshal.PtrToStructure(data, typeof(AUDIO_VOLUME_NOTIFICATION_DATA));
                // Our own changes were already reported by whoever made them.
                if (n.guidEventContext != Sound.HilalContext) Sound.SendVolume(true, n.fMasterVolume, n.bMuted != 0, "change");
            }
            catch { }
            return 0;
        }
    }

    [ComVisible(true)]
    class DeviceWatcher : IMMNotificationClient
    {
        public int OnDeviceStateChanged(string id, int state) { return 0; }
        public int OnDeviceAdded(string id) { return 0; }
        public int OnDeviceRemoved(string id) { return 0; }
        public int OnPropertyValueChanged(string id, PROPERTYKEY key) { return 0; }

        public int OnDefaultDeviceChanged(int flow, int role, string id)
        {
            // Only the speakers/headphones you hear from; never do audio work inside this callback.
            if (flow == 0 && role == 0) ThreadPool.QueueUserWorkItem(delegate { Sound.Attach(); });
            return 0;
        }
    }

    // ------------------------------------------------------------ volume keys

    // While the island is on screen, the volume keys are handled here so it can show its own
    // volume pop-up instead of the Windows one. Off (keys go to Windows as usual) when hidden.
    static class VolumeKeys
    {
        delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint thread);
        [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
        [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);

        [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int x, y; }
        [StructLayout(LayoutKind.Sequential)] struct KBDLLHOOKSTRUCT { public uint vk, scan, flags, time; public IntPtr extra; }

        static readonly HookProc Proc = Hook; // must stay referenced while the hook is installed
        static IntPtr hook = IntPtr.Zero;
        static volatile bool enabled;
        static Thread thread;

        public static void Enable(bool on)
        {
            enabled = on;
            if (on && thread == null)
            {
                thread = new Thread(Loop);
                thread.IsBackground = true;
                thread.Start();
            }
        }

        static void Loop()
        {
            hook = SetWindowsHookEx(13 /* WH_KEYBOARD_LL */, Proc, GetModuleHandle(null), 0);
            if (hook == IntPtr.Zero) { Out.Log("volume keys: hook failed " + Marshal.GetLastWin32Error()); return; }
            MSG msg;
            while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
        }

        static IntPtr Hook(int code, IntPtr wParam, IntPtr lParam)
        {
            if (code >= 0 && enabled)
            {
                var k = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                int dir = k.vk == 0xAF ? 1 : k.vk == 0xAE ? -1 : k.vk == 0xAD ? 0 : 99; // VK_VOLUME_UP / DOWN / MUTE
                if (dir != 99)
                {
                    int m = wParam.ToInt32();
                    if (m == 0x100 || m == 0x104) ThreadPool.QueueUserWorkItem(delegate { Sound.Step(dir, "key"); });
                    return new IntPtr(1); // handled here, so Windows doesn't show its own pop-up
                }
            }
            return CallNextHookEx(hook, code, wParam, lParam);
        }
    }

    // ------------------------------------------------------------ scroll wheel

    // Scrolling over the closed island changes the volume (Shift: brightness). Hilal turns this on
    // only while the pointer is over the island, and the scroll never reaches the app underneath.
    static class WheelZone
    {
        delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint thread);
        [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
        [DllImport("user32.dll")] static extern bool PeekMessage(out MSG msg, IntPtr hwnd, uint min, uint max, uint remove);
        [DllImport("user32.dll")] static extern bool PostThreadMessage(uint thread, uint msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
        [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);

        [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int x, y; }
        [StructLayout(LayoutKind.Sequential)] struct MSLLHOOKSTRUCT { public int x, y; public uint mouseData, flags, time; public IntPtr extra; }

        const uint WM_APP_HOOK = 0x8001;
        const uint WM_APP_UNHOOK = 0x8002;

        static readonly HookProc Proc = Hook; // must stay referenced while the hook is installed
        static readonly object Gate = new object();
        static IntPtr hook = IntPtr.Zero;
        static Thread thread;
        static uint threadId;
        static volatile bool active;
        static int left, top, right, bottom, acc;

        // "off", or the island's rectangle in screen pixels: x y width height
        public static void Set(string[] p)
        {
            if (p.Length < 5 || p[1] == "off")
            {
                active = false;
                Post(WM_APP_UNHOOK);
                return;
            }
            int x = int.Parse(p[1], CultureInfo.InvariantCulture);
            int y = int.Parse(p[2], CultureInfo.InvariantCulture);
            left = x;
            top = y;
            right = x + int.Parse(p[3], CultureInfo.InvariantCulture);
            bottom = y + int.Parse(p[4], CultureInfo.InvariantCulture);
            acc = 0;
            active = true;
            EnsureThread();
            Post(WM_APP_HOOK);
        }

        static void Post(uint message)
        {
            if (threadId != 0) PostThreadMessage(threadId, message, IntPtr.Zero, IntPtr.Zero);
        }

        static void EnsureThread()
        {
            lock (Gate)
            {
                if (thread != null) return;
                var ready = new ManualResetEvent(false);
                thread = new Thread(Loop);
                thread.IsBackground = true;
                thread.Start(ready);
                ready.WaitOne(2000);
            }
        }

        static void Loop(object ready)
        {
            MSG msg;
            PeekMessage(out msg, IntPtr.Zero, 0, 0, 0); // creates this thread's message queue
            threadId = GetCurrentThreadId();
            ((ManualResetEvent)ready).Set();
            while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
            {
                if (msg.message == WM_APP_HOOK && hook == IntPtr.Zero && active)
                {
                    hook = SetWindowsHookEx(14 /* WH_MOUSE_LL */, Proc, GetModuleHandle(null), 0);
                    if (hook == IntPtr.Zero) Out.Log("scroll wheel: hook failed " + Marshal.GetLastWin32Error());
                }
                else if (msg.message == WM_APP_UNHOOK && hook != IntPtr.Zero && !active)
                {
                    UnhookWindowsHookEx(hook);
                    hook = IntPtr.Zero;
                }
            }
        }

        static IntPtr Hook(int code, IntPtr wParam, IntPtr lParam)
        {
            int m = wParam.ToInt32();
            if (code >= 0 && active && (m == 0x020A || m == 0x020E)) // WM_MOUSEWHEEL, WM_MOUSEHWHEEL
            {
                var h = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
                if (h.x >= left && h.x < right && h.y >= top && h.y < bottom)
                {
                    int delta = (short)((h.mouseData >> 16) & 0xffff);
                    // One step per wheel notch (120); touchpads send many small deltas, so add them up.
                    acc += delta;
                    int steps = acc / 120;
                    acc -= steps * 120;
                    if (steps != 0)
                    {
                        bool brightness = (GetAsyncKeyState(0x10) & 0x8000) != 0 || (GetAsyncKeyState(0x11) & 0x8000) != 0;
                        int dir = steps > 0 ? 1 : -1;
                        int count = Math.Abs(steps);
                        ThreadPool.QueueUserWorkItem(delegate
                        {
                            for (int i = 0; i < count; i++)
                            {
                                if (brightness) Brightness.Step(dir);
                                else Sound.Step(dir, "wheel");
                            }
                        });
                    }
                    return new IntPtr(1); // used here; the app under the island doesn't scroll
                }
            }
            return CallNextHookEx(hook, code, wParam, lParam);
        }
    }

    // ------------------------------------------------------------- brightness

    // Laptop screens through WMI, external monitors through DDC/CI (most monitors support it).
    static class Brightness
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct PHYSICAL_MONITOR { public IntPtr Handle; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description; }
        delegate bool MonitorEnum(IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data);
        [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnum callback, IntPtr data);
        [DllImport("dxva2.dll")] static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr monitor, out uint count);
        [DllImport("dxva2.dll")] static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr monitor, uint count, [Out] PHYSICAL_MONITOR[] monitors);
        [DllImport("dxva2.dll")] static extern bool DestroyPhysicalMonitors(uint count, PHYSICAL_MONITOR[] monitors);
        [DllImport("dxva2.dll")] static extern bool GetMonitorBrightness(IntPtr monitor, out uint min, out uint current, out uint max);
        [DllImport("dxva2.dll")] static extern bool SetMonitorBrightness(IntPtr monitor, uint value);

        static readonly object Gate = new object();
        static string method; // "wmi", "ddc" or "none" once known
        static int pending = -1;
        static bool working;
        static int lastSet = -1;
        static int current = -1;
        static DateTime lastSetAt = DateTime.MinValue;
        static ManagementEventWatcher watcher;

        public static void Query()
        {
            ThreadPool.QueueUserWorkItem(delegate
            {
                int level = -1;
                lock (Gate)
                {
                    if (method == null || method == "wmi") { level = WmiGet(); if (level >= 0) method = "wmi"; }
                    if (level < 0 && (method == null || method == "ddc")) { level = DdcGet(); if (level >= 0) method = "ddc"; }
                    if (level < 0) method = "none";
                    else current = level;
                    if (method == "wmi") WatchWmi();
                }
                Send(level, "query");
            });
        }

        static void Send(int level, string source)
        {
            Out.Send("{\"type\":\"brightness\",\"supported\":" + Json.Bool(level >= 0) + ",\"level\":" + (level < 0 ? 0 : level)
                + ",\"method\":" + Json.Str(method ?? "none") + ",\"source\":" + Json.Str(source) + "}");
        }

        // Monitors are slow to answer (about 50ms each), so only the newest value is applied.
        public static void Set(int level)
        {
            if (level < 0) level = 0;
            if (level > 100) level = 100;
            lock (Gate)
            {
                pending = level;
                current = level;
                if (working) return;
                working = true;
            }
            ThreadPool.QueueUserWorkItem(delegate
            {
                while (true)
                {
                    int next;
                    lock (Gate)
                    {
                        next = pending;
                        pending = -1;
                        if (next < 0) { working = false; return; }
                        lastSet = next;
                        lastSetAt = DateTime.UtcNow;
                    }
                    try
                    {
                        if (method == "wmi") WmiSet(next);
                        else if (method == "ddc") DdcSet(next);
                    }
                    catch (Exception ex) { Out.Log("brightness: " + ex.Message); }
                }
            });
        }

        // One scroll step: 5% brighter or darker.
        public static void Step(int dir)
        {
            int level;
            lock (Gate)
            {
                if (current < 0 || method == null || method == "none") return;
                level = (int)Math.Round(current / 5.0) * 5 + 5 * dir;
            }
            if (level < 0) level = 0;
            if (level > 100) level = 100;
            Set(level);
            Send(level, "wheel");
        }

        static int WmiGet()
        {
            try
            {
                using (var s = new ManagementObjectSearcher("root\\WMI", "SELECT CurrentBrightness FROM WmiMonitorBrightness"))
                    foreach (ManagementObject o in s.Get()) return Convert.ToInt32(o["CurrentBrightness"], CultureInfo.InvariantCulture);
            }
            catch { }
            return -1;
        }

        static void WmiSet(int level)
        {
            using (var s = new ManagementObjectSearcher("root\\WMI", "SELECT * FROM WmiMonitorBrightnessMethods"))
                foreach (ManagementObject o in s.Get()) o.InvokeMethod("WmiSetBrightness", new object[] { (uint)1, (byte)level });
        }

        // Brightness keys on a laptop: show the change on the island.
        static void WatchWmi()
        {
            if (watcher != null) return;
            try
            {
                watcher = new ManagementEventWatcher(new ManagementScope("root\\WMI"), new WqlEventQuery("SELECT * FROM WmiMonitorBrightnessEvent"));
                watcher.EventArrived += delegate(object sender, EventArrivedEventArgs e)
                {
                    try
                    {
                        int level = Convert.ToInt32(e.NewEvent["Brightness"], CultureInfo.InvariantCulture);
                        bool ours;
                        lock (Gate)
                        {
                            ours = level == lastSet && (DateTime.UtcNow - lastSetAt).TotalSeconds < 2;
                            current = level;
                        }
                        Send(level, ours ? "island" : "change");
                    }
                    catch { }
                };
                watcher.Start();
            }
            catch (Exception ex) { Out.Log("brightness watch: " + ex.Message); watcher = null; }
        }

        delegate void PhysicalVisitor(IntPtr handle);

        static void ForEachMonitor(PhysicalVisitor visit)
        {
            EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data)
            {
                uint count;
                if (!GetNumberOfPhysicalMonitorsFromHMONITOR(monitor, out count) || count == 0) return true;
                var list = new PHYSICAL_MONITOR[count];
                if (!GetPhysicalMonitorsFromHMONITOR(monitor, count, list)) return true;
                try { foreach (var m in list) visit(m.Handle); }
                finally { DestroyPhysicalMonitors(count, list); }
                return true;
            }, IntPtr.Zero);
        }

        static int DdcGet()
        {
            int result = -1;
            ForEachMonitor(delegate(IntPtr h)
            {
                if (result >= 0) return;
                uint min, cur, max;
                if (GetMonitorBrightness(h, out min, out cur, out max) && max > min)
                    result = (int)Math.Round((cur - min) * 100.0 / (max - min));
            });
            return result;
        }

        static void DdcSet(int level)
        {
            ForEachMonitor(delegate(IntPtr h)
            {
                uint min, cur, max;
                if (GetMonitorBrightness(h, out min, out cur, out max) && max > min)
                    SetMonitorBrightness(h, (uint)Math.Round(min + (max - min) * level / 100.0));
            });
        }
    }

    // ------------------------------------------------------- per-app muting

    static class AudioMuter
    {
        static readonly List<ISimpleAudioVolume> muted = new List<ISimpleAudioVolume>();
        static readonly List<string> mutedIds = new List<string>();

        static string RecoveryFile
        {
            get { return Path.Combine(Path.GetTempPath(), "hilal-muted.txt"); }
        }

        public static void MuteOthers(HashSet<uint> exclude)
        {
            int count = 0;
            lock (muted)
            {
                ForEachSession(delegate(ISimpleAudioVolume vol, uint pid, string instanceId)
                {
                    if (exclude.Contains(pid)) return;
                    bool isMuted;
                    vol.GetMute(out isMuted);
                    if (isMuted) return;
                    Guid ctx = Guid.Empty;
                    vol.SetMute(true, ref ctx);
                    muted.Add(vol);
                    mutedIds.Add(instanceId);
                    count++;
                });
                // Remember what we muted, so a crash can never leave apps silent.
                try { File.WriteAllLines(RecoveryFile, mutedIds.ToArray()); } catch { }
            }
            Out.Send("{\"type\":\"muted\",\"count\":" + count + "}");
        }

        public static void UnmuteAll()
        {
            lock (muted)
            {
                Guid ctx = Guid.Empty;
                foreach (var v in muted)
                {
                    try { v.SetMute(false, ref ctx); } catch { }
                }
                muted.Clear();
                mutedIds.Clear();
                try { File.Delete(RecoveryFile); } catch { }
            }
        }

        public static void RecoverFromCrash()
        {
            if (!File.Exists(RecoveryFile)) return;
            var ids = new HashSet<string>(File.ReadAllLines(RecoveryFile));
            ForEachSession(delegate(ISimpleAudioVolume vol, uint pid, string instanceId)
            {
                if (!ids.Contains(instanceId)) return;
                Guid ctx = Guid.Empty;
                vol.SetMute(false, ref ctx);
            });
            File.Delete(RecoveryFile);
        }

        delegate void SessionVisitor(ISimpleAudioVolume vol, uint pid, string instanceId);

        static void ForEachSession(SessionVisitor visit)
        {
            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            IMMDeviceCollection devices;
            enumerator.EnumAudioEndpoints(0 /* eRender */, 1 /* DEVICE_STATE_ACTIVE */, out devices);
            int deviceCount;
            devices.GetCount(out deviceCount);
            for (int d = 0; d < deviceCount; d++)
            {
                try
                {
                    IMMDevice device;
                    devices.Item(d, out device);
                    Guid iid = typeof(IAudioSessionManager2).GUID;
                    object o;
                    device.Activate(ref iid, 23 /* CLSCTX_ALL */, IntPtr.Zero, out o);
                    var manager = (IAudioSessionManager2)o;
                    IAudioSessionEnumerator sessions;
                    manager.GetSessionEnumerator(out sessions);
                    int n;
                    sessions.GetCount(out n);
                    for (int i = 0; i < n; i++)
                    {
                        try
                        {
                            IAudioSessionControl2 ctl;
                            sessions.GetSession(i, out ctl);
                            if (ctl.IsSystemSoundsSession() == 0) continue; // S_OK = system sounds
                            int state;
                            ctl.GetState(out state);
                            if (state == 2) continue; // expired
                            uint pid = 0;
                            try { ctl.GetProcessId(out pid); } catch { }
                            string instanceId = "";
                            try { ctl.GetSessionInstanceIdentifier(out instanceId); } catch { }
                            var vol = ctl as ISimpleAudioVolume;
                            if (vol != null) visit(vol, pid, instanceId ?? "");
                        }
                        catch (Exception ex) { Out.Log("audio session: " + ex.Message); }
                    }
                }
                catch (Exception ex) { Out.Log("audio device: " + ex.Message); }
            }
        }
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorComObject { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        void EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
        void GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
        void GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        void RegisterEndpointNotificationCallback(IMMNotificationClient client);
        void UnregisterEndpointNotificationCallback(IMMNotificationClient client);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection
    {
        void GetCount(out int count);
        void Item(int index, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        void Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        void OpenPropertyStore(int access, out IPropertyStore store);
        void GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        void GetState(out int state);
    }

    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        void GetCount(out int count);
        void GetAt(int index, out PROPERTYKEY key);
        void GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
    }

    [StructLayout(LayoutKind.Sequential)] struct PROPERTYKEY { public Guid fmtid; public int pid; }
    [StructLayout(LayoutKind.Sequential)] struct PROPVARIANT { public ushort vt; public ushort r1, r2, r3; public IntPtr p; public IntPtr p2; }

    [ComImport, Guid("7991EEC9-7E89-4D85-8390-6C703CEC60C0"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMNotificationClient
    {
        [PreserveSig] int OnDeviceStateChanged([MarshalAs(UnmanagedType.LPWStr)] string id, int state);
        [PreserveSig] int OnDeviceAdded([MarshalAs(UnmanagedType.LPWStr)] string id);
        [PreserveSig] int OnDeviceRemoved([MarshalAs(UnmanagedType.LPWStr)] string id);
        [PreserveSig] int OnDefaultDeviceChanged(int flow, int role, [MarshalAs(UnmanagedType.LPWStr)] string id);
        [PreserveSig] int OnPropertyValueChanged([MarshalAs(UnmanagedType.LPWStr)] string id, PROPERTYKEY key);
    }

    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioEndpointVolume
    {
        void RegisterControlChangeNotify(IAudioEndpointVolumeCallback notify);
        void UnregisterControlChangeNotify(IAudioEndpointVolumeCallback notify);
        void GetChannelCount(out uint count);
        void SetMasterVolumeLevel(float levelDB, ref Guid eventContext);
        void SetMasterVolumeLevelScalar(float level, ref Guid eventContext);
        void GetMasterVolumeLevel(out float levelDB);
        void GetMasterVolumeLevelScalar(out float level);
        void SetChannelVolumeLevel(uint channel, float levelDB, ref Guid eventContext);
        void SetChannelVolumeLevelScalar(uint channel, float level, ref Guid eventContext);
        void GetChannelVolumeLevel(uint channel, out float levelDB);
        void GetChannelVolumeLevelScalar(uint channel, out float level);
        void SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid eventContext);
        void GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    [ComImport, Guid("657804FA-D6AD-4496-8A60-352752AF4F89"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioEndpointVolumeCallback
    {
        [PreserveSig] int OnNotify(IntPtr notifyData);
    }

    [StructLayout(LayoutKind.Sequential)]
    struct AUDIO_VOLUME_NOTIFICATION_DATA { public Guid guidEventContext; public int bMuted; public float fMasterVolume; public uint nChannels; }

    [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioMeterInformation
    {
        void GetPeakValue(out float peak);
    }

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionManager2
    {
        void GetAudioSessionControl(IntPtr sessionGuid, int streamFlags, out IntPtr sessionControl);
        void GetSimpleAudioVolume(IntPtr sessionGuid, int streamFlags, out IntPtr audioVolume);
        void GetSessionEnumerator(out IAudioSessionEnumerator sessionEnum);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionEnumerator
    {
        void GetCount(out int count);
        void GetSession(int index, out IAudioSessionControl2 session);
    }

    [ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionControl2
    {
        // IAudioSessionControl
        void GetState(out int state);
        void GetDisplayName(out IntPtr name);
        void SetDisplayName(IntPtr name, IntPtr eventContext);
        void GetIconPath(out IntPtr path);
        void SetIconPath(IntPtr path, IntPtr eventContext);
        void GetGroupingParam(out Guid groupingId);
        void SetGroupingParam(IntPtr groupingId, IntPtr eventContext);
        void RegisterAudioSessionNotification(IntPtr client);
        void UnregisterAudioSessionNotification(IntPtr client);
        // IAudioSessionControl2
        void GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
        void GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
        void GetProcessId(out uint pid);
        [PreserveSig] int IsSystemSoundsSession();
        void SetDuckingPreference([MarshalAs(UnmanagedType.Bool)] bool optOut);
    }

    [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ISimpleAudioVolume
    {
        void SetMasterVolume(float level, ref Guid eventContext);
        void GetMasterVolume(out float level);
        void SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid eventContext);
        void GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    // ---------------------------------------------------------------- helpers

    static class Async
    {
        // Blocking wait for a WinRT async operation (System.Runtime.WindowsRuntime's
        // AsTask() needs the full Windows SDK metadata, which we don't have).
        public static T Await<T>(IAsyncOperation<T> op, int timeoutMs)
        {
            var done = new ManualResetEvent(false);
            op.Completed = delegate { try { done.Set(); } catch { } };
            if (!done.WaitOne(timeoutMs))
            {
                try { op.Cancel(); } catch { }
                throw new TimeoutException("operation timed out");
            }
            if (op.Status == AsyncStatus.Error)
                throw new Exception(op.ErrorCode != null ? op.ErrorCode.Message : "operation failed");
            if (op.Status == AsyncStatus.Canceled) throw new OperationCanceledException();
            return op.GetResults();
        }
    }

    static class Out
    {
        static readonly object Gate = new object();
        static readonly Stream Stdout = Console.OpenStandardOutput();

        public static void Send(string json)
        {
            byte[] bytes = Encoding.ASCII.GetBytes(json + "\n");
            lock (Gate)
            {
                try { Stdout.Write(bytes, 0, bytes.Length); Stdout.Flush(); }
                catch { Environment.Exit(0); } // parent is gone
            }
        }

        public static void Log(string message)
        {
            Send("{\"type\":\"log\",\"msg\":" + Json.Str(message) + "}");
        }
    }

    static class Json
    {
        public static string Str(string s)
        {
            if (s == null) return "null";
            var sb = new StringBuilder(s.Length + 2);
            sb.Append('"');
            foreach (char ch in s)
            {
                switch (ch)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (ch < 0x20 || ch > 0x7e) sb.Append("\\u").Append(((int)ch).ToString("x4"));
                        else sb.Append(ch);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        public static string Num(double d)
        {
            if (double.IsNaN(d) || double.IsInfinity(d)) return "0";
            return d.ToString("0.######", CultureInfo.InvariantCulture);
        }

        public static string Bool(bool b) { return b ? "true" : "false"; }
    }
}
