from __future__ import annotations

import re
from collections import Counter
from functools import lru_cache
from typing import Iterable

import jieba
import jieba.posseg as pseg
from pypinyin import Style, pinyin

from config import LEVEL_ORDER, LEVEL_SPECS, get_level_profile, level_comparison
from data.hsk_vocab import get_cumulative_vocab

PUNCT_RE = re.compile(r"^[\W_]+$", re.UNICODE)
SENTENCE_END_RE = re.compile(r"[。！？!?；;]+[”’\"』」》）)]*")
CHINESE_RE = re.compile(r"^[\u4e00-\u9fff]+$")
FACT_VALUE_RE = re.compile(r"(?:\d+(?:\.\d+)?|[零一二三四五六七八九十百千万两]+)(?:年|月|日|号|点|岁|次|个|公里|元|分钟)")

GRAMMAR_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("因为……所以……", re.compile(r"因为.{0,40}所以")),
    ("虽然……但是……", re.compile(r"虽然.{0,40}(?:但是|可是)")),
    ("如果……就……", re.compile(r"如果.{0,40}就")),
    ("除了……以外……", re.compile(r"除了.{0,30}以外")),
    ("不但……而且……", re.compile(r"(?:不但|不仅).{0,40}而且")),
    ("即使……也……", re.compile(r"即使.{0,40}也")),
    ("不管……都……", re.compile(r"不管.{0,40}都")),
)

FORBIDDEN_GRAMMAR_BY_LEVEL: dict[str, frozenset[str]] = {
    "HSK1": frozenset(label for label, _ in GRAMMAR_PATTERNS),
    "HSK2": frozenset({"虽然……但是……", "如果……就……", "除了……以外……", "不但……而且……", "即使……也……", "不管……都……"}),
    "HSK3": frozenset({"不但……而且……", "即使……也……", "不管……都……"}),
    "HSK4": frozenset(),
}

# Jieba may emit a productive morpheme while old HSK lists contain only its
# common lexical form. These aliases keep ordinary combinations such as 吃饭
# and 说一说 from becoming false positives without broadly allowing any
# character that happens to occur inside an HSK word.
MORPHEME_ALIASES = {"饭": "米饭", "说": "说话", "们": "我们", "儿": "儿子", "句": "句子", "中": "中国"}
# The legacy HSK word lists omit a few high-frequency function words whose
# grammar is nevertheless appropriate from a specific level onward. Keep
# these as exact lexical exceptions: they must not become productive
# morphemes for arbitrary single-character compounds.
FUNCTION_WORD_MIN_LEVEL = {"只是": "HSK2"}
COMMON_SURNAMES = frozenset("赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛范彭鲁韦昌马苗凤花方俞任袁柳鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝安常乐于傅皮卞齐康伍余元顾孟黄穆萧尹姚邵汪祁毛狄米贝明臧计伏成戴宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄江童颜郭梅林钟徐邱骆高夏蔡田樊胡凌霍虞万支柯卢莫房裘缪解应宗丁宣邓郁单杭洪包诸左石崔吉龚程邢裴陆荣翁荀羊甄家封芮储靳邴松井段富巫乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾甘厉戎祖武符刘景詹束龙叶幸司韶黎白蒲邰鄂索赖卓蔺屠蒙池乔阳郁胥能苍双闻莘党翟谭贡劳姬申扶堵冉宰郦雍却璩桑桂濮牛寿边扈燕冀郏浦尚农温别庄晏柴瞿阎连习容向古易慎戈廖庾终步都耿满匡国文寇广禄阙东欧殳沃利蔚越夔隆师巩厍聂晁勾敖融冷辛阚简饶曾关蒯相查后荆红游竺权盖益桓公")
NON_NAME_TOKENS = frozenset({"家里人", "一家人", "年轻人", "老年人", "外国人", "中国人", "工作人员", "志愿者"})

