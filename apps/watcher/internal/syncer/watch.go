package syncer

import "io/fs"

// Change detection is a 1 s poll, not filesystem events. The module keeps no
// third-party dependencies (fsnotify would be the only one), and the watched
// folder holds a few hundred small files, so walking it once a second is cheap.
// New subfolders need no special handling: every poll walks the roots afresh.

// poll walks every root and notices each included file whose size or mtime
// differs from what the previous poll (or scan) saw.
func (s *Syncer) poll() {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = s.walk(func(abs, rel string, fi fs.FileInfo) {
		st := statKey{fi.Size(), fi.ModTime()}
		if old, ok := s.seen[abs]; ok && old == st {
			return
		}
		s.seen[abs] = st
		if fi.Size() == 0 {
			return
		}
		s.notice(abs, false)
	})
}
