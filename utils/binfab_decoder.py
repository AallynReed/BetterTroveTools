from __future__ import annotations

import argparse
import json
import math
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Any


TYPE_VARINT = 0x0
TYPE_FIXED32 = 0x4
TYPE_FIXED64 = 0x6
TYPE_BYTES = 0x8
TYPE_CONTAINER = 0xE

TYPE_NAMES = {
    TYPE_VARINT: "varint",
    TYPE_FIXED32: "fixed32",
    TYPE_FIXED64: "fixed64",
    TYPE_BYTES: "bytes",
    TYPE_CONTAINER: "container",
}


@dataclass
class Token:
    offset: int
    tag_value: int
    field_id: int
    wire_type: int
    payload: Any
    raw_hex: str
    children: list["Token"] | None = None

    def to_dict(self) -> dict[str, Any]:
        data = {
            "offset": self.offset,
            "tag_value": self.tag_value,
            "tag_hex": f"0x{self.tag_value:X}",
            "field_id": self.field_id,
            "wire_type": self.wire_type,
            "wire_type_name": TYPE_NAMES.get(self.wire_type, f"unknown_{self.wire_type:X}"),
            "payload": self.payload,
            "raw_hex": self.raw_hex,
        }
        if self.children is not None:
            data["children"] = [child.to_dict() for child in self.children]
        return data


def read_varint(data: bytes, offset: int) -> tuple[int | None, int]:
    value = 0
    shift = 0
    cursor = offset
    while cursor < len(data):
        byte = data[cursor]
        value |= (byte & 0x7F) << shift
        cursor += 1
        if byte < 0x80:
            return value, cursor
        shift += 7
        if shift > 63:
            break
    return None, offset


def decode_fixed32(raw: bytes) -> dict[str, Any]:
    unsigned = int.from_bytes(raw, "little", signed=False)
    signed = int.from_bytes(raw, "little", signed=True)
    payload: dict[str, Any] = {
        "u32": unsigned,
        "i32": signed,
        "hex": raw.hex().upper(),
    }
    float_value = struct.unpack("<f", raw)[0]
    if not math.isnan(float_value) and not math.isinf(float_value):
        payload["f32"] = float_value
    return payload


def decode_fixed64(raw: bytes) -> dict[str, Any]:
    return {
        "u64": int.from_bytes(raw, "little", signed=False),
        "i64": int.from_bytes(raw, "little", signed=True),
        "hex": raw.hex().upper(),
    }


def decode_bytes(raw: bytes) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "length": len(raw),
        "hex": raw.hex().upper(),
    }
    if all(32 <= byte < 127 for byte in raw):
        payload["ascii"] = raw.decode("ascii", errors="ignore")
    return payload


def parse_tokens(data: bytes, start: int = 0, end: int | None = None) -> list[Token]:
    tokens: list[Token] = []
    cursor = start
    limit = len(data) if end is None else min(end, len(data))

    while cursor < limit:
        tag_value, tag_end = read_varint(data, cursor)
        if tag_value is None or tag_end <= cursor:
            break

        field_id = tag_value >> 4
        wire_type = tag_value & 0xF

        if wire_type == TYPE_VARINT:
            value, next_cursor = read_varint(data, tag_end)
            if value is None or next_cursor > limit:
                break
            raw = data[tag_end:next_cursor]
            tokens.append(Token(cursor, tag_value, field_id, wire_type, value, raw.hex().upper()))
            cursor = next_cursor
            continue

        if wire_type == TYPE_FIXED32:
            next_cursor = tag_end + 4
            if next_cursor > limit:
                break
            raw = data[tag_end:next_cursor]
            tokens.append(Token(cursor, tag_value, field_id, wire_type, decode_fixed32(raw), raw.hex().upper()))
            cursor = next_cursor
            continue

        if wire_type == TYPE_FIXED64:
            next_cursor = tag_end + 8
            if next_cursor > limit:
                break
            raw = data[tag_end:next_cursor]
            tokens.append(Token(cursor, tag_value, field_id, wire_type, decode_fixed64(raw), raw.hex().upper()))
            cursor = next_cursor
            continue

        if wire_type == TYPE_BYTES:
            size, size_end = read_varint(data, tag_end)
            if size is None:
                break
            next_cursor = size_end + size
            if next_cursor > limit:
                break
            raw = data[size_end:next_cursor]
            tokens.append(Token(cursor, tag_value, field_id, wire_type, decode_bytes(raw), raw.hex().upper()))
            cursor = next_cursor
            continue

        if wire_type == TYPE_CONTAINER:
            size, size_end = read_varint(data, tag_end)
            if size is None:
                break
            next_cursor = size_end + size
            if next_cursor > limit:
                break
            raw = data[size_end:next_cursor]
            children = parse_tokens(data, size_end, next_cursor)
            tokens.append(
                Token(
                    cursor,
                    tag_value,
                    field_id,
                    wire_type,
                    {"length": size},
                    raw.hex().upper(),
                    children=children,
                )
            )
            cursor = next_cursor
            continue

        break

    return tokens


def analyze_binfab(data: bytes, source_name: str = "") -> dict[str, Any]:
    tokens = parse_tokens(data)
    return {
        "file": source_name,
        "size": len(data),
        "tokens": [token.to_dict() for token in tokens],
    }


def format_payload(payload: Any) -> str:
    if isinstance(payload, dict):
        if "ascii" in payload:
            return repr(payload["ascii"])
        if "length" in payload:
            return f"length={payload['length']}"
        if "f32" in payload:
            return f"f32={payload['f32']!r} hex={payload['hex']}"
        if "u64" in payload:
            return f"u64={payload['u64']} hex={payload['hex']}"
        return json.dumps(payload, ensure_ascii=True)
    return repr(payload)


def _append_token_lines(lines: list[str], tokens: list[dict[str, Any]], depth: int, max_tokens: int, counter: list[int]) -> None:
    indent = "  " * depth
    for token in tokens:
        if counter[0] >= max_tokens:
            return
        lines.append(
            f"{indent}0x{token['offset']:04X} tag={token['tag_hex']:<6} field={token['field_id']:<4} "
            f"type={token['wire_type_name']:<9} {format_payload(token['payload'])}"
        )
        counter[0] += 1
        children = token.get("children") or []
        if children:
            _append_token_lines(lines, children, depth + 1, max_tokens, counter)
        if counter[0] >= max_tokens:
            return


def format_analysis(analysis: dict[str, Any], max_tokens: int = 120) -> str:
    lines = [
        f"File: {analysis['file'] or '<memory>'}",
        f"Size: {analysis['size']} bytes",
        f"Top-level tokens: {len(analysis['tokens'])}",
        "",
        "Token tree:",
    ]
    counter = [0]
    _append_token_lines(lines, analysis["tokens"], 1, max_tokens, counter)
    if counter[0] >= max_tokens:
        lines.append("  ... token output truncated")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Structured Trove .binfab token decoder.")
    parser.add_argument("path", type=Path, help="Path to the .binfab file")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON")
    parser.add_argument("--max-tokens", type=int, default=120, help="Text mode token limit")
    args = parser.parse_args()

    analysis = analyze_binfab(args.path.read_bytes(), str(args.path))
    if args.json:
        print(json.dumps(analysis, indent=2))
    else:
        print(format_analysis(analysis, max_tokens=args.max_tokens))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