# Words that are useful for comprehension but usually make poor lesson targets.
# The list intentionally stays small: teachers can still add any custom word in
# GenerateRequest.keep_words.
TOPIC_STOPWORDS = {
    "今天", "明天", "昨天", "现在", "以前", "以后", "时候", "时间", "每年", "平时",
    "很多", "一些", "一个", "自己", "别人", "大家", "事情", "问题", "方面", "地方",
    "开始", "已经", "可以", "可能", "需要", "觉得", "因为", "所以", "但是", "只是",
    "非常", "比较", "这样", "那样", "机会", "原因", "结果", "生活",
}


def _is_hanzi_word(word: str) -> bool:
    return bool(word and CHINESE_RE.fullmatch(word))


def segment(text: str) -> list[str]:
    """Segment text and remove whitespace/punctuation-only pieces."""
    return [word.strip() for word in jieba.cut(text) if word.strip() and not PUNCT_RE.fullmatch(word.strip())]


def _name_tokens(text: str) -> set[str]:
    """Return likely person names so they do not become level violations."""
    return {
        word.strip()
        for word, flag in pseg.cut(text)
        if word.strip() and _is_hanzi_word(word.strip()) and flag.startswith("nr")
    }


@lru_cache(maxsize=64)
def _cached_vocab(level: str) -> frozenset[str]:
    return frozenset(get_cumulative_vocab(level))


@lru_cache(maxsize=8)
def _level_safe_function_words(level: str) -> frozenset[str]:
    """Return exact function words allowed at ``level`` and above."""
    rank = get_level_profile(level).rank
    return frozenset(
        word
        for word, first_level in FUNCTION_WORD_MIN_LEVEL.items()
        if get_level_profile(first_level).rank <= rank
    )


def _allowed_words(level: str, keep_words: set[str] | None = None) -> frozenset[str]:
    """Return exact lexical allowances, including narrowly scoped aliases."""
    return _cached_vocab(level) | _level_safe_function_words(level) | frozenset(keep_words or set())


def _compound_source_words(level: str, keep_words: set[str] | None = None) -> frozenset[str]:
    """Return words that may productively compose a larger token.

    Exact function-word aliases are deliberately excluded so adding ``只是``
    never makes ``只`` or unrelated strings valid compound components.
    """
    return _cached_vocab(level) | frozenset(keep_words or set())


def _split_known_compound(word: str, allowed: Iterable[str]) -> list[str]:
    """Split an unknown token into known words when it is genuinely compositional.

    The dynamic program prefers the longest known pieces and requires at least
    two pieces, including one multi-character piece.  That avoids labelling
    every unknown Chinese token as a compound merely because its characters
    happen to be common.
    """
    if not _is_hanzi_word(word) or len(word) < 2:
        return []
    vocabulary = frozenset(item for item in allowed if item)
    vocabulary = vocabulary | frozenset(alias for alias, representative in MORPHEME_ALIASES.items() if representative in vocabulary)
    if len(word) == 2 and word[0] == word[1] and word[0] in vocabulary:
        return [word[0], word[1]]
    if len(word) == 3 and word[0] == word[2] and word[1] in {"一", "了"} and word[0] in vocabulary:
        return [word[0], word[1], word[2]]
    candidates = tuple(sorted((item for item in vocabulary if len(item) >= 1), key=len, reverse=True))

    @lru_cache(maxsize=None)
    def solve(index: int) -> tuple[str, ...] | None:
        if index == len(word):
            return ()
        for piece in candidates:
            if not word.startswith(piece, index):
                continue
            remainder = solve(index + len(piece))
            if remainder is not None:
                return (piece, *remainder)
        return None

    parts = solve(0) or ()
    if len(parts) < 2 or (len(word) > 2 and not any(len(part) >= 2 for part in parts)):
        return []
    # A single one-character function word plus a known compound is useful;
    # arbitrary one-character chains are not.
    if len(word) > 2 and sum(len(part) == 1 for part in parts) > 1:
        return []
    return list(parts)


