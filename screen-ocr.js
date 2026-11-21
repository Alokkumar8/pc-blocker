const { execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_OCR_TEXT_CHARS = 12000;
const DEFAULT_OCR_TIMEOUT_MS = 10000;

const OVERLAY_NOISE_PATTERNS = [
  /JEV LIVE OVERLAY\s*\(DRAG\)/gi,
  /=== PC Blocker Jev Evaluation Snapshot ===/gi,
  /\bOCR\s*\+\s*Gemini\b/gi,
  /DISTRACTION DETECTED\s*[-—–•][^\n]*/gi,
];

/**
 * Cleans and normalizes raw OCR text extracted from the screen, removing
 * floating debug overlay UI labels and capping total length for the LLM prompt.
 * @param {string} rawText
 * @param {number} [maxChars]
 * @returns {string}
 */
function cleanOcrText(rawText = '', maxChars = MAX_OCR_TEXT_CHARS) {
  let cleaned = String(rawText || '');
  for (const pattern of OVERLAY_NOISE_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }
  cleaned = cleaned
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');

  if (cleaned.length > maxChars) {
    return `${cleaned.slice(0, maxChars)}...`;
  }
  return cleaned;
}

const CSHARP_OCR_SOURCE = `
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Windows.Foundation;
using Windows.Globalization;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage.Streams;

public class PcBlockerOcrSensor {
  [DllImport("user32.dll")]
  private static extern bool SetProcessDPIAware();

  [DllImport("user32.dll")]
  private static extern int GetSystemMetrics(int nIndex);

  private const int SM_XVIRTUALSCREEN = 76;
  private const int SM_YVIRTUALSCREEN = 77;
  private const int SM_CXVIRTUALSCREEN = 78;
  private const int SM_CYVIRTUALSCREEN = 79;
  private const int SM_CXSCREEN = 0;
  private const int SM_CYSCREEN = 1;

  static string EscapeJson(string s) {
    if (s == null) return "";
    StringBuilder sb = new StringBuilder(s.Length + 32);
    foreach (char c in s) {
      if (c == '\\\\') sb.Append("\\\\\\\\");
      else if (c == '"') sb.Append("\\\\\\"");
      else if (c == '\\n') sb.Append("\\\\n");
      else if (c == '\\r') sb.Append("\\\\r");
      else if (c == '\\t') sb.Append("\\\\t");
      else if (c >= 32) sb.Append(c);
    }
    return sb.ToString();
  }

  static T WaitWinRt<T>(IAsyncOperation<T> op) {
    int waitedMs = 0;
    while (op.Status == AsyncStatus.Started && waitedMs < 8000) {
      Thread.Sleep(5);
      waitedMs += 5;
    }
    return op.GetResults();
  }

  static string RunOcr(string inputImagePath) {
    try {
      SetProcessDPIAware();
    } catch {}

    int x = 0;
    int y = 0;
    int width = GetSystemMetrics(SM_CXSCREEN);
    int height = GetSystemMetrics(SM_CYSCREEN);

    if (width <= 0 || height <= 0) {
      x = GetSystemMetrics(SM_XVIRTUALSCREEN);
      y = GetSystemMetrics(SM_YVIRTUALSCREEN);
      width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
      height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    }
    if (width <= 0) width = 1920;
    if (height <= 0) height = 1080;

    byte[] pngBytes;
    if (!string.IsNullOrEmpty(inputImagePath) && File.Exists(inputImagePath)) {
      pngBytes = File.ReadAllBytes(inputImagePath);
      using (MemoryStream checkMs = new MemoryStream(pngBytes)) {
        using (Bitmap fileBmp = new Bitmap(checkMs)) {
          width = fileBmp.Width;
          height = fileBmp.Height;
        }
      }
    } else {
      using (Bitmap bmp = new Bitmap(width, height, PixelFormat.Format32bppArgb)) {
        using (Graphics g = Graphics.FromImage(bmp)) {
          g.CopyFromScreen(x, y, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
        }
        using (MemoryStream ms = new MemoryStream()) {
          bmp.Save(ms, ImageFormat.Png);
          pngBytes = ms.ToArray();
        }
      }
    }

    using (InMemoryRandomAccessStream winRtStream = new InMemoryRandomAccessStream()) {
      using (DataWriter writer = new DataWriter(winRtStream)) {
        writer.WriteBytes(pngBytes);
        WaitWinRt(writer.StoreAsync());
        writer.DetachStream();
      }
      winRtStream.Seek(0);

      BitmapDecoder decoder = WaitWinRt(BitmapDecoder.CreateAsync(winRtStream));
      SoftwareBitmap softwareBitmap = WaitWinRt(decoder.GetSoftwareBitmapAsync(
        BitmapPixelFormat.Bgra8,
        BitmapAlphaMode.Premultiplied
      ));

      OcrEngine engine = OcrEngine.TryCreateFromUserProfileLanguages();
      if (engine == null) {
        try {
          engine = OcrEngine.TryCreateFromLanguage(new Language("en-US"));
        } catch {}
      }

      if (engine == null) {
        return "{\\"ok\\":false,\\"error\\":\\"Windows OcrEngine unavailable for current language profile\\"}\\n";
      }

      OcrResult result = WaitWinRt(engine.RecognizeAsync(softwareBitmap));
      StringBuilder textBuilder = new StringBuilder();
      int linesCount = 0;

      if (result != null && result.Lines != null) {
        foreach (var line in result.Lines) {
          if (line != null && !string.IsNullOrWhiteSpace(line.Text)) {
            if (textBuilder.Length > 0) textBuilder.Append("\\n");
            textBuilder.Append(line.Text.Trim());
            linesCount++;
          }
        }
      }

      string fullText = textBuilder.ToString();
      if (string.IsNullOrEmpty(fullText) && result != null && !string.IsNullOrEmpty(result.Text)) {
        fullText = result.Text.Trim();
      }

      return "{\\"ok\\":true,\\"text\\":\\"" + EscapeJson(fullText) +
             "\\",\\"linesCount\\":" + linesCount +
             ",\\"width\\":" + width +
             ",\\"height\\":" + height + "}\\n";
    }
  }

  public static void Main(string[] args) {
    string json = "{\\"ok\\":false,\\"error\\":\\"Unknown OCR failure\\"}\\n";
    try {
      string argPath = (args != null && args.Length > 0) ? args[0] : null;
      if (argPath == "selftest") {
        using (Bitmap testBmp = new Bitmap(900, 220, PixelFormat.Format32bppArgb)) {
          using (Graphics g = Graphics.FromImage(testBmp)) {
            g.Clear(Color.White);
            using (Font f = new Font("Arial", 28, FontStyle.Bold)) {
              g.DrawString("Complete system architecture task", f, Brushes.Black, new PointF(20, 40));
              g.DrawString("Windows Built-in OCR Engine Active", f, Brushes.Black, new PointF(20, 110));
            }
          }
          string tempTestPng = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "self-test-ocr.png");
          testBmp.Save(tempTestPng, ImageFormat.Png);
          json = RunOcr(tempTestPng);
        }
      } else {
        json = RunOcr(argPath);
      }
    } catch (Exception ex) {
      string msg = ex.InnerException != null ? ex.InnerException.Message : ex.Message;
      json = "{\\"ok\\":false,\\"error\\":\\"" + EscapeJson(msg) + "\\"}\\n";
    }

    try {
      byte[] bytes = Encoding.UTF8.GetBytes(json);
      using (var stdout = Console.OpenStandardOutput()) {
        stdout.Write(bytes, 0, bytes.Length);
        stdout.Flush();
      }
    } catch {}
  }
}
`;

/**
 * Captures the full screen and extracts all visible on-screen text using
 * Windows 10/11 built-in OCR (Windows.Media.Ocr.OcrEngine).
 */
class ScreenOcrSensor {
  /**
   * @param {object} [options]
   * @param {number} [options.timeoutMs]
   * @param {() => Promise<void>|void} [options.beforeCapture]
   * @param {() => Promise<void>|void} [options.afterCapture]
   * @param {() => Promise<{ok: boolean, text?: string, linesCount?: number, error?: string}>} [options.ocrProvider]
   */
  constructor(options = {}) {
    this.timeoutMs = options.timeoutMs || DEFAULT_OCR_TIMEOUT_MS;
    this.beforeCapture = options.beforeCapture || null;
    this.afterCapture = options.afterCapture || null;
    this.ocrProvider = options.ocrProvider || null;

    this.buildDir = this._resolveBuildDir();
    this.exePath = path.join(this.buildDir, 'pc-blocker-ocr-sensor-v2.exe');
    this.csPath = path.join(this.buildDir, 'pc-blocker-ocr-sensor-v2.cs');
    this.compiled = false;
    this.compileAttempted = false;
  }

  _resolveBuildDir() {
    const localCacheDir = path.join(__dirname, '.ocr-bin');
    try {
      fs.mkdirSync(localCacheDir, { recursive: true });
      return localCacheDir;
    } catch {}
    try {
      const tmp = os.tmpdir();
      if (tmp && fs.existsSync(tmp)) {
        return tmp;
      }
    } catch {}
    return __dirname;
  }

  _ensureCompiled() {
    if (this.compiled) return true;
    if (fs.existsSync(this.exePath)) {
      this.compiled = true;
      return true;
    }
    if (this.compileAttempted) return false;
    this.compileAttempted = true;

    const winDir = process.env.WINDIR || 'C:\\Windows';
    const cscCandidates = [
      path.join(winDir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
      path.join(winDir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
    ];

    const cscPath = cscCandidates.find((p) => fs.existsSync(p));
    if (!cscPath) return false;

    const fxDir = path.dirname(cscPath);
    const winMdDir = path.join(winDir, 'System32', 'WinMetadata');

    const requiredRefs = [
      path.join(fxDir, 'System.Drawing.dll'),
      path.join(fxDir, 'System.Runtime.dll'),
      path.join(fxDir, 'System.Runtime.InteropServices.WindowsRuntime.dll'),
      path.join(winMdDir, 'Windows.Foundation.winmd'),
      path.join(winMdDir, 'Windows.Globalization.winmd'),
      path.join(winMdDir, 'Windows.Graphics.winmd'),
      path.join(winMdDir, 'Windows.Media.winmd'),
      path.join(winMdDir, 'Windows.Storage.winmd'),
    ];

    if (!requiredRefs.every((refPath) => fs.existsSync(refPath))) {
      return false;
    }

    const args = [
      '/nologo',
      '/optimize+',
      ...requiredRefs.map((refPath) => `/r:${refPath}`),
      `/out:${this.exePath}`,
      this.csPath,
    ];

    try {
      fs.writeFileSync(this.csPath, CSHARP_OCR_SOURCE, 'utf8');
      execFileSync(cscPath, args, {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 15000,
      });
      this.compiled = fs.existsSync(this.exePath);
      return this.compiled;
    } catch {
      return false;
    }
  }

  _runCompiledOcr(args = []) {
    return new Promise((resolve) => {
      execFile(
        this.exePath,
        args,
        {
          windowsHide: true,
          timeout: this.timeoutMs,
          encoding: 'utf8',
          maxBuffer: 4 * 1024 * 1024,
        },
        (err, stdout) => {
          if (err || !stdout) {
            resolve({
              ok: false,
              error: err?.message || 'Compiled Windows OCR helper failed',
            });
            return;
          }
          try {
            const line = String(stdout).trim();
            const parsed = line ? JSON.parse(line) : null;
            if (!parsed || typeof parsed !== 'object') {
              resolve({ ok: false, error: 'Invalid JSON output from Windows OCR helper' });
              return;
            }
            resolve(parsed);
          } catch (parseErr) {
            resolve({
              ok: false,
              error: parseErr?.message || 'Failed to parse Windows OCR output',
            });
          }
        }
      );
    });
  }

  /**
   * Runs a built-in Windows OCR self-test against a synthetic text bitmap.
   * Useful for automated verification in headless/sandboxed environments.
   * @returns {Promise<{ ok: boolean, text: string, linesCount: number, latencyMs: number, error?: string }>}
   */
  async runSelfTest() {
    const startMs = Date.now();
    if (process.platform !== 'win32' || !this._ensureCompiled()) {
      return {
        ok: false,
        text: '',
        linesCount: 0,
        latencyMs: Date.now() - startMs,
        error: 'Windows OCR helper compilation unavailable',
      };
    }
    const existingSelfTestPng = path.join(this.buildDir, 'self-test-ocr.png');
    const arg = fs.existsSync(existingSelfTestPng) ? existingSelfTestPng : 'selftest';
    const raw = await this._runCompiledOcr([arg]);
    return {
      ok: Boolean(raw?.ok),
      text: cleanOcrText(raw?.text || ''),
      linesCount: Number(raw?.linesCount || 0),
      latencyMs: Date.now() - startMs,
      ...(raw?.error ? { error: raw.error } : {}),
    };
  }

  _runPowerShellFallbackOcr() {
    const psScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]

function Await-WinRT($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  return $netTask.Result
}

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$g.Dispose()

$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$ms.Position = 0

$winRtStream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($ms)
$decoder = Await-WinRT ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($winRtStream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$softBmp = Await-WinRT ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) {
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language('en-US')))
}
$ocrResult = Await-WinRT ($engine.RecognizeAsync($softBmp)) ([Windows.Media.Ocr.OcrResult])
$lines = @($ocrResult.Lines | ForEach-Object { $_.Text })
$fullText = ($lines -join "\`n")
@{ ok = $true; text = $fullText; linesCount = $lines.Count } | ConvertTo-Json -Compress
`;
    const encoded = Buffer.from(`Add-Type -AssemblyName System.Windows.Forms\n${psScript}`, 'utf16le').toString('base64');

    return new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        {
          windowsHide: true,
          timeout: this.timeoutMs,
          encoding: 'utf8',
          maxBuffer: 4 * 1024 * 1024,
        },
        (err, stdout) => {
          if (err || !stdout) {
            resolve({
              ok: false,
              error: err?.message || 'Windows PowerShell OCR fallback failed',
            });
            return;
          }
          try {
            const parsed = JSON.parse(String(stdout).trim());
            resolve(parsed);
          } catch (parseErr) {
            resolve({
              ok: false,
              error: parseErr?.message || 'Failed to parse PowerShell OCR JSON',
            });
          }
        }
      );
    });
  }

  /**
   * Captures the full screen and runs Windows built-in OCR.
   * Never throws; returns `{ ok, text, linesCount, latencyMs, error? }`.
   * @returns {Promise<{ ok: boolean, text: string, linesCount: number, latencyMs: number, error?: string }>}
   */
  async captureFullScreenText() {
    const startMs = Date.now();

    if (typeof this.ocrProvider === 'function') {
      try {
        const customRes = await this.ocrProvider();
        const cleaned = cleanOcrText(customRes?.text || '');
        return {
          ok: Boolean(customRes?.ok),
          text: cleaned,
          linesCount: Number(customRes?.linesCount ?? (cleaned ? cleaned.split('\n').length : 0)),
          latencyMs: Date.now() - startMs,
          ...(customRes?.error ? { error: customRes.error } : {}),
        };
      } catch (err) {
        return {
          ok: false,
          text: '',
          linesCount: 0,
          latencyMs: Date.now() - startMs,
          error: err?.message || 'Custom OCR provider failed',
        };
      }
    }

    if (process.platform !== 'win32') {
      return {
        ok: false,
        text: '',
        linesCount: 0,
        latencyMs: Date.now() - startMs,
        error: 'Windows built-in OCR is only supported on win32',
      };
    }

    try {
      if (typeof this.beforeCapture === 'function') {
        await this.beforeCapture();
      }

      let rawResult;
      if (this._ensureCompiled()) {
        rawResult = await this._runCompiledOcr();
        if ((!rawResult || !rawResult.ok) && typeof this.captureFallbackImage === 'function') {
          try {
            const fallbackPath = await this.captureFallbackImage();
            if (fallbackPath) {
              rawResult = await this._runCompiledOcr([fallbackPath]);
            }
          } catch {}
        }
      } else {
        rawResult = await this._runPowerShellFallbackOcr();
      }

      const latencyMs = Date.now() - startMs;
      if (!rawResult || !rawResult.ok) {
        return {
          ok: false,
          text: '',
          linesCount: 0,
          latencyMs,
          error: rawResult?.error || 'Windows OCR failed',
        };
      }

      const cleanedText = cleanOcrText(rawResult.text || '');
      return {
        ok: true,
        text: cleanedText,
        linesCount: Number(rawResult.linesCount ?? (cleanedText ? cleanedText.split('\n').length : 0)),
        width: rawResult.width,
        height: rawResult.height,
        latencyMs,
      };
    } catch (err) {
      return {
        ok: false,
        text: '',
        linesCount: 0,
        latencyMs: Date.now() - startMs,
        error: err?.message || 'Unexpected Windows OCR error',
      };
    } finally {
      if (typeof this.afterCapture === 'function') {
        try {
          await this.afterCapture();
        } catch {}
      }
    }
  }
}

module.exports = {
  MAX_OCR_TEXT_CHARS,
  DEFAULT_OCR_TIMEOUT_MS,
  cleanOcrText,
  ScreenOcrSensor,
};
