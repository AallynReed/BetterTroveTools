"""One pooled HTTP session for the app's outbound calls.

Every request used to go through `requests.get`/`.post` directly, which opens a
fresh connection each time: DNS, TCP, then a TLS handshake. Measured against the
Kiwi API and Trovesaurus that setup costs 105-371 ms per call -- several times
the response itself, since both APIs answer these endpoints in tens of
milliseconds with a few KB. A shared session keeps the connection alive, so only
the first call to a host pays it.

Use `SESSION` exactly like the `requests` module: `SESSION.get(...)`,
`SESSION.post(...)`. Same arguments, same return type.
"""

import atexit

import requests
from requests.adapters import HTTPAdapter

SESSION = requests.Session()

# The mod manager fans out (a page of cards, then details / images / a download),
# so keep enough sockets alive that concurrent tasks don't queue behind one.
_adapter = HTTPAdapter(pool_connections=8, pool_maxsize=16)
SESSION.mount("https://", _adapter)
SESSION.mount("http://", _adapter)

atexit.register(SESSION.close)
