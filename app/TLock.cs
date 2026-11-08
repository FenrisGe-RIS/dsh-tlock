// T约束 桌面端（V1 先验版）
// 与 DSH 插件 dsh-tlock 通过 %USERPROFILE%\.dsh\storages\dsh-tlock\ 下的三个 JSON 文件联动：
//   settings.json  ← 本程序写（挡位、开关、归档格式、自启）
//   status.json    → 本程序读（实时用量、剩余时间、等待决定）
//   commands.json  ← 本程序写（continue / end / stop）
//
// 只用 .NET Framework 自带部件，csc 直接编译，零下载：
//   csc /target:winexe /out:TLock.exe /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll TLock.cs
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

static class Paths
{
    public static readonly string DshHome = ResolveDshHome();
    public static readonly string StateDir = ResolveStateDir();
    public static readonly string SettingsFile = Path.Combine(StateDir, "settings.json");
    public static readonly string StatusFile = Path.Combine(StateDir, "status.json");
    public static readonly string CommandsFile = Path.Combine(StateDir, "commands.json");

    static string ResolveStateDir()
    {
        // 测试/多环境用：TLOCK_STATE_DIR 可把三个 JSON 改到别处（沙盒里写不进用户目录时尤其有用）
        string overrideDir = Environment.GetEnvironmentVariable("TLOCK_STATE_DIR");
        if (overrideDir != null && overrideDir.Length > 0) return overrideDir;
        return Path.Combine(DshHome, "storages", "dsh-tlock");
    }

    static string ResolveDshHome()
    {
        string env = Environment.GetEnvironmentVariable("DSH_HOME");
        if (env != null && env.Length > 0) return env;
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh");
    }

    public static string DefaultArchiveRoot
    {
        get
        {
            string profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            string direct = Path.Combine(profile, "Desktop");
            if (Directory.Exists(direct)) return Path.Combine(direct, "DSH限定生成内容");
            string oneDrive = Path.Combine(profile, "OneDrive", "Desktop");
            if (Directory.Exists(oneDrive)) return Path.Combine(oneDrive, "DSH限定生成内容");
            return Path.Combine(direct, "DSH限定生成内容");
        }
    }
}

static class Ui
{
    public static readonly Color Bg = Color.FromArgb(250, 250, 251);
    public static readonly Color Card = Color.White;
    public static readonly Color Line = Color.FromArgb(229, 231, 235);
    public static readonly Color Text = Color.FromArgb(31, 41, 55);
    public static readonly Color Muted = Color.FromArgb(107, 114, 128);
    public static readonly Color Faint = Color.FromArgb(156, 163, 175);
    public static readonly Color Accent = Color.FromArgb(24, 30, 42);
    public static readonly Color Good = Color.FromArgb(21, 128, 61);
    public static readonly Color Green = Color.FromArgb(34, 197, 94);
    public static readonly Color Warn = Color.FromArgb(180, 83, 9);
    public static readonly Color Danger = Color.FromArgb(185, 28, 28);

    public static Font F(float size, bool bold)
    {
        return new Font("Microsoft YaHei UI", size, bold ? FontStyle.Bold : FontStyle.Regular, GraphicsUnit.Point);
    }

    public static GraphicsPath Round(RectangleF r, float radius)
    {
        GraphicsPath path = new GraphicsPath();
        float d = Math.Min(radius * 2f, Math.Min(r.Width, r.Height));
        path.AddArc(r.X, r.Y, d, d, 180, 90);
        path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    public static void SetQuality(Graphics g)
    {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
    }
}

/// <summary>圆角胶囊按钮。</summary>
class Pill : Control
{
    public bool Selected;
    public Color SelectedColor = Ui.Accent;
    bool hover;
    bool down;

    public Pill(string text)
    {
        Text = text;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        Cursor = Cursors.Hand;
        Font = Ui.F(8.5f, false);
        Height = 30;
    }

    protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { hover = false; down = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnMouseDown(MouseEventArgs e) { down = true; Invalidate(); base.OnMouseDown(e); }
    protected override void OnMouseUp(MouseEventArgs e) { down = false; Invalidate(); base.OnMouseUp(e); }
    protected override void OnEnabledChanged(EventArgs e) { base.OnEnabledChanged(e); Invalidate(); }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        Ui.SetQuality(g);
        RectangleF r = new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f);
        using (GraphicsPath path = Ui.Round(r, 8f))
        {
            if (Selected)
            {
                using (SolidBrush b = new SolidBrush(SelectedColor)) g.FillPath(b, path);
            }
            else if (hover)
            {
                using (SolidBrush b = new SolidBrush(Color.FromArgb(243, 244, 246))) g.FillPath(b, path);
            }
            if (!Selected)
            {
                using (Pen p = new Pen(hover ? Color.FromArgb(209, 213, 219) : Ui.Line, 1f)) g.DrawPath(p, path);
            }
        }
        Color textColor = Selected ? Color.White : (Enabled ? Ui.Text : Ui.Faint);
        TextRenderer.DrawText(g, Text, Font, new Rectangle(0, 0, Width, Height), textColor,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
    }
}

/// <summary>一个简单的数字输入小窗（自定义挡位用）。</summary>
class InputDialog : Form
{
    NumericUpDown box;
    public decimal Value { get { return box.Value; } }

    public InputDialog(string title, string label, decimal value, decimal min, decimal max, int decimals, string unit)
    {
        Text = title;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterParent;
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = false;
        ClientSize = new Size(300, 132);
        BackColor = Ui.Bg;
        Font = Ui.F(9f, false);

        Label caption = new Label();
        caption.Text = label;
        caption.Location = new Point(18, 18);
        caption.Size = new Size(264, 20);
        caption.ForeColor = Ui.Text;
        Controls.Add(caption);

        box = new NumericUpDown();
        box.Location = new Point(18, 44);
        box.Size = new Size(176, 26);
        box.Minimum = min;
        box.Maximum = max;
        box.DecimalPlaces = decimals;
        box.Value = Math.Min(max, Math.Max(min, value));
        Controls.Add(box);

        Label unitLabel = new Label();
        unitLabel.Text = unit;
        unitLabel.Location = new Point(202, 48);
        unitLabel.Size = new Size(60, 20);
        unitLabel.ForeColor = Ui.Muted;
        Controls.Add(unitLabel);

        Pill ok = new Pill("确定");
        ok.Selected = true;
        ok.Location = new Point(186, 88);
        ok.Size = new Size(76, 30);
        ok.Click += delegate { DialogResult = DialogResult.OK; Close(); };
        Controls.Add(ok);

        Pill cancel = new Pill("取消");
        cancel.Location = new Point(104, 88);
        cancel.Size = new Size(76, 30);
        cancel.Click += delegate { DialogResult = DialogResult.Cancel; Close(); };
        Controls.Add(cancel);

        AcceptButton = null;
        CancelButton = null;
    }
}

/// <summary>右下角轻提示：到 80%/90% 时问一句要不要继续。</summary>
class Toast : Form
{
    public event EventHandler ContinueClicked;
    public event EventHandler StopClicked;
    System.Windows.Forms.Timer life;

