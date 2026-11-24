# Measures how long a new PowerShell session takes to become usable, the way Polaris Terminal starts it:
# under ConPTY with the init command from pwsh_init_shell.ps1, then sourcing the bootstrap once
# the shell reports InitShell. Prints, per run, the time to InitShell, to Bootstrapped, and to
# the first prompt after it. Run it from the repository root:
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File script/windows/bench_pwsh_startup.ps1 -Runs 8
#
# Machine load moves single runs by seconds; compare medians of interleaved runs.
param(
    [string]$Bootstrap = (Join-Path $PSScriptRoot '../../app/assets/bundled/bootstrap/pwsh.ps1'),
    [string]$Shell = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe',
    [string]$InitScriptFile,
    [int]$Runs = 3
)
# Reproduces Polaris Terminal's PowerShell startup under ConPTY: spawn with the init -Command, wait for the
# InitShell OSC, write " . '<bootstrap>'\r", wait for the Bootstrapped OSC.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class ConPtyBench {
    [StructLayout(LayoutKind.Sequential)] struct COORD { public short X, Y; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO { public int cb; public string r, d, t; public int x, y, xs, ys, xc, yc, fa, f; public short sw, cb2; public IntPtr r2, i, o, e; }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO S; public IntPtr A; }
    [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr hP, hT; public int pid, tid; }
    [DllImport("kernel32.dll")] static extern int CreatePseudoConsole(COORD s, SafeFileHandle i, SafeFileHandle o, uint f, out IntPtr h);
    [DllImport("kernel32.dll")] static extern void ClosePseudoConsole(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out SafeFileHandle r, out SafeFileHandle w, IntPtr a, int s);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr l, int c, int f, ref IntPtr s);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr l, uint f, IntPtr a, IntPtr v, IntPtr s, IntPtr p, IntPtr r);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcess(string a, string c, IntPtr pa, IntPtr ta, bool ih, uint f, IntPtr e, string d, ref STARTUPINFOEX si, out PI pi);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h, uint c);

    static string Hooks(string s) {
        // Decode every hex-encoded OSC 9278 JSON message and return the hook names.
        var sb = new StringBuilder();
        int i = 0;
        while ((i = s.IndexOf("\u001b]9278;d;", i)) >= 0) {
            i += 9; int e = s.IndexOf('\a', i); if (e < 0) break;
            string hex = s.Substring(i, e - i); var b = new byte[hex.Length / 2];
            for (int k = 0; k < b.Length; k++) b[k] = Convert.ToByte(hex.Substring(k * 2, 2), 16);
            string json = Encoding.UTF8.GetString(b);
            int h = json.IndexOf("\"hook\":\""); if (h >= 0) { h += 8; sb.Append(json.Substring(h, json.IndexOf('"', h) - h)).Append(','); }
            i = e;
        }
        return sb.ToString();
    }

    public static string Run(string cmdline, string bootstrapLine, int timeoutMs) {
        SafeFileHandle inR, inW, outR, outW;
        CreatePipe(out inR, out inW, IntPtr.Zero, 0); CreatePipe(out outR, out outW, IntPtr.Zero, 0);
        IntPtr hpc; CreatePseudoConsole(new COORD { X = 120, Y = 30 }, inR, outW, 0, out hpc);
        IntPtr size = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        var si = new STARTUPINFOEX(); si.S.cb = Marshal.SizeOf(si); si.S.f = 0x100; si.A = Marshal.AllocHGlobal(size);
        InitializeProcThreadAttributeList(si.A, 1, 0, ref size);
        UpdateProcThreadAttribute(si.A, 0, (IntPtr)0x20016, hpc, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero);
        var sw = Stopwatch.StartNew(); PI pi;
        if (!CreateProcess(null, cmdline, IntPtr.Zero, IntPtr.Zero, false, 0x00080000, IntPtr.Zero, null, ref si, out pi))
            return "CreateProcess failed " + Marshal.GetLastWin32Error();
        var all = new StringBuilder(); object gate = new object();
        var reader = new Thread(() => {
            var fs = new FileStream(outR, FileAccess.Read); var buf = new byte[65536]; int n;
            try { while ((n = fs.Read(buf, 0, buf.Length)) > 0) lock (gate) all.Append(Encoding.UTF8.GetString(buf, 0, n)); } catch { }
        }); reader.IsBackground = true; reader.Start();
        var input = new FileStream(inW, FileAccess.Write);
        long tInit = -1, tBoot = -1, tPrompt = -1;
        while (sw.ElapsedMilliseconds < timeoutMs) {
            string hooks; lock (gate) hooks = Hooks(all.ToString());
            if (tInit < 0 && hooks.Contains("InitShell,")) {
                tInit = sw.ElapsedMilliseconds;
                var b = Encoding.UTF8.GetBytes(bootstrapLine); input.Write(b, 0, b.Length); input.Flush();
            }
            if (tBoot < 0 && hooks.Contains("Bootstrapped,")) tBoot = sw.ElapsedMilliseconds;
            if (tBoot >= 0 && hooks.IndexOf("Precmd,", hooks.IndexOf("Bootstrapped,")) >= 0) { tPrompt = sw.ElapsedMilliseconds; break; }
            Thread.Sleep(5);
        }
        TerminateProcess(pi.hP, 0); ClosePseudoConsole(hpc);
        return string.Format("InitShell {0} ms | Bootstrapped {1} ms | first prompt {2} ms", tInit, tBoot, tPrompt);
    }
}
'@

if (-not $InitScriptFile) {
    # Rebuild Polaris Terminal's init -Command the same way bootstrap.rs does: drop comment/blank lines, join with ';'.
    $InitScriptFile = Join-Path $PSScriptRoot '../../app/assets/bundled/bootstrap/pwsh_init_shell.ps1'
}
$Bootstrap = (Resolve-Path -LiteralPath $Bootstrap).Path
$init = (Get-Content -LiteralPath $InitScriptFile | Where-Object { $_.Trim() -and -not $_.TrimStart().StartsWith('#') }) -join ';'
$init = $init.Replace('@@POLARIS_TERMINAL_SESSION_ID@@', '12345')
$quoted = '"' + $init.Replace('"', '\"') + '"'
$cmd = "`"$Shell`" -NoLogo -NoProfile -NoExit -Command $quoted"
$line = " . '" + $Bootstrap.Replace("'", "''") + "'`r"
1..$Runs | ForEach-Object { [ConPtyBench]::Run($cmd, $line, 30000) }
