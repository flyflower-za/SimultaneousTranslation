"""生成可下载的会议纪要 PDF。"""
from io import BytesIO
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer


def render_minutes_pdf(title: str, content: str) -> bytes:
    if "STSong-Light" not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    regular = ParagraphStyle("regular", fontName="STSong-Light", fontSize=10.5,
                             leading=17, spaceAfter=7, alignment=TA_LEFT,
                             textColor=colors.HexColor("#202638"), wordWrap="CJK")
    heading = ParagraphStyle("heading", parent=regular, fontSize=15, leading=23,
                             spaceBefore=13, spaceAfter=9)
    title_style = ParagraphStyle("title", parent=heading, fontSize=19, leading=28)
    output = BytesIO()
    doc = SimpleDocTemplate(output, pagesize=A4, leftMargin=44, rightMargin=44,
                            topMargin=45, bottomMargin=45, title=title)
    story = [Paragraph(escape(title), title_style), Spacer(1, 12)]
    for raw in content.splitlines():
        line = raw.strip()
        if not line:
            story.append(Spacer(1, 5))
        elif line.startswith("#"):
            story.append(Paragraph(escape(line.lstrip("# ")), heading))
        else:
            story.append(Paragraph(escape(line), regular))
    doc.build(story)
    return output.getvalue()
