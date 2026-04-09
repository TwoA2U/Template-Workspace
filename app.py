from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import threading
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape

import webview
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.platypus import HRFlowable, Paragraph, SimpleDocTemplate, Spacer

IS_FROZEN = getattr(sys, 'frozen', False)
APP_ROOT = Path(sys.executable).resolve().parent if IS_FROZEN else Path(__file__).resolve().parent
RESOURCE_ROOT = Path(getattr(sys, '_MEIPASS', APP_ROOT))
WEB_DIR = RESOURCE_ROOT / 'web'
APP_HTML = WEB_DIR / 'Report-Template-builder.html'
BUNDLED_TEMPLATE_DIR = RESOURCE_ROOT / 'report-templates'
TEMPLATE_DIR = APP_ROOT / 'report-templates'
WINDOW_ICON = WEB_DIR / 'favicon.svg'
TEMPLATE_SUFFIX = '.json'
STATE_LOCK = threading.Lock()
VERBOSE = False


def log(message: str) -> None:
    if VERBOSE:
        print(message)


def slugify_template_name(name: str) -> str:
    slug = re.sub(r'[^a-z0-9]+', '-', (name or 'template').lower()).strip('-')
    return slug or 'template'


def build_template_filename(name: str, used_names: set[str]) -> str:
    base = slugify_template_name(name)
    candidate = f'{base}{TEMPLATE_SUFFIX}'
    index = 2
    while candidate in used_names:
        candidate = f'{base}-{index}{TEMPLATE_SUFFIX}'
        index += 1
    used_names.add(candidate)
    return candidate


def normalize_template(template_id: str, template: dict, used_names: set[str]) -> dict:
    normalized = json.loads(json.dumps(template))
    normalized['name'] = (normalized.get('name') or 'Untitled Template').strip() or 'Untitled Template'
    normalized['narrative'] = normalized.get('narrative') or ''
    normalized['sections'] = normalized.get('sections') if isinstance(normalized.get('sections'), list) else []
    preferred = f"{slugify_template_name(normalized['name'])}{TEMPLATE_SUFFIX}"
    if preferred in used_names:
        normalized['fileName'] = build_template_filename(normalized['name'], used_names)
    else:
        used_names.add(preferred)
        normalized['fileName'] = preferred
    return normalized


def normalize_template_collection(collection: dict | None) -> dict[str, dict]:
    used_names: set[str] = set()
    out: dict[str, dict] = {}
    for template_id, template in (collection or {}).items():
        if template is not None:
            out[template_id] = normalize_template(template_id, template, used_names)
    return out


def build_template_body(template_id: str, template: dict) -> dict:
    return {
        'app': 'template-workspace',
        'version': 1,
        'id': template_id,
        'name': template['name'],
        'narrative': template.get('narrative') or '',
        'sections': template.get('sections') if isinstance(template.get('sections'), list) else [],
    }


def add_warning(warnings: list[str], path: Path, reason: str) -> None:
    warnings.append(f'{path.name}: {reason}')


def seed_template_dir() -> None:
    if TEMPLATE_DIR.exists() and any(TEMPLATE_DIR.glob('*.json')):
        return
    TEMPLATE_DIR.mkdir(parents=True, exist_ok=True)
    if not BUNDLED_TEMPLATE_DIR.exists() or BUNDLED_TEMPLATE_DIR.resolve() == TEMPLATE_DIR.resolve():
        return
    for source in BUNDLED_TEMPLATE_DIR.glob('*.json'):
        target = TEMPLATE_DIR / source.name
        if not target.exists():
            shutil.copy2(source, target)


def ensure_template_dir() -> None:
    TEMPLATE_DIR.mkdir(parents=True, exist_ok=True)
    seed_template_dir()


def write_json_atomic(path: Path, payload: dict) -> None:
    temp_path = path.with_name(f'{path.name}.tmp')
    temp_path.write_text(json.dumps(payload, indent=2), encoding='utf-8')
    temp_path.replace(path)