def split_compound_word(word: str, level: str, keep_words: set[str] | None = None) -> list[str]:
    """Return known components for ``word`` or an empty list if none exist."""
    return _split_known_compound(word, _compound_source_words(level, keep_words))


def is_compound_word(word: str, level: str, keep_words: set[str] | None = None) -> bool:
    return bool(split_compound_word(word, level, keep_words))


def classify_word(word: str, level: str, keep_words: set[str] | None = None) -> dict[str, object]:
    """Classify a segmented token for explainable level checks."""
    allowed = _allowed_words(level, keep_words)
    if word in allowed:
        return {"word": word, "kind": "allowed", "components": [word]}
    components = _split_known_compound(word, _compound_source_words(level, keep_words))
    if components:
        return {"word": word, "kind": "compound", "components": components}
    return {"word": word, "kind": "unknown", "components": []}


def detect_compound_words(text: str, level: str, keep_words: set[str] | None = None) -> list[dict[str, object]]:
    """Find out-of-level compounds and show their known morphemes."""
    names = _name_tokens(text)
    result: list[dict[str, object]] = []
    for word in segment(text):
        if len(word) <= 1 or not _is_hanzi_word(word) or word in names:
            continue
        classified = classify_word(word, level, keep_words)
        if classified["kind"] == "compound":
            result.append(classified)
    return result


def find_violations(text: str, level: str, keep_words: set[str] | None = None) -> list[str]:
    """Find unknown/compound words outside the target level.

    Proper names are exempt because they are content labels, not vocabulary
    targets.  A selected keep word is exempt only as an exact token; a larger
    compound containing it is still surfaced for teacher review.
    """
    allowed = _allowed_words(level, keep_words)
    compound_sources = _compound_source_words(level, keep_words)
    names = _name_tokens(text)
    violations: list[str] = []
    for word in segment(text):
        if len(word) <= 1 or not _is_hanzi_word(word) or word in names:
            continue
        if word not in allowed and not _split_known_compound(word, compound_sources):
            violations.append(word)
    return sorted(set(violations))


def get_pinyin(text: str) -> list[dict[str, str]]:
    result = []
    for word in jieba.cut(text):
        clean = word.strip()
        if not clean:
            continue
        if PUNCT_RE.fullmatch(clean):
            result.append({"word": clean, "pinyin": ""})
            continue
        result.append({"word": clean, "pinyin": " ".join(item[0] for item in pinyin(clean, style=Style.TONE, errors="default"))})
    return result


def split_sentences(text: str) -> list[str]:
    """Split Chinese text without dropping punctuation or cutting a sentence."""
    normalized = re.sub(r"\r\n?", "\n", text).strip()
    if not normalized:
        return []
    sentences: list[str] = []
    cursor = 0
    for match in SENTENCE_END_RE.finditer(normalized):
        end = match.end()
        sentence = normalized[cursor:end].strip()
        if sentence:
            sentences.append(sentence)
        cursor = end
    tail = normalized[cursor:].strip()
    if tail:
        lines = [line.strip() for line in tail.split("\n") if line.strip()]
        sentences.extend(lines or [tail])
    return sentences


def _sentence_length(sentence: str) -> int:
    """Count readable symbols while excluding punctuation and whitespace."""
    return len(re.sub(r"[^\u4e00-\u9fffA-Za-z0-9]", "", sentence))


def readable_length(text: str) -> int:
    """Count visible Chinese/Latin letters and digits, excluding punctuation."""
    return _sentence_length(text)


def detect_grammar(text: str) -> list[str]:
    return [label for label, pattern in GRAMMAR_PATTERNS if pattern.search(text)]


def grammar_violations(text: str, level: str) -> list[str]:
    forbidden = FORBIDDEN_GRAMMAR_BY_LEVEL[level]
    return [label for label in detect_grammar(text) if label in forbidden]


