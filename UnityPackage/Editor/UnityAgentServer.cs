using System;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Collections.Generic;
using System.Collections.Concurrent;
using UnityEditor;
using UnityEngine;
using System.Reflection;

[InitializeOnLoad]
public class UnityAgentServer
{
    const int Port = 5142;
    const string Host = "127.0.0.1";

    static HttpListener httpListener;
    static Thread listenerThread;
    static readonly ConcurrentQueue<Action> pendingActions = new ConcurrentQueue<Action>();
    static volatile bool compiling;
    static List<ErrorEntry> errorCache = new List<ErrorEntry>();
    static double nextErrorPoll;

    struct ErrorEntry
    {
        public string file;
        public int line;
        public string message;
    }

    static UnityAgentServer()
    {
        EditorApplication.update += Tick;
        AppDomain.CurrentDomain.DomainUnload += (_, __) => Shutdown();
        Boot();
    }

    static void Tick()
    {
        compiling = EditorApplication.isCompiling;

        if (EditorApplication.timeSinceStartup > nextErrorPoll)
        {
            errorCache = PollErrors();
            nextErrorPoll = EditorApplication.timeSinceStartup + 1.0;
        }

        while (pendingActions.TryDequeue(out var action))
        {
            try { action(); }
            catch (Exception ex) { Debug.LogError("[UnityAgentServer] " + ex); }
        }
    }

    static void Boot()
    {
        if (!TryBindPort(Port))
        {
            if (httpListener != null && httpListener.IsListening)
                return;
            Debug.LogWarning($"[UnityAgentServer] Port {Port} already in use. Server not started.");
            return;
        }

        try
        {
            httpListener = new HttpListener();
            httpListener.Prefixes.Add($"http://{Host}:{Port}/");
            httpListener.Start();
            listenerThread = new Thread(AcceptLoop) { IsBackground = true };
            listenerThread.Start();
            Debug.Log($"[UnityAgentServer] Listening on http://{Host}:{Port}/");
        }
        catch (Exception ex)
        {
            Debug.LogError("[UnityAgentServer] Failed to start: " + ex.Message);
        }
    }

    static bool TryBindPort(int port)
    {
        try
        {
            var probe = new System.Net.Sockets.TcpListener(IPAddress.Loopback, port);
            probe.Start();
            probe.Stop();
            return true;
        }
        catch { return false; }
    }

    static void Shutdown()
    {
        EditorApplication.update -= Tick;
        try { httpListener?.Stop(); } catch { }
        try { httpListener?.Close(); } catch { }
        httpListener = null;
        try { listenerThread?.Abort(); } catch { }
        listenerThread = null;
    }

    static void AcceptLoop()
    {
        while (httpListener != null && httpListener.IsListening)
        {
            try { Dispatch(httpListener.GetContext()); }
            catch { }
        }
    }

    static void Dispatch(HttpListenerContext ctx)
    {
        try
        {
            switch (ctx.Request.Url.AbsolutePath)
            {
                case "/ping":
                    Respond(ctx, "{\"isCompiling\":" + (compiling ? "true" : "false") + "}");
                    break;
                case "/refresh":
                    pendingActions.Enqueue(() => AssetDatabase.Refresh());
                    Respond(ctx, "{\"status\":\"ok\"}");
                    break;
                case "/compile-errors":
                    Respond(ctx, ErrorsToJson(errorCache));
                    break;
                case "/exec":
                    HandleExec(ctx);
                    break;
                default:
                    ctx.Response.StatusCode = 404;
                    ctx.Response.Close();
                    break;
            }
        }
        catch (Exception ex)
        {
            Debug.LogError("[UnityAgentServer] Request error: " + ex.Message);
            try { ctx.Response.StatusCode = 500; ctx.Response.Close(); } catch { }
        }
    }

