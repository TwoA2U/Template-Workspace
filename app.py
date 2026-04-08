from __future__ import annotations

import argparse
import json
import re
import threading
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR / 'web'
APP_HTML = WEB_DIR / 'Report-Template-builder.html'
TEMPLATE_DIR = BASE_DIR / 'report-templates'
TEMPLATE_SUFFIX = '.json'
STATE_LOCK = threading.Lock()
REQUEST_LOGGING = False


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


def ensure_template_dir() -> None:
    TEMPLATE_DIR.mkdir(parents=True, exist_ok=True)


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
                    rewrites.append((path, {
                        'name': data.get('name'),
                        'narrative': data.get('narrative'),
                        'sections': data.get('sections'),
                    }))
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
    return {'templates': normalized, 'activeId': active_id, 'templateDir': TEMPLATE_DIR.name}


class AppHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BASE_DIR), **kwargs)

    def log_message(self, format: str, *args) -> None:
        if REQUEST_LOGGING:
            super().log_message(format, *args)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == '/api/state':
            self._handle_get_state()
            return
        if parsed.path == '/':
            self.path = f'/{APP_HTML.relative_to(BASE_DIR).as_posix()}'
        super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == '/api/state':
            self._handle_post_state()
            return
        self.send_error(HTTPStatus.NOT_FOUND, 'Unknown endpoint')

    def _handle_get_state(self) -> None:
        state = load_state()
        self._send_json(HTTPStatus.OK, state)

    def _handle_post_state(self) -> None:
        length = int(self.headers.get('Content-Length', '0'))
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode('utf-8') or '{}')
            state = save_state(payload)
        except json.JSONDecodeError:
            self._send_json(HTTPStatus.BAD_REQUEST, {'error': 'Invalid JSON payload'})
            return
        except ValueError as exc:
            self._send_json(HTTPStatus.BAD_REQUEST, {'error': str(exc)})
            return
        self._send_json(HTTPStatus.OK, state)

    def _send_json(self, status: HTTPStatus, payload: dict[str, object]) -> None:
        body = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Serve Template Workspace locally.')
    parser.add_argument('--host', default='127.0.0.1', help='Host interface to bind to')
    parser.add_argument('--port', type=int, default=8000, help='Port to listen on')
    parser.add_argument(
        "-v",'--verbose',
        action='store_true',
        help='Enable HTTP request logging in the terminal',
    )
    return parser.parse_args()


if __name__ == '__main__':
    args = parse_args()
    REQUEST_LOGGING = args.verbose
    ensure_template_dir()
    if not APP_HTML.exists():
        raise FileNotFoundError(f'Frontend entry file not found: {APP_HTML}')
    server = ThreadingHTTPServer((args.host, args.port), AppHandler)
    print(f'Template Workspace running at http://{args.host}:{args.port}/')
    print(f'Template files are stored in: {TEMPLATE_DIR}')
    print(f'Web files are served from: {WEB_DIR}')
    print(f'Request logging: {"on" if REQUEST_LOGGING else "off"}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
