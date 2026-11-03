package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestVirtualStoreTwin(t *testing.T) {
	env := map[string]string{"ProgramFiles(x86)": `C:\Program Files (x86)`, "LOCALAPPDATA": `C:\Users\ravi\AppData\Local`}
	get := func(k string) string { return env[k] }
	got, ok := VirtualStoreTwin(`C:\Program Files (x86)\ODIN\Diet\OnLineBackup`, get)
	if !ok || got != `C:\Users\ravi\AppData\Local\VirtualStore\Program Files (x86)\ODIN\Diet\OnLineBackup` {
		t.Fatalf("got %q %v", got, ok)
	}
	if _, ok := VirtualStoreTwin(`C:\ODIN\Diet\OnLineBackup`, get); ok {
		t.Fatal("C:\\ODIN is not virtualised")
	}
	// defaults + case-insensitive
	got, ok = VirtualStoreTwin(`c:\program files\ODIN\x`, get)
	if !ok || got != `C:\Users\ravi\AppData\Local\VirtualStore\program files\ODIN\x` {
		t.Fatalf("got %q %v", got, ok)
	}
	if _, ok := VirtualStoreTwin(`C:\Windows\Temp`, get); !ok {
		t.Fatal("C:\\Windows is virtualised")
	}
	// prefix must end at a separator
	if _, ok := VirtualStoreTwin(`C:\Program Files Extra\x`, get); ok {
		t.Fatal("sibling dir is not virtualised")
	}
	// no LOCALAPPDATA -> no twin
	if _, ok := VirtualStoreTwin(`C:\Program Files\x`, func(string) string { return "" }); ok {
		t.Fatal("no LOCALAPPDATA")
	}
}

func valid() Config {
	return Config{Server: "https://example.com", Token: strings.Repeat("a", 20), Folder: `C:\ODIN\OnLineBackup`, Include: []string{"*/Trades/*TRD.TXT"}}
}

func TestValidate(t *testing.T) {
	if err := valid().Validate(); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name, field string
		mut         func(*Config)
	}{
		{"missing token", "token", func(c *Config) { c.Token = "" }},
		{"short token", "token", func(c *Config) { c.Token = "short" }},
		{"ftp server", "server", func(c *Config) { c.Server = "ftp://example.com" }},
		{"server path", "server", func(c *Config) { c.Server = "https://example.com/api" }},
		{"no host", "server", func(c *Config) { c.Server = "https://" }},
		{"empty folder", "folder", func(c *Config) { c.Folder = "" }},
		{"empty include", "include", func(c *Config) { c.Include = nil }},
		{"bad pattern", "include", func(c *Config) { c.Include = []string{"["} }},
	}
	for _, tc := range cases {
		c := valid()
		tc.mut(&c)
		err := c.Validate()
		if err == nil || !strings.Contains(err.Error(), tc.field) {
			t.Errorf("%s: got %v", tc.name, err)
		}
	}
	c := valid()
	c.Server = "http://host:8080/"
	if err := c.Validate(); err != nil {
		t.Errorf("trailing slash: %v", err)
	}
}

func TestValidatePlainHTTPBareIP(t *testing.T) {
	for _, server := range []string{"http://203.0.113.10", "http://203.0.113.10:80"} {
		c := valid()
		c.Server = server
		if err := c.Validate(); err != nil {
			t.Errorf("%s: plain http to a bare IP must validate: %v", server, err)
		}
	}
}

func TestLoadAndDefaultPath(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "watcher.json")
	os.WriteFile(p, []byte(`{"server":"https://x.io","token":"`+strings.Repeat("t", 24)+`","folder":"C:\\ODIN","include":["*/Orders/*.txt"]}`), 0o600)
	c, err := Load(p)
	if err != nil || c.Folder != `C:\ODIN` {
		t.Fatalf("%+v %v", c, err)
	}
	os.WriteFile(p, []byte(`{"server":"https://x.io"}`), 0o600)
	if _, err := Load(p); err == nil {
		t.Fatal("expected validation error")
	}
	os.WriteFile(p, []byte(`not json`), 0o600)
	if _, err := Load(p); err == nil {
		t.Fatal("expected parse error")
	}
	if _, err := Load(filepath.Join(dir, "none.json")); err == nil {
		t.Fatal("expected read error")
	}
	if got := DefaultPath(filepath.Join("a", "b", "watcher.exe")); got != filepath.Join("a", "b", "watcher.json") {
		t.Fatal(got)
	}
}
