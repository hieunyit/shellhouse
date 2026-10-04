// shellhouse-rdp-host.exe — tiến trình phụ chạy control Remote Desktop gốc của Windows (mstscax.dll) cho
// tab RDP của Shellhouse. Mỗi tab một tiến trình (control lỗi / treo chỉ hỏng tab đó).
//
//   shellhouse-rdp-host.exe --parent=<HWND>   gắn vào cửa sổ Shellhouse, nhận lệnh qua stdin
//   shellhouse-rdp-host.exe --selftest        không tạo control RDP (E2E): mảng màu + sự kiện giả
//   shellhouse-rdp-host.exe --probe           kiểm typelib / tạo control rồi in báo cáo JSON (CI)
//
// Lệnh (stdin, mỗi dòng một JSON): connect, bounds, region, resize, focus, cad, disconnect, snapshot,
// query, quit. Sự kiện (stdout): ready, connecting, connected, loginComplete, disconnected, warning,
// fatalError, logonError, desktopSize, focus, focusReleased, snapshot, state, error, log.
// Định nghĩa trường: src/main/rdp-native/protocol.ts.
using System;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Shellhouse.RdpHost
{
    internal static class Program
    {
        public const string Version = "1.0.0";

        [STAThread]
        private static int Main(string[] args)
        {
            IntPtr parent = IntPtr.Zero;
            bool selftest = false, probe = false;
            Output.Init();
            foreach (string arg in args)
            {
                if (arg.StartsWith("--parent="))
                {
                    long value;
                    if (!long.TryParse(arg.Substring(9), out value) || value <= 0)
                    {
                        Fail("invalid --parent");
                        return 2;
                    }
                    parent = new IntPtr(value);
                }
                else if (arg == "--selftest") selftest = true;
                else if (arg == "--probe") probe = true;
                else
                {
                    Fail("unknown argument");
                    return 2;
                }
            }
            Native.EnableDpiAwareness();
            AppDomain.CurrentDomain.UnhandledException += delegate(object sender, UnhandledExceptionEventArgs e)
            {
                Exception ex = e.ExceptionObject as Exception;
                Fail("unhandled error: " + (ex != null ? ex.GetType().Name + ": " + ex.Message : "unknown"));
            };
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += delegate(object sender, System.Threading.ThreadExceptionEventArgs e)
            {
                Fail("unhandled error: " + e.Exception.GetType().Name + ": " + e.Exception.Message);
            };
            if (probe) return Probe();
            if (parent != IntPtr.Zero && !Native.IsWindow(parent))
            {
                Fail("the parent window does not exist");
                return 3;
            }
            Application.Run(new HostForm(parent, selftest));
            Environment.Exit(0);
            return 0;
        }

        /** Lỗi không chạy tiếp được: báo qua stdout (sự kiện error) + stderr (main đọc khi tiến trình thoát). */
        public static void Fail(string message)
        {
            Output.Send("error", Json.Obj("message", message));
            try
            {
                Console.Error.WriteLine(message);
            }
            catch { }
            Environment.Exit(3);
        }

        /**
         * Báo cáo cho CI: đọc được typelib của mstscax.dll không, các GUID / DISPID chép cứng có khớp
         * typelib của máy không, tạo được control nào. Mã thoát 0 = mọi thứ khớp và tạo được control.
         */
        private static int Probe()
        {
            Dictionary<string, object> report = new Dictionary<string, object>();
            bool ok = true;
            report["typelib"] = TypeLib.Lib != null;
            if (TypeLib.Lib == null)
            {
                report["typelibError"] = TypeLib.LoadError ?? "";
                ok = false;
            }

            Dictionary<string, object> classes = new Dictionary<string, object>();
            foreach (string[] entry in RdpControl.Classes)
            {
                Guid? guid = TypeLib.GuidOf(entry[0]);
                classes[entry[0]] = guid.HasValue ? guid.Value.ToString().ToUpperInvariant() : null;
                if (guid.HasValue && entry[1] != null && !string.Equals(guid.Value.ToString(), entry[1], StringComparison.OrdinalIgnoreCase))
                {
                    report["classMismatch"] = entry[0];
                    ok = false;
                }
            }
            report["classes"] = classes;

            Guid declared = typeof(IMsTscAxEvents).GUID;
            Guid? events = TypeLib.GuidOf("IMsTscAxEvents");
            report["eventsIid"] = events.HasValue ? events.Value.ToString().ToUpperInvariant() : null;
            if (events.HasValue && events.Value != declared)
            {
                report["eventsIidDeclared"] = declared.ToString().ToUpperInvariant();
                ok = false;
            }

            List<object> dispids = new List<object>();
            foreach (MethodInfo method in typeof(IMsTscAxEvents).GetMethods())
            {
                DispIdAttribute attr = (DispIdAttribute)Attribute.GetCustomAttribute(method, typeof(DispIdAttribute));
                int? actual = TypeLib.DispIdOf("IMsTscAxEvents", method.Name);
                bool match = actual.HasValue && attr != null && actual.Value == attr.Value;
                if (!match) ok = false;
                dispids.Add(Json.Obj(
                    "name", method.Name,
                    "declared", attr != null ? (object)attr.Value : null,
                    "actual", actual.HasValue ? (object)actual.Value : null,
                    "match", match));
            }
            report["dispids"] = dispids;

            report["extendedSettings"] = Json.Obj(
                "iid", VtableCall.ExtendedSettingsIid.ToString().ToUpperInvariant(),
                "putSlot", VtableCall.ExtendedSettingsPutSlot);
            report["nonScriptable"] = Json.Obj(
                "iid", VtableCall.NonScriptableIid.ToString().ToUpperInvariant(),
                "sendKeysSlot", VtableCall.SendKeysSlot);

            // Tạo control thật trong một cửa sổ ẩn ngoài màn hình.
            Form form = new Form();
            form.FormBorderStyle = FormBorderStyle.None;
            form.ShowInTaskbar = false;
            form.StartPosition = FormStartPosition.Manual;
            form.Location = new System.Drawing.Point(-32000, -32000);
            form.Size = new System.Drawing.Size(320, 240);
            form.Show();
            List<string> errors = new List<string>();
            RdpControl control = RdpControl.Create(form, delegate(string type, Dictionary<string, object> data) { }, errors);
            report["created"] = control != null ? control.ClassName : null;
            report["createErrors"] = errors.ToArray();
            if (control == null) ok = false;
            else
            {
                try
                {
                    report["controlVersion"] = Convert.ToString(RdpControl.Get(control.Ocx, "Version"));
                }
                catch (Exception e)
                {
                    report["controlVersionError"] = e.Message;
                }
                object adv = RdpControl.First(control.Ocx, "AdvancedSettings9", "AdvancedSettings8", "AdvancedSettings2");
                report["advancedSettings"] = adv != null;
                if (adv == null) ok = false;
                try
                {
                    VtableCall.PutExtendedProperty(control.Ocx, "DesktopScaleFactor", (uint)100);
                    report["extendedSettingsCall"] = true;
                }
                catch (Exception e)
                {
                    report["extendedSettingsCall"] = false;
                    report["extendedSettingsError"] = e.Message;
                    ok = false;
                }
                control.Unadvise();
            }
            form.Close();
            report["ok"] = ok;
            Output.Send("probe", report);
            return ok ? 0 : 1;
        }
    }
}
