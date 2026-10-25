"""Fetch selected CC0 MakeHuman asset-pack entries without a full pack download."""
import argparse
import io
from pathlib import Path
import urllib.request
import zipfile


class RemoteZip(io.RawIOBase):
    def __init__(self, url):
        self.url = url
        with urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=30) as r:
            self.size = int(r.headers["Content-Length"])
        self.position = 0

    def seekable(self):
        return True

    def seek(self, offset, whence=0):
        self.position = offset if whence == 0 else self.position + offset if whence == 1 else self.size + offset
        return self.position

    def tell(self):
        return self.position

    def read(self, size=-1):
        if size == 0 or self.position >= self.size:
            return b""
        end = self.size - 1 if size < 0 else min(self.size - 1, self.position + size - 1)
        request = urllib.request.Request(self.url, headers={"Range": f"bytes={self.position}-{end}"})
        with urllib.request.urlopen(request, timeout=45) as response:
            if response.status != 206:
                raise RuntimeError("Server did not honor byte range; full-pack transfer was not started")
            result = response.read()
        self.position += len(result)
        return result


def main():
    p = argparse.ArgumentParser()
    p.add_argument("url")
    p.add_argument("--contains", default="")
    p.add_argument("--suffix", default="")
    p.add_argument("--output", default=".local/body-templates/assets")
    p.add_argument("--fetch", action="store_true")
    a = p.parse_args()
    root = Path(a.output).resolve()
    with zipfile.ZipFile(RemoteZip(a.url)) as archive:
        for name in archive.namelist():
            if a.contains.lower() not in name.lower() or name.endswith("/") or not name.endswith(a.suffix):
                continue
            print(name, flush=True)
            if a.fetch:
                target = (root / name).resolve()
                if not target.is_relative_to(root):
                    raise RuntimeError("Archive entry escaped the destination")
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(name))


if __name__ == "__main__":
    main()
