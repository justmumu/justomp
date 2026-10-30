// Package main maps active Go test files to runnable declarations using Go's parser.
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/doc"
	"go/parser"
	"go/token"
	"os"
	"strings"
	"unicode"
)

type runnable struct {
	File string `json:"file"`
	Name string `json:"name"`
}

func testName(name, prefix string) bool {
	if !strings.HasPrefix(name, prefix) {
		return false
	}
	rest := strings.TrimPrefix(name, prefix)
	if rest == "" {
		return true
	}
	return !unicode.IsLower([]rune(rest)[0])
}
func main() {
	var files []string
	input, err := os.Open(os.Args[1])
	if err != nil {
		panic(err)
	}
	defer input.Close()
	if err := json.NewDecoder(input).Decode(&files); err != nil {
		panic(err)
	}
	result := []runnable{}
	for _, path := range files {
		file, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.ParseComments)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		for _, decl := range file.Decls {
			f, ok := decl.(*ast.FuncDecl)
			if !ok || f.Recv != nil || f.Name.Name == "TestMain" {
				continue
			}
			name := f.Name.Name
			if (testName(name, "Test") || testName(name, "Fuzz")) && f.Type.Results == nil && f.Type.Params != nil && len(f.Type.Params.List) == 1 {
				result = append(result, runnable{path, name})
			}
		}
		for _, e := range doc.Examples(file) {
			if e.Output != "" || e.EmptyOutput {
				result = append(result, runnable{path, "Example" + e.Name})
			}
		}
	}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		panic(err)
	}
}
