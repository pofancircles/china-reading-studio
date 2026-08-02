from __future__ import annotations

import json
import urllib.request
from pathlib import Path


BASE = "https://raw.githubusercontent.com/drkameleon/complete-hsk-vocabulary/main/wordlists/exclusive/old/{level}.min.json"
OUTPUT = Path(__file__).parents[1] / "backend" / "data" / "hsk_vocab.json"


def main() -> None:
    result: dict[str, list[str]] = {}
    for level in range(1, 5):
        with urllib.request.urlopen(BASE.format(level=level), timeout=30) as response:
            payload = json.load(response)
        result[f"HSK{level}"] = [item["s"] for item in payload]
        print(f"HSK{level}: {len(result[f'HSK{level}'])} words")
    OUTPUT.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {OUTPUT}")


if __name__ == "__main__":
    main()

