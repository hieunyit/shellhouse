// Cửa sổ chứa control RDP. Có --parent=<HWND>: thành cửa sổ CON của cửa sổ Shellhouse (WS_CHILD +
// SetParent) — tự đi theo khi cửa sổ app di chuyển / thu nhỏ; main chỉ cần báo vị trí trong vùng client
// (pixel vật lý). Không có parent (test): cửa sổ popup không viền, toạ độ là toạ độ màn hình.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Shellhouse.RdpHost
{
    internal class HostForm : Form
    {
        private readonly IntPtr parentWindow;
        private readonly bool selftest;
        private RdpControl rdp;
        private Panel stub;
        private bool stubConnected;
        private Rectangle area = Rectangle.Empty;
        private bool areaVisible;
        private string regionMode = "none";
        private readonly List<Rectangle> holes = new List<Rectangle>();
        private bool focused;
        private Timer focusTimer;
        private Dictionary<string, object> pendingResize;
        private bool quitting;

        public HostForm(IntPtr parentWindow, bool selftest)
        {
            this.parentWindow = parentWindow;
            this.selftest = selftest;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            AutoScaleMode = AutoScaleMode.None;
            BackColor = Color.Black;
            Location = new Point(-32000, -32000);
            Size = new Size(1, 1);
            Text = "Shellhouse Remote Desktop";
        }

        /** Hiện mà không giành focus / kích hoạt — cửa sổ Shellhouse vẫn là cửa sổ đang dùng. */
        protected override bool ShowWithoutActivation
        {
            get { return true; }
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                if (parentWindow != IntPtr.Zero)
                {
                    // Tạo thẳng là cửa sổ con của cửa sổ Shellhouse. Phải nằm trong CreateParams: WinForms
                    // áp lại style từ đây (UpdateStyles) — đổi bằng SetWindowLong sau đó sẽ bị ghi đè.
                    long style = (cp.Style & 0xFFFFFFFFL) & ~(Native.WS_POPUP | Native.WS_CAPTION | Native.WS_THICKFRAME);
                    style |= Native.WS_CHILD | Native.WS_CLIPSIBLINGS | Native.WS_CLIPCHILDREN;
                    cp.Style = unchecked((int)style);
                    cp.ExStyle = (int)(cp.ExStyle & ~(Native.WS_EX_APPWINDOW | Native.WS_EX_TOOLWINDOW));
                    cp.Parent = parentWindow;
                    cp.X = 0;
                    cp.Y = 0;
                }
                else
                {
                    // Không hiện trên taskbar / Alt+Tab (chế độ test, cửa sổ riêng).
                    cp.ExStyle = (int)((cp.ExStyle | Native.WS_EX_TOOLWINDOW) & ~Native.WS_EX_APPWINDOW);
                }
                return cp;
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            // Không vẽ gì cho tới khi main báo vị trí và đã kết nối.
            Native.SetWindowRgn(Handle, Native.CreateRectRgn(0, 0, 0, 0), false);
            if (parentWindow != IntPtr.Zero) Embed();
        }

        /** Bảo đảm cửa sổ là con của cửa sổ Shellhouse (WinForms có thể đã đổi cha). */
        private void Embed()
        {
            if (Native.GetParent(Handle) == parentWindow) return;
            // MSDN SetParent: bỏ WS_POPUP, thêm WS_CHILD TRƯỚC khi đổi cha.
            long style = Native.Style(Handle, Native.GWL_STYLE);
            style &= ~(Native.WS_POPUP | Native.WS_CAPTION | Native.WS_THICKFRAME);
            style |= Native.WS_CHILD | Native.WS_CLIPSIBLINGS | Native.WS_CLIPCHILDREN;
            // Style là DWORD: GetWindowLongPtr mở rộng dấu bit 31 lên 64 bit — chỉ giữ 32 bit thấp.
            style &= 0xFFFFFFFFL;
            Native.SetStyle(Handle, Native.GWL_STYLE, style);
            if (Native.SetParent(Handle, parentWindow) == IntPtr.Zero)
            {
                Program.Fail("SetParent failed (" + Marshal.GetLastWin32Error() + ")");
                return;
            }
            Native.SetWindowPos(Handle, Native.HWND_TOP, 0, 0, 1, 1,
                Native.SWP_NOACTIVATE | Native.SWP_FRAMECHANGED | Native.SWP_NOOWNERZORDER);
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            // WinForms "đỗ" cửa sổ con không có cha WinForms vào ParkingWindow của nó khi hiện form —
            // gắn lại vào cửa sổ Shellhouse.
            if (parentWindow != IntPtr.Zero) Embed();
            string control;
            if (selftest)
            {
                // E2E: không có control RDP — một mảng màu cố định để test kiểm vị trí / thứ tự lớp.
                stub = new Panel();
                stub.Dock = DockStyle.Fill;
                stub.BackColor = Color.FromArgb(255, 0, 255);
                Controls.Add(stub);
                control = "selftest";
            }
            else
            {
                List<string> errors = new List<string>();
                rdp = RdpControl.Create(this, Emit, errors);
                if (rdp == null)
                {
                    Program.Fail("could not create the Remote Desktop control: " + string.Join("; ", errors.ToArray()));
                    return;
                }
                control = rdp.ClassName;
                try
                {
                    Output.Log("info", "control " + control + " version " + Convert.ToString(RdpControl.Get(rdp.Ocx, "Version")));
                }
                catch { }
            }
            focusTimer = new Timer();
            focusTimer.Interval = 250;
            focusTimer.Tick += delegate { PollFocus(); };
            focusTimer.Start();
            Output.Send("ready", Json.Obj(
                "control", control,
                "selftest", selftest,
                "hwnd", Handle.ToInt64().ToString(),
                "version", Program.Version));
            new InputReader(
                delegate(Dictionary<string, object> c) { Post(delegate { Execute(c); }); },
                delegate { Post(Quit); }).Start();
        }

        private void Post(MethodInvoker action)
        {
            try
            {
                BeginInvoke(action);
            }
            catch (Exception)
            {
                // Cửa sổ đã huỷ (đang thoát).
                Environment.Exit(0);
            }
        }

        /** Sự kiện của control → stdout (+ việc phải làm kèm). */
        private void Emit(string type, Dictionary<string, object> data)
        {
            Output.Send(type, data);
            if (type == "loginComplete" && pendingResize != null)
            {
                Dictionary<string, object> resize = pendingResize;
                pendingResize = null;
                ResizeSession(resize);
            }
            if (type == "disconnected" && quitting) Exit();
        }

        private void Execute(Dictionary<string, object> c)
        {
            object rawType;
            string type = c.TryGetValue("type", out rawType) ? rawType as string : null;
            try
            {
                switch (type)
                {
                    case "connect": Connect(c); break;
                    case "bounds":
                        ApplyBounds(
                            Field.Int(c, "x", -100000, 100000),
                            Field.Int(c, "y", -100000, 100000),
                            Field.Int(c, "width", 0, 100000),
                            Field.Int(c, "height", 0, 100000),
                            Field.Bool(c, "visible"));
                        break;
                    case "region": SetRegion(c); break;
                    case "resize": ResizeSession(c); break;
                    case "focus": FocusControl(); break;
                    case "cad": SendCtrlAltDel(); break;
                    case "disconnect": Disconnect(); break;
                    case "quit": Quit(); break;
                    case "snapshot": Snapshot(Field.Int(c, "id", 0, int.MaxValue)); break;
                    case "query": Query(Field.Int(c, "id", 0, int.MaxValue)); break;
                    default: throw new ArgumentException("unknown command");
                }
            }
            catch (Exception e)
            {
                Output.Send("error", Json.Obj("message", (type ?? "?") + ": " + e.Message));
            }
        }

        // ——— Kết nối ———

        private readonly List<string> skipped = new List<string>();

        private void Try(object target, string name, object value)
        {
            try
            {
                RdpControl.Set(target, name, value);
            }
            catch (Exception)
            {
                skipped.Add(name);
            }
        }

        private void Connect(Dictionary<string, object> c)
        {
            string server = Field.Host(c, "server", false);
            int port = Field.Int(c, "port", 1, 65535);
            string username = Field.Text(c, "username", 256, true);
            string domain = Field.Text(c, "domain", 255, true);
            string password = Field.Secret(c, "password", 1024);
            c.Remove("password");
            string gateway = Field.Host(c, "gateway", true);
            int width = Field.Int(c, "width", 200, 8192);
            int height = Field.Int(c, "height", 200, 8192);
            int desktopScale = Field.Int(c, "desktopScale", 100, 500);
            int deviceScale = Field.Int(c, "deviceScale", 100, 180);
            int colorDepth = Field.Int(c, "colorDepth", 15, 32);
            bool smartSizing = Field.Bool(c, "smartSizing");
            bool clipboard = Field.Bool(c, "clipboard");
            bool drives = Field.Bool(c, "drives");
            bool printers = Field.Bool(c, "printers");
            int audioMode = Field.Int(c, "audioMode", 0, 2);
            int keyboardHookMode = Field.Int(c, "keyboardHookMode", 0, 2);
            int authenticationLevel = Field.Int(c, "authenticationLevel", 0, 2);
            bool enableCredSsp = Field.Bool(c, "enableCredSsp");

            if (selftest)
            {
                password = null;
                SelftestConnect(width, height);
                return;
            }
            if (rdp.Connected) throw new InvalidOperationException("already connected");
            object ocx = rdp.Ocx;
            skipped.Clear();
            RdpControl.Set(ocx, "Server", server);
            Try(ocx, "UserName", username);
            Try(ocx, "Domain", domain);
            Try(ocx, "DesktopWidth", width);
            Try(ocx, "DesktopHeight", height);
            Try(ocx, "ColorDepth", colorDepth);

            object adv = RdpControl.First(ocx,
                "AdvancedSettings9", "AdvancedSettings8", "AdvancedSettings7", "AdvancedSettings6",
                "AdvancedSettings5", "AdvancedSettings4", "AdvancedSettings3", "AdvancedSettings2");
            if (adv == null) throw new InvalidOperationException("AdvancedSettings is not available");
            RdpControl.Set(adv, "RDPPort", port);
            if (password.Length > 0)
            {
                try
                {
                    RdpControl.Set(adv, "ClearTextPassword", password);
                }
                catch (Exception)
                {
                    Output.Log("warn", "could not pass the password to the control — it will ask");
                }
            }
            // Chuỗi .NET không xoá được tại chỗ; bỏ tham chiếu ngay để GC thu sớm nhất có thể.
            password = null;
            Try(adv, "EnableCredSspSupport", enableCredSsp);
            Try(adv, "AuthenticationLevel", (uint)authenticationLevel);
            Try(adv, "NegotiateSecurityLayer", true);
            Try(adv, "SmartSizing", smartSizing);
            Try(adv, "RedirectClipboard", clipboard);
            Try(adv, "RedirectDrives", drives);
            Try(adv, "RedirectPrinters", printers);
            Try(adv, "EnableAutoReconnect", true);
            Try(adv, "BitmapPersistence", 1);
            Try(adv, "Compress", 1);
            // Tự dò băng thông (RemoteFX / AVC khi mạng cho phép) như mstsc.
            Try(adv, "BandwidthDetection", true);
            Try(adv, "NetworkConnectionType", (uint)7);
            // Toàn màn hình do Shellhouse lo (Fullscreen API của trang), control không tự bung cửa sổ.
            Try(adv, "ContainerHandledFullScreen", 1);

            object secured = RdpControl.First(ocx, "SecuredSettings3", "SecuredSettings2");
            if (secured != null)
            {
                Try(secured, "AudioRedirectionMode", audioMode);
                Try(secured, "KeyboardHookMode", keyboardHookMode);
            }
            else skipped.Add("SecuredSettings");

            if (gateway != null)
            {
                object ts = RdpControl.First(ocx, "TransportSettings4", "TransportSettings3", "TransportSettings2", "TransportSettings");
                if (ts == null) throw new InvalidOperationException("RD Gateway settings are not available");
                RdpControl.Set(ts, "GatewayHostname", gateway);
                RdpControl.Set(ts, "GatewayUsageMethod", (uint)1);
                Try(ts, "GatewayProfileUsageMethod", (uint)1);
                Try(ts, "GatewayCredsSource", (uint)0);
                // Đăng nhập gateway bằng chính thông tin đăng nhập của máy đích.
                Try(ts, "GatewayCredSharing", (uint)1);
            }

            try
            {
                VtableCall.PutExtendedProperty(ocx, "DesktopScaleFactor", (uint)desktopScale);
                VtableCall.PutExtendedProperty(ocx, "DeviceScaleFactor", (uint)deviceScale);
            }
            catch (Exception)
            {
                skipped.Add("ScaleFactor");
            }
            if (skipped.Count > 0) Output.Log("warn", "settings not applied: " + string.Join(", ", skipped.ToArray()));
            RdpControl.Call(ocx, "Connect");
        }

        private void SelftestConnect(int width, int height)
        {
            Output.Send("connecting", null);
            Timer t = new Timer();
            t.Interval = 200;
            t.Tick += delegate
            {
                t.Stop();
                t.Dispose();
                stubConnected = true;
                Output.Send("connected", null);
                Output.Send("loginComplete", null);
                Output.Send("desktopSize", Json.Obj("width", width, "height", height));
            };
            t.Start();
        }

        private void Disconnect()
        {
            if (selftest)
            {
                if (!stubConnected) return;
                stubConnected = false;
                Emit("disconnected", Json.Obj("reason", 1, "extended", 0, "message", "selftest"));
                return;
            }
            if (rdp == null) return;
            try
            {
                RdpControl.Call(rdp.Ocx, "Disconnect");
            }
            catch (Exception)
            {
                // Chưa kết nối — không có gì để ngắt.
            }
        }

        /** Đổi độ phân giải phiên theo vùng tab (IMsRdpClient9::UpdateSessionDisplaySettings). */
        private void ResizeSession(Dictionary<string, object> c)
        {
            int width = Field.Int(c, "width", 200, 8192);
            int height = Field.Int(c, "height", 200, 8192);
            int desktopScale = Field.Int(c, "desktopScale", 100, 500);
            int deviceScale = Field.Int(c, "deviceScale", 100, 180);
            if (selftest)
            {
                Output.Send("desktopSize", Json.Obj("width", width, "height", height));
                return;
            }
            if (rdp == null || !rdp.LoggedIn)
            {
                // Chỉ đổi được sau khi đăng nhập xong — làm lúc loginComplete.
                pendingResize = c;
                return;
            }
            // Kích thước vật lý (mm) theo DPI tương ứng hệ số scale.
            double dpi = 96.0 * desktopScale / 100.0;
            uint widthMm = (uint)Math.Max(10, Math.Round(width * 25.4 / dpi));
            uint heightMm = (uint)Math.Max(10, Math.Round(height * 25.4 / dpi));
            try
            {
                RdpControl.Call(rdp.Ocx, "UpdateSessionDisplaySettings",
                    (uint)width, (uint)height, widthMm, heightMm, (uint)0, (uint)desktopScale, (uint)deviceScale);
            }
            catch (Exception e)
            {
                Output.Log("warn", "UpdateSessionDisplaySettings failed: " + e.Message);
            }
        }

        private void FocusControl()
        {
            if (rdp != null) rdp.Host.Focus();
            else if (stub != null) stub.Focus();
        }

        private void SendCtrlAltDel()
        {
            if (selftest)
            {
                Output.Log("info", "selftest: Ctrl+Alt+Del");
                return;
            }
            if (rdp == null || !rdp.Connected) return;
            rdp.Host.Focus();
            // Ctrl, Alt, Del xuống rồi nhả (mã quét set 1) — control gửi thành SAS ở máy từ xa.
            VtableCall.SendKeys(rdp.Ocx,
                new int[] { 0x1d, 0x38, 0x53, 0x53, 0x38, 0x1d },
                new bool[] { false, false, false, true, true, true });
        }

        // ——— Vị trí, hiện / ẩn, lỗ cho lớp phủ ———

        private void ApplyBounds(int x, int y, int width, int height, bool visible)
        {
            area = new Rectangle(x, y, width, height);
            areaVisible = visible && width > 0 && height > 0;
            uint flags = Native.SWP_NOACTIVATE | Native.SWP_NOOWNERZORDER |
                (areaVisible ? Native.SWP_SHOWWINDOW : Native.SWP_HIDEWINDOW);
            if (parentWindow == IntPtr.Zero) flags |= Native.SWP_NOZORDER;
            else Embed();
            // HWND_TOP mỗi lần: Chromium có thể tạo / xếp lại cửa sổ con của nó.
            Native.SetWindowPos(Handle, Native.HWND_TOP, x, y, Math.Max(1, width), Math.Max(1, height), flags);
            ApplyRegion();
        }

        private void SetRegion(Dictionary<string, object> c)
        {
            string mode = Field.Text(c, "mode", 16, false);
            holes.Clear();
            if (mode == "holes")
            {
                foreach (object item in Field.Array(c, "holes", 32))
                {
                    Dictionary<string, object> h = item as Dictionary<string, object>;
                    if (h == null) throw new ArgumentException("holes must contain objects");
                    holes.Add(new Rectangle(
                        Field.Int(h, "x", 0, 100000), Field.Int(h, "y", 0, 100000),
                        Field.Int(h, "width", 0, 100000), Field.Int(h, "height", 0, 100000)));
                }
            }
            else if (mode != "full" && mode != "none") throw new ArgumentException("invalid region mode");
            regionMode = mode;
            ApplyRegion();
        }

        /** Vùng cửa sổ (toạ độ cửa sổ): Windows sở hữu region sau khi SetWindowRgn thành công. */
        private void ApplyRegion()
        {
            if (regionMode == "full")
            {
                Native.SetWindowRgn(Handle, IntPtr.Zero, true);
                return;
            }
            IntPtr region;
            if (regionMode == "none") region = Native.CreateRectRgn(0, 0, 0, 0);
            else
            {
                region = Native.CreateRectRgn(0, 0, Math.Max(1, area.Width), Math.Max(1, area.Height));
                foreach (Rectangle h in holes)
                {
                    IntPtr hole = Native.CreateRectRgn(h.Left, h.Top, h.Right, h.Bottom);
                    Native.CombineRgn(region, region, hole, Native.RGN_DIFF);
                    Native.DeleteObject(hole);
                }
            }
            if (Native.SetWindowRgn(Handle, region, true) == 0) Native.DeleteObject(region);
        }

        private void PollFocus()
        {
            GUITHREADINFO info = new GUITHREADINFO();
            info.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
            bool now = false;
            if (Native.GetGUIThreadInfo(0, ref info) && info.hwndFocus != IntPtr.Zero)
                now = info.hwndFocus == Handle || Native.IsChild(Handle, info.hwndFocus);
            if (now == focused) return;
            focused = now;
            Output.Send("focus", Json.Obj("focused", now));
        }

        // ——— Ảnh chụp / trạng thái ———

        private void Snapshot(int id)
        {
            int width = area.Width, height = area.Height;
            if (width <= 0 || height <= 0 || !areaVisible)
            {
                Output.Send("snapshot", Json.Obj("id", id, "ok", false, "message", "not visible"));
                return;
            }
            using (Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format24bppRgb))
            {
                bool printed;
                using (Graphics g = Graphics.FromImage(bitmap))
                {
                    IntPtr hdc = g.GetHdc();
                    try
                    {
                        // PW_RENDERFULLCONTENT: lấy được cả nội dung vẽ bằng GPU (RemoteFX / AVC).
                        printed = Native.PrintWindow(Handle, hdc, Native.PW_RENDERFULLCONTENT);
                    }
                    finally
                    {
                        g.ReleaseHdc(hdc);
                    }
                }
                if (!printed || MostlyBlack(bitmap))
                {
                    RECT r;
                    Native.GetWindowRect(Handle, out r);
                    using (Graphics g = Graphics.FromImage(bitmap))
                        g.CopyFromScreen(r.Left, r.Top, 0, 0, new Size(width, height));
                }
                Output.Send("snapshot", Json.Obj(
                    "id", id, "ok", true, "data", Jpeg(bitmap), "width", width, "height", height));
            }
        }

        private static bool MostlyBlack(Bitmap bitmap)
        {
            int dark = 0, total = 0;
            for (int i = 1; i < 16; i++)
                for (int j = 1; j < 16; j++)
                {
                    Color c = bitmap.GetPixel(bitmap.Width * i / 16, bitmap.Height * j / 16);
                    total++;
                    if (c.R + c.G + c.B < 24) dark++;
                }
            return dark == total;
        }

        private static string Jpeg(Bitmap bitmap)
        {
            ImageCodecInfo codec = null;
            foreach (ImageCodecInfo info in ImageCodecInfo.GetImageEncoders())
                if (info.MimeType == "image/jpeg") codec = info;
            using (MemoryStream stream = new MemoryStream())
            {
                if (codec == null) bitmap.Save(stream, ImageFormat.Jpeg);
                else
                {
                    using (EncoderParameters p = new EncoderParameters(1))
                    {
                        p.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 82L);
                        bitmap.Save(stream, codec, p);
                    }
                }
                return Convert.ToBase64String(stream.ToArray());
            }
        }

        private void Query(int id)
        {
            RECT r;
            Native.GetWindowRect(Handle, out r);
            POINT p = new POINT();
            p.X = r.Left;
            p.Y = r.Top;
            if (parentWindow != IntPtr.Zero) Native.ScreenToClient(parentWindow, ref p);
            Dictionary<string, object> state = Json.Obj(
                "id", id,
                "hwnd", Handle.ToInt64().ToString(),
                "parent", Native.GetParent(Handle).ToInt64().ToString(),
                "x", p.X,
                "y", p.Y,
                "width", r.Right - r.Left,
                "height", r.Bottom - r.Top,
                "visible", Native.IsWindowVisible(Handle),
                "region", regionMode,
                "connected", selftest ? stubConnected : rdp != null && rdp.Connected);
            if (selftest && r.Right > r.Left && r.Bottom > r.Top)
            {
                // Màu điểm giữa đọc từ MÀN HÌNH: magenta = cửa sổ thật sự nổi trên nội dung web.
                using (Bitmap one = new Bitmap(1, 1, PixelFormat.Format24bppRgb))
                {
                    using (Graphics g = Graphics.FromImage(one))
                        g.CopyFromScreen((r.Left + r.Right) / 2, (r.Top + r.Bottom) / 2, 0, 0, new Size(1, 1));
                    Color c = one.GetPixel(0, 0);
                    state["screenColor"] = string.Format("#{0:X2}{1:X2}{2:X2}", c.R, c.G, c.B);
                }
            }
            Output.Send("state", state);
        }

        // ——— Thoát ———

        private void Quit()
        {
            if (quitting) return;
            quitting = true;
            if (rdp != null && rdp.Connected)
            {
                Disconnect();
                // Không đợi mãi nếu control không báo ngắt.
                Timer t = new Timer();
                t.Interval = 1500;
                t.Tick += delegate { Exit(); };
                t.Start();
                return;
            }
            Exit();
        }

        private void Exit()
        {
            if (focusTimer != null) focusTimer.Stop();
            if (rdp != null) rdp.Unadvise();
            Application.ExitThread();
        }
    }
}