    public Toast(string title, string detail)
    {
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = false;
        TopMost = true;
        BackColor = Ui.Card;
        ClientSize = new Size(340, 116);
        Padding = new Padding(0);

        Label head = new Label();
        head.Text = title;
        head.Font = Ui.F(9.5f, true);
        head.ForeColor = Ui.Text;
        head.Location = new Point(18, 14);
        head.Size = new Size(300, 22);
        Controls.Add(head);

        Label body = new Label();
        body.Text = detail;
        body.Font = Ui.F(8.5f, false);
        body.ForeColor = Ui.Muted;
        body.Location = new Point(18, 38);
        body.Size = new Size(304, 38);
        Controls.Add(body);

        Pill keep = new Pill("继续生成");
        keep.Selected = true;
        keep.Location = new Point(140, 76);
        keep.Size = new Size(88, 28);
        keep.Click += delegate { if (ContinueClicked != null) ContinueClicked(this, EventArgs.Empty); Close(); };
        Controls.Add(keep);

        Pill stop = new Pill("到此为止");
        stop.Location = new Point(236, 76);
        stop.Size = new Size(88, 28);
        stop.Click += delegate { if (StopClicked != null) StopClicked(this, EventArgs.Empty); Close(); };
        Controls.Add(stop);

        life = new System.Windows.Forms.Timer();
        life.Interval = 25000;
        life.Tick += delegate { life.Stop(); Close(); };
        life.Start();

        AddBorder();
        Place();
    }

    void AddBorder()
    {
        Paint += delegate (object sender, PaintEventArgs e)
        {
            Ui.SetQuality(e.Graphics);
            using (Pen p = new Pen(Ui.Line, 1f)) e.Graphics.DrawRectangle(p, 0, 0, Width - 1, Height - 1);
            using (SolidBrush b = new SolidBrush(Ui.Warn)) e.Graphics.FillRectangle(b, 0, 0, 4, Height);
        };
    }

    void Place()
    {
        Rectangle area = Screen.PrimaryScreen.WorkingArea;
        Location = new Point(area.Right - Width - 18, area.Bottom - Height - 18);
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        Place();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing && life != null) life.Dispose();
        base.Dispose(disposing);
    }
}


    /// <summary>黑色滑轨 + 刻度吸附的分段滑条（token / 时间共用）。</summary>
    sealed class SliderCtl : Control
    {
        public int[] Stops = new int[] { 0, 100 };
        public string Label = "";
        public Func<int, string> Format;
        public event EventHandler ValueChanged;
        public event EventHandler CustomRequested;
        public bool ShowCustom = true;
        int value;
        bool drag;

        public SliderCtl()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
            BackColor = Ui.Bg;
            Size = new Size(388, 44);
            Format = delegate(int v) { return v.ToString(); };
        }

        public int Value
        {
            get { return value; }
            set
            {
                int next = Clamp(value);
                if (next == this.value) { Invalidate(); return; }
                this.value = next;
                Invalidate();
            }
        }

        int Clamp(int v)
        {
            if (Stops == null || Stops.Length == 0) return v;
            if (v < Stops[0]) v = Stops[0];
            if (v > Stops[Stops.Length - 1]) v = Stops[Stops.Length - 1];
            return v;
        }

        double PosOf(int v)
        {
            v = Clamp(v);
            int segs = Stops.Length - 1;
            for (int i = 0; i < segs; i++)
            {
                int a = Stops[i];
                int b = Stops[i + 1];
                if (v <= b || i == segs - 1)
                {
                    double t = Math.Log((double)v / a) / Math.Log((double)b / a);
                    double raw = (i + Math.Max(0, Math.Min(1, t))) / segs;
                    return Math.Max(0, Math.Min(1, raw));
                }
            }
            return 1;
        }

        int ValueAt(double pos)
        {
            pos = Math.Max(0, Math.Min(1, pos));
            int segs = Stops.Length - 1;
            double raw = pos * segs;
            // 靠近整刻度就吸过去
            if (Math.Abs(raw - Math.Round(raw)) <= 0.075) pos = (double)Math.Round(raw) / segs;
            raw = pos * segs;
            int i = Math.Min(segs - 1, (int)Math.Floor(raw));
            double t = raw - i;
            double a = Stops[i];
            double b = Stops[i + 1];
            return (int)Math.Round(a * Math.Pow(b / a, t));
        }

        Rectangle TrackRect()
        {
            return new Rectangle(8, 26, Width - 16, 20);
        }

        double PosFromX(int x)
        {
            return (double)(x - TrackRect().X) / Math.Max(1, TrackRect().Width - 0);
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (ShowCustom && e.X >= Width - 60 && e.Y <= 20)
            {
                if (CustomRequested != null) CustomRequested(this, EventArgs.Empty);
                return;
            }
            drag = true;
            Value = ValueAt(PosFromX(e.X));
            if (ValueChanged != null) ValueChanged(this, EventArgs.Empty);
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            if (!drag) return;
            int next = ValueAt(PosFromX(e.X));
            if (next != value)
            {
                value = Clamp(next);
                Invalidate();
                if (ValueChanged != null) ValueChanged(this, EventArgs.Empty);
            }
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            drag = false;
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            g.Clear(Ui.Bg);

            Color ink = Ui.Text;
            using (SolidBrush tb = new SolidBrush(Ui.Muted)) g.DrawString(Label, Ui.F(8.5f, true), tb, 0f, 0f);
            string text = Format(value);
            SizeF size = g.MeasureString(text, Ui.F(9f, true));
            float rightEdge = ShowCustom ? Width - 68f : (float)Width;
            using (SolidBrush vb = new SolidBrush(ink)) g.DrawString(text, Ui.F(9f, true), vb, rightEdge - size.Width, -0.5f);
            if (ShowCustom)
            {
                using (SolidBrush cb = new SolidBrush(Color.FromArgb(96, 104, 128))) g.DrawString("手动输入", Ui.F(8f, false), cb, Width - 60f, 0f);
            }

            Rectangle track = TrackRect();
            Rectangle barRect = new Rectangle(track.X, track.Y + 8, track.Width, 5);
            using (GraphicsPath path = Ui.Round(barRect, 2.5f))
            using (SolidBrush b = new SolidBrush(Color.FromArgb(232, 234, 238))) g.FillPath(b, path);

            double pos = PosOf(value);
            int fillW = (int)Math.Round(barRect.Width * pos);
            if (fillW > 3)
            {
                using (GraphicsPath path = Ui.Round(new Rectangle(barRect.X, barRect.Y, fillW, barRect.Height), 2.5f))
                using (SolidBrush b = new SolidBrush(Color.FromArgb(20, 25, 34))) g.FillPath(b, path);
            }

            int segs = Stops.Length - 1;
            for (int i = 0; i <= segs; i++)
            {
                int x = track.X + (int)Math.Round((double)track.Width * i / segs);
                bool hot = Math.Abs(pos - (double)i / segs) < 0.012;
                using (SolidBrush b = new SolidBrush(hot ? Ui.Text : Color.FromArgb(190, 195, 203)))
                {
                    g.FillRectangle(b, x - 1, track.Y + 4, 1, hot ? 13 : 9);
                }
            }

            int thumbX = track.X + (int)Math.Round((double)track.Width * pos);
            int r = drag ? 8 : 7;
            using (SolidBrush b = new SolidBrush(Color.White))
            using (Pen pen = new Pen(Color.FromArgb(24, 30, 42), 2f))
            {
                g.FillEllipse(b, thumbX - r, track.Y + 10 - r, r * 2, r * 2);
                g.DrawEllipse(pen, thumbX - r, track.Y + 10 - r, r * 2, r * 2);
            }
        }
    }