def factual_markers(text: str) -> list[str]:
    """Extract names and concrete numeric values that a rewrite must not invent."""
    names = {
        word for word in _name_tokens(text)
        if word not in NON_NAME_TOKENS and 2 <= len(word) <= 4 and (
            word[0] in COMMON_SURNAMES
            or (word[0] in {"小", "老"} and len(word) >= 2 and word[1] in COMMON_SURNAMES)
        )
    }
    return sorted(names | set(FACT_VALUE_RE.findall(text)))


def extract_topic_word_details(text: str, level: str, top_n: int = 8) -> list[dict[str, str | int | bool | list[str]]]:
    """Return ranked, explainable noun candidates for teacher confirmation."""
    frequencies: Counter[str] = Counter()
    positions: dict[str, str] = {}
    names = _name_tokens(text)
    for word, flag in pseg.cut(text):
        word = word.strip()
        if (
            len(word) >= 2
            and _is_hanzi_word(word)
            and word not in TOPIC_STOPWORDS
            and word not in names
            and not flag.startswith("nr")
            and flag.startswith(("n", "t"))
        ):
            frequencies[word] += 1
            positions[word] = flag
    ranked = sorted(frequencies, key=lambda item: (-frequencies[item], -len(item), item))[:top_n]
    result: list[dict[str, str | int | bool | list[str]]] = []
    for word in ranked:
        components = split_compound_word(word, level)
        first_level = next((candidate for candidate in LEVEL_ORDER if word in _cached_vocab(candidate)), None)
        if word in _cached_vocab(level):
            status = "known"
            reason = f"本级已学主题词，可用于复习和迁移，出现 {frequencies[word]} 次"
        elif components:
            status = "known_composite"
            reason = f"由本级已学词组成，可作为表达练习，出现 {frequencies[word]} 次"
        else:
            status = "above_level"
            reason = f"当前等级需要讲解的{'时间/节日词' if positions[word].startswith('t') else '主题词'}，出现 {frequencies[word]} 次"
        result.append({
            "word": word,
            "frequency": frequencies[word],
            "pos": positions[word],
            "status": status,
            "first_level": first_level,
            "is_compound": bool(components),
            "components": components,
            "reason": reason,
        })
    return result


def extract_topic_words(text: str, level: str, top_n: int = 8) -> list[str]:
    """Backward-compatible word-only API used by callers and older scripts."""
    return [item["word"] for item in extract_topic_word_details(text, level, top_n)]


def extract_teaching_word_details(text: str, level: str, top_n: int = 16) -> list[dict[str, object]]:
    """Rank teachable content words, including useful verbs/adjectives.

    Analysis candidates stay noun-focused. Package generation can use this
    broader list so higher levels receive more productive expressions without
    turning ordinary known composites into automatic vocabulary cards.
    """
    frequencies: Counter[str] = Counter()
    positions: dict[str, str] = {}
    names = _name_tokens(text)
    for word, flag in pseg.cut(text):
        word = word.strip()
        if (
            len(word) >= 2
            and _is_hanzi_word(word)
            and word not in TOPIC_STOPWORDS
            and word not in names
            and flag.startswith(("n", "t", "v", "a"))
        ):
            frequencies[word] += 1
            positions[word] = flag
    ranked = sorted(frequencies, key=lambda item: (-frequencies[item], -len(item), item))[:top_n]
    result: list[dict[str, object]] = []
    for word in ranked:
        classified = classify_word(word, level)
        status = "known_composite" if classified["kind"] == "compound" else "known" if classified["kind"] == "allowed" else "above_level"
        result.append({
            "word": word,
            "frequency": frequencies[word],
            "pos": positions[word],
            "status": status,
            "components": classified["components"],
        })
    return result


def _estimated_level(text: str, keep_words: set[str] | None = None) -> str:
    """Estimate the first legacy level that can carry the text."""
    for candidate in LEVEL_ORDER:
        profile = get_level_profile(candidate)
        if not find_violations(text, candidate, keep_words) and all(
            _sentence_length(sentence) <= profile.max_sentence_len for sentence in split_sentences(text)
        ):
            return candidate
    return "HSK4"


