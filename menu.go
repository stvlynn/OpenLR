package main

import (
	"context"
	"encoding/base64"
	"mime"
	"os"
	"path/filepath"
	"runtime"

	"github.com/egoist/mygo"
)

// Menu construction and action routing adapted from AstraFoundry/Arion,
// apps/desktop/bootstrap/windows.go at 3b1acc1, under AGPL-3.0-only.
// OpenLR dispatches photo commands to its focused workspace.
var menuAction = mygo.NewEvent[string]("workspaceMenu")

func installMenu() {
	action := func(label, id string) *mygo.MenuItem {
		return &mygo.MenuItem{Label: label, ID: id, Click: func(_ *mygo.MenuItem, win *mygo.Window) {
			if win != nil {
				_ = menuAction.Emit(win, id)
			}
		}}
	}
	items := []*mygo.MenuItem{
		{Label: "File", Submenu: []*mygo.MenuItem{
			action("Add photos…", "choose-photos"), action("Open local folder…", "local-open"),
			action("Tethered capture…", "tether"),
			mygo.Separator(), action("Create album…", "new-album"), action("Export…", "export-dialog"),
			mygo.Separator(), {Role: mygo.RoleClose},
		}},
		{Label: "Edit", Submenu: []*mygo.MenuItem{
			action("Undo photo edit", "undo"), action("Redo photo edit", "redo"),
			mygo.Separator(), action("Copy edit settings", "copy-edits"), action("Paste edit settings", "paste-edits"),
			mygo.Separator(), {Role: mygo.RoleCut}, {Role: mygo.RoleCopy}, {Role: mygo.RolePaste},
		}},
		{Label: "View", Submenu: []*mygo.MenuItem{
			action("Grid", "grid"), action("Edit photo", "detail"), action("Filmstrip", "film"),
			action("Compare side by side", "compare-pair"), mygo.Separator(), {Role: mygo.RoleToggleFullScreen},
		}},
	}
	if runtime.GOOS == "darwin" {
		items = append([]*mygo.MenuItem{{Role: mygo.RoleAppMenu}}, items...)
	}
	mygo.App.SetMenu(mygo.NewMenu(items))
}

type ChosenPhoto struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Base64   string `json:"base64"`
	Modified int64  `json:"lastModified"`
}

func (d *Desktop) ChoosePhotos(ctx context.Context) ([]ChosenPhoto, error) {
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Parent: mygo.CallerWindow(ctx), Title: "Add photos", Multiple: true})
	if err != nil {
		return nil, err
	}
	result := make([]ChosenPhoto, 0, len(paths))
	for _, path := range paths {
		info, err := os.Stat(path)
		if err != nil {
			return nil, err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		result = append(result, ChosenPhoto{Name: info.Name(), Type: mime.TypeByExtension(filepath.Ext(path)), Base64: base64.StdEncoding.EncodeToString(data), Modified: info.ModTime().UnixMilli()})
	}
	return result, nil
}
