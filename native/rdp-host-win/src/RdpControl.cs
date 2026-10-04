// Control RDP (MsRdpClient*NotSafeForScripting trong mstscax.dll) bọc trong AxHost của WinForms: AxHost lo
// phần chứa ActiveX (IOleClientSite, kích hoạt tại chỗ, focus, phím tắt) — cùng cách mRemoteNG / RDCMan.
// Thuộc tính / phương thức gọi qua IDispatch (late binding theo tên, không cần interop assembly); sự kiện
// nhận qua connection point với dispinterface IMsTscAxEvents khai báo bên dưới.
using System;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Windows.Forms;

namespace Shellhouse.RdpHost
{
    /**
     * Sự kiện của control (dispinterface IMsTscAxEvents, mstsax.idl). Chỉ khai báo sự kiện cần dùng; DISPID
     * khác control gọi tới thì CLR trả DISP_E_MEMBERNOTFOUND (control bỏ qua). `--probe` so DISPID ở đây
     * với typelib thật của máy.
     */
    [ComVisible(true)]
    [Guid("336D5562-EFA8-482E-8CB3-C5C0FC7A7DB6")]
    [InterfaceType(ComInterfaceType.InterfaceIsIDispatch)]
    public interface IMsTscAxEvents
    {
        [DispId(1)] void OnConnecting();
        [DispId(2)] void OnConnected();
        [DispId(3)] void OnLoginComplete();
        [DispId(4)] void OnDisconnected(int discReason);
        [DispId(10)] void OnFatalError(int errorCode);
        [DispId(11)] void OnWarning(int warningCode);
        [DispId(12)] void OnRemoteDesktopSizeChange(int width, int height);
        [DispId(22)] void OnLogonError(int lError);
        [DispId(23)] void OnFocusReleased(int iDirection);
    }

    [ComVisible(true)]
    [ClassInterface(ClassInterfaceType.None)]
    public class RdpEventSink : IMsTscAxEvents
    {
        private readonly RdpControl owner;

        internal RdpEventSink(RdpControl owner)
        {
            this.owner = owner;
        }

        public void OnConnecting() { owner.Raise("connecting", null); }
        public void OnConnected() { owner.Raise("connected", null); }
        public void OnLoginComplete() { owner.Raise("loginComplete", null); }
        public void OnDisconnected(int discReason) { owner.OnDisconnected(discReason); }
        public void OnFatalError(int errorCode) { owner.Raise("fatalError", Json.Obj("code", errorCode)); }
        public void OnWarning(int warningCode) { owner.Raise("warning", Json.Obj("code", warningCode)); }
        public void OnRemoteDesktopSizeChange(int width, int height) { owner.Raise("desktopSize", Json.Obj("width", width, "height", height)); }
        public void OnLogonError(int lError) { owner.Raise("logonError", Json.Obj("code", lError)); }
        public void OnFocusReleased(int iDirection) { owner.Raise("focusReleased", Json.Obj("direction", iDirection)); }
    }

    internal class RdpAx : AxHost
    {
        public RdpAx(string clsid) : base(clsid) { }

        public object Ocx
        {
            get { return GetOcx(); }
        }
    }

    internal class RdpControl
    {
        /** Lớp control theo thứ tự ưu tiên; CLSID dự phòng khi không đọc được typelib. */
        public static readonly string[][] Classes = new string[][]
        {
            new string[] { "MsRdpClient11NotSafeForScripting", "1DF7C823-B2D4-4B54-975A-F2AC5D7CF8B8" },
            new string[] { "MsRdpClient10NotSafeForScripting", "A0C63C30-F08D-4AB4-907C-34905D770C7D" },
            new string[] { "MsRdpClient9NotSafeForScripting", "8B918B82-7985-4C24-89DF-C33AD2BBFBCD" },
            new string[] { "MsRdpClient8NotSafeForScripting", "A3BC03A0-041D-42E3-AD22-882B7865C9C5" },
            new string[] { "MsRdpClient7NotSafeForScripting", "54D38BF7-B1EF-4479-9674-1BD6EA465258" }
        };

