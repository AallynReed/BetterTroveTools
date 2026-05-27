from __future__ import annotations

import re
import zlib
from copy import copy
from enum import Enum
from hashlib import md5
from pathlib import Path
from typing import AsyncGenerator, Generator, Optional

import aiofiles
from binary_reader import BinaryReader

from models.trove.directory import Directories
from utils.functions import read_leb128

archive_id = re.compile(r"^archive(\d+)")


def _read_uleb(data: bytes, pos: int) -> tuple[int, int]:
    """Read a uleb128 directly from a bytes buffer. Much faster than seeking a
    BinaryReader one byte at a time, which matters when parsing every index.tfi
    in a game install. Masks to 32 bits to match the previous decoder exactly."""
    result = 0
    shift = 0
    while True:
        byte = data[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if not (byte & 0x80):
            return result & 0xFFFFFFFF, pos
        shift += 7
        if shift >= 64:
            raise ValueError("Too many bytes when decoding varint.")


class FileStatus(Enum):
    unchanged = "Unchanged"
    added = "Added"
    changed = "Changed"
    removed = "Removed"


class TroveFile:
    index: TFIndex = None

    def __init__(self, **data):
        for key, value in data.items():
            setattr(self, key, value)
        self._content: Optional[bytes] = None
        self._content_hash: Optional[str] = None
        self._status: Optional[FileStatus] = None

    @classmethod
    def parse_obj(cls, data):
        return cls(**data)

    @property
    def status(self):
        return self._status

    @property
    def color(self):
        if self.status == FileStatus.unchanged:
            return None
        if self.status == FileStatus.added:
            return "green"
        if self.status == FileStatus.changed:
            return "yellow"
        if self.status == FileStatus.removed:
            return "red"

    @property
    async def content_hash(self):
        if self._content is None:
            _ = await self.content
        return self._content_hash

    @property
    async def content(self):
        if self._content is None:
            reader = BinaryReader(await self.archive.content)
            reader.seek(self.offset)
            self._content = reader.read_bytes(self.size)
            self._content_hash = md5(self._content).hexdigest()
        return self._content

    def extracted_path(self, opath: Path, path: Path) -> Path:
        return path.joinpath(self.path.relative_to(opath))

    def extract_to_path(self, opath: Path, path: Path) -> Path:
        return path.joinpath(self.path.relative_to(opath))

    async def compare(self, opath: Path, path: Path) -> FileStatus:
        extracted_file = self.extracted_path(opath, path)
        if not extracted_file.exists():
            self._status = FileStatus.added
        else:
            async with aiofiles.open(extracted_file, "rb") as f:
                if await self.content_hash == md5(await f.read()).hexdigest():
                    self._status = FileStatus.unchanged
                else:
                    self._status = FileStatus.changed
        return self.status

    async def copy_old(self, opath: Path, gpath: Path, path: Path):
        path_to_get = self.extract_to_path(opath, gpath)
        if not path_to_get.exists():
            return
        path_to_save = self.extract_to_path(opath, path)
        path_to_save.parent.mkdir(parents=True, exist_ok=True)
        async with aiofiles.open(path_to_get, "rb") as old:
            async with aiofiles.open(path_to_save, "wb") as new:
                await new.write(await old.read())

    async def save(self, opath: Path, path: Path):
        path_to_save = self.extract_to_path(opath, path)
        path_to_save.parent.mkdir(parents=True, exist_ok=True)
        async with aiofiles.open(path_to_save, "wb") as f:
            await f.write(await self.content)


class TFArchive:
    def __init__(self, index: TFIndex, path: Path):
        self.index = index
        self.directory = path.parent
        self.path = path
        self.id = int(archive_id.search(path.stem).group(1))
        self._content = None
        self._content_hash: Optional[str] = None

    def __eq__(self, other):
        if not isinstance(other, TFIndex):
            return False
        return self.path == other.path

    def __ne__(self, other):
        return not self.__eq__(other)

    def __int__(self):
        return self.id

    def __str__(self):
        return f"<path={str(self.path)}>"

    def __repr__(self):
        return self.__str__()

    @property
    async def content_hash(self):
        if self._content is None:
            _ = await self.content
        return self._content_hash

    @property
    async def content(self):
        if self._content is None:
            data = zlib.decompressobj(wbits=zlib.MAX_WBITS)
            async with aiofiles.open(self.path, "rb") as f:
                self._content = data.decompress(await f.read())
                self._content_hash = md5(self._content).hexdigest()
        return self._content

    async def files(self) -> AsyncGenerator[TroveFile]:
        for file in await self.index.files_list:
            if file["archive_index"] == int(self):
                copy_file = copy(file)
                copy_file["archive"] = self
                yield TroveFile.parse_obj(copy_file)


class TFIndex:
    def __init__(self, file: Path):
        self.directory = file.parent
        self.path = file
        self._files = []
        self._content = None
        self._content_hash: Optional[str] = None

    def __eq__(self, other):
        if not isinstance(other, TFIndex):
            return False
        return self.path == other.path

    def __ne__(self, other):
        return not self.__eq__(other)

    def __str__(self):
        return f"<path={str(self.path)}>"

    def __repr__(self):
        return self.__str__()

    @property
    async def content_hash(self):
        if self._content is None:
            _ = await self.content
        return self._content_hash

    @property
    async def content(self):
        if self._content is None:
            async with aiofiles.open(self.path, "rb") as f:
                self._content = await f.read()
            self._content_hash = md5(self._content).hexdigest()
        return self._content

    @property
    def archives(self) -> Generator[TFArchive]:
        for archive in self.directory.glob("*.tfa"):
            yield TFArchive(self, archive)

    @property
    async def files_list(self) -> list[dict]:
        if not self._files:
            self._files.extend([x async for x in self.get_files_list()])
        return self._files

    async def get_files_list(self) -> AsyncGenerator[dict]:
        data = await self.content
        directory = self.directory
        pos = 0
        n = len(data)
        while pos < n:
            name_len, pos = _read_uleb(data, pos)
            name = data[pos:pos + name_len].split(b"\x00", 1)[0].decode("utf-8")
            pos += name_len
            archive_index, pos = _read_uleb(data, pos)
            offset, pos = _read_uleb(data, pos)
            size, pos = _read_uleb(data, pos)
            file_hash, pos = _read_uleb(data, pos)
            yield {
                "name": name,
                "path": directory.joinpath(name),
                "archive_index": archive_index,
                "offset": offset,
                "size": size,
                "hash": file_hash,
            }


async def find_all_indexes(
    path: Path, hashes: dict, track_changes=True
) -> AsyncGenerator[TFIndex]:
    for item in path.iterdir():
        if item.is_file():
            continue
        if item.name not in [d.value for d in Directories]:
            continue
        for index_file in item.rglob("index.tfi"):
            index = TFIndex(index_file)
            if not track_changes:
                yield index
                continue
            hash = hashes.get(str(index.path.relative_to(path)))
            if hash is None or await index.content_hash != hash:
                yield index


async def find_all_archives(path: Path, hashes: dict) -> AsyncGenerator[TFArchive]:
    async for index in find_all_indexes(path, hashes):
        for archive in index.archives:
            opath = archive.path.relative_to(path)
            hash = hashes.get(opath)
            if hash is None or (await archive.content_hash) != hash:
                yield archive


async def find_all_files(path: Path, hashes: dict) -> AsyncGenerator[TroveFile]:
    async for archive in find_all_archives(path, hashes):
        async for file in archive.files():
            file.index = archive.index
            yield file


async def find_changes(
    archive_path: Path, extracted_path: Path, hashes: dict
) -> AsyncGenerator[TroveFile]:
    async for file in find_all_files(archive_path, hashes):
        if (await file.compare(archive_path, extracted_path)) in [
            FileStatus.added,
            FileStatus.changed,
        ]:
            yield file