class MainForm : Form
{
    // ---- 状态（来自 status.json）
    Dictionary<string, object> settings = new Dictionary<string, object>();
    Dictionary<string, object> status = null;
    DateTime statusReadAt = DateTime.MinValue;
    DateTime statusFileWrite = DateTime.MinValue;
    DateTime settingsFileWrite = DateTime.MinValue;
    string lastTriggerNotified = "";
    string lastWarnKey = "";
    Toast warnToast;

    // ---- 控件
    System.Windows.Forms.Timer ticker;
    NotifyIcon tray;
    SliderCtl tokenSlider;
    SliderCtl timeSlider;
    Pill[] modePills;
    Pill archiveToggle;
    Label connLabel;
    CheckBox autoStart;

    // ---- 绘制用矩形
    Rectangle cardRect = new Rectangle(16, 82, 388, 134);
    Rectangle bannerContinue = Rectangle.Empty;
    Rectangle bannerEnd = Rectangle.Empty;
    bool bannerHoverContinue;
    bool bannerHoverEnd;

    static readonly int[] TokenStops = new int[] { 5000, 50000, 200000, 400000, 700000, 1000000 };
    static readonly int[] TimeStops = new int[] { 60, 600, 1800, 3600, 5400, 7200 };

    readonly string demoMode;

    public MainForm(bool demo) : this(demo, "running") { }

    public MainForm(bool demo, string mode)
    {
        demoMode = mode;
        Text = "T约束";
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(420, 468);
        BackColor = Ui.Bg;
        Font = Ui.F(9f, false);
        DoubleBuffered = true;
        Icon = LoadIcon();

        Directory.CreateDirectory(Paths.StateDir);
        LoadSettings();
        BuildChrome();
        BuildControls();
        BuildFooter();

        if (demo && mode != "real") seedDemo(mode);

        ticker = new System.Windows.Forms.Timer();
        ticker.Interval = 200;
        ticker.Tick += delegate { Refresh1(); };
        ticker.Start();

        Shown += delegate
        {
            if (demo) return;
            SetupTray();
            if (autoStart.Checked) SetAutoStart(true); // 默认开机自启，注册表里没有就补上
            Refresh1();
        };
        FormClosing += OnClosing;
    }

    // ------------------------------------------------------------------ 图标