def load_state() -> dict[str, object]:
    ensure_template_dir()
    templates: dict[str, dict] = {}
    rewrites: list[tuple[Path, dict]] = []
    warnings: list[str] = []
    with STATE_LOCK:
        for path in sorted(TEMPLATE_DIR.glob('*.json')):
            try:
                data = json.loads(path.read_text(encoding='utf-8'))
            except json.JSONDecodeError:
                add_warning(warnings, path, 'invalid JSON')
                continue
            template_id = data.get('id')
            if not isinstance(template_id, str) or not template_id:
                if isinstance(data.get('name'), str) and isinstance(data.get('sections'), list):
                    template_id = path.stem
                    rewrites.append((
                        path,
                        {
                            'name': data.get('name'),
                            'narrative': data.get('narrative'),
                            'sections': data.get('sections'),
                        },
                    ))
                else:
                    add_warning(warnings, path, 'missing required template fields')
                    continue
            if template_id in templates:
                add_warning(warnings, path, f'duplicate template id "{template_id}" ignored')
                continue
            templates[template_id] = {
                'name': data.get('name'),
                'narrative': data.get('narrative'),
                'sections': data.get('sections'),
                'fileName': path.name,
            }
        for path, template in rewrites:
            write_json_atomic(path, build_template_body(path.stem, template))
    if not templates:
        return {'templates': {}, 'activeId': None, 'templateDir': TEMPLATE_DIR.name, 'warnings': warnings}
    normalized = normalize_template_collection(templates)
    active_id = next(iter(normalized.keys()))
    return {'templates': normalized, 'activeId': active_id, 'templateDir': TEMPLATE_DIR.name, 'warnings': warnings}


def save_state(payload: dict) -> dict[str, object]:
    ensure_template_dir()
    templates = payload.get('templates')
    if not isinstance(templates, dict):
        raise ValueError('templates payload must be an object')

    normalized = normalize_template_collection(templates)
    active_id = payload.get('activeId')
    if normalized and active_id not in normalized:
        active_id = next(iter(normalized.keys()))
    if not normalized:
        active_id = None

    wanted_names = {template['fileName'] for template in normalized.values()}
    with STATE_LOCK:
        for template_id, template in normalized.items():
            path = TEMPLATE_DIR / template['fileName']
            write_json_atomic(path, build_template_body(template_id, template))

        for path in TEMPLATE_DIR.glob('*.json'):
            if path.name not in wanted_names:
                path.unlink(missing_ok=True)
    return {'templates': normalized, 'activeId': active_id, 'templateDir': TEMPLATE_DIR.name, 'warnings': []}


def default_export_name(title: str) -> str:
    return f"{slugify_template_name(title or 'template-workspace-report')}.pdf"


def format_inline_markdown(text: str) -> str:
    escaped = escape(text)
    return re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', escaped)


