// Đọc type library của mstscax.dll lúc chạy: CLSID của các lớp MsRdpClient*NotSafeForScripting, IID và
// vị trí vtable của các interface không có IDispatch (IMsRdpClientNonScriptable, IMsRdpExtendedSettings),
// DISPID của sự kiện. Không phải chép cứng GUID / thứ tự hàm — chỉ dùng giá trị chép cứng khi không đọc
// được typelib. Chế độ --probe so khớp hai nguồn (CI Windows chạy nó).
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using FUNCDESC = System.Runtime.InteropServices.ComTypes.FUNCDESC;
using INVOKEKIND = System.Runtime.InteropServices.ComTypes.INVOKEKIND;
using TYPEATTR = System.Runtime.InteropServices.ComTypes.TYPEATTR;

namespace Shellhouse.RdpHost
{
    internal static class TypeLib
    {
        [DllImport("oleaut32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
        private static extern ITypeLib LoadTypeLib(string file);

        private static ITypeLib lib;
        private static bool loaded;
        public static string LoadError;

        public static ITypeLib Lib
        {
            get
            {
                if (!loaded)
                {
                    loaded = true;
                    try
                    {
                        lib = LoadTypeLib(Path.Combine(Environment.SystemDirectory, "mstscax.dll"));
                    }
                    catch (Exception e)
                    {
                        LoadError = e.Message;
                    }
                }
                return lib;
            }
        }

        private static ITypeInfo Find(string name)
        {
            ITypeLib l = Lib;
            if (l == null) return null;
            int count = l.GetTypeInfoCount();
            for (int i = 0; i < count; i++)
            {
                string found, doc, help;
                int context;
                l.GetDocumentation(i, out found, out doc, out context, out help);
                if (found == name)
                {
                    ITypeInfo info;
                    l.GetTypeInfo(i, out info);
                    return info;
                }
            }
            return null;
        }

        private static TYPEATTR Attr(ITypeInfo info)
        {
            IntPtr p;
            info.GetTypeAttr(out p);
            try
            {
                return (TYPEATTR)Marshal.PtrToStructure(p, typeof(TYPEATTR));
            }
            finally
            {
                info.ReleaseTypeAttr(p);
            }
        }

        /** GUID của một coclass / interface theo tên; null = không có trong typelib. */
        public static Guid? GuidOf(string name)
        {
            try
            {
                ITypeInfo info = Find(name);
                if (info == null) return null;
                return Attr(info).guid;
            }
            catch
            {
                return null;
            }
        }

        /** DISPID của một thành viên (sự kiện của dispinterface). */
        public static int? DispIdOf(string iface, string member)
        {
            try
            {
                ITypeInfo info = Find(iface);
                if (info == null) return null;
                int[] ids = new int[1];
                info.GetIDsOfNames(new string[] { member }, 1, ids);
                return ids[0];
            }
            catch
            {
                return null;
            }
        }

        /** Vị trí trong vtable (đã tính interface cha) của một hàm; null = không tìm thấy. */
        public static int? SlotOf(string iface, string member, INVOKEKIND kind)
        {
            try
            {
                ITypeInfo info = Find(iface);
                if (info == null) return null;
                TYPEATTR attr = Attr(info);
                for (int i = 0; i < attr.cFuncs; i++)
                {
                    IntPtr p;
                    info.GetFuncDesc(i, out p);
                    try
                    {
                        FUNCDESC fd = (FUNCDESC)Marshal.PtrToStructure(p, typeof(FUNCDESC));
                        if (fd.invkind != kind) continue;
                        string[] names = new string[1];
                        int got;
                        info.GetNames(fd.memid, names, 1, out got);
                        if (got == 1 && names[0] == member) return fd.oVft / IntPtr.Size;
                    }
                    finally
                    {
                        info.ReleaseFuncDesc(p);
                    }
                }
                return null;
            }
            catch
            {
                return null;
            }
        }
    }

    /** Gọi hàm của interface chỉ có vtable (không IDispatch) qua IID + vị trí lấy từ typelib. */
    internal static class VtableCall
    {
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int PutPropertyFn(IntPtr self, [MarshalAs(UnmanagedType.BStr)] string name, ref object value);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int SendKeysFn(
            IntPtr self,
            int count,
            [MarshalAs(UnmanagedType.LPArray)] short[] keyUp,
            [MarshalAs(UnmanagedType.LPArray)] int[] keyData);

        // Giá trị dự phòng (mstscax.idl) khi không đọc được typelib.
        private static readonly Guid FallbackExtendedSettings = new Guid("302D8188-0052-4807-806A-362B628F9AC5");
        private static readonly Guid FallbackNonScriptable = new Guid("2F079C4C-87B2-4AFD-97AB-20CDB43038AE");

        public static Guid ExtendedSettingsIid
        {
            get { return TypeLib.GuidOf("IMsRdpExtendedSettings") ?? FallbackExtendedSettings; }
        }

        public static int ExtendedSettingsPutSlot
        {
            get { return TypeLib.SlotOf("IMsRdpExtendedSettings", "Property", INVOKEKIND.INVOKE_PROPERTYPUT) ?? 3; }
        }

        public static Guid NonScriptableIid
        {
            get { return TypeLib.GuidOf("IMsRdpClientNonScriptable") ?? FallbackNonScriptable; }
        }

        public static int SendKeysSlot
        {
            get { return TypeLib.SlotOf("IMsRdpClientNonScriptable", "SendKeys", INVOKEKIND.INVOKE_FUNC) ?? 14; }
        }

        private static IntPtr Query(object obj, Guid iid)
        {
            IntPtr unknown = Marshal.GetIUnknownForObject(obj);
            try
            {
                IntPtr result;
                int hr = Marshal.QueryInterface(unknown, ref iid, out result);
                if (hr < 0) Marshal.ThrowExceptionForHR(hr);
                return result;
            }
            finally
            {
                Marshal.Release(unknown);
            }
        }

        private static T Method<T>(IntPtr self, int slot) where T : class
        {
            IntPtr vtable = Marshal.ReadIntPtr(self);
            IntPtr fn = Marshal.ReadIntPtr(vtable, slot * IntPtr.Size);
            return Marshal.GetDelegateForFunctionPointer(fn, typeof(T)) as T;
        }

        /** IMsRdpExtendedSettings::put_Property (DesktopScaleFactor, DeviceScaleFactor…). */
        public static void PutExtendedProperty(object ocx, string name, object value)
        {
            IntPtr self = Query(ocx, ExtendedSettingsIid);
            try
            {
                int hr = Method<PutPropertyFn>(self, ExtendedSettingsPutSlot)(self, name, ref value);
                if (hr < 0) Marshal.ThrowExceptionForHR(hr);
            }
            finally
            {
                Marshal.Release(self);
            }
        }

        /** IMsRdpClientNonScriptable::SendKeys — mã quét, keyUp = VARIANT_BOOL (-1 / 0). */
        public static void SendKeys(object ocx, int[] scanCodes, bool[] up)
        {
            short[] flags = new short[up.Length];
            for (int i = 0; i < up.Length; i++) flags[i] = up[i] ? (short)-1 : (short)0;
            IntPtr self = Query(ocx, NonScriptableIid);
            try
            {
                int hr = Method<SendKeysFn>(self, SendKeysSlot)(self, scanCodes.Length, flags, scanCodes);
                if (hr < 0) Marshal.ThrowExceptionForHR(hr);
            }
            finally
            {
                Marshal.Release(self);
            }
        }
    }
}