    static Icon LoadIcon()
    {
        try
        {
            string beside = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "icon.ico");
            if (File.Exists(beside)) return new Icon(beside, 32, 32);
            string parent = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app", "icon.ico");
            if (File.Exists(parent)) return new Icon(parent, 32, 32);
        }
        catch { }
        return SystemIcons.Application;
    }

    // ------------------------------------------------------------------ 设置

    void LoadSettings()
    {
        bool existed = File.Exists(Paths.SettingsFile);
        Dictionary<string, object> loaded = Json.Read(Paths.SettingsFile);
        settings = loaded != null ? loaded : new Dictionary<string, object>();
        if (!settings.ContainsKey("enabled")) settings["enabled"] = true;
        if (!settings.ContainsKey("tokenLimit")) settings["tokenLimit"] = 20000;
        if (!settings.ContainsKey("timeLimitSec")) settings["timeLimitSec"] = 300;
        if (!settings.ContainsKey("archiveMode"))
        {
            string oldFormat = Json.Str(settings["archiveFormat"], "md");
            settings["archiveMode"] = oldFormat == "json" ? "ai" : oldFormat == "both" ? "both" : "brief";
        }
        bool migrated = settings.ContainsKey("archiveFormat");
        settings.Remove("archiveFormat");
        if (!settings.ContainsKey("archiveEnabled")) settings["archiveEnabled"] = true;
        if (!settings.ContainsKey("lang")) settings["lang"] = "zh";
        if (!settings.ContainsKey("ball")) settings["ball"] = true;
        if (!settings.ContainsKey("panelSize")) settings["panelSize"] = "m";
        if (!settings.ContainsKey("autoStart")) settings["autoStart"] = true;
        if (!settings.ContainsKey("snapshotOnInterrupt")) settings["snapshotOnInterrupt"] = true;
        if (!settings.ContainsKey("archiveRoot")) settings["archiveRoot"] = "";
        // 旧版量程外的手填值收回到新量程（157 万 → 100 万），保证 App 与插件看到同一份
        int rawTokens = (int)Json.Num(settings["tokenLimit"], 20000);
        int rawTime = (int)Json.Num(settings["timeLimitSec"], 300);
        int fixedTokens = Math.Max(5000, Math.Min(1000000, rawTokens));
        int fixedTime = Math.Max(60, Math.Min(7200, rawTime));
        if (fixedTokens != rawTokens)
        {
            settings["tokenLimit"] = fixedTokens;
            migrated = true;
        }
        if (fixedTime != rawTime)
        {
            settings["timeLimitSec"] = fixedTime;
            migrated = true;
        }
        try { settingsFileWrite = File.GetLastWriteTimeUtc(Paths.SettingsFile); } catch { }
        if (!existed || migrated) SaveSettings(); // 第一次运行 / 迁移过就把设置落盘，插件启动即同一份
    }

    void SaveSettings()
    {
        Json.Write(Paths.SettingsFile, settings);
    }

    int TokenLimit { get { return (int)Json.Num(settings["tokenLimit"], 20000); } set { settings["tokenLimit"] = value; SaveSettings(); } }
    int TimeLimitSec { get { return (int)Json.Num(settings["timeLimitSec"], 300); } set { settings["timeLimitSec"] = value; SaveSettings(); } }
    string ArchiveMode
    {
        get
        {
            string mode = Json.Str(settings["archiveMode"], "brief");
            if (mode == "ai") mode = "full";
            if (mode != "brief" && mode != "full" && mode != "both") mode = "brief";
            return mode;
        }
        set { settings["archiveMode"] = value; SaveSettings(); }
    }
    bool ArchiveOn { get { return Json.Bool(settings["archiveEnabled"], true); } set { settings["archiveEnabled"] = value; SaveSettings(); } }
    bool Enabled_ { get { return Json.Bool(settings["enabled"], true); } set { settings["enabled"] = value; SaveSettings(); } }

    void WriteSetting(string key, object value)
    {
        settings[key] = value;
        SaveSettings();
    }

    // ------------------------------------------------------------------ 界面骨架

    void BuildChrome()
    {
        connLabel = new Label();
        connLabel.Text = "DSH 未运行";
        connLabel.AutoSize = false;
        connLabel.TextAlign = ContentAlignment.MiddleRight;
        connLabel.Font = Ui.F(8f, false);
        connLabel.ForeColor = Ui.Faint;
        connLabel.Location = new Point(232, 22);
        connLabel.Size = new Size(172, 20);
        Controls.Add(connLabel);

    }

    void BuildControls()
    {
        tokenSlider = new SliderCtl();
        tokenSlider.Stops = TokenStops;
        tokenSlider.Label = "Token 上限（每轮）";
        tokenSlider.Format = delegate(int v) { return FmtTokens(v); };
        tokenSlider.Value = TokenLimit;
        tokenSlider.ValueChanged += delegate { TokenLimit = tokenSlider.Value; SyncControls(); };
        tokenSlider.CustomRequested += delegate { AskCustomTokens(); };
        Controls.Add(tokenSlider);

        timeSlider = new SliderCtl();
        timeSlider.Stops = TimeStops;
        timeSlider.Label = "时间上限（每轮）";
        timeSlider.Format = delegate(int v) { return FmtTime(v); };
        timeSlider.Value = TimeLimitSec;
        timeSlider.ValueChanged += delegate { TimeLimitSec = timeSlider.Value; SyncControls(); };
        timeSlider.CustomRequested += delegate { AskCustomTime(); };
        Controls.Add(timeSlider);

        modePills = new Pill[3];
        string[] modes = new string[] { "brief", "full", "both" };
        string[] labels = new string[] { "简洁描述", "完全记录", "两个都要" };
        for (int i = 0; i < 3; i++)
        {
            string value = modes[i];
            Pill pill = new Pill(labels[i]);
            pill.Click += delegate { ArchiveMode = value; SyncControls(); };
            modePills[i] = pill;
            Controls.Add(pill);
        }

        archiveToggle = new Pill("解除归档");
        archiveToggle.Click += delegate
        {
            ArchiveOn = !ArchiveOn;
            SyncControls();
        };
        Controls.Add(archiveToggle);

        LayoutControls();
        SyncControls();
    }

    void LayoutControls()
    {
        if (tokenSlider != null)
        {
            tokenSlider.Location = new Point(16, 238);
            tokenSlider.Size = new Size(388, 44);
        }
        if (timeSlider != null)
        {
            timeSlider.Location = new Point(16, 304);
            timeSlider.Size = new Size(388, 44);
        }
        if (modePills != null)
        {
            int gap = 6;
            int w = (388 - gap * 2) / 3;
            for (int i = 0; i < modePills.Length; i++)
            {
                modePills[i].Location = new Point(16 + i * (w + gap), 382);
                modePills[i].Size = new Size(w, 30);
            }
        }
        if (archiveToggle != null)
        {
            archiveToggle.Location = new Point(276, 351);
            archiveToggle.Size = new Size(128, 24);
        }
        Invalidate();
    }

    void SyncControls()
    {
        if (tokenSlider != null) tokenSlider.Value = TokenLimit;
        if (timeSlider != null) timeSlider.Value = TimeLimitSec;
        if (modePills != null)
        {
            string[] modes = new string[] { "brief", "full", "both" };
            for (int i = 0; i < modePills.Length; i++) modePills[i].Selected = modes[i] == ArchiveMode;
        }
        if (archiveToggle != null)
        {
            archiveToggle.Selected = !ArchiveOn;
            archiveToggle.Text = ArchiveOn ? "解除归档" : "已取消归档";
        }
        if (modePills != null)
        {
            foreach (Pill pill in modePills) pill.Invalidate();
        }
        if (archiveToggle != null) archiveToggle.Invalidate();
        Invalidate();
    }

    void BuildFooter()
    {
        autoStart = new CheckBox();
        autoStart.Text = "开机自启";
        autoStart.AutoSize = false;
        autoStart.Location = new Point(20, 424);
        autoStart.Size = new Size(100, 26);
        autoStart.ForeColor = Ui.Muted;
        autoStart.Font = Ui.F(8.5f, false);
        autoStart.Checked = Json.Bool(settings["autoStart"], true);
        autoStart.CheckedChanged += delegate
        {
            WriteSetting("autoStart", autoStart.Checked);
            SetAutoStart(autoStart.Checked);
        };
        Controls.Add(autoStart);

        Pill open = new Pill("打开归档目录");
        open.Location = new Point(150, 420);
        open.Size = new Size(122, 32);
        open.Click += delegate { OpenArchive(); };
        Controls.Add(open);

        Pill quit = new Pill("退出");
        quit.Location = new Point(282, 420);
        quit.Size = new Size(122, 32);
        quit.Click += delegate { reallyQuit = true; Close(); };
        Controls.Add(quit);
    }

    bool reallyQuit;

    // ------------------------------------------------------------------ 托盘

    void SetupTray()
    {
        tray = new NotifyIcon();
        tray.Icon = Icon;
        tray.Text = "T约束";
        tray.Visible = true;
        ContextMenuStrip menu = new ContextMenuStrip();
        ToolStripMenuItem showItem = new ToolStripMenuItem("打开面板");
        showItem.Click += delegate { Restore(); };
        ToolStripMenuItem pauseItem = new ToolStripMenuItem("暂停约束");
        pauseItem.Checked = !Enabled_;
        pauseItem.Click += delegate
        {
            Enabled_ = !Enabled_;
            pauseItem.Checked = !Enabled_;
            ApplyEnabledToUi();
            SaveSettings();
        };
        ToolStripMenuItem folderItem = new ToolStripMenuItem("打开归档目录");
        folderItem.Click += delegate { OpenArchive(); };
        ToolStripMenuItem exitItem = new ToolStripMenuItem("退出");
        exitItem.Click += delegate { reallyQuit = true; Close(); };
        menu.Items.Add(showItem);
        menu.Items.Add(pauseItem);
        menu.Items.Add(folderItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(exitItem);
        tray.ContextMenuStrip = menu;
        tray.DoubleClick += delegate { Restore(); };
        tray.BalloonTipTitle = "T约束 在后台盯着";
        tray.BalloonTipText = "关窗口不会退出，点托盘图标可以再打开。";
    }

    void Restore()
    {
        Show();
        WindowState = FormWindowState.Normal;
        Activate();
        Refresh1();
    }

    void OnClosing(object sender, FormClosingEventArgs e)
    {
        if (!reallyQuit && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            Hide();
            if (tray != null && tray.Visible)
            {
                tray.BalloonTipTitle = "T约束 还在跑";
                tray.BalloonTipText = "点托盘图标回到面板。";
                tray.ShowBalloonTip(2500);
            }
            return;
        }
        if (ticker != null) ticker.Stop();
        if (tray != null) { tray.Visible = false; tray.Dispose(); }
    }

    // ------------------------------------------------------------------ 状态读取

    void Refresh1()
    {
        ReloadSettingsIfChanged();
        ReadStatus();
        ApplyEnabledToUi();
        Invalidate();
    }

    // 设置可能被别处改（手改、插件写、另一个面板实例），变了就把挡位灯重新点亮
    void ReloadSettingsIfChanged()
    {
        try
        {
            DateTime write = File.GetLastWriteTimeUtc(Paths.SettingsFile);
            if (write == settingsFileWrite) return;
            settingsFileWrite = write;
            LoadSettings();
            settingsFileWrite = write;
            SyncControls();
            if (autoStart != null) autoStart.Checked = Json.Bool(settings["autoStart"], true);
            ApplyEnabledToUi();
            Invalidate();
        }
        catch { }
    }

    void ReadStatus()
    {
        try
        {
            DateTime write = File.GetLastWriteTimeUtc(Paths.StatusFile);
            if (write == statusFileWrite && status != null) return;
            Dictionary<string, object> parsed = Json.Read(Paths.StatusFile);
            if (parsed == null) return;
            status = parsed;
            statusFileWrite = write;
            statusReadAt = DateTime.Now;
            CheckNotifications();
        }
        catch { }
    }

    void CheckNotifications()
    {
        Dictionary<string, object> active = Json.Dict(status, "active");
        if (active == null) { lastTriggerNotified = ""; lastWarnKey = ""; return; }
        string state = Json.Str(active["state"], "idle");
        string key = Json.Str(active["sid"], "") + "#" + Json.Num(active["turn"], 0).ToString();
        if (state == "awaiting")
        {
            if (lastTriggerNotified != key)
            {
                lastTriggerNotified = key;
                string trigger = Json.Str(active["trigger"], "token");
                string text = trigger == "time" ? "时间到点，已硬断" : "Token 到量，已硬断";
                Notify(text, "生成已停，已生成的内容已存到桌面的「DSH限定生成内容」里。");
            }
            return;
        }
        if (state == "running") WarnIfNeeded(active);
    }

    // 80% / 90% 各问一次要不要继续（插件只上报百分比，是否硬断由你这一下决定）
    void WarnIfNeeded(Dictionary<string, object> active)
    {
        object raw = active["warned"];
        if (!(raw is IList)) return;
        int top = 0;
        foreach (object item in (IList)raw)
        {
            int value = (int)Json.Num(item, 0);
            if (value > top) top = value;
        }
        if (top <= 0) return;
        string key = Json.Str(active["sid"], "") + "#" + ((long)Json.Num(active["turn"], 0)).ToString() + "#" + top.ToString();
        if (key == lastWarnKey) return;
        lastWarnKey = key;
        ShowWarnToast(top, Json.Num(active["used"], 0), Json.Num(active["limit"], 0));
    }

    void ShowWarnToast(int pct, double used, double limit)
    {
        if (warnToast != null)
        {
            try { warnToast.Close(); } catch { }
            warnToast = null;
        }
        Toast toast = new Toast("已用 " + pct.ToString() + "%，还接着生成吗？",
            "本轮 " + FmtTokens(used) + " / " + FmtTokens(limit) + "。选「到此为止」立刻硬断，并把这轮已生成的内容存到桌面。");
        toast.ContinueClicked += delegate { toast.Close(); };
        toast.StopClicked += delegate { SendCommand("stop"); };
        toast.FormClosed += delegate { if (warnToast == toast) warnToast = null; };
        warnToast = toast;
        toast.Show();
    }

    void Notify(string title, string text)
    {
        if (tray == null || !tray.Visible) return;
        tray.BalloonTipTitle = title;
        tray.BalloonTipText = text;
        tray.ShowBalloonTip(4000);
    }

    // ------------------------------------------------------------------ 命令

    public void SendCommandCli(string action) { SendCommand(action); }

    void SendCommand(string action)
    {
        try
        {
            Dictionary<string, object> root = Json.Read(Paths.CommandsFile);
            // JavaScriptSerializer 把数组反序列化成 object[]（也可能是 ArrayList），两种都要认
            ArrayList list = new ArrayList();
            object raw = root == null ? null : root["commands"];
            if (raw is IList)
            {
                foreach (object item in (IList)raw) list.Add(item);   // object[] 是定长的，先拷进 ArrayList 再追加
            }
            long maxId = 0;
            foreach (object item in list)
            {
                Dictionary<string, object> row = item as Dictionary<string, object>;
                if (row == null) continue;
                long id = (long)Json.Num(row["id"], 0);
                if (id > maxId) maxId = id;
            }
            Dictionary<string, object> command = new Dictionary<string, object>();
            command["id"] = maxId + 1;
            command["action"] = action;
            command["at"] = DateTime.Now.ToString("o");
            list.Add(command);
            while (list.Count > 40) list.RemoveAt(0);
            Dictionary<string, object> output = new Dictionary<string, object>();
            output["commands"] = list;
            Json.Write(Paths.CommandsFile, output);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("DEBUG send error: " + error.GetType().Name + " / " + error.Message);
            Notify("命令没发出去", error.Message);
        }
    }

    void OpenArchive()
    {
        string root = Json.Str(settings["archiveRoot"], "");
        if (root == "")
        {
            Dictionary<string, object> report = Json.Dict(status, "settings");
            if (report != null) root = Json.Str(report["archiveRoot"], "");
        }
        if (root == "") root = Paths.DefaultArchiveRoot;
        try
        {
            Directory.CreateDirectory(root);
            ProcessStartInfo psi = new ProcessStartInfo("explorer.exe");
            psi.Arguments = "\"" + root + "\"";
            psi.UseShellExecute = true;
            Process.Start(psi);
        }
        catch (Exception error)
        {
            Notify("打不开目录", error.Message);
        }
    }

    void SetAutoStart(bool on)
    {
        try
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Run", true))
            {
                if (key == null) return;
                if (on) key.SetValue("TLock", "\"" + Application.ExecutablePath + "\"");
                else key.DeleteValue("TLock", false);
            }
        }
        catch { }
    }

    // ------------------------------------------------------------------ 演示数据

    void seedDemo(string mode)
    {
        Dictionary<string, object> active = new Dictionary<string, object>();
        active["sid"] = "sess_demo";
        active["title"] = "T约束：先验版调试";
        active["turn"] = 1;
        active["used"] = mode == "awaiting" ? 20110 : mode == "time" ? 6840 : 13240;
        active["usedExact"] = 13010;
        active["estimated"] = 230;
        active["limit"] = 20000;
        active["elapsedMs"] = mode == "time" ? 312000 : 138000;
        active["timeLimitMs"] = 300000;
        active["state"] = mode == "time" || mode == "awaiting" ? "awaiting" : "running";
        active["trigger"] = mode == "time" ? "time" : "token";
        active["continues"] = 0;
        status = new Dictionary<string, object>();
        status["enabled"] = true;
        status["active"] = active;
        status["at"] = DateTime.Now.Ticks / 10000;
        Dictionary<string, object> reportSettings = new Dictionary<string, object>();
        reportSettings["archiveRoot"] = Paths.DefaultArchiveRoot;
        status["settings"] = reportSettings;
        statusReadAt = DateTime.Now;
        statusFileWrite = DateTime.MinValue;
    }

    void ApplyEnabledToUi()
    {
        bool enabled = status != null && Json.Bool(status["enabled"], true);
        bool fresh = status != null && (DateTime.Now - statusReadAt).TotalSeconds < 6;
        if (fresh)
        {
            connLabel.Text = enabled ? "DSH 在线 · 约束中" : "DSH 在线 · 已暂停";
            connLabel.ForeColor = enabled ? Ui.Good : Ui.Muted;
        }
        else
        {
            connLabel.Text = "DSH 未运行";
            connLabel.ForeColor = Ui.Faint;
        }
    }

    // ------------------------------------------------------------------ 绘制

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        Graphics g = e.Graphics;
        Ui.SetQuality(g);

        using (SolidBrush bg = new SolidBrush(Ui.Bg)) g.FillRectangle(bg, ClientRectangle);

        // 标题
        Rectangle iconRect = new Rectangle(20, 16, 26, 26);
        try { if (Icon != null) g.DrawIcon(Icon, iconRect); } catch { }
        g.DrawString("T约束", Ui.F(14f, true), new SolidBrush(Ui.Text), 56f, 12f);
        g.DrawString("每轮生成的 token / 时间双闸", Ui.F(8f, false), new SolidBrush(Ui.Muted), 58f, 30f);
        using (Pen line = new Pen(Ui.Line, 1f)) g.DrawLine(line, 16, 70, 404, 70);

        Dictionary<string, object> active = status == null ? null : Json.Dict(status, "active");
        bool awaiting = active != null && Json.Str(active["state"], "") == "awaiting";
        if (awaiting) DrawBanner(g, active);
        else DrawCard(g, active);

        g.DrawString("归档", Ui.F(8.5f, true), new SolidBrush(Ui.Text), 18f, 355f);
    }

    void DrawCard(Graphics g, Dictionary<string, object> active)
    {
        using (GraphicsPath path = Ui.Round(cardRect, 12f))
        {
            using (SolidBrush b = new SolidBrush(Ui.Card)) g.FillPath(b, path);
            using (Pen p = new Pen(Ui.Line, 1f)) g.DrawPath(p, path);
        }

        double used = active == null ? 0 : Json.Num(active["used"], 0);
        double limit = active == null ? TokenLimit : Json.Num(active["limit"], TokenLimit);
        if (limit <= 0) limit = TokenLimit;
        long elapsed = active == null ? 0 : (long)Json.Num(active["elapsedMs"], 0);
        long timeLimit = active == null ? TimeLimitSec * 1000 : (long)Json.Num(active["timeLimitMs"], TimeLimitSec * 1000);
        if (active != null && Json.Str(active["state"], "") == "running")
            elapsed += (long)(DateTime.Now - statusReadAt).TotalMilliseconds;

        DrawBarRow(g, 100, "Token", FmtTokens(used) + " / " + FmtTokens(limit), used / limit, Ui.Green);
        DrawBarRow(g, 150, "时间", FmtClock(elapsed) + " / " + FmtClock(timeLimit), timeLimit <= 0 ? 0 : (double)elapsed / timeLimit, Ui.Green);

        string session = active == null ? "" : Json.Str(active["title"], "");
        if (session == "")
        {
            g.DrawString("还没有开始计量的一轮", Ui.F(8f, false), new SolidBrush(Ui.Faint), 32f, 186f);
        }
        else
        {
            g.DrawString("会话：" + Clip(session, 26), Ui.F(8f, false), new SolidBrush(Ui.Faint), 32f, 186f);
        }
    }

    void DrawBarRow(Graphics g, int top, string label, string value, double ratio, Color color)
    {
        if (ratio < 0) ratio = 0;
        if (ratio > 1) ratio = 1;
        g.DrawString(label, Ui.F(8f, false), new SolidBrush(Ui.Muted), 32f, top);
        SizeF size = g.MeasureString(value, Ui.F(9f, true));
        g.DrawString(value, Ui.F(9f, true), new SolidBrush(Ui.Text), 388f - size.Width, top - 1f);
        RectangleF track = new RectangleF(32, top + 20, 356, 7);
        using (GraphicsPath path = Ui.Round(track, 3.5f))
        {
            using (SolidBrush b = new SolidBrush(Color.FromArgb(243, 244, 246))) g.FillPath(b, path);
            if (ratio > 0.001)
            {
                RectangleF fill = new RectangleF(track.X, track.Y, (float)(track.Width * ratio), track.Height);
                using (GraphicsPath fillPath = Ui.Round(fill, 3.5f))
                using (SolidBrush b = new SolidBrush(color)) g.FillPath(b, fillPath);
            }
        }
    }

    void DrawBanner(Graphics g, Dictionary<string, object> active)
    {
        string trigger = Json.Str(active["trigger"], "token");
        Color accent = trigger == "time" ? Ui.Warn : Ui.Danger;
        using (GraphicsPath path = Ui.Round(cardRect, 12f))
        {
            using (SolidBrush b = new SolidBrush(Color.FromArgb(253, 242, 242))) g.FillPath(b, path);
            using (Pen p = new Pen(Color.FromArgb(254, 202, 202), 1f)) g.DrawPath(p, path);
        }
        string head = trigger == "time" ? "时间到点，生成已硬断" : "Token 到量，生成已硬断";
        g.DrawString(head, Ui.F(11f, true), new SolidBrush(accent), 32f, 96f);
        double used = Json.Num(active["used"], 0);
        double limit = Json.Num(active["limit"], TokenLimit);
        long elapsed = (long)Json.Num(active["elapsedMs"], 0);
        string detail = "已用 " + FmtTokens(used) + " / " + FmtTokens(limit) + " · " + FmtClock(elapsed);
        g.DrawString(detail, Ui.F(8f, false), new SolidBrush(Ui.Muted), 32f, 122f);
        g.DrawString("已生成的内容已存到桌面「DSH限定生成内容」。要接着写吗？", Ui.F(8f, false), new SolidBrush(Ui.Muted), 32f, 142f);

        bannerContinue = new Rectangle(150, 168, 118, 32);
        bannerEnd = new Rectangle(274, 168, 98, 32);
        DrawInlineButton(g, bannerContinue, "继续生成", true, bannerHoverContinue);
        DrawInlineButton(g, bannerEnd, "结束本轮", false, bannerHoverEnd);
    }

    void DrawInlineButton(Graphics g, Rectangle rect, string text, bool primary, bool hover)
    {
        using (GraphicsPath path = Ui.Round(rect, 8f))
        {
            Color fill = primary ? Ui.Accent : (hover ? Color.FromArgb(243, 244, 246) : Color.White);
            using (SolidBrush b = new SolidBrush(fill)) g.FillPath(b, path);
            using (Pen p = new Pen(primary ? Ui.Accent : Ui.Line, 1f)) g.DrawPath(p, path);
        }
        TextRenderer.DrawText(g, text, Ui.F(8.5f, false), rect,
            primary ? Color.White : Ui.Text,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
    }

    static string Clip(string text, int max)
    {
        if (text == null) return "";
        return text.Length <= max ? text : text.Substring(0, max) + "…";
    }

    static string FmtTime(int sec)
    {
        if (sec < 60) return sec + " 秒";
        int m = sec / 60;
        if (m < 60) return m + " 分";
        int h = m / 60;
        int mm = m % 60;
        return mm == 0 ? h + " 小时" : h + " 小时 " + mm + " 分";
    }

    static string FmtTokens(double n)
    {
        if (n >= 1e8) return (n / 1e8).ToString("0.##") + " 亿";
        if (n >= 1e4) return (n / 1e4).ToString("0.##") + " 万";
        return ((long)Math.Round(n)).ToString();
    }

    static string FmtClock(long ms)
    {
        long total = Math.Max(0, ms / 1000);
        long m = total / 60;
        long s = total % 60;
        return m.ToString("00") + ":" + s.ToString("00");
    }

    // ------------------------------------------------------------------ 鼠标

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        bool hc = bannerContinue.Contains(e.Location);
        bool he = bannerEnd.Contains(e.Location);
        if (hc != bannerHoverContinue || he != bannerHoverEnd)
        {
            bannerHoverContinue = hc;
            bannerHoverEnd = he;
            Cursor = hc || he ? Cursors.Hand : Cursors.Default;
            Invalidate();
        }
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        base.OnMouseLeave(e);
        if (bannerHoverContinue || bannerHoverEnd)
        {
            bannerHoverContinue = false;
            bannerHoverEnd = false;
            Cursor = Cursors.Default;
            Invalidate();
        }
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        if (bannerContinue.Contains(e.Location))
        {
            SendCommand("continue");
            lastTriggerNotified = "";
        }
        else if (bannerEnd.Contains(e.Location))
        {
            SendCommand("end");
            lastTriggerNotified = "";
        }
        else if (new Rectangle(326, 214, 78, 24).Contains(e.Location))
        {
            AskCustomTokens();
        }
        else if (new Rectangle(326, 280, 78, 24).Contains(e.Location))
        {
            AskCustomTime();
        }
    }

    void AskCustomTokens()
    {
        decimal current = Math.Round((decimal)TokenLimit / 1000m, 1);
        using (InputDialog dialog = new InputDialog("手动输入 Token 上限", "每轮最多生成多少 token（单位：千，范围 5 ~ 1000）", current, 5m, 1000m, 1, "千 token"))
        {
            if (dialog.ShowDialog(this) == DialogResult.OK)
            {
                int value = (int)Math.Round(dialog.Value * 1000m);
                TokenLimit = Math.Max(5000, Math.Min(1000000, value));
                SyncControls();
            }
        }
    }

    void AskCustomTime()
    {
        decimal current = (decimal)TimeLimitSec / 60m;
        using (InputDialog dialog = new InputDialog("手动输入时间上限", "每轮最多生成多少分钟（范围 1 ~ 120）", current, 1m, 120m, 0, "分钟"))
        {
            if (dialog.ShowDialog(this) == DialogResult.OK)
            {
                int value = (int)Math.Round(dialog.Value * 60m);
                TimeLimitSec = Math.Max(60, Math.Min(7200, value));
                SyncControls();
            }
        }
    }
}

