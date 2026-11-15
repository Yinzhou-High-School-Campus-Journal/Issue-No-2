#!/usr/bin/env python3
"""把 Markdown 稿件按源码原样排成 A4 PDF，打印出来线下审稿。

版式：A4，五号字（10.5 磅），左对齐；行距固定 14 磅并对齐网格（每行等高，每页行数相同，
正反面行位一致）；正文在页面上左右居中，页边距约 12 毫米；行长是字号的整数倍（每行 50 字），
行首有空格的行整块缩进整数个字，折行后的行长也是整数倍。行号就是源文件的行号，挂在左边距里、
紧贴正文，长行折行后不另编号；四位数行号横向压扁到三位宽，所有稿件版式一致。
页眉是文件名和 Git 版本，页脚是页码。
字体：正文用汉仪新人文宋 55W，缺字依次用思源宋体、Noto Serif 补（希腊字母整段用 Noto Serif，
免得一个词里混用两套字形）；YAML 元数据和代码块用 SF Mono，其中的汉字和中文标点用无衬线的
更纱黑体 Ui（Sarasa Ui SC），缺字依次用思源黑体、Noto Sans 补。
中西文之间由 CSS 自动加空（text-autospace，1/8 字）；标点由 CSS 压缩（text-spacing-trim: trim-start）：
行首的开始标点（「『（《“ 等）压成半字，相邻标点之间的空白（如「」「」「。」」）也挤掉。
Chrome 压缩标点要靠字体的 halt 特性，更纱黑体自带，汉仪新人文宋没有，所以脚本会用 fontTools
给它做一份临时副本，只补上全角标点的半字数据，字形不变，打印完即删。

需要 Python 3.10+ 和 Chrome（用无头模式打印）；行首标点压缩另需 fontTools
（pip install fonttools），没装就照常打印，只是不压缩。

用法（在仓库根目录运行）：
  python scripts/md2pdf.py                  「文章/」下全部稿件，跳过「编审未通过」「非见刊类」和数学卷
  python scripts/md2pdf.py --all            连同跳过的这些一起
  python scripts/md2pdf.py 文章/创意写作（李洛霄）/七夕.md
  python scripts/md2pdf.py 文章/人文社科（张哲源）
PDF 默认放在仓库根目录的「打印/」，目录结构与「文章/」一致。
"""

from __future__ import annotations

import argparse
import html
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from string import Template

REPO = Path(__file__).resolve().parent.parent
ARTICLES = REPO / "文章"
DEFAULT_OUT = REPO / "打印"
SKIPPED_DIRS = ("编审未通过", "非见刊类", "浙江省2026年初中学业水平模拟考试数学卷")  # 默认不打印；直接指定路径时照打
SKIPPED_TEXT = "「编审未通过」「非见刊类」和数学卷"

PT_PER_MM = 72 / 25.4
A4_W = 210 * PT_PER_MM
A4_H = 297 * PT_PER_MM
SMALL = 7.5  # 行号、页眉、页脚用六号字
MONO_ADVANCE = 0.62  # SF Mono 的字宽（em）
EDGE = 5 * PT_PER_MM  # 行号离纸边至少这么远，免得打印机印不到
NUMBER_GAP = MONO_ADVANCE * SMALL  # 行号与正文之间空一个 SF Mono 字宽
GUTTER = 3 * MONO_ADVANCE * SMALL + NUMBER_GAP + 0.5  # 行号栏：三位行号加间隔；更长的行号横向压扁到这个宽度
SLACK = 1.5  # 版心比整行整字多留的余量（磅）：Chrome 把纸张尺寸取整到 1/300 英寸，行高取整到 1/64 像素
SONG_SPACE_EM = 0.25  # 汉仪新人文宋的半角空格宽

SONG_PS = "HYXinRenWenSong-EEW"  # 汉仪新人文宋 55W 的 PostScript 名
SONG_LOCAL = f'local("{SONG_PS}"), local("HYXinRenWenSong 55W"), local("汉仪新人文宋 55W")'
SONG_TRIM_FILE = "song-halt.ttf"
# 给汉仪新人文宋补 halt 的全角标点：开始标点的字面在右半边，结束标点和句读在左半边，间隔号居中
OPENING = "「『（《〈【〔〖〘〚［｛｟“‘"
CLOSING = "」』）》〉】〕〗〙〛］｝｠”’，。、．：；！？"
MIDDLE = "·・"

