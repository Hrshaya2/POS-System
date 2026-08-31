// StartPOS.cs - one-click launcher for the Nangi POS system.
//
//   StartPOS.exe        (or: StartPOS.exe start) -> starts backend (port 5000)
//                           and frontend (port 5173) hidden, waits for them,
//                           then opens the browser at http://localhost:5173
//   StartPOS.exe stop   -> stops both servers (kills whatever is LISTENING
//                           on those ports)
//
// Compiled with the C# compiler that ships with Windows (C# 5 syntax only):
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo
//     /target:winexe /out:StartPOS.exe /win32icon:pos.ico
//     /r:System.dll /r:System.Core.dll /r:System.Windows.Forms.dll StartPOS.cs

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace PosLauncher
{
    internal static class Program
    {
        private const int FrontPort = 5173;
        private const int BackPort = 5000;

        [STAThread]
        private static int Main(string[] args)
        {
            string mode = args.Length > 0 ? args[0].ToLowerInvariant() : "start";
            string exeDir = AppDomain.CurrentDomain.BaseDirectory;
            string root = Path.GetFullPath(Path.Combine(exeDir, ".."));
            string frontDir = Path.Combine(root, "frontend");
            string backDir = Path.Combine(root, "backend");
            string logDir = Path.Combine(exeDir, "logs");

            if (mode == "stop")
            {
                int killed = StopServers();
                MessageBox.Show(
                    killed > 0
                        ? "POS servers stopped (" + killed + " process" + (killed == 1 ? "" : "es") + ")."
                        : "No running POS servers were found.",
                    "Nangi POS", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return 0;
            }

            if (mode != "start")
            {
                MessageBox.Show("Usage: StartPOS.exe [start|stop]", "Nangi POS",
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
                return 1;
            }

            // Already running? Just open the browser again.
            if (PortOpen(FrontPort))
            {
                OpenBrowser();
                return 0;
            }

            // First run on a machine: make sure npm dependencies exist.
            if (!Directory.Exists(Path.Combine(frontDir, "node_modules")))
                InstallDeps(frontDir, "frontend");
            if (!Directory.Exists(Path.Combine(backDir, "node_modules")))
                InstallDeps(backDir, "backend");

            Directory.CreateDirectory(logDir);
            string backLog = Path.Combine(logDir, "backend.log");
            string frontLog = Path.Combine(logDir, "frontend.log");

            StartHidden("node index.js", backDir, backLog);
            StartHidden("npm run dev", frontDir, frontLog);

            bool back = WaitPort(BackPort, 30);
            bool front = WaitPort(FrontPort, 60);

            if (front)
            {
                OpenBrowser();
                if (!back)
                    MessageBox.Show(
                        "The POS interface is open, but the backend did not come up within 30s.\n" +
                        "Check:\n  " + backLog + "\n" +
                        "(The app keeps working with its offline cached data.)",
                        "Nangi POS", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            else
            {
                MessageBox.Show(
                    "The POS interface failed to start.\nCheck:\n  " + frontLog + "\n  " + backLog,
                    "Nangi POS", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
            return 0;
        }

        private static void OpenBrowser()
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo("http://localhost:" + FrontPort);
                psi.UseShellExecute = true;
                Process.Start(psi);
            }
            catch { /* browser failed to open; servers keep running */ }
        }

        private static bool PortOpen(int port)
        {
            // Vite binds "localhost" which resolves to ::1 (IPv6), while
            // Express binds all interfaces - so probe both stacks. A default
            // TcpClient is IPv4-only, so each address gets a matching socket.
            IPAddress[] addrs = new IPAddress[] { IPAddress.Parse("127.0.0.1"), IPAddress.Parse("::1") };
            foreach (IPAddress addr in addrs)
            {
                using (TcpClient c = new TcpClient(addr.AddressFamily))
                {
                    try
                    {
                        IAsyncResult r = c.BeginConnect(addr, port, null, null);
                        if (r.AsyncWaitHandle.WaitOne(300)) { c.EndConnect(r); return true; }
                    }
                    catch { /* try next address */ }
                }
            }
            return false;
        }

        private static bool WaitPort(int port, int seconds)
        {
            DateTime deadline = DateTime.UtcNow.AddSeconds(seconds);
            while (DateTime.UtcNow < deadline)
            {
                if (PortOpen(port)) return true;
                Thread.Sleep(500);
            }
            return PortOpen(port);
        }

        // Runs a command fully hidden, appending stdout+stderr to a log file.
        private static void StartHidden(string inner, string workingDir, string logPath)
        {
            ProcessStartInfo psi = new ProcessStartInfo("cmd.exe");
            psi.Arguments = "/c echo ===== started %date% %time% ===== >> \"" + logPath + "\" && "
                + inner + " >> \"" + logPath + "\" 2>&1";
            psi.WorkingDirectory = workingDir;
            psi.CreateNoWindow = true;
            psi.UseShellExecute = false;
            Process.Start(psi);
        }

        private static void InstallDeps(string dir, string name)
        {
            if (MessageBox.Show(
                    "First-time setup: npm dependencies for " + name + " are missing.\n" +
                    "Install them now? (needs internet, may take a few minutes)",
                    "Nangi POS", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes)
                return;
            ProcessStartInfo psi = new ProcessStartInfo("cmd.exe");
            psi.Arguments = "/c npm install";
            psi.WorkingDirectory = dir;
            psi.UseShellExecute = true;
            psi.WindowStyle = ProcessWindowStyle.Minimized; // progress visible, out of the way
            Process p = Process.Start(psi);
            p.WaitForExit();
            if (p.ExitCode != 0)
                MessageBox.Show("npm install for " + name + " failed (exit code " + p.ExitCode + ").",
                    "Nangi POS", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }

        // Kills whatever process is LISTENING on the two app ports.
        private static int StopServers()
        {
            int killed = 0;
            HashSet<int> done = new HashSet<int>();
            Regex lineRe = new Regex(@"\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)");
            string output = Capture("netstat.exe", "-ano"); // no -p tcp: must also see IPv6 rows
            foreach (string line in output.Split('\n'))
            {
                Match m = lineRe.Match(line);
                if (!m.Success) continue;
                int port = int.Parse(m.Groups[1].Value);
                if (port != FrontPort && port != BackPort) continue;
                int pid = int.Parse(m.Groups[2].Value);
                if (!done.Add(pid)) continue;
                try { Process.GetProcessById(pid).Kill(); killed++; }
                catch { /* already gone */ }
            }
            Thread.Sleep(800); // give the sockets a moment to close
            return killed;
        }

        private static string Capture(string file, string arguments)
        {
            ProcessStartInfo psi = new ProcessStartInfo(file, arguments);
            psi.CreateNoWindow = true;
            psi.UseShellExecute = false;
            psi.RedirectStandardOutput = true;
            using (Process p = Process.Start(psi))
            {
                string s = p.StandardOutput.ReadToEnd();
                p.WaitForExit();
                return s;
            }
        }
    }
}