static class Json
{
    static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer();

    static JavaScriptSerializer S { get { return Serializer; } }

    public static Dictionary<string, object> Read(string file)
    {
        try
        {
            if (!File.Exists(file)) return null;
            string text = File.ReadAllText(file);
            if (text.Trim() == "") return null;
            object parsed = S.DeserializeObject(text);
            Dictionary<string, object> dict = parsed as Dictionary<string, object>;
            if (dict == null && Environment.GetEnvironmentVariable("TLOCK_DEBUG") != null)
                Console.Error.WriteLine("DEBUG read not dict: " + (parsed == null ? "null" : parsed.GetType().FullName) + " from " + file);
            return dict;
        }
        catch (Exception error)
        {
            if (Environment.GetEnvironmentVariable("TLOCK_DEBUG") != null)
                Console.Error.WriteLine("DEBUG read error " + file + " :: " + error.GetType().Name + " " + error.Message);
            return null;
        }
    }

    public static void Write(string file, Dictionary<string, object> value)
    {
        string dir = Path.GetDirectoryName(file);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        string text = S.Serialize(value);
        string tmp = file + "." + Process.GetCurrentProcess().Id + ".tmp";
        File.WriteAllText(tmp, text);
        if (File.Exists(file)) File.Delete(file);
        File.Move(tmp, file);
    }

