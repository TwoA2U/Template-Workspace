package main

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"

	"github.com/phpdave11/gofpdf"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed report-templates/*.json
var bundledTemplates embed.FS

var nonSlug = regexp.MustCompile(`[^a-z0-9]+`)

type App struct {
	ctx         context.Context
	templateDir string
	mu          sync.Mutex
}

func NewApp() *App {
	return &App{templateDir: filepath.Join(appDir(), "report-templates")}
}

func (a *App) startup(ctx context.Context) { a.ctx = ctx }

func appDir() string {
	executable, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Dir(executable)
}

func slugify(name string) string {
	slug := strings.Trim(nonSlug.ReplaceAllString(strings.ToLower(name), "-"), "-")
	if slug == "" {
		return "template"
	}
	return slug
}

func templateName(template map[string]any) string {
	name, _ := template["name"].(string)
	name = strings.TrimSpace(name)
	if name == "" {
		return "Untitled Template"
	}
	return name
}

func templateSections(template map[string]any) []any {
	sections, _ := template["sections"].([]any)
	return sections
}

func normalizeTemplates(templates map[string]any) map[string]map[string]any {
	ids := make([]string, 0, len(templates))
	for id := range templates {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	used := map[string]bool{}
	normalized := make(map[string]map[string]any, len(templates))
	for _, id := range ids {
		template, ok := templates[id].(map[string]any)
		if !ok || template == nil {
			continue
		}
		name := templateName(template)
		filename := slugify(name) + ".json"
		for index := 2; used[filename]; index++ {
			filename = fmt.Sprintf("%s-%d.json", slugify(name), index)
		}
		used[filename] = true
		normalized[id] = map[string]any{
			"name":      name,
			"narrative": stringValue(template["narrative"]),
			"sections":  templateSections(template),
			"fileName":  filename,
		}
	}
	return normalized
}

func stringValue(value any) string {
	text, _ := value.(string)
	return text
}

func (a *App) ensureTemplateDir() error {
	if err := os.MkdirAll(a.templateDir, 0o755); err != nil {
		return err
	}
	entries, err := os.ReadDir(a.templateDir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".json") {
			return nil
		}
	}

	seedFiles, err := bundledTemplates.ReadDir("report-templates")
	if err != nil {
		return err
	}
	for _, entry := range seedFiles {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		contents, err := bundledTemplates.ReadFile("report-templates/" + entry.Name())
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(a.templateDir, entry.Name()), contents, 0o644); err != nil {
			return err
		}
	}
	return nil
}

func writeJSONAtomic(path string, value any) error {
	contents, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	temp := path + ".tmp"
	if err := os.WriteFile(temp, contents, 0o644); err != nil {
		return err
	}
	return os.Rename(temp, path)
}

func state(templates map[string]map[string]any, activeID any, warnings []string, templateDir string) map[string]any {
	active, _ := activeID.(string)
	if _, ok := templates[active]; !ok {
		active = ""
		for id := range templates {
			active = id
			break
		}
	}
	return map[string]any{"templates": templates, "activeId": active, "templateDir": templateDir, "warnings": warnings}
}

func (a *App) GetState() (map[string]any, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.ensureTemplateDir(); err != nil {
		return nil, err
	}

	templates := map[string]any{}
	warnings := []string{}
	entries, err := os.ReadDir(a.templateDir)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		path := filepath.Join(a.templateDir, entry.Name())
		contents, err := os.ReadFile(path)
		if err != nil {
			warnings = append(warnings, entry.Name()+": unreadable")
			continue
		}
		var template map[string]any
		if err := json.Unmarshal(contents, &template); err != nil {
			warnings = append(warnings, entry.Name()+": invalid JSON")
			continue
		}
		id := stringValue(template["id"])
		if id == "" {
			if _, hasName := template["name"].(string); hasName {
				id = strings.TrimSuffix(entry.Name(), ".json")
				template["id"] = id
				if err := writeJSONAtomic(path, template); err != nil {
					return nil, err
				}
			} else {
				warnings = append(warnings, entry.Name()+": missing required template fields")
				continue
			}
		}
		if _, duplicate := templates[id]; duplicate {
			warnings = append(warnings, entry.Name()+`: duplicate template id "`+id+`" ignored`)
			continue
		}
		template["fileName"] = entry.Name()
		templates[id] = template
	}
	return state(normalizeTemplates(templates), nil, warnings, filepath.Base(a.templateDir)), nil
}

func (a *App) SaveState(payload map[string]any) (map[string]any, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.ensureTemplateDir(); err != nil {
		return nil, err
	}
	templates, ok := payload["templates"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("templates payload must be an object")
	}
	normalized := normalizeTemplates(templates)
	for id, template := range normalized {
		body := map[string]any{"app": "template-workspace", "version": 1, "id": id, "name": template["name"], "narrative": template["narrative"], "sections": template["sections"]}
		if err := writeJSONAtomic(filepath.Join(a.templateDir, stringValue(template["fileName"])), body); err != nil {
			return nil, err
		}
	}
	entries, err := os.ReadDir(a.templateDir)
	if err != nil {
		return nil, err
	}
	keep := map[string]bool{}
	for _, template := range normalized {
		keep[stringValue(template["fileName"])] = true
	}
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".json") && !keep[entry.Name()] {
			if err := os.Remove(filepath.Join(a.templateDir, entry.Name())); err != nil {
				return nil, err
			}
		}
	}
	return state(normalized, payload["activeId"], nil, filepath.Base(a.templateDir)), nil
}

func (a *App) ExportPDF(payload map[string]any) (map[string]any, error) {
	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{DefaultFilename: slugify(stringValue(payload["name"])) + ".pdf", Filters: []runtime.FileFilter{{DisplayName: "PDF files", Pattern: "*.pdf"}}})
	if err != nil || path == "" {
		return map[string]any{"cancelled": true}, nil
	}
	if err := buildPDF(path, stringValue(payload["name"]), stringValue(payload["markdown"])); err != nil {
		return nil, err
	}
	return map[string]any{"savedPath": path}, nil
}

func buildPDF(path, title, markdown string) error {
	pdf := gofpdf.New("P", "mm", "A4", "")
	pdf.SetMargins(17, 17, 17)
	pdf.SetAutoPageBreak(true, 17)
	pdf.AddPage()
	pdf.SetFont("Helvetica", "B", 20)
	pdf.MultiCell(176, 9, fallback(title, "Template Workspace Report"), "", "L", false)
	pdf.SetFont("Helvetica", "", 8)
	pdf.SetTextColor(123, 116, 109)
	pdf.CellFormat(176, 6, "Generated from Template Workspace", "", 1, "L", false, 0, "")
	pdf.SetTextColor(43, 41, 39)
	for _, block := range strings.Split(strings.ReplaceAll(markdown, "\r\n", "\n"), "\n\n") {
		block = strings.TrimSpace(block)
		if block == "" || block == "---" {
			continue
		}
		size, style := float64(11), ""
		switch {
		case strings.HasPrefix(block, "### "):
			size, style, block = 13, "B", strings.TrimPrefix(block, "### ")
		case strings.HasPrefix(block, "## "):
			size, style, block = 16, "B", strings.TrimPrefix(block, "## ")
		case strings.HasPrefix(block, "# "):
			size, style, block = 20, "B", strings.TrimPrefix(block, "# ")
		case strings.HasPrefix(block, "> "):
			block = strings.ReplaceAll(block, "\n> ", "\n")
			block = strings.TrimPrefix(block, "> ")
		}
		pdf.SetFont("Helvetica", style, size)
		pdf.MultiCell(176, size*0.46, strings.ReplaceAll(block, "**", ""), "", "L", false)
		pdf.Ln(2)
	}
	return pdf.OutputFileAndClose(path)
}

func fallback(value, defaultValue string) string {
	if value == "" {
		return defaultValue
	}
	return value
}
