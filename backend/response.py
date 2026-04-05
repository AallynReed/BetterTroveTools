from functools import wraps


def resp(success, data=None, error=None, code=None, meta=None, **legacy):
    payload = {
        "success": bool(success),
        "code": code or ("OK" if success else "ERROR"),
        "data": data if data is not None else {},
        "error": error,
        "meta": meta or {},
    }
    payload.update(legacy)
    return payload


def normalize_response(value):
    if isinstance(value, dict):
        has_envelope = all(k in value for k in ("success", "code", "data", "error", "meta"))
        if has_envelope:
            return value

        success = bool(value.get("success", True))
        error = value.get("error")
        code = value.get("code")
        meta = value.get("meta")

        if "data" in value:
            data = value.get("data")
        else:
            data = {k: v for k, v in value.items() if k not in ("success", "error", "code", "meta")}

        # Forward only non-envelope keys to avoid collisions like success/code/error/meta/data.
        legacy = {k: v for k, v in value.items() if k not in ("success", "code", "data", "error", "meta")}
        return resp(success, data=data, error=error, code=code, meta=meta, **legacy)

    if value is None:
        return resp(True)

    return resp(True, data={"value": value}, value=value)


def standardize_response(func):
    @wraps(func)
    def wrapper(*args, **kwargs):
        try:
            return normalize_response(func(*args, **kwargs))
        except Exception as exc:
            return resp(False, error=str(exc), code="UNHANDLED_EXCEPTION")

    return wrapper
