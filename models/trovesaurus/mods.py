from datetime import datetime, timezone
from enum import Enum
from typing import Union, Optional, List

from pydantic import BaseModel, Field, validator

class ModFileType(Enum):
    TMOD = "tmod"
    ZIP = "zip"
    CONFIG = "config"

class ModFile(BaseModel):
    file_id: int = Field(alias="fileid")
    type: ModFileType = Field(alias="format")
    is_config: bool = Field(alias="extra", default=False)
    version: str
    changes: str = ""
    created_at: datetime = Field(alias="date")
    downloads: int = 0
    size: int = 0
    hash: str = Field(default="")

    @validator("created_at", pre=True)
    def parse_timestamp(cls, value):
        if isinstance(value, datetime):
            return value
        return datetime.fromtimestamp(int(value), timezone.utc)

    @validator("version")
    def parse_version(cls, value, values):
        if values.get("is_config"):
            return "config"
        if not value.strip():
            return f"File: [{str(values.get('file_id'))}]"
        return value

class ModAuthor(BaseModel):
    ID: Optional[int] = None
    Username: Optional[str] = None
    Avatar: Optional[str] = None
    Role: Optional[str] = None

    @property
    def avatar_url(self):
        if not self.Avatar:
            return ""
        if self.Avatar.startswith("//"):
            return f"https:{self.Avatar}"
        return self.Avatar.replace("http:", "https:")

class Mod(BaseModel):
    id: int
    name: str
    type: str
    subtype: str = ""
    description: str = ""
    created_at: datetime = Field(alias="date")
    downloads: int = Field(alias="totaldownloads", default=0)
    thumbnail_url: str = Field(alias="image", default="")
    notes: str = ""
    likes: int = 0
    author: ModAuthor
    file_objs: List[ModFile] = Field(alias="downloads", default_factory=list)
    
    installed: bool = False
    installed_file: Optional[ModFile] = None
    installed_version: Optional[str] = None
    obsolete: int = 0

    def __contains__(self, item):
        return item in self.hashes

    @property
    def hashes(self):
        return [file.hash for file in self.file_objs]

    @validator("created_at", pre=True)
    def parse_timestamp(cls, value):
        if isinstance(value, datetime):
            return value
        return datetime.fromtimestamp(int(value), timezone.utc)

    @property
    def url(self):
        return f"https://trovesaurus.com/mod={self.id}"

    @property
    def is_obsolete(self):
        return self.obsolete != 0