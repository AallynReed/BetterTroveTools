import sys
from pathlib import Path

if sys.platform == "win32":
    BasePath = Path(sys.argv[0]).parent
else:
    BasePath = Path(__file__).parent.parent