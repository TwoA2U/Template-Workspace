package main

import (
	"embed"
	"io/fs"
	"log"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:web
var webFiles embed.FS

func main() {
	assets, err := fs.Sub(webFiles, "web")
	if err != nil {
		log.Fatal(err)
	}

	app := NewApp()
	if err := wails.Run(&options.App{
		Title:     "Template Workspace",
		Width:     1440,
		Height:    960,
		MinWidth:  1120,
		MinHeight: 760,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		Bind: []interface{}{app},
	}); err != nil {
		log.Fatal(err)
	}
}
