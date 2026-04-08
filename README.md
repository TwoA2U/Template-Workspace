# Template Workspace

A small local web app for building, filling, previewing, sorting, and exporting report templates.

## Screenshots

### Template Builder

![Template Builder view](./Images/Template-Builder-View.png)

### Fill & Preview

![Fill and Preview view](./Images/Fill-and-Preview-View.png)

## Run

```bash
python app.py
```

Enable request logging if you want to see HTTP requests in the terminal:

```bash
python app.py --verbose
```

Then open:

```text
http://127.0.0.1:8000/
```

On Windows, you can also run:

```text
start-builder.bat
```

## Files

- `web/`: frontend files served by the Python app
- `web/Report-Template-builder.html`: app markup
- `web/Report-Template-builder.css`: app styles
- `web/Report-Template-builder.js`: app logic
- `app.py`: local Python server and template API
- `report-templates/`: saved template JSON files

## Features

- Build templates with editable sections, fields, placeholders, select options, and date defaults
- Reorder sections and fields with drag and drop
- Duplicate templates from the sidebar
- Fill templates and see a live preview
- Copy the rendered report as Markdown or export it as a print-friendly PDF
- Sort templates by recent, `A-Z`, or `Z-A`
- Autosave template changes to the Python backend and browser cache

## Keyboard Shortcuts

- `Ctrl/Cmd + S`: save the current template
- `Ctrl/Cmd + Shift + D`: duplicate the current template
- `Ctrl/Cmd + 1`: switch to Template Builder
- `Ctrl/Cmd + 2`: switch to Fill & Preview

## Templates

Templates are stored as individual `.json` files in `report-templates/`.

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

If `id` is missing, the server will generate one from the filename on load.

## Notes

- Use `Reload Templates` after manually adding or editing template files.
- The app serves its frontend from `web/` and template JSON files from `report-templates/`.
- Template filenames are generated from the current template name when saving.