def validate(text: str, level: str, keep_words: set[str] | None = None) -> dict:
    """Run deterministic vocabulary, sentence-length, and level checks."""
    profile = get_level_profile(level)
    words = segment(text)
    violations = find_violations(text, level, keep_words)
    meaningful = [word for word in words if len(word) > 1 and _is_hanzi_word(word) and word not in _name_tokens(text)]
    violating_tokens = [word for word in meaningful if word in violations]
    in_level_ratio = 1 - len(violating_tokens) / max(len(meaningful), 1)
    sentence_over_length = [sentence for sentence in split_sentences(text) if _sentence_length(sentence) > profile.max_sentence_len]
    total_length = readable_length(text)
    if total_length < profile.min_total_len:
        total_length_status = "below_target"
    elif total_length > profile.max_total_len:
        total_length_status = "above_target"
    else:
        total_length_status = "within_target"
    detected_grammar = detect_grammar(text)
    forbidden_grammar = grammar_violations(text, level)
    estimated = _estimated_level(text, keep_words)
    sentence_count = max(len(split_sentences(text)), 1)
    compliance_score = round(max(0.0, min(1.0,
        in_level_ratio * 0.65
        + (1 - len(sentence_over_length) / sentence_count) * 0.2
        + (0.1 if not forbidden_grammar else 0.0)
        + (0.05 if total_length_status == "within_target" else 0.0)
    )), 3)
    return {
        "in_level_ratio": round(in_level_ratio, 3),
        "compliance_score": compliance_score,
        "violations": violations,
        "sentence_over_length": sentence_over_length,
        "total_length": total_length,
        "target_total_len": list(profile.target_total_len),
        "total_length_status": total_length_status,
        "detected_grammar": detected_grammar,
        "grammar_violations": forbidden_grammar,
        "compound_words": detect_compound_words(text, level, keep_words),
        "estimated_level": estimated,
        "level_comparison": level_comparison(level, estimated),
    }


def compare_levels(text: str, top_n: int = 8) -> list[dict[str, object]]:
    """Return comparable difficulty metrics for the same source text."""
    words = [word for word in segment(text) if len(word) > 1 and _is_hanzi_word(word) and word not in _name_tokens(text)]
    meaningful = list(dict.fromkeys(words))
    result: list[dict[str, object]] = []
    for level in LEVEL_ORDER:
        profile = get_level_profile(level)
        classifications = [classify_word(word, level) for word in meaningful]
        known_count = sum(1 for item in classifications if item["kind"] in {"allowed", "compound"})
        out_of_level = sorted({str(item["word"]) for item in classifications if item["kind"] == "unknown"})
        candidates = extract_topic_word_details(text, level, top_n)
        suggested = [str(item["word"]) for item in candidates if item.get("status") == "above_level"][:profile.max_target_words]
        result.append({
            "level": level,
            "known_ratio": round(known_count / max(len(meaningful), 1), 3),
            "out_of_level_words": len(out_of_level),
            "out_of_level_examples": out_of_level[:10],
            "max_sentence_len": profile.max_sentence_len,
            "target_total_len": list(profile.target_total_len),
            "suggested_target_words": suggested,
            "grammar_focus": list(profile.allowed_grammar),
            "task_focus": list(profile.task_focus),
            "question_types": list(profile.question_types),
        })
    return result


def level_issues(text: str, level: str, keep_words: set[str] | None = None) -> list[str]:
    """Return compact issue labels used by component validators."""
    quality = validate(text, level, keep_words)
    issues: list[str] = []
    if quality["violations"]:
        issues.append("out_of_level_words")
    if quality["sentence_over_length"]:
        issues.append("overlength_sentence")
    if quality["grammar_violations"]:
        issues.append("forbidden_grammar")
    return issues
