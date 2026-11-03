// Package config loads and validates watcher.json.
package config

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// Config is the content of watcher.json.
type Config struct {
	Server  string   `json:"server"`
	Token   string   `json:"token"`
	Folder  string   `json:"folder"`
	Include []string `json:"include"`
}

// Load reads path as JSON and validates it.
func Load(p string) (Config, error) {
	var c Config
	b, err := os.ReadFile(p)
	if err != nil {
		return c, err
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return Config{}, fmt.Errorf("%s: %w", p, err)
	}
	if err := c.Validate(); err != nil {
		return Config{}, err
	}
	return c, nil
}

// Validate checks every field; the error names the offending field.
func (c Config) Validate() error {
	u, err := url.Parse(c.Server)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("config: server must be an http(s) URL, got %q", c.Server)
	}
	if u.Path != "" && u.Path != "/" || u.RawQuery != "" || u.Fragment != "" {
		return fmt.Errorf("config: server must not have a path, got %q", c.Server)
	}
	if len(c.Token) < 20 {
		return fmt.Errorf("config: token must be at least 20 characters")
	}
	if strings.TrimSpace(c.Folder) == "" {
		return fmt.Errorf("config: folder is required")
	}
	if len(c.Include) == 0 {
		return fmt.Errorf("config: include must have at least one pattern")
	}
	for _, p := range c.Include {
		if _, err := path.Match(p, ""); err != nil {
			return fmt.Errorf("config: include pattern %q is invalid: %w", p, err)
		}
	}
	return nil
}

// DefaultPath is watcher.json next to the executable.
func DefaultPath(exe string) string {
	return filepath.Join(filepath.Dir(exe), "watcher.json")
}

// VirtualStoreTwin returns where Windows redirects writes made by a
// non-elevated 32-bit process under Program Files / Windows:
// %LOCALAPPDATA%\VirtualStore\<folder without its drive>. Pure string logic.
func VirtualStoreTwin(folder string, env func(string) string) (string, bool) {
	lad := env("LOCALAPPDATA")
	if lad == "" {
		return "", false
	}
	def := func(key, fallback string) string {
		if v := env(key); v != "" {
			return v
		}
		return fallback
	}
	roots := []string{
		def("ProgramFiles", `C:\Program Files`),
		def("ProgramFiles(x86)", `C:\Program Files (x86)`),
		def("SystemRoot", `C:\Windows`),
	}
	f := strings.ReplaceAll(folder, "/", `\`)
	for _, r := range roots {
		r = strings.TrimRight(strings.ReplaceAll(r, "/", `\`), `\`)
		if len(f) > len(r) && strings.EqualFold(f[:len(r)], r) && f[len(r)] == '\\' {
			if len(f) < 3 || f[1] != ':' {
				return "", false
			}
			rest := strings.TrimLeft(f[2:], `\`)
			return strings.TrimRight(lad, `\`) + `\VirtualStore\` + rest, true
		}
	}
	return "", false
}