    public static Dictionary<string, object> Dict(Dictionary<string, object> parent, string key)
    {
        if (parent == null || !parent.ContainsKey(key)) return null;
        return parent[key] as Dictionary<string, object>;
    }

    public static string Str(object value, string fallback)
    {
        if (value == null) return fallback;
        string s = value as string;
        if (s != null) return s;
        return value.ToString();
    }

    public static double Num(object value, double fallback)
    {
        if (value == null) return fallback;
        try
        {
            if (value is int) return (int)value;
            if (value is long) return (long)value;
            if (value is double) return (double)value;
            if (value is decimal) return (double)(decimal)value;
            if (value is float) return (float)value;
            return double.Parse(value.ToString(), System.Globalization.CultureInfo.InvariantCulture);
        }
        catch { return fallback; }
    }

    public static bool Bool(object value, bool fallback)
    {
        if (value == null) return fallback;
        if (value is bool) return (bool)value;
        string text = value.ToString();
        return text == "true" || text == "True" || text == "1";
    }
}

static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "--cmd")
        {
            try
            {
                Console.Error.WriteLine("DEBUG state=" + Paths.StateDir);
                using (MainForm form = new MainForm(false))
                {
                    form.SendCommandCli(args[1]);
                }
                Console.Error.WriteLine("DEBUG wrote=" + Paths.CommandsFile + " exists=" + File.Exists(Paths.CommandsFile));
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("DEBUG error: " + error);
            }
            return;
        }

        if (args.Length > 0 && args[0] == "--shot")
        {
            string output = args.Length > 1 ? args[1] : "shot.png";
            string mode = args.Length > 2 ? args[2] : "running";
            using (MainForm form = new MainForm(true, mode))
            {
                form.Show();
                Application.DoEvents();
                Thread.Sleep(450);
                Application.DoEvents();
                using (Bitmap bmp = new Bitmap(form.Width, form.Height))
                {
                    form.DrawToBitmap(bmp, new Rectangle(0, 0, form.Width, form.Height));
                    bmp.Save(output, System.Drawing.Imaging.ImageFormat.Png);
                }
            }
            return;
        }

        if (args.Length > 0 && args[0] == "--toast")
        {
            string output = args.Length > 1 ? args[1] : "toast.png";
            int pct = args.Length > 2 ? int.Parse(args[2]) : 80;
            using (Toast toast = new Toast("已用 " + pct.ToString() + "%，还接着生成吗？", "本轮 8 万 / 10 万。选「到此为止」立刻硬断并存档。"))
            {
                toast.Show();
                Application.DoEvents();
                Thread.Sleep(300);
                Application.DoEvents();
                using (Bitmap bmp = new Bitmap(toast.Width, toast.Height))
                {
                    toast.DrawToBitmap(bmp, new Rectangle(0, 0, toast.Width, toast.Height));
                    bmp.Save(output, System.Drawing.Imaging.ImageFormat.Png);
                }
            }
            return;
        }

        bool created = false;
        Mutex mutex = new Mutex(true, "Global\\TLock_TConstraint_Single", out created);
        if (!created)
        {
            MessageBox.Show("T约束 已经在运行了，看右下角托盘。", "T约束", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new MainForm(false));
        GC.KeepAlive(mutex);
    }
}
