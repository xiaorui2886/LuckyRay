using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using System.Text.Json;
using System.Runtime.InteropServices;

internal static class Program
{
    internal static string RunDir = "";
    internal static void Log(string type, object details) => File.AppendAllText(Path.Combine(RunDir, "native.jsonl"), JsonSerializer.Serialize(new { time = DateTimeOffset.UtcNow, type, details }) + "\n");
    [STAThread]
    static int Main(string[] args)
    {
        if (args.Length != 3) return 64;
        RunDir = Path.GetFullPath(args[0]);
        Directory.CreateDirectory(RunDir);
        try {
            if (Environment.GetEnvironmentVariables().Keys.Cast<string>().Any(k => k.StartsWith("WEBVIEW2_", StringComparison.OrdinalIgnoreCase))) throw new InvalidOperationException("Inherited WEBVIEW2 overrides are not allowed");
            var url = new Uri(args[1]);
            if (url.Host != "127.0.0.1" || url.Scheme != "http" || !int.TryParse(args[2], out var port) || port < 1024 || port > 65535) return 64;
            string version;
            try { version = CoreWebView2Environment.GetAvailableBrowserVersionString(); }
            catch (WebView2RuntimeNotFoundException e) { Log("BLOCKED_RUNTIME_MISSING", new { error = e.Message }); return 20; }
            Log("environment", new { runtime = version, os = Environment.OSVersion.ToString(), dotnet = Environment.Version.ToString(), sdk = typeof(CoreWebView2Environment).Assembly.FullName, processId = Environment.ProcessId });
            ApplicationConfiguration.Initialize();
            using var form = new HostForm(url, port);
            Application.Run(form);
            return form.Failed ? 21 : 0;
        } catch (Exception e) { Log("HOST_ERROR", new { error = e.ToString() }); return 22; }
    }
}
internal sealed class HostForm : Form
{
    readonly WebView2 view = new() { Dock = DockStyle.Fill };
    readonly Uri target;
    readonly int port;
    readonly System.Windows.Forms.Timer timer = new() { Interval = 100 };
    string? lastCommand;
    string? resizeId;
    Size requestedSize;
    Size previousClient;
    int stableTicks;
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool GetClientRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
    void ReportSettledResize()
    {
        if (resizeId == null) return;
        if (!GetClientRect(view.Handle, out var rect)) throw new InvalidOperationException("GetClientRect failed");
        var actual = new Size(rect.Right - rect.Left, rect.Bottom - rect.Top);
        stableTicks = actual == previousClient ? stableTicks + 1 : 0;
        previousClient = actual;
        if (stableTicks < 2) return;
        var area = Screen.FromControl(this).WorkingArea;
        var details = new { id = resizeId, requestedWidth = requestedSize.Width, requestedHeight = requestedSize.Height,
            formClientWidth = ClientSize.Width, formClientHeight = ClientSize.Height,
            webviewClientWidth = actual.Width, webviewClientHeight = actual.Height,
            windowDpi = GetDpiForWindow(view.Handle), managedDeviceDpi = view.DeviceDpi, zoomFactor = view.ZoomFactor,
            workAreaWidth = area.Width, workAreaHeight = area.Height };
        Program.Log("resize", details);
        var file = Path.Combine(Program.RunDir, $"resize-{resizeId}.json");
        File.WriteAllText(file + ".tmp", JsonSerializer.Serialize(details)); File.Move(file + ".tmp", file);
        resizeId = null;
    }
    public bool Failed { get; private set; }
    public HostForm(Uri target, int port)
    {
        this.target = target; this.port = port;
        Text = "LuckyRay synthetic WebView2 QA"; ClientSize = new Size(1440, 900); Controls.Add(view);
        Shown += async (_, _) => await Initialize();
        timer.Tick += (_, _) => {
            try { ReportSettledResize(); } catch (Exception e) { Fail("RESIZE_MEASUREMENT_ERROR", e.ToString()); return; }
            var file = Path.Combine(Program.RunDir, "command.json");
            if (!File.Exists(file)) return;
            try {
                var text = File.ReadAllText(file);
                if (text == lastCommand) return;
                using var json = JsonDocument.Parse(text);
                var root = json.RootElement;
                if (root.GetProperty("action").GetString() == "close") { lastCommand = text; Close(); return; }
                int width = root.GetProperty("width").GetInt32(), height = root.GetProperty("height").GetInt32();
                if (width < 640 || width > 1600 || height < 600 || height > 1200) throw new InvalidOperationException("Invalid window size");
                var id = root.GetProperty("id").GetString();
                if (id is not ("narrow" or "wide")) throw new InvalidOperationException("Invalid resize id");
                requestedSize = new Size(width, height); resizeId = id; stableTicks = 0; previousClient = Size.Empty;
                ClientSize = requestedSize; lastCommand = text;
            } catch (JsonException) { /* atomic rename may be in flight */ }
            catch (Exception e) { Fail("COMMAND_ERROR", e.ToString()); }
        };
    }
    void Fail(string type, string error) { Failed = true; Program.Log(type, new { error }); Close(); }
    async Task Initialize()
    {
        try {
            var options = new CoreWebView2EnvironmentOptions($"--remote-debugging-port={port} --remote-debugging-address=127.0.0.1");
            var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Program.RunDir, "profile"), options);
            await view.EnsureCoreWebView2Async(environment);
            view.CoreWebView2.ProcessFailed += (_, e) => Fail("PROCESS_FAILED", e.ProcessFailedKind.ToString());
            view.CoreWebView2.NavigationCompleted += (_, e) => { Program.Log("navigation", new { success = e.IsSuccess, error = e.WebErrorStatus.ToString() }); if (!e.IsSuccess) Fail("NAVIGATION_FAILED", e.WebErrorStatus.ToString()); };
            view.CoreWebView2.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            view.CoreWebView2.WebResourceRequested += (_, e) => {
                var uri = new Uri(e.Request.Uri);
                if ((uri.Scheme == "http" && uri.Authority == target.Authority) || uri.Scheme is "data" or "blob") return;
                e.Response = environment.CreateWebResourceResponse(new MemoryStream(), 403, "Blocked by synthetic QA", "Content-Type: text/plain");
                Fail("UNEXPECTED_REQUEST", uri.GetLeftPart(UriPartial.Authority));
            };
            File.WriteAllText(Path.Combine(Program.RunDir, "ready.tmp"), JsonSerializer.Serialize(new { browserVersion = environment.BrowserVersionString, browserProcessId = view.CoreWebView2.BrowserProcessId, hostProcessId = Environment.ProcessId, url = target.ToString(), debugPort = port }));
            File.Move(Path.Combine(Program.RunDir, "ready.tmp"), Path.Combine(Program.RunDir, "ready.json"));
            // Stay blank until the PowerShell listener/ownership guard permits CDP attachment.
            timer.Start();
        } catch (Exception e) { Fail("INITIALIZATION_FAILED", e.ToString()); }
    }
    protected override void Dispose(bool disposing) { if (disposing) { timer.Dispose(); view.Dispose(); } base.Dispose(disposing); }
}
