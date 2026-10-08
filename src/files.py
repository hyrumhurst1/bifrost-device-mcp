"""Descriptor-relative file access. No symlink component is followed."""
import json, os, stat, sys

def main():
    root, operation, relative = sys.argv[1:]
    if not relative or os.path.isabs(relative) or '\x00' in relative:
        raise ValueError('Relative workspace path required')
    parts = relative.split('/')
    if any(part == '..' for part in parts):
        raise ValueError('Parent traversal is not allowed')
    parts = [part for part in parts if part not in ('', '.')]
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for index, part in enumerate(parts):
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
            if index < len(parts) - 1 or operation == 'list':
                flags |= os.O_DIRECTORY
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        if operation == 'read':
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise ValueError('Regular file required')
            data = os.read(fd, 32769)
            result = {'text': data[:32768].decode('utf-8', 'replace'), 'truncated': len(data) > 32768}
        elif operation == 'list':
            entries = []
            truncated = False
            with os.scandir(fd) as listing:
                for entry in listing:
                    if len(entries) >= 1000:
                        truncated = True
                        break
                    kind = 'symlink' if entry.is_symlink() else 'directory' if entry.is_dir(follow_symlinks=False) else 'file'
                    entries.append({'name': entry.name, 'type': kind})
            result = {'entries': entries, 'truncated': truncated}
        else:
            raise ValueError('Unknown file operation')
        print(json.dumps(result))
    finally:
        os.close(fd)

try:
    main()
except Exception:
    print(json.dumps({'error': 'File access refused: require an existing regular file/directory inside the workspace, with no symlink components'}))
    sys.exit(1)
