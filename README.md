# Template Workspace

A desktop template editor built with Python, `pywebview`, and a local HTML/CSS/JS UI. It stores templates as individual JSON files, opens as a standalone GUI window, and can export filled reports to PDF.

## Screenshots

### Template Builder

![Template Builder view](./Images/Template-Builder-View.png)

### Fill & Preview

![Fill and Preview view](./Images/Fill-and-Preview-View.png)

## Install

```bash
python -m pip install -r requirements.txt
```

## Run Desktop App

```bash
python app.py
```

Or on Windows:

```text
start-template-workspace.bat
```

Enable verbose desktop logging and `pywebview` debug output if needed:

```bash
python app.py --verbose
```

## Local Packaging

Build a local package for the current platform with:

```bash
python scripts/package_release.py build-current --version snapshot --output release-artifacts --clean
```

Write checksums for local artifacts with:

```bash
python scripts/package_release.py write-checksums --version snapshot --output release-artifacts
```

Typical local output on Windows looks like:

```text
release-artifacts\TemplateWorkspace_snapshot_Windows_x86_64.zip
release-artifacts\TemplateWorkspace_snapshot_checksums.txt
```

Official releases are tag-driven:

```bash
git tag v1.0.0
git push origin v1.0.0
```

The GitHub Actions workflow then builds Windows, Linux, and macOS artifacts on native runners, generates checksums, and publishes them directly to the GitHub Release for that tag.

Manual `workflow_dispatch` runs are also supported for snapshot testing without publishing a GitHub Release.

## Packaging Layout

PyInstaller remains the actual app builder, and the checked-in spec files stay the packaging source of truth:

- `TemplateWorkspace.spec`: Windows/Linux `onedir` packaging
- `TemplateWorkspace.macos.spec`: macOS `.app` packaging

The shared packaging helper used by both local packaging and CI is:

```bash
python scripts/package_release.py build-current --version <version> --output release-artifacts --clean
```

## Project Layout

- `app.py`: desktop entrypoint, template persistence, JS bridge, and PDF export
- `web/`: frontend loaded inside the desktop window
- `web/Report-Template-builder.html`: app markup
- `web/Report-Template-builder.css`: app styles
- `web/Report-Template-builder.js`: app logic and desktop bridge calls
- `report-templates/`: saved template JSON files
- `requirements.txt`: runtime and build dependencies
- `TemplateWorkspace.spec`: Windows/Linux PyInstaller packaging definition
- `TemplateWorkspace.macos.spec`: macOS PyInstaller app-bundle definition
- `scripts/package_release.py`: cross-platform packaging helper used by local packaging and CI
- `.github/workflows/release.yml`: GitHub Actions release workflow

## Features

- Build templates with editable sections, fields, placeholders, select options, and date defaults
- Reorder sections and fields with drag and drop
- Duplicate templates from the sidebar
- Inline-edit field labels, field types, placeholders, select options, and date defaults
- Fill templates and see a live preview
- Copy the rendered report as Markdown or export it to PDF
- Sort templates by recent, `A-Z`, or `Z-A`
- Autosave template changes through the Python desktop bridge and browser cache
- Launch without a local web server or browser tab

## Keyboard Shortcuts

- `Ctrl/Cmd + S`: save the current template
- `Ctrl/Cmd + Shift + D`: duplicate the current template
- `Ctrl/Cmd + 1`: switch to Template Builder
- `Ctrl/Cmd + 2`: switch to Fill & Preview

## Templates

Templates are stored as individual `.json` files in `report-templates/`.

The desktop app keeps this storage model unchanged:

- one template per file
- filenames generated from the current template name on save
- duplicate IDs skipped with warnings
- atomic writes when saving

Example manual template:

```json
{
  "id": "incident-report",
  "name": "Incident Report",
  "narrative": "Title: {{Overview.Title}}",
  "sections": [
    {
      "name": "Overview",
      "open": true,
      "fields": [
        {
          "label": "Title",
          "type": "text",
          "placeholder": ""
        }
      ]
    }
  ]
}
```

If `id` is missing, the desktop app will generate one from the filename on load.

## Notes

- Use `Reload Templates` after manually adding or editing template files.
- The packaged desktop app reads/writes `report-templates/` next to the executable.
- Bundled starter templates are copied into the executable-adjacent `report-templates/` folder on first launch if needed.
- Windows stays `onedir` because startup is faster than a self-extracting `onefile` executable.
