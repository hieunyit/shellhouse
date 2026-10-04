// Giao thức với main (src/main/rdp-native/protocol.ts): mỗi dòng một JSON UTF-8 qua stdin / stdout.
// Chỉ nhận lệnh từ stdin (ống của tiến trình cha) — không mở cổng mạng, không đọc file lệnh nào khác.
// stdin đóng (cha chết / đóng tab) → thoát. KHÔNG BAO GIỜ ghi mật khẩu ra stdout / stderr.
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace Shellhouse.RdpHost
{
    internal static class Json
    {
        private static readonly JavaScriptSerializer serializer = CreateSerializer();

        private static JavaScriptSerializer CreateSerializer()
        {
            JavaScriptSerializer s = new JavaScriptSerializer();
            s.MaxJsonLength = int.MaxValue;
            return s;
        }

        public static Dictionary<string, object> Obj(params object[] pairs)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            for (int i = 0; i + 1 < pairs.Length; i += 2) d[(string)pairs[i]] = pairs[i + 1];
            return d;
        }

        public static string Serialize(object value)
        {
            lock (serializer) return serializer.Serialize(value);
        }

        public static Dictionary<string, object> Parse(string line)
        {
            object value;
            lock (serializer) value = serializer.DeserializeObject(line);
            return value as Dictionary<string, object>;
        }
    }

    /** Ghi sự kiện ra stdout (an toàn đa luồng). */
    internal static class Output
    {
        private static StreamWriter writer;
        private static readonly object gate = new object();

        public static void Init()
        {
            writer = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            writer.AutoFlush = true;
            writer.NewLine = "\n";
        }

        public static void Send(string type, Dictionary<string, object> data)
        {
            Dictionary<string, object> message = data ?? new Dictionary<string, object>();
            message["type"] = type;
            string line = Json.Serialize(message);
            lock (gate)
            {
                try
                {
                    writer.WriteLine(line);
                }
                catch (IOException)
                {
                    // Cha đã đóng ống — luồng đọc stdin sẽ thấy EOF và cho thoát.
                }
            }
        }

        public static void Log(string level, string message)
        {
            Send("log", Json.Obj("level", level, "message", message));
        }
    }

    /** Đọc lệnh từ stdin trên luồng riêng, chuyển sang luồng giao diện. */
    internal class InputReader
    {
        /** Lệnh dài nhất chấp nhận (lệnh thật chỉ vài trăm byte). */
        private const int MaxLine = 256 * 1024;

        private readonly Action<Dictionary<string, object>> onCommand;
        private readonly Action onEnd;

        public InputReader(Action<Dictionary<string, object>> onCommand, Action onEnd)
        {
            this.onCommand = onCommand;
            this.onEnd = onEnd;
        }

        public void Start()
        {
            Thread thread = new Thread(Run);
            thread.IsBackground = true;
            thread.Name = "stdin";
            thread.Start();
        }

        private void Run()
        {
            try
            {
                using (StreamReader reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false)))
                {
                    string line;
                    while ((line = reader.ReadLine()) != null)
                    {
                        if (line.Length == 0) continue;
                        if (line.Length > MaxLine)
                        {
                            Output.Send("error", Json.Obj("message", "command too long"));
                            continue;
                        }
                        Dictionary<string, object> command = null;
                        try
                        {
                            command = Json.Parse(line);
                        }
                        catch (Exception)
                        {
                            // Không lặp lại nội dung dòng (có thể chứa mật khẩu).
                        }
                        line = null;
                        if (command == null)
                        {
                            Output.Send("error", Json.Obj("message", "invalid command"));
                            continue;
                        }
                        onCommand(command);
                    }
                }
            }
            catch (Exception)
            {
                // Ống hỏng = coi như cha đã chết.
            }
            onEnd();
        }
    }

    /** Đọc / kiểm trường của lệnh. Sai kiểu / ngoài khoảng → ArgumentException (không kèm giá trị). */
    internal static class Field
    {
        public static string Text(Dictionary<string, object> c, string name, int max, bool allowEmpty)
        {
            object v;
            if (!c.TryGetValue(name, out v) || v == null)
            {
                if (allowEmpty) return "";
                throw new ArgumentException(name + " is required");
            }
            string s = v as string;
            if (s == null) throw new ArgumentException(name + " must be a string");
            if (s.Length > max) throw new ArgumentException(name + " is too long");
            if (!allowEmpty && s.Length == 0) throw new ArgumentException(name + " is required");
            foreach (char ch in s)
                if (ch < 0x20 || ch == 0x7f) throw new ArgumentException(name + " contains control characters");
            return s;
        }

        /** Mật khẩu: chỉ kiểm độ dài (ký tự gì cũng được), không bao giờ đưa vào thông báo lỗi. */
        public static string Secret(Dictionary<string, object> c, string name, int max)
        {
            object v;
            if (!c.TryGetValue(name, out v) || v == null) return "";
            string s = v as string;
            if (s == null || s.Length > max) throw new ArgumentException(name + " is invalid");
            return s;
        }

        /** Tên máy / địa chỉ: chữ, số và . _ - : [ ] % (IPv6, cổng của gateway). */
        public static string Host(Dictionary<string, object> c, string name, bool optional)
        {
            string s = optional ? OptionalText(c, name, 255) : Text(c, name, 255, false);
            if (s == null) return null;
            if (s.StartsWith("-")) throw new ArgumentException(name + " is invalid");
            foreach (char ch in s)
            {
                bool ok = (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') ||
                    ch == '.' || ch == '_' || ch == '-' || ch == ':' || ch == '[' || ch == ']' || ch == '%';
                if (!ok) throw new ArgumentException(name + " is invalid");
            }
            return s;
        }

        public static string OptionalText(Dictionary<string, object> c, string name, int max)
        {
            object v;
            if (!c.TryGetValue(name, out v) || v == null) return null;
            return Text(c, name, max, false);
        }

        public static int Int(Dictionary<string, object> c, string name, int min, int max)
        {
            object v;
            if (!c.TryGetValue(name, out v) || v == null) throw new ArgumentException(name + " is required");
            long n;
            if (v is int) n = (int)v;
            else if (v is long) n = (long)v;
            else if (v is decimal && decimal.Truncate((decimal)v) == (decimal)v) n = (long)(decimal)v;
            else throw new ArgumentException(name + " must be an integer");
            if (n < min || n > max) throw new ArgumentException(name + " is out of range");
            return (int)n;
        }

        public static bool Bool(Dictionary<string, object> c, string name)
        {
            object v;
            if (!c.TryGetValue(name, out v) || !(v is bool)) throw new ArgumentException(name + " must be a boolean");
            return (bool)v;
        }

        public static object[] Array(Dictionary<string, object> c, string name, int max)
        {
            object v;
            if (!c.TryGetValue(name, out v)) throw new ArgumentException(name + " is required");
            object[] items = v as object[];
            if (items == null)
            {
                System.Collections.ArrayList list = v as System.Collections.ArrayList;
                if (list == null) throw new ArgumentException(name + " must be an array");
                items = list.ToArray();
            }
            if (items.Length > max) throw new ArgumentException(name + " has too many items");
            return items;
        }
    }
}
