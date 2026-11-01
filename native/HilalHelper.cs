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
using System.Globalization;
using System.IO;
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
        [MTAThread]
        static int Main(string[] args)
        {
            try { AudioMuter.RecoverFromCrash(); } catch (Exception ex) { Out.Log("recover: " + ex.Message); }
            Media.Start();
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
                default: Out.Log("unknown command: " + cmd); break;
            }
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

    static class FullscreenWatcher
    {
        [DllImport("shell32.dll")]
        static extern int SHQueryUserNotificationState(out int state);

        static Timer timer;
        static int last = -1;

        public static void Start()
        {
            timer = new Timer(delegate { Check(); }, null, 300, 1500);
        }

        static void Check()
        {
            int state;
            try { if (SHQueryUserNotificationState(out state) != 0) return; }
            catch { return; }
            // 2 = busy (fullscreen app / locked), 3 = D3D fullscreen game, 4 = presentation mode
            int fs = (state == 2 || state == 3 || state == 4) ? 1 : 0;
            if (fs == last) return;
            last = fs;
            Out.Send("{\"type\":\"fullscreen\",\"value\":" + (fs == 1 ? "true" : "false") + ",\"state\":" + state + "}");
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