    private static void HandleExec(HttpListenerContext context)
    {
        try
        {
            // Read POST body
            string body;
            using (var reader = new StreamReader(context.Request.InputStream, context.Request.ContentEncoding))
            {
                body = reader.ReadToEnd();
            }

            // Parse method call from JSON: {"method":"ClassName.MethodName()"}
            string methodCall = "";
            // Simple JSON parse — extract "method" value
            int methodKeyIdx = body.IndexOf("\"method\"");
            if (methodKeyIdx >= 0)
            {
                int colonIdx = body.IndexOf(':', methodKeyIdx);
                int firstQuote = body.IndexOf('"', colonIdx + 1);
                int lastQuote = body.IndexOf('"', firstQuote + 1);
                if (firstQuote >= 0 && lastQuote > firstQuote)
                    methodCall = body.Substring(firstQuote + 1, lastQuote - firstQuote - 1);
            }

            if (string.IsNullOrEmpty(methodCall))
            {
                Respond(context, "{\"success\":false,\"error\":\"No method specified\",\"output\":\"\"}");
                return;
            }

            // Parse "ClassName.MethodName()" into class and method
            string cleanCall = methodCall.Replace("()", "").Trim();
            int dotIdx = cleanCall.LastIndexOf('.');
            if (dotIdx <= 0)
            {
                Respond(context, "{\"success\":false,\"error\":\"Invalid format. Use ClassName.MethodName()\",\"output\":\"\"}");
                return;
            }

            string className = cleanCall.Substring(0, dotIdx);
            string methodName = cleanCall.Substring(dotIdx + 1);

            // Find the type across all loaded assemblies
            Type targetType = null;
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                targetType = assembly.GetType(className);
                if (targetType != null) break;
            }

            if (targetType == null)
            {
                Respond(context, "{\"success\":false,\"error\":\"Type '" + JsonEscape(className) + "' not found\",\"output\":\"\"}");
                return;
            }

            MethodInfo method = targetType.GetMethod(methodName, BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            if (method == null)
            {
                Respond(context, "{\"success\":false,\"error\":\"Method '" + JsonEscape(methodName) + "' not found on type '" + JsonEscape(className) + "'\",\"output\":\"\"}");
                return;
            }

            // Execute on main thread and wait for result
            string execError = null;
            string execOutput = "";
            var waitHandle = new ManualResetEventSlim(false);

            pendingActions.Enqueue(() =>
            {
                try
                {
                    object result = method.Invoke(null, null);
                    if (result != null)
                        execOutput = result.ToString();
                }
                catch (Exception e)
                {
                    execError = e.InnerException != null ? e.InnerException.Message : e.Message;
                }
                finally
                {
                    waitHandle.Set();
                }
            });

            if (!waitHandle.Wait(120000))
            {
                Respond(context, "{\"success\":false,\"error\":\"Execution timed out\",\"output\":\"\"}");
                return;
            }

            if (execError != null)
            {
                Respond(context, "{\"success\":false,\"error\":\"" + JsonEscape(execError) + "\",\"output\":\"\"}");
            }
            else
            {
                Respond(context, "{\"success\":true,\"error\":null,\"output\":\"" + JsonEscape(execOutput) + "\"}");
            }
        }
        catch (Exception e)
        {
            Respond(context, "{\"success\":false,\"error\":\"" + JsonEscape(e.Message) + "\",\"output\":\"\"}");
        }
    }

    static void Respond(HttpListenerContext ctx, string json)
    {
        var bytes = Encoding.UTF8.GetBytes(json);
        ctx.Response.ContentType = "application/json";
        ctx.Response.ContentLength64 = bytes.Length;
        ctx.Response.OutputStream.Write(bytes, 0, bytes.Length);
        ctx.Response.OutputStream.Close();
    }

    static List<ErrorEntry> PollErrors()
    {
        var result = new List<ErrorEntry>();
        try
        {
            var logEntriesType = Type.GetType("UnityEditor.LogEntries, UnityEditor.dll");
            var logEntryType = Type.GetType("UnityEditor.LogEntry, UnityEditor.dll");
            if (logEntriesType == null || logEntryType == null) return result;

            var startMethod = logEntriesType.GetMethod("StartGettingEntries", BindingFlags.Static | BindingFlags.Public);
            var getMethod = logEntriesType.GetMethod("GetEntryInternal", BindingFlags.Static | BindingFlags.Public);
            var endMethod = logEntriesType.GetMethod("EndGettingEntries", BindingFlags.Static | BindingFlags.Public);
            if (startMethod == null || getMethod == null || endMethod == null) return result;

            var modeField = logEntryType.GetField("mode", BindingFlags.Instance | BindingFlags.Public);
            var msgField = logEntryType.GetField("message", BindingFlags.Instance | BindingFlags.Public);
            var fileField = logEntryType.GetField("file", BindingFlags.Instance | BindingFlags.Public);
            var lineField = logEntryType.GetField("line", BindingFlags.Instance | BindingFlags.Public);

            var entry = Activator.CreateInstance(logEntryType);

            int count = 0;
            for (int attempt = 0; attempt < 4; attempt++)
            {
                count = (int)startMethod.Invoke(null, null);
                if (count > 0) break;
                endMethod.Invoke(null, null);
                Thread.Sleep(250);
            }

            for (int i = 0; i < count; i++)
            {
                getMethod.Invoke(null, new object[] { i, entry });
                int mode = (int)modeField.GetValue(entry);
                string msg = (string)msgField.GetValue(entry);
                string file = (string)fileField.GetValue(entry);
                int line = (int)lineField.GetValue(entry);

                bool isError = mode == 272384 || msg.Contains("error CS") || msg.Contains("Assets/");
                if (isError && !string.IsNullOrEmpty(file) && !msg.StartsWith("[UnityAgentServer]"))
                {
                    result.Add(new ErrorEntry { file = file, line = line, message = msg });
                }
            }

            endMethod.Invoke(null, null);
        }
        catch (Exception ex)
        {
            Debug.LogError("[UnityAgentServer] Error polling logs: " + ex.Message);
        }
        return result;
    }

    static string ErrorsToJson(List<ErrorEntry> errors)
    {
        var sb = new StringBuilder("[");
        for (int i = 0; i < errors.Count; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append("{\"File\":\"").Append(JsonEscape(errors[i].file))
              .Append("\",\"Line\":").Append(errors[i].line)
              .Append(",\"Message\":\"").Append(JsonEscape(errors[i].message))
              .Append("\"}");
        }
        sb.Append(']');
        return sb.ToString();
    }

    static string JsonEscape(string s)
    {
        if (s == null) return "";
        return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n").Replace("\r", "");
    }
}
