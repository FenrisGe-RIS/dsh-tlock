using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

// T约束 图标生成器：深色圆角方块 + 左上→右下斜向锁链 + 棱角化的科幻 T（与锁链留缝）
class IconGen
{
    static readonly int[] Sizes = { 16, 24, 32, 48, 64, 128, 256 };

    static GraphicsPath RoundedSquare(RectangleF r, float radius)
    {
        GraphicsPath p = new GraphicsPath();
        float d = radius * 2;
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    // 胶囊链环：外轮廓由两段半圆 + 两条直线组成，用粗笔描边画成"环"
    static void DrawLink(Graphics g, float cx, float cy, float len, float wid, float pen, Color color)
    {
        GraphicsState state = g.Save();
        g.TranslateTransform(cx, cy);
        g.RotateTransform(45f);
        float half = len / 2f - wid / 2f;
        RectangleF r = new RectangleF(-len / 2f, -wid / 2f, len, wid);
        using (GraphicsPath path = new GraphicsPath())
        {
            float d = wid;
            path.AddArc(r.X, r.Y, d, d, 90, 180);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 180);
            path.CloseFigure();
            using (Pen p = new Pen(color, pen))
            {
                p.LineJoin = LineJoin.Round;
                g.DrawPath(p, path);
            }
        }
        g.Restore(state);
    }

    // 棱角化的科幻 T：上横杠是带切角的多边形，竖杆下端收成尖角
    static GraphicsPath TShape(float s)
    {
        // 以 256 为设计基准，按 s 缩放
        float k = s / 256f;
        PointF[] pts = new PointF[]
        {
            new PointF(84, 56),   // 横杠左上
            new PointF(172, 56),  // 横杠右上
            new PointF(186, 70),  // 右上切角
            new PointF(186, 96),  // 右端
            new PointF(148, 96),  // 右肩内收
            new PointF(148, 200), // 竖杆右下
            new PointF(128, 214), // 尖端
            new PointF(108, 200), // 竖杆左下
            new PointF(108, 96),  // 左肩内收
            new PointF(70, 96),   // 左端
            new PointF(70, 70),   // 左上切角
        };
        GraphicsPath p = new GraphicsPath();
        for (int i = 0; i < pts.Length; i++)
        {
            pts[i] = new PointF(pts[i].X * k, pts[i].Y * k);
        }
        p.AddPolygon(pts);
        return p;
    }

    static Bitmap Render(int size)
    {
        Bitmap bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.Clear(Color.Transparent);

            float s = size;
            RectangleF full = new RectangleF(0, 0, s - 0.5f, s - 0.5f);
            using (GraphicsPath bg = RoundedSquare(full, s * 0.22f))
            {
                using (LinearGradientBrush fill = new LinearGradientBrush(full, Color.FromArgb(32, 41, 56), Color.FromArgb(12, 16, 24), 45f))
                {
                    g.FillPath(fill, bg);
                }
                using (Pen edge = new Pen(Color.FromArgb(120, 96, 138, 196), Math.Max(1f, s * 0.008f)))
                {
                    g.DrawPath(edge, bg);
                }
            }

            // 斜向锁链：6 个密排链环，从左上角一路排到右下角
            float pen = s * 0.034f;
            Color chain = Color.FromArgb(226, 232, 240);
            float len = s * 0.158f;
            float wid = s * 0.084f;
            float startX = s * 0.112f, startY = s * 0.112f;
            float step = s * 0.1055f;
            for (int i = 0; i < 8; i++)
            {
                DrawLink(g, startX + step * i, startY + step * i, len, wid, pen, chain);
            }

            // 先画一圈深色描边当"间隙"，再把 T 填进去 —— 锁链就被 T 让开了一条缝
            using (GraphicsPath t = TShape(s))
            {
                using (Pen gapPen = new Pen(Color.FromArgb(255, 17, 22, 32), s * 0.040f))
                {
                    gapPen.LineJoin = LineJoin.Miter;
                    g.DrawPath(gapPen, t);
                }
                using (LinearGradientBrush tb = new LinearGradientBrush(new PointF(0, s * 0.22f), new PointF(0, s * 0.84f), Color.FromArgb(255, 255, 255), Color.FromArgb(222, 230, 240)))
                {
                    g.FillPath(tb, t);
                }
            }
        }
        return bmp;
    }

    static byte[] PngBytes(Bitmap bmp)
    {
        using (MemoryStream ms = new MemoryStream())
        {
            bmp.Save(ms, ImageFormat.Png);
            return ms.ToArray();
        }
    }

    static void Main(string[] args)
    {
        string outPath = args.Length > 0 ? args[0] : "icon.ico";
        string previewPath = args.Length > 1 ? args[1] : "";
        int count = Sizes.Length;
        byte[][] pngs = new byte[count][];
        for (int i = 0; i < count; i++)
        {
            using (Bitmap bmp = Render(Sizes[i]))
            {
                pngs[i] = PngBytes(bmp);
            }
        }

        using (FileStream fs = new FileStream(outPath, FileMode.Create))
        using (BinaryWriter w = new BinaryWriter(fs))
        {
            w.Write((ushort)0);
            w.Write((ushort)1);
            w.Write((ushort)count);
            int offset = 6 + 16 * count;
            for (int i = 0; i < count; i++)
            {
                int dim = Sizes[i] >= 256 ? 0 : Sizes[i];
                w.Write((byte)dim);
                w.Write((byte)dim);
                w.Write((byte)0);
                w.Write((byte)0);
                w.Write((ushort)1);
                w.Write((ushort)32);
                w.Write((uint)pngs[i].Length);
                w.Write((uint)offset);
                offset += pngs[i].Length;
            }
            for (int i = 0; i < count; i++)
            {
                w.Write(pngs[i]);
            }
        }

        if (previewPath != "")
        {
            using (Bitmap big = Render(256))
            {
                big.Save(previewPath, ImageFormat.Png);
            }
        }
        Console.WriteLine("icon written: " + outPath);
    }
}
