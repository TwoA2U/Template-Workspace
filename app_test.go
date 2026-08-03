package main

import "testing"

func TestNormalizeTemplatesUsesUniqueStableNames(t *testing.T) {
	templates := normalizeTemplates(map[string]any{
		"one": map[string]any{"name": "Incident Report"},
		"two": map[string]any{"name": "Incident Report"},
	})
	if templates["one"]["fileName"] != "incident-report.json" || templates["two"]["fileName"] != "incident-report-2.json" {
		t.Fatalf("unexpected filenames: %#v", templates)
	}
}
