# Template Workspace

A small local web app for building, filling, previewing, and exporting report templates.

## Run

```bash
python app.py
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

- `web/Report-Template-builder.html`: app markup
- `web/Report-Template-builder.css`: app styles
- `web/Report-Template-builder.js`: app logic
- `app.py`: local Python server and template API
- `report-templates/`: saved template JSON files

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