FONT_PREFIX = {"汉仪新人文宋 55W": "HYXinRenWenSong", "SF Mono": "SFMono", "更纱黑体 Ui": "Sarasa"}  # PDF 里的字体名前缀

# 回退：汉字找思源，西文找 Noto；Noto SC 与思源是同一套字形，没装思源时顶上
SONG = '"Src Song", "Src Greek", "Source Han Serif SC", "思源宋体", "Noto Serif SC", "Noto Serif CJK SC", "Noto Serif", serif'
MONO = '"Src Mono", "Src Sans", "Source Han Sans SC", "思源黑体", "Noto Sans SC", "Noto Sans CJK SC", "Noto Sans", sans-serif'

CSS = Template("""
@font-face { font-family: "Src Song"; src: $song_src; }
/* 希腊字母（含多调符号）整段交给 Noto Serif；思源宋体只有基本希腊字母，混用会一个词两套字形 */
@font-face {
  font-family: "Src Greek";
  src: local("NotoSerif-Regular"), local("Noto Serif Regular");
  unicode-range: U+0370-03FF, U+1F00-1FFF;
}
@font-face {
  font-family: "Src Sans";
  src: local("Sarasa-Ui-PD-SC-Regular"), local("Sarasa-Ui-PropDigits-SC-Regular"), local("SarasaUiSC-Regular"),
       local("Sarasa Ui PD SC"), local("Sarasa Ui PropDigits SC"), local("Sarasa UI SC");
}
/* 间隔号、破折号、省略号、弯引号、带圈数字在等宽行里交给更纱黑体，与汉字一致 */
@font-face {
  font-family: "Src Mono";
  src: local("SFMono-Regular"), local("SF Mono Regular");
  unicode-range: U+0-B6, U+B8-2013, U+2016-2017, U+201A-201B, U+201E-2024, U+2027-245F, U+2500-10FFFF;
}
/* 页面区域左右各比正文多出一个行号栏宽：Chrome 不画页边距里的正文，行号得在页面区域内。
   正文因此仍然居中，页眉按正文的左右边对齐，页码居中 */
@page {
  size: A4;
  margin: ${top}pt ${page_side}pt;
  @top-left {
    content: $header_left; font: ${small}pt $song; color: #666;
    vertical-align: bottom; padding: 0 0 6pt ${pad}pt;
  }
  @top-right {
    content: $header_right; font: ${small}pt $song; color: #666;
    vertical-align: bottom; padding: 0 ${pad}pt 6pt 0;
  }
  @bottom-center {
    content: counter(page) " / " counter(pages); font: ${small}pt $song; color: #333;
    vertical-align: top; padding-top: 6pt;
  }
}
body {
  margin: 0;
  font: ${font_size}pt/${line_height}pt $song;
  color: #000;
  text-align: left;
  text-autospace: normal;
  text-spacing-trim: trim-start;
  line-break: strict;
  orphans: 1;
  widows: 1;
}
main { margin: 0 auto; width: ${text_width}pt; }
/* 每行源码是两栏网格：左栏行号挂在左边距里，右栏正文。行号不在正文行内，首行的开始标点照样压缩；
   两栏按首行基线对齐。行号行高为 0，不会把行撑高 */
.l {
  display: grid;
  grid-template-columns: ${gutter}pt minmax(0, 1fr);
  margin-left: -${gutter}pt;
  align-items: baseline;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 4;
}
/* 从右往左排，超宽的行号向左溢出，再横向压扁到三位宽（--sx） */
.l::before {
  content: attr(data-n);
  direction: rtl;
  text-align: right;
  white-space: nowrap;
  overflow-wrap: normal;
  padding-right: ${gap}pt;
  font: ${small}pt/0 $mono;
  color: #888;
  transform: scaleX(var(--sx, 1));
  transform-origin: right;
}
.m { font-family: $mono; }
.i { padding-left: var(--i); }
""")

FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")


@dataclass
class Layout:
    font_size: float
    line_height: float
    chars: int
    rows: int
    side: float  # 正文到纸边的距离（左右相等）
    top: float


