"""Shared configuration for the legacy HSK 1-4 scale."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


LEVEL_ORDER = ("HSK1", "HSK2", "HSK3", "HSK4")


@dataclass(frozen=True)
class LevelProfile:
    """Prompt and deterministic validation constraints for one HSK level."""

    code: str
    rank: int
    vocab_size: int
    max_sentence_len: int
    target_total_len: tuple[int, int]
    allowed_grammar: tuple[str, ...] = ()
    forbidden_grammar: tuple[str, ...] = ()
    max_target_words: int = 4
    task_focus: tuple[str, ...] = ()
    question_types: tuple[str, ...] = ()

    @property
    def min_total_len(self) -> int:
        return self.target_total_len[0]

    @property
    def max_total_len(self) -> int:
        return self.target_total_len[1]

    @property
    def grammar_focus(self) -> tuple[str, ...]:
        return self.allowed_grammar

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["target_total_len"] = list(self.target_total_len)
        payload["min_total_len"] = self.min_total_len
        payload["max_total_len"] = self.max_total_len
        payload["grammar_focus"] = list(self.allowed_grammar)
        return payload


LEVEL_PROFILES: dict[str, LevelProfile] = {
    "HSK1": LevelProfile(
        code="HSK1", rank=1, vocab_size=150, max_sentence_len=8, target_total_len=(80, 140),
        allowed_grammar=(
            "主谓宾基本句", "是 / 有 / 在", "很 + 形容词", "不 / 没 否定", "吗 疑问句",
            "疑问词：什么、谁、几、哪儿", "的（简单所属）", "句末 了（表完成）", "想 / 要 + 动词",
        ),
        forbidden_grammar=(
            "把字句", "被字句", "结果、趋向、程度、可能补语", "兼语句（使 / 让 / 叫）",
            "因为所以、虽然但是等复句", "长定语", "成语、书面语", "比较句",
        ),
        max_target_words=4, task_focus=("识别关键词", "复述事实", "简单问答"), question_types=("fact", "choice", "repeat"),
    ),
    "HSK2": LevelProfile(
        code="HSK2", rank=2, vocab_size=300, max_sentence_len=12, target_total_len=(140, 220),
        allowed_grammar=(
            "HSK1 全部", "会 / 能 / 可以", "正在 / 在 + 动词", "太……了 / 真……", "基础比较句",
            "因为……所以…… / 但是", "简单结果补语", "过（表经历）", "一边……一边……", "常见离合词",
        ),
        forbidden_grammar=(
            "被字句", "把字句", "可能补语", "兼语句", "成语", "超过五字的长定语", "不但……而且……",
        ),
        max_target_words=5, task_focus=("按顺序复述", "说明原因", "联系个人经历"), question_types=("fact", "sequence", "reason"),
    ),
    "HSK3": LevelProfile(
        code="HSK3", rank=3, vocab_size=600, max_sentence_len=18, target_total_len=(220, 350),
        allowed_grammar=(
            "HSK2 全部", "基础把字句", "虽然……但是…… / 如果……就……", "趋向补语", "程度补语",
            "可能补语", "中等长度的的字定语", "又……又…… / 越来越", "除了……以外……", "最简被字句",
        ),
        forbidden_grammar=(
            "生僻成语", "然而、因此、尽管等书面连词", "三个分句以上的复句", "文言结构：之、其、以",
        ),
        max_target_words=6, task_focus=("概括段意", "解释原因", "做简单推断"), question_types=("fact", "inference", "explain"),
    ),
    "HSK4": LevelProfile(
        code="HSK4", rank=4, vocab_size=1200, max_sentence_len=25, target_total_len=(350, 550),
        allowed_grammar=(
            "HSK3 全部", "完整被字句", "不但……而且…… / 不管……都……", "使 / 让兼语句",
            "即使……也……", "对于 / 关于 / 由于", "高频四字成语（每篇不超过两个）", "复杂定语与状语", "反问句",
        ),
        forbidden_grammar=("生僻成语与典故", "文言句式", "学术、法律、公文腔"),
        max_target_words=8, task_focus=("概括观点", "比较信息", "迁移讨论"), question_types=("fact", "inference", "discussion"),
    ),
}


# Keep the old dictionary contract for callers that index into LEVEL_SPECS.
LEVEL_SPECS: dict[str, dict[str, Any]] = {
    level: {
        "vocab_size": profile.vocab_size,
        "max_sentence_len": profile.max_sentence_len,
        "target_total_len": profile.target_total_len,
        "allowed_grammar": list(profile.allowed_grammar),
        "forbidden_grammar": list(profile.forbidden_grammar),
        "max_target_words": profile.max_target_words,
        "task_focus": list(profile.task_focus),
        "question_types": list(profile.question_types),
    }
    for level, profile in LEVEL_PROFILES.items()
}


def get_level_profile(level: str) -> LevelProfile:
    try:
        return LEVEL_PROFILES[level]
    except KeyError as exc:
        raise ValueError(f"Unsupported HSK level: {level}") from exc


def compare_levels(target_level: str, observed_level: str) -> int:
    """Return ``observed - target`` on the legacy HSK scale."""
    return get_level_profile(observed_level).rank - get_level_profile(target_level).rank


def level_comparison(target_level: str, observed_level: str | None = None) -> dict[str, Any]:
    observed_level = observed_level or target_level
    delta = compare_levels(target_level, observed_level)
    relation = "below_target" if delta < 0 else "at_target" if delta == 0 else "above_target"
    return {
        "target_level": target_level,
        "observed_level": observed_level,
        "delta": delta,
        "relation": relation,
        "within_target": delta <= 0,
    }


def level_profile_metadata(level: str) -> dict[str, Any]:
    return get_level_profile(level).to_dict()