def build_pdf(output_path: Path, title: str, markdown: str) -> None:
    styles = getSampleStyleSheet()
    body_style = ParagraphStyle(
        'ReportBody',
        parent=styles['BodyText'],
        fontName='Times-Roman',
        fontSize=11,
        leading=16,
        spaceAfter=12,
        textColor=colors.HexColor('#2b2927'),
    )
    title_style = ParagraphStyle(
        'ReportTitle',
        parent=styles['Title'],
        fontName='Helvetica-Bold',
        fontSize=24,
        leading=30,
        textColor=colors.HexColor('#2b2927'),
        spaceAfter=4,
    )
    meta_style = ParagraphStyle(
        'ReportMeta',
        parent=styles['BodyText'],
        fontName='Helvetica',
        fontSize=8,
        leading=10,
        textColor=colors.HexColor('#7b746d'),
        spaceAfter=14,
    )
    h1_style = ParagraphStyle(
        'HeadingOne',
        parent=styles['Heading1'],
        fontName='Helvetica-Bold',
        fontSize=20,
        leading=24,
        textColor=colors.HexColor('#2b2927'),
        spaceAfter=8,
        spaceBefore=16,
    )
    h2_style = ParagraphStyle(
        'HeadingTwo',
        parent=styles['Heading2'],
        fontName='Helvetica-Bold',
        fontSize=16,
        leading=20,
        textColor=colors.HexColor('#2b2927'),
        spaceAfter=8,
        spaceBefore=14,
    )
    h3_style = ParagraphStyle(
        'HeadingThree',
        parent=styles['Heading3'],
        fontName='Helvetica-Bold',
        fontSize=13,
        leading=17,
        textColor=colors.HexColor('#5f5952'),
        spaceAfter=6,
        spaceBefore=12,
    )
    quote_style = ParagraphStyle(
        'Quote',
        parent=body_style,
        leftIndent=14,
        borderPadding=8,
        borderWidth=2,
        borderColor=colors.HexColor('#d8d0c4'),
        backColor=colors.HexColor('#faf8f4'),
        textColor=colors.HexColor('#5f5952'),
    )

    story: list[Any] = [
        Paragraph(escape(title or 'Template Workspace Report'), title_style),
        Paragraph('Generated from Template Workspace', meta_style),
        HRFlowable(width='100%', color=colors.HexColor('#ece8e1'), thickness=1),
        Spacer(1, 18),
    ]

    blocks = [block.strip() for block in re.split(r'\n\s*\n', markdown or '') if block.strip()]
    for block in blocks:
        if block == '---':
            story.append(Spacer(1, 8))
            story.append(HRFlowable(width='100%', color=colors.HexColor('#e9e3db'), thickness=1))
            story.append(Spacer(1, 12))
            continue
        if block.startswith('### '):
            story.append(Paragraph(format_inline_markdown(block[4:].strip()), h3_style))
            continue
        if block.startswith('## '):
            story.append(Paragraph(format_inline_markdown(block[3:].strip()), h2_style))
            continue
        if block.startswith('# '):
            story.append(Paragraph(format_inline_markdown(block[2:].strip()), h1_style))
            continue
        if block.startswith('> '):
            quote_text = '\n'.join(line[2:] if line.startswith('> ') else line for line in block.splitlines())
            story.append(Paragraph(format_inline_markdown(quote_text).replace('\n', '<br/>'), quote_style))
            continue
        story.append(Paragraph(format_inline_markdown(block).replace('\n', '<br/>'), body_style))

    doc = SimpleDocTemplate(
        str(output_path),
        pagesize=A4,
        title=title,
        author='Template Workspace',
        leftMargin=48,
        rightMargin=48,
        topMargin=48,
        bottomMargin=48,
    )
    doc.build(story)


class DesktopApi:
    def __init__(self) -> None:
        self.window: webview.Window | None = None

    def get_state(self) -> dict[str, object]:
        log('Loading template state')
        return load_state()

    def save_state(self, payload: dict[str, Any]) -> dict[str, object]:
        log('Saving template state')
        return save_state(payload or {})

    def get_app_info(self) -> dict[str, str]:
        return {'mode': 'desktop', 'templateDir': TEMPLATE_DIR.name}

    def export_pdf(self, payload: dict[str, Any]) -> dict[str, object]:
        if self.window is None:
            raise RuntimeError('Desktop window is not ready')

        report_title = str(payload.get('name') or 'Template Workspace Report')
        markdown = str(payload.get('markdown') or '')
        selected = self.window.create_file_dialog(
            webview.SAVE_DIALOG,
            save_filename=default_export_name(report_title),
            file_types=('PDF files (*.pdf)',),
        )
        if not selected:
            return {'cancelled': True}

        output_path = Path(selected if isinstance(selected, str) else selected[0])
        build_pdf(output_path, report_title, markdown)
        log(f'Exported PDF to {output_path}')
        return {'savedPath': str(output_path)}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Launch Template Workspace desktop app.')
    parser.add_argument(
        '-v',
        '--verbose',
        action='store_true',
        help='Enable verbose desktop logging and pywebview debug output',
    )
    return parser.parse_args()


def main() -> None:
    global VERBOSE

    args = parse_args()
    VERBOSE = args.verbose
    ensure_template_dir()
    if not APP_HTML.exists():
        raise FileNotFoundError(f'Frontend entry file not found: {APP_HTML}')

    api = DesktopApi()
    window = webview.create_window(
        title='Template Workspace',
        url=APP_HTML.resolve().as_uri(),
        js_api=api,
        width=1440,
        height=960,
        min_size=(1120, 760),
    )
    api.window = window

    print('Template Workspace desktop app starting...')
    print(f'Template files are stored in: {TEMPLATE_DIR}')
    print(f'Web files are loaded from: {WEB_DIR}')
    print(f'Verbose logging: {"on" if VERBOSE else "off"}')
    webview.start(debug=args.verbose)


if __name__ == '__main__':
    main()