        public readonly RdpAx Host;
        public readonly string ClassName;
        private readonly Action<string, Dictionary<string, object>> emit;
        private IConnectionPoint connectionPoint;
        private int cookie;
        public bool Connected;
        public bool LoggedIn;

        private RdpControl(RdpAx host, string className, Action<string, Dictionary<string, object>> emit)
        {
            Host = host;
            ClassName = className;
            this.emit = emit;
        }

        public object Ocx
        {
            get { return Host.Ocx; }
        }

        /** Tạo control trong `container` (đã có handle); thử từng lớp, lớp mới nhất trước. */
        public static RdpControl Create(Control container, Action<string, Dictionary<string, object>> emit, List<string> errors)
        {
            foreach (string[] entry in Classes)
            {
                Guid? clsid = TypeLib.GuidOf(entry[0]);
                if (clsid == null && entry[1] != null) clsid = new Guid(entry[1]);
                if (clsid == null) continue;
                RdpAx ax = null;
                try
                {
                    ax = new RdpAx(clsid.Value.ToString());
                    ((System.ComponentModel.ISupportInitialize)ax).BeginInit();
                    ax.Dock = DockStyle.Fill;
                    container.Controls.Add(ax);
                    ((System.ComponentModel.ISupportInitialize)ax).EndInit();
                    ax.CreateControl();
                    if (ax.Ocx == null) throw new InvalidOperationException("no control object");
                    RdpControl control = new RdpControl(ax, entry[0], emit);
                    control.Advise();
                    return control;
                }
                catch (Exception e)
                {
                    errors.Add(entry[0] + ": " + e.Message);
                    if (ax != null)
                    {
                        try
                        {
                            container.Controls.Remove(ax);
                            ax.Dispose();
                        }
                        catch { }
                    }
                }
            }
            return null;
        }

        private void Advise()
        {
            IConnectionPointContainer container = (IConnectionPointContainer)Ocx;
            Guid iid = typeof(IMsTscAxEvents).GUID;
            container.FindConnectionPoint(ref iid, out connectionPoint);
            connectionPoint.Advise(new RdpEventSink(this), out cookie);
        }

        public void Unadvise()
        {
            if (connectionPoint == null) return;
            try
            {
                connectionPoint.Unadvise(cookie);
            }
            catch { }
            connectionPoint = null;
        }

        internal void Raise(string type, Dictionary<string, object> data)
        {
            if (type == "connected") Connected = true;
            if (type == "loginComplete") LoggedIn = true;
            emit(type, data);
        }

        internal void OnDisconnected(int reason)
        {
            Connected = false;
            LoggedIn = false;
            int extended = 0;
            string message = "";
            try
            {
                extended = Convert.ToInt32(Get(Ocx, "ExtendedDisconnectReason"));
            }
            catch { }
            try
            {
                object text = Call(Ocx, "GetErrorDescription", (uint)reason, (uint)extended);
                message = text as string ?? "";
            }
            catch { }
            emit("disconnected", Json.Obj("reason", reason, "extended", extended, "message", message));
        }

        // ——— IDispatch theo tên ———

        public static object Get(object target, string name)
        {
            return target.GetType().InvokeMember(name, BindingFlags.GetProperty, null, target, null);
        }

        public static void Set(object target, string name, object value)
        {
            target.GetType().InvokeMember(name, BindingFlags.SetProperty, null, target, new object[] { value });
        }

        public static object Call(object target, string name, params object[] args)
        {
            return target.GetType().InvokeMember(name, BindingFlags.InvokeMethod, null, target, args);
        }

        /** Thuộc tính đầu tiên đọc được (AdvancedSettings9 → … → AdvancedSettings2). */
        public static object First(object target, params string[] names)
        {
            foreach (string name in names)
            {
                try
                {
                    object value = Get(target, name);
                    if (value != null) return value;
                }
                catch { }
            }
            return null;
        }
    }
}
