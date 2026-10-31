// Package main maps active Go test files to runnable declarations using Go's parser.
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/build/constraint"
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

type constraintRecord struct {
	File       string      `json:"file"`
	Expression interface{} `json:"expression,omitempty"`
	Error      string      `json:"error,omitempty"`
}

func expressionTree(expr constraint.Expr) interface{} {
	switch value := expr.(type) {
	case *constraint.TagExpr:
		return map[string]interface{}{"tag": value.Tag}
	case *constraint.NotExpr:
		return map[string]interface{}{"not": expressionTree(value.X)}
	case *constraint.AndExpr:
		return map[string]interface{}{"and": []interface{}{expressionTree(value.X), expressionTree(value.Y)}}
	case *constraint.OrExpr:
		return map[string]interface{}{"or": []interface{}{expressionTree(value.X), expressionTree(value.Y)}}
	}
	return nil
}
func inspectConstraint(path string) constraintRecord {
	result := constraintRecord{File: path}
	file, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.ParseComments)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	return inspectParsedConstraint(path, file)
}
func inspectParsedConstraint(path string, file *ast.File) constraintRecord {
	result := constraintRecord{File: path}
	found := false
	for _, group := range file.Comments {
		for _, comment := range group.List {
			if !strings.HasPrefix(comment.Text, "//go:build") {
				continue
			}
			if found || comment.Pos() > file.Package {
				result.Error = "duplicate or misplaced //go:build directive"
				return result
			}
			found = true
			expr, err := constraint.Parse(comment.Text)
			if err != nil {
				result.Error = err.Error()
				return result
			}
			result.Expression = expressionTree(expr)
		}
	}
	return result
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
	parsedConstraints := map[string]constraintRecord{}
	for _, path := range files {
		file, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.ParseComments)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		parsedConstraints[path] = inspectParsedConstraint(path, file)
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
	var output interface{} = result
	if len(os.Args) > 2 {
		bytes, err := os.ReadFile(os.Args[2])
		if err != nil {
			panic(err)
		}
		var paths []string
		if err := json.Unmarshal(bytes, &paths); err != nil {
			panic(err)
		}
		constraints := []constraintRecord{}
		for _, path := range paths {
			record, ok := parsedConstraints[path]
			if !ok {
				record = inspectConstraint(path)
			}
			constraints = append(constraints, record)
		}
		output = map[string]interface{}{"runnables": result, "constraints": constraints}
	}
	if err := json.NewEncoder(os.Stdout).Encode(output); err != nil {
		panic(err)
	}
}
