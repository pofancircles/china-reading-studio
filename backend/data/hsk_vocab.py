"""Old HSK vocabulary loader.

The generated JSON is intentionally kept out of git because it is built from
the public source repository by scripts/build_hsk_vocab.py.
"""

from __future__ import annotations

import json
from pathlib import Path

LEVELS = ("HSK1", "HSK2", "HSK3", "HSK4")
DATA_PATH = Path(__file__).with_name("hsk_vocab.json")


def _load() -> dict[str, list[str]]:
    if not DATA_PATH.exists():
        return {
            "HSK1": ["我", "你", "他", "她", "好", "是", "有", "在", "人", "家", "吃", "喝", "看", "说", "去", "来", "今天", "明天", "喜欢", "朋友"],
            "HSK2": ["因为", "所以", "但是", "可以", "正在", "已经", "觉得", "开始", "一起", "时间"],
            "HSK3": ["发现", "影响", "选择", "文化", "城市", "生活", "特别", "需要", "后来", "如果"],
            "HSK4": ["安排", "安全", "经验", "提高", "原因", "结果", "虽然", "因此", "对于", "继续"],
        }
    return json.loads(DATA_PATH.read_text(encoding="utf-8"))


HSK_VOCAB = _load()


def get_cumulative_vocab(level: str) -> set[str]:
    if level not in LEVELS:
        raise ValueError(f"Unsupported HSK level: {level}")
    end = LEVELS.index(level) + 1
    result: set[str] = set()
    for item in LEVELS[:end]:
        result.update(HSK_VOCAB.get(item, []))
    return result