def make_layout(font_size: float, line_height: float, margin_mm: float) -> Layout:
    """正文左右居中；左边距要放得下三位行号，并让行号离纸边至少 EDGE，放不下就每行少排字。"""
    margin = margin_mm * PT_PER_MM
    chars = int((A4_W - 2 * max(margin, GUTTER + EDGE) - SLACK) // font_size)
    rows = int((A4_H - 2 * margin - SLACK) // line_height)
    if chars < 10 or rows < 10:
        sys.exit("页边距、字号或行距过大，版心放不下。")
    side = (A4_W - chars * font_size - SLACK) / 2
    top = (A4_H - rows * line_height - SLACK) / 2
    return Layout(font_size, line_height, chars, rows, side, top)


def split_lines(text: str) -> list[str]:
    """按编辑器的方式分行：只认 \\n，文件末尾的换行不算新的一行。"""
    text = text.removeprefix("\ufeff")
    lines = [line.removesuffix("\r") for line in text.split("\n")]
    if len(lines) > 1 and lines[-1] == "":
        lines.pop()
    return lines


def mono_flags(lines: list[str]) -> list[bool]:
    """YAML 元数据（含首尾的 ---）和围栏代码块用等宽字体。"""
    mono = [False] * len(lines)
    start = 0
    if lines and lines[0].rstrip() == "---":
        for i in range(1, len(lines)):
            if lines[i].rstrip() in ("---", "..."):
                mono[: i + 1] = [True] * (i + 1)
                start = i + 1
                break
    fence = None
    for i in range(start, len(lines)):
        m = FENCE.match(lines[i])
        if fence is None:
            if m:
                fence = m.group(1)
                mono[i] = True
        else:
            mono[i] = True
            if m and m.group(1)[0] == fence[0] and len(m.group(1)) >= len(fence) and not lines[i][m.end():].strip():
                fence = None
    return mono


def render_line(n: int, text: str, mono: bool) -> str:
    """一行源码对应一个列表项。

    行首的空格改成整块缩进：折行后与首行对齐，行首标点也能压缩。缩进按空格原宽四舍五入到整字
    （至少一字），这样缩进行的行长仍是字号的整数倍。
    """
    cls = "l m" if mono else "l"
    digits = len(str(n))
    squash = f' style="--sx:{3 / digits:.3f}"' if digits > 3 else ""
    body = text.lstrip(" \t")
    indent = text[: len(text) - len(body)]
    # 空行放一个零宽空格：网格里只有空白的文字不成栏，行就塌了
    content = html.escape(body, quote=False) or "\u200b"
    if indent and body:
        cols = len(indent.expandtabs(4))
        ems = max(1, round(cols * (MONO_ADVANCE if mono else SONG_SPACE_EM)))
        content = f'<div class="i" style="--i:{ems}em">{content}</div>'
    return f'<div class="{cls}" data-n="{n}"{squash}>{content}</div>'


def css_string(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ") + '"'


def git_version(path: Path) -> str:
    def git(*args: str) -> str:
        return subprocess.run(
            ["git", "-C", str(REPO), *args], capture_output=True, text=True, encoding="utf-8", timeout=20
        ).stdout.strip()

    try:
        status = git("status", "--porcelain", "--", str(path))
        if status.startswith("??"):
            return "未提交的新文件"
        log = git("log", "-1", "--format=%h %cs", "--", str(path))
    except (OSError, subprocess.SubprocessError):
        return ""
    if not log:
        return ""
    commit, date = log.split()
    return f"版本 {commit}（{date}）" + ("＋本地未提交改动" if status else "")


def display_path(path: Path) -> str:
    try:
        return path.relative_to(REPO).as_posix()
    except ValueError:
        return str(path)


def build_html(src: Path, layout: Layout, song_src: str) -> tuple[str, set[str]]:
    """返回网页和这份稿件应当用到的字体（用于打印后检查字体是否装好）。"""
    lines = split_lines(src.read_text(encoding="utf-8"))
    mono = mono_flags(lines)
    mono_text = "".join(text for text, is_mono in zip(lines, mono) if is_mono)
    fonts = {"汉仪新人文宋 55W"}
    if re.search(r"[!-~]", mono_text):
        fonts.add("SF Mono")
    if re.search(r"[\u2e80-\u9fff\uff00-\uffef]", mono_text):
        fonts.add("更纱黑体 Ui")
    rows = [render_line(n, text, is_mono) for n, (text, is_mono) in enumerate(zip(lines, mono), 1)]
    css = CSS.substitute(
        song_src=song_src,
        top=f"{layout.top:.3f}",
        page_side=f"{layout.side - GUTTER:.3f}",
        header_left=css_string(src.name),
        header_right=css_string(git_version(src)),
        small=SMALL,
        song=SONG,
        mono=MONO,
        font_size=layout.font_size,
        line_height=layout.line_height,
        pad=f"{GUTTER + SLACK / 2:.3f}",
        gutter=f"{GUTTER:.3f}",
        gap=f"{NUMBER_GAP:.3f}",
        text_width=f"{layout.chars * layout.font_size:.3f}",
    )
    page = (
        '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n'
        f"<title>{html.escape(display_path(src))}</title>\n<style>{css}</style>\n</head>\n"
        "<body><main>\n" + "\n".join(rows) + "\n</main></body>\n</html>\n"
    )
    return page, fonts


def font_dirs() -> list[Path]:
    home = Path.home()
    if sys.platform == "win32":
        dirs = [Path(os.environ[k]) / sub for k, sub in (("LOCALAPPDATA", r"Microsoft\Windows\Fonts"), ("WINDIR", "Fonts")) if k in os.environ]
    elif sys.platform == "darwin":
        dirs = [home / "Library/Fonts", Path("/Library/Fonts"), Path("/System/Library/Fonts")]
    else:
        dirs = [home / ".local/share/fonts", home / ".fonts", Path("/usr/local/share/fonts"), Path("/usr/share/fonts")]
    return [d for d in dirs if d.is_dir()]


def build_trim_font(dest: Path) -> str | None:
    """给汉仪新人文宋做一份带 halt 特性的副本，让 CSS 的 text-spacing-trim 能压缩标点。

    halt 是 OpenType 的「半宽标点」数据：开始标点左移半字、宽度减半，结束标点和句读只减宽，
    间隔号左移四分之一字、宽度减半。只给字面确实落在对应半边的全角标点加，其他字形与数据原样保留。
    成功返回 None，否则返回原因。
    """
    try:
        from fontTools.otlLib import builder as otl
        from fontTools.pens.boundsPen import BoundsPen
        from fontTools.ttLib import TTFont
        from fontTools.ttLib.tables import otTables as ot
    except ImportError:
        return "没装 fontTools（pip install fonttools）"

    src = None
    for d in font_dirs():
        for p in d.rglob("*"):
            if p.suffix.lower() in (".ttf", ".otf") and re.search(r"xinrenwensong|新人文宋", p.name, re.I):
                try:
                    if TTFont(p, lazy=True)["name"].getDebugName(6) == SONG_PS:
                        src = p
                        break
                except Exception:  # noqa: BLE001 —— 坏字体文件跳过
                    continue
        if src:
            break
    if src is None:
        return "找不到汉仪新人文宋 55W 的字体文件"

    try:
        font = TTFont(src, lazy=True)
        upem = font["head"].unitsPerEm
        cmap = font.getBestCmap()
        glyphs = font.getGlyphSet()
        half = upem // 2
        values = {}
        for chars, fits, shift in (
            (OPENING, lambda x0, x1: x0 >= upem * 0.45, -half),
            (CLOSING, lambda x0, x1: x1 <= upem * 0.55, 0),
            (MIDDLE, lambda x0, x1: x0 >= upem * 0.2 and x1 <= upem * 0.8, -half // 2),
        ):
            for ch in chars:
                name = cmap.get(ord(ch))
                if not name or name in values or font["hmtx"][name][0] != upem:
                    continue
                pen = BoundsPen(glyphs)
                glyphs[name].draw(pen)
                if pen.bounds and fits(pen.bounds[0], pen.bounds[2]):
                    values[name] = otl.buildValue({"XPlacement": shift, "XAdvance": -half} if shift else {"XAdvance": -half})
        if not any(cmap.get(ord(ch)) in values for ch in OPENING) or "GPOS" not in font:
            return "字体里的开始标点不是全角，没法压缩"

        gpos = font["GPOS"].table
        lookup = otl.buildLookup([otl.buildSinglePosSubtable(values, font.getReverseGlyphMap())])
        gpos.LookupList.Lookup.append(lookup)
        gpos.LookupList.LookupCount = len(gpos.LookupList.Lookup)
        record = ot.FeatureRecord()
        record.FeatureTag = "halt"
        record.Feature = ot.Feature()
        record.Feature.FeatureParams = None
        record.Feature.LookupListIndex = [gpos.LookupList.LookupCount - 1]
        record.Feature.LookupCount = 1
        records = gpos.FeatureList.FeatureRecord
        at = sum(r.FeatureTag < "halt" for r in records)  # 特性表按标签排序
        records.insert(at, record)
        gpos.FeatureList.FeatureCount = len(records)
        for script in gpos.ScriptList.ScriptRecord:
            for langsys in [script.Script.DefaultLangSys] + [r.LangSys for r in script.Script.LangSysRecord]:
                if langsys is None:
                    continue
                langsys.FeatureIndex = [i + (i >= at) for i in langsys.FeatureIndex] + [at]
                langsys.FeatureCount = len(langsys.FeatureIndex)
                if langsys.ReqFeatureIndex != 0xFFFF and langsys.ReqFeatureIndex >= at:
                    langsys.ReqFeatureIndex += 1
        font.save(dest)
    except Exception as exc:  # noqa: BLE001 —— 补不上就退回不压缩
        return f"处理字体出错：{exc}"
    return None


def find_chrome(explicit: str | None) -> str:
    if explicit:
        if Path(explicit).is_file():
            return explicit
        sys.exit(f"找不到 Chrome：{explicit}")
    candidates = []
    if sys.platform == "win32":
        for root in filter(None, (os.environ.get(k) for k in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"))):
            candidates.append(os.path.join(root, r"Google\Chrome\Application\chrome.exe"))
    elif sys.platform == "darwin":
        candidates.append("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    candidates += [shutil.which(name) for name in ("google-chrome", "google-chrome-stable", "chrome")]
    for c in candidates:
        if c and Path(c).is_file():
            return c
    sys.exit("找不到 Chrome：请安装 Chrome，或用 --chrome 指定 chrome.exe 的路径。")


def print_to_pdf(chrome: str, html_path: Path, pdf_path: Path, profile: Path) -> None:
    cmd = [
        chrome,
        "--headless",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-sync",
        "--disable-background-networking",
        f"--user-data-dir={profile}",
        # 字体是异步加载的：给足虚拟时间，等字体就绪再打印
        "--virtual-time-budget=10000",
        "--no-pdf-header-footer",
        "--print-to-pdf-no-header",
        f"--print-to-pdf={pdf_path}",
        html_path.as_uri(),
    ]
    proc = subprocess.run(cmd, capture_output=True, timeout=180)
    if not pdf_path.is_file() or pdf_path.stat().st_size == 0:
        detail = proc.stderr.decode("utf-8", "replace").strip().splitlines()[-3:]
        raise RuntimeError("Chrome 没有生成 PDF：" + " / ".join(detail))


def inspect_pdf(path: Path) -> tuple[int, set[str]]:
    data = path.read_bytes()
    pages = len(re.findall(rb"/Type\s*/Page\b", data))
    # Chrome 把 TrueType 字体嵌成 CID 字体，把 CFF 字体（如 SF Mono）转成 Type 3；两者的描述里都有 FontName
    names = re.findall(rb"/(?:BaseFont|FontName)\s*/([^\s/<>\[\]()]+)", data)
    return pages, {m.decode("latin-1").split("+", 1)[-1] for m in names}


def collect(paths: list[str], include_all: bool) -> tuple[list[Path], list[Path]]:
    files: list[Path] = []
    skipped: list[Path] = []
    for target in [Path(p).resolve() for p in paths] or [ARTICLES]:
        if target.is_file():
            files.append(target)
        elif target.is_dir():
            for p in sorted(target.rglob("*.md")):
                if not include_all and any(part in SKIPPED_DIRS for part in p.relative_to(target).parts[:-1]):
                    skipped.append(p)
                else:
                    files.append(p)
        else:
            sys.exit(f"找不到：{target}")
    return list(dict.fromkeys(files)), skipped


def output_path(src: Path, out_dir: Path) -> Path:
    for base in (ARTICLES, REPO):
        if src.is_relative_to(base):
            return out_dir / src.relative_to(base).with_suffix(".pdf")
    return out_dir / src.with_suffix(".pdf").name


def shown(path: Path) -> str:
    try:
        return os.path.relpath(path)
    except ValueError:
        return str(path)


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(errors="replace")
    parser = argparse.ArgumentParser(
        prog="md2pdf", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("paths", nargs="*", help="稿件或目录，可写多个；不写就是「文章/」")
    parser.add_argument("-o", "--out", type=Path, default=DEFAULT_OUT, help="输出目录，默认为仓库根目录的「打印/」")
    parser.add_argument("--all", action="store_true", help=f"{SKIPPED_TEXT}也一起打印")
    parser.add_argument("--font-size", type=float, default=10.5, metavar="磅", help="字号，默认 10.5（五号）")
    parser.add_argument("--line-height", type=float, default=14, metavar="磅", help="行距（固定值），默认 14")
    parser.add_argument("--margin", type=float, default=12, metavar="毫米", help="页边距下限，默认 12")
    parser.add_argument("--chrome", metavar="路径", help="chrome.exe 的路径，默认自动查找")
    parser.add_argument("-j", "--jobs", type=int, default=4, help="同时打印几份，默认 4")
    args = parser.parse_args()

    files, skipped = collect(args.paths, args.all)
    if not files:
        print("没有找到 Markdown 文件。")
        return 1
    chrome = find_chrome(args.chrome)
    layout = make_layout(args.font_size, args.line_height, args.margin)
    out_dir = args.out.resolve()
    workers = max(1, min(args.jobs, len(files)))

    failed = total_pages = 0
    warned_fonts: set[str] = set()
    with tempfile.TemporaryDirectory(prefix="md2pdf-", ignore_cleanup_errors=True) as tmp_name:
        tmp = Path(tmp_name)
        trim_problem = build_trim_font(tmp / SONG_TRIM_FILE)
        song_src = SONG_LOCAL if trim_problem else f'url("{SONG_TRIM_FILE}")'
        jobs = [(src, *build_html(src, layout, song_src), output_path(src, out_dir)) for src in files]

        profiles: queue.Queue[Path] = queue.Queue()
        for i in range(workers):
            (tmp / f"profile{i}").mkdir()
            profiles.put(tmp / f"profile{i}")

        def render(item: tuple[int, tuple[Path, str, set[str], Path]]) -> tuple[int, set[str]]:
            index, (_, page, _, out) = item
            html_path, pdf_path = tmp / f"{index}.html", tmp / f"{index}.pdf"
            html_path.write_text(page, encoding="utf-8")
            profile = profiles.get()
            try:
                print_to_pdf(chrome, html_path, pdf_path, profile)
            finally:
                profiles.put(profile)
            result = inspect_pdf(pdf_path)
            out.parent.mkdir(parents=True, exist_ok=True)
            try:
                shutil.move(pdf_path, out)
            except PermissionError:
                raise RuntimeError(f"写不进 {shown(out)}，是不是正在别的程序里打开着？") from None
            return result

        with ThreadPoolExecutor(workers) as pool:
            futures = [pool.submit(render, item) for item in enumerate(jobs)]
            for (src, _, wanted, out), future in zip(jobs, futures):
                try:
                    pages, fonts = future.result()
                except Exception as exc:  # noqa: BLE001 —— 单篇失败不影响其他稿件
                    failed += 1
                    print(f"失败  {display_path(src)}：{exc}", file=sys.stderr)
                    continue
                total_pages += pages
                print(f"{pages:>3} 页  {shown(out)}")
                for label in wanted:
                    if not any(f.startswith(FONT_PREFIX[label]) for f in fonts):
                        warned_fonts.add(label)

    print(f"共 {len(jobs) - failed} 份、{total_pages} 页（每页 {layout.rows} 行、每行 {layout.chars} 字），在 {shown(out_dir)}")
    if skipped:
        print(f"跳过{SKIPPED_TEXT}中的 {len(skipped)} 份；要一起打印请加 --all")
    if trim_problem:
        print(f"注意：{trim_problem}，正文的标点没有压缩。", file=sys.stderr)
    for font in sorted(warned_fonts):
        print(f"注意：PDF 里没有用上「{font}」，可能是没装这个字体，已用其他字体代替。", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
