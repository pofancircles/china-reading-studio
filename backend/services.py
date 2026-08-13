from __future__ import annotations

import asyncio
import json
from collections.abc import Callable, Iterable
from typing import Any

from config import get_level_profile
from data.hsk_vocab import get_cumulative_vocab
from llm import LLMError, complete_json
from nlp import (
    compare_levels,
    extract_topic_word_details,
    extract_teaching_word_details,
    factual_markers,
    get_pinyin,
    readable_length,
    split_sentences,
    validate,
)
from prompts import (
    lesson_plan_prompt,
    question_item_prompt,
    questions_prompt,
    rewrite_prompt,
    rewrite_repair_prompt,
    vocab_item_prompt,
    vocab_prompt,
)


SYSTEM_PROMPT = "You are a careful Chinese teaching-material editor. Always return valid JSON and never invent facts."
LESSON_STAGE_TITLES = ("导入", "理解阅读", "词汇与句型", "交互练习", "总结与迁移")
LESSON_STAGE_DURATIONS = (4, 8, 7, 8, 3)
LESSON_STAGE_MATERIALS = (
    ("标题或主题图",),
    ("分级阅读材料",),
    ("目标词卡", "分级阅读材料"),
    ("练习题", "分级阅读材料"),
    ("课堂板书",),
)
AUTO_KEEP_LIMITS = {"HSK1": 1, "HSK2": 2, "HSK3": 3, "HSK4": 4}

# Lesson objectives need to describe something a teacher can see or hear. Keep
# this deliberately small and concrete: it rejects the common vague outputs
# without trying to solve Chinese semantic parsing with a brittle word list.
LESSON_OBSERVABLE_ACTIONS = (
    "找出", "圈出", "指出", "说出", "选出", "写出", "标出", "列出",
    "回答", "复述", "概括", "总结", "比较", "排序", "匹配", "完成", "填写",
    "朗读", "跟读", "讨论", "对话", "表演", "描述", "解释", "说明", "造句",
    "编写", "改写", "阅读", "听", "读", "说", "写", "问", "选", "画",
)
LESSON_VAGUE_OBJECTIVE_PREFIXES = (
    "理解", "掌握", "了解", "熟悉", "认识", "学习", "感受", "体会", "培养", "提升", "增强",
)
LESSON_PLAN_SPEAK = (
    "教师", "老师", "学生", "引导", "激活", "教学目标", "本环节", "课堂材料", "分钟",
)
LESSON_DIRECT_ACTIONS = (
    "请", "先", "再", "用", "把", "找", "圈", "指", "说", "选", "写", "标", "列",
    "回答", "复述", "概括", "总结", "比较", "排序", "匹配", "完成", "填",
    "读", "听", "看", "想", "讨论", "对话", "表演", "描述", "解释", "说明", "造句",
)
LESSON_OBJECTIVE_PREFIXES = (
    "学生将能够", "学生能够", "学生可以", "学生能", "学习者能够", "学习者可以", "学习者能",
)


def _unique(items: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(item for item in items if isinstance(item, str) and item.strip()))


def _rewrite_token_budget(level: str) -> int:
    return max(900, get_level_profile(level).max_total_len * 3)


def _component_token_budget(name: str, level: str) -> int:
    profile = get_level_profile(level)
    if name == "lesson_plan":
        return 1500
    if name == "vocab":
        return 1100 + profile.max_target_words * 100
    return 900


def _initial_rewrite_keep_words(text: str, level: str, selected_words: list[str]) -> list[str]:
    profile = get_level_profile(level)
    suggested = [
        str(item["word"])
        for item in extract_topic_word_details(text, level, top_n=profile.max_target_words * 2)
        if item.get("status") == "above_level"
    ]
    accepted_selected = _unique(selected_words)[:profile.max_target_words]
    auto_limit = min(AUTO_KEEP_LIMITS[level], profile.max_target_words - len(accepted_selected))
    return _unique([*accepted_selected, *suggested[:auto_limit]])[:profile.max_target_words]


def analyze_article(text: str, level: str) -> dict:
    sentences = split_sentences(text)
    details = extract_topic_word_details(text, level)
    profile = get_level_profile(level)
    comparisons = compare_levels(text)
    known_ratios = [float(item["known_ratio"]) for item in comparisons]
    out_counts = [int(item["out_of_level_words"]) for item in comparisons]
    distinct = max(known_ratios) - min(known_ratios) >= 0.1 or max(out_counts) - min(out_counts) >= 3
    return {
        "sentences": [{"id": index, "text": sentence} for index, sentence in enumerate(sentences)],
        "topic_word_candidates": details[:10],
        "level_profile": profile.to_dict(),
        "level_comparison": comparisons,
        "material_distinctiveness": {
            "status": "sufficient" if distinct else "low",
            "known_ratio_spread": round(max(known_ratios) - min(known_ratios), 3),
            "out_of_level_spread": max(out_counts) - min(out_counts),
        },
    }


def _source_preview(text: str) -> dict:
    original = split_sentences(text)
    selected = original or [text.strip()]
    sentences = [{"text": sentence, "source_sentence_ids": [index]} for index, sentence in enumerate(selected)]
    return {
        "title": "原文预览",
        "sentences": sentences,
        "deleted_info": "无",
        "teacher_notes": "改写组件未成功；这里只显示原文，不能作为分级改写使用。",
    }


def _empty_lesson_plan() -> dict:
    return {"title": "", "total_minutes": 0, "objectives": [], "stages": [], "homework": "", "available": False}


def _fact_alignment_issues(result: dict, source_text: str) -> list[str]:
    issues: list[str] = []
    rewritten_text = "".join(item["text"] for item in result["sentences"])
    invented_markers = sorted(set(factual_markers(rewritten_text)) - set(factual_markers(source_text)))
    if invented_markers:
        issues.append(f"出现原文没有的人名或数值：{'、'.join(invented_markers)}")
    source_count = len(split_sentences(source_text))
    covered = {source_id for item in result["sentences"] for source_id in item["source_sentence_ids"]}
    if len(covered) < source_count and str(result.get("deleted_info", "")).strip() in {"", "无", "没有"}:
        issues.append("有原文句子未覆盖，但 deleted_info 没有说明删减内容")
    return issues


def _rewrite_quality_issues(
    result: dict,
    source_text: str,
    level: str,
    keep_words: list[str],
    enforce_source_limited_floor: bool = True,
) -> list[str]:
    profile = get_level_profile(level)
    text = "".join(item["text"] for item in result["sentences"])
    quality = validate(text, level, set(keep_words))
    issues: list[str] = []
    if quality["sentence_over_length"]:
        issues.append(f"句子超过 {profile.max_sentence_len} 字")
    if quality["violations"]:
        issues.append(f"含有未获准的超纲词：{'、'.join(quality['violations'][:8])}")
    if quality["grammar_violations"]:
        issues.append(f"含有本级禁用句型：{'、'.join(quality['grammar_violations'])}")
    output_length = int(quality["total_length"])
    source_length = readable_length(source_text)
    source_quality = validate(source_text, level, set(keep_words))
    source_difficulty_limited = float(source_quality["compliance_score"]) < 0.55
    if output_length > profile.max_total_len:
        issues.append(f"全文超过 {profile.max_total_len} 字")
    difficult_source_floor = max(40, int(profile.min_total_len * 0.55))
    if source_length >= profile.min_total_len and output_length < profile.min_total_len and (
        not source_difficulty_limited or output_length < difficult_source_floor
    ):
        issues.append(f"原文信息量足够，但全文不足 {profile.min_total_len} 字")
    source_limited_floor = max(1, min(profile.min_total_len, int(source_length * 0.65)))
    if enforce_source_limited_floor and source_length < profile.min_total_len and output_length < source_limited_floor:
        issues.append(f"全文只有 {output_length} 字；原文信息有限时也至少保留 {source_limited_floor} 字，不要只写提纲")
    issues.extend(_fact_alignment_issues(result, source_text))
    return issues


def _rewrite_can_ship_with_review(result: dict, source_text: str, level: str, keep_words: list[str]) -> bool:
    """Allow a useful near-miss after repair without pretending it is perfect."""
    profile = get_level_profile(level)
    rewritten_text = "".join(item["text"] for item in result["sentences"])
    quality = validate(rewritten_text, level, set(keep_words))
    if _fact_alignment_issues(result, source_text):
        return False
    if quality["grammar_violations"] or int(quality["total_length"]) > profile.max_total_len:
        return False
    if float(quality["compliance_score"]) < 0.82:
        return False
    if len(quality["violations"]) > 2 or len(quality["sentence_over_length"]) > 2:
        return False
    if quality["sentence_over_length"]:
        overflow = max(
            readable_length(sentence) - profile.max_sentence_len
            for sentence in quality["sentence_over_length"]
        )
        if overflow > 5:
            return False
    source_length = readable_length(source_text)
    output_length = int(quality["total_length"])
    if source_length >= profile.min_total_len and output_length < int(profile.min_total_len * 0.65):
        return False
    return bool(
        quality["violations"]
        or quality["sentence_over_length"]
        or quality["total_length_status"] != "within_target"
    )


def _rewrite_candidate_score(result: dict, source_text: str, level: str, keep_words: list[str]) -> tuple:
    text = "".join(item["text"] for item in result["sentences"])
    quality = validate(text, level, set(keep_words))
    profile = get_level_profile(level)
    target_midpoint = (profile.min_total_len + profile.max_total_len) / 2
    return (
        not bool(_fact_alignment_issues(result, source_text)),
        not bool(quality["grammar_violations"]),
        round(float(quality["compliance_score"]), 3),
        -len(quality["violations"]),
        -len(quality["sentence_over_length"]),
        -abs(int(quality["total_length"]) - target_midpoint),
    )


def _rewrite_best_candidate_can_ship(result: dict, source_text: str, level: str, keep_words: list[str]) -> bool:
    """Use a materially improved AI rewrite instead of falling back to raw text."""
    text = "".join(item["text"] for item in result["sentences"])
    quality = validate(text, level, set(keep_words))
    source_quality = validate(source_text, level, set(keep_words))
    profile = get_level_profile(level)
    return bool(
        not _fact_alignment_issues(result, source_text)
        and not quality["grammar_violations"]
        and int(quality["total_length"]) <= profile.max_total_len
        and float(quality["compliance_score"]) >= 0.68
        and float(quality["compliance_score"]) >= float(source_quality["compliance_score"]) + 0.12
        and len(quality["violations"]) <= 8
        and len(quality["sentence_over_length"]) <= 3
    )


async def _rewrite(text: str, level: str, keep_words: list[str]) -> tuple[dict, bool, str, list[str], list[str]]:
    vocab = sorted(get_cumulative_vocab(level))
    profile = get_level_profile(level)
    source_sentences = split_sentences(text) or [text.strip()]
    indexed_source_text = "\n".join(f"[{index}] {sentence}" for index, sentence in enumerate(source_sentences))
    effective_keep_words = _initial_rewrite_keep_words(text, level, keep_words)
    max_effective_keep_words = min(profile.max_target_words, len(_unique(keep_words)) + AUTO_KEEP_LIMITS[level])
    source_difficulty_limited = float(validate(text, level, set(effective_keep_words))["compliance_score"]) < 0.55
    last_error = LLMError("rewrite failed", "provider_error")
    feedback = ""
    best_result: dict | None = None
    best_issues: list[str] = []
    best_keep_words = list(effective_keep_words)
    best_score: tuple | None = None
    max_rewrite_attempts = 3 if source_difficulty_limited else 2
    for attempt in range(max_rewrite_attempts):
        try:
            if attempt > 0 and best_result is not None:
                user_prompt = rewrite_repair_prompt(
                    json.dumps(best_result, ensure_ascii=False),
                    level,
                    vocab,
                    effective_keep_words,
                    feedback,
                )
            else:
                user_prompt = rewrite_prompt(
                    indexed_source_text,
                    level,
                    vocab,
                    effective_keep_words,
                    retry=attempt > 0,
                    repair_feedback=feedback,
                    aggressive_simplification=source_difficulty_limited,
                )
            result = await complete_json(
                SYSTEM_PROMPT,
                user_prompt,
                max_completion_tokens=_rewrite_token_budget(level),
            )
            result = _normalize_rewrite_result(result, text)
            issues = _rewrite_quality_issues(result, text, level, effective_keep_words, enforce_source_limited_floor=attempt == 0)
            candidate_score = _rewrite_candidate_score(result, text, level, effective_keep_words)
            if candidate_score[0] and (best_score is None or candidate_score > best_score):
                best_result = result
                best_issues = list(issues)
                best_keep_words = list(effective_keep_words)
                best_score = candidate_score
            if issues:
                feedback = "；".join(best_issues if best_result is not None else issues)
                if attempt == 0 and len(effective_keep_words) < max_effective_keep_words:
                    rewritten_text = "".join(item["text"] for item in result["sentences"])
                    quality = validate(rewritten_text, level, set(effective_keep_words))
                    source_terms = [word for word in quality["violations"] if word in text]
                    additions = source_terms[:max_effective_keep_words - len(effective_keep_words)]
                    effective_keep_words = _unique([*effective_keep_words, *additions])
                if attempt > 0 and _rewrite_can_ship_with_review(result, text, level, effective_keep_words):
                    return result, False, "level_violation", issues, effective_keep_words
                raise LLMError("rewrite quality check failed", "level_violation")
            return result, False, "", [], effective_keep_words
        except LLMError as exc:
            last_error = exc
            if not feedback:
                feedback = "；".join(exc.details) or {
                    "empty_rewrite": "模型返回了空改写",
                    "invalid_response": "改写 JSON 缺少有效句子、来源编号或元信息",
                    "provider_error": "模型服务未在时限内返回",
                    "auth_failed": "模型认证失败",
                    "quota_exceeded": "模型账户额度不足",
                    "invalid_request": "模型名称或请求参数不兼容",
                    "not_configured": "本地未配置模型密钥",
                    "invalid_config": "模型地址或超时配置无效",
                }.get(exc.code, "改写没有通过确定性检查")
            if exc.code not in {"invalid_response", "empty_rewrite", "level_violation"}:
                break
        except Exception:
            last_error = LLMError("rewrite pipeline failed", "internal_error")
            feedback = "本地改写流程发生临时错误"
            break
    if best_result is not None:
        best_text = "".join(item["text"] for item in best_result["sentences"])
        best_quality = validate(best_text, level, set(best_keep_words))
        promotable_words = [word for word in best_quality["violations"] if word in text]
        promoted_keep_words = _unique([*best_keep_words, *promotable_words])[:profile.max_target_words]
        if _rewrite_best_candidate_can_ship(best_result, text, level, promoted_keep_words):
            promoted_issues = _rewrite_quality_issues(
                best_result,
                text,
                level,
                promoted_keep_words,
                enforce_source_limited_floor=False,
            )
            return best_result, False, "level_violation", promoted_issues or best_issues, promoted_keep_words
    return _source_preview(text), True, last_error.code, [item for item in feedback.split("；") if item], effective_keep_words


def _normalize_rewrite_result(result: dict, source_text: str) -> dict:
    if not isinstance(result, dict) or not isinstance(result.get("sentences"), list) or not result["sentences"]:
        raise LLMError("rewrite response has no sentences", "empty_rewrite")
    source_count = max(1, len(split_sentences(source_text)))
    output_count = len(result["sentences"])

    def inferred_source_ids(index: int) -> list[int]:
        if output_count <= source_count:
            start = index * source_count // output_count
            end = max(start, ((index + 1) * source_count // output_count) - 1)
            return list(range(start, min(end, source_count - 1) + 1))
        return [min(index * source_count // output_count, source_count - 1)]

    raw_source_ids: list[int] = []
    for item in result["sentences"]:
        ids = item.get("source_sentence_ids") if isinstance(item, dict) else None
        if not isinstance(ids, list):
            continue
        for value in ids:
            if isinstance(value, int) and not isinstance(value, bool):
                raw_source_ids.append(value)
            elif isinstance(value, str) and value.strip().isdigit():
                raw_source_ids.append(int(value.strip()))
    one_based_ids = bool(raw_source_ids) and 0 not in raw_source_ids and max(raw_source_ids) == source_count and all(
        1 <= value <= source_count for value in raw_source_ids
    )
    normalized = []
    for index, item in enumerate(result["sentences"]):
        if not isinstance(item, dict) or not isinstance(item.get("text"), str) or not item["text"].strip():
            raise LLMError(f"rewrite sentence {index} is missing text", "invalid_response")
        ids = item.get("source_sentence_ids")
        if not isinstance(ids, list) or not ids:
            valid_ids = inferred_source_ids(index)
            normalized.append({**item, "source_sentence_ids": valid_ids})
            continue
        valid_ids: list[int] = []
        for raw_value in ids:
            if isinstance(raw_value, int) and not isinstance(raw_value, bool):
                value = raw_value
            elif isinstance(raw_value, str) and raw_value.strip().isdigit():
                value = int(raw_value.strip())
            else:
                raise LLMError(
                    f"rewrite sentence {index} has non-numeric source ids",
                    "invalid_response",
                    [f"第 {index + 1} 个改写句的来源编号不是数字"],
                )
            if one_based_ids:
                value -= 1
            if 0 <= value < source_count:
                valid_ids.append(value)
            elif value == index and index >= source_count:
                # Models sometimes number rewritten sentences instead of reusing
                # the final source id after splitting the last source sentence.
                valid_ids.append(source_count - 1)
            else:
                raise LLMError(
                    f"rewrite sentence {index} has invalid source ids",
                    "invalid_response",
                    [f"第 {index + 1} 个改写句的来源编号超出 0–{source_count - 1}"],
                )
        valid_ids = list(dict.fromkeys(valid_ids))
        normalized.append({**item, "source_sentence_ids": valid_ids})
    deleted_info = result.get("deleted_info", "")
    teacher_notes = result.get("teacher_notes", "")
    if not isinstance(deleted_info, str) or not isinstance(teacher_notes, str):
        raise LLMError("rewrite metadata is invalid", "invalid_response")
    return {**result, "title": str(result.get("title", "分级阅读")), "sentences": normalized}


def _level_text_details(text: str, level: str, allow_words: list[str]) -> tuple[dict, list[str]]:
    quality = validate(text, level, set(allow_words))
    details: list[str] = []
    if quality["sentence_over_length"]:
        details.append(f"超长句：{text}")
    if quality["violations"]:
        details.append(f"超纲词：{'、'.join(quality['violations'])}（句子：{text}）")
    if quality["grammar_violations"]:
        details.append(f"禁用句型：{'、'.join(quality['grammar_violations'])}（句子：{text}）")
    return quality, details


def _validate_level_text(text: str, level: str, allow_words: list[str], allow_minor: bool = False) -> list[str]:
    quality, details = _level_text_details(text, level, allow_words)
    if not details:
        return []
    profile = get_level_profile(level)
    max_overflow = max(
        (readable_length(sentence) - profile.max_sentence_len for sentence in quality["sentence_over_length"]),
        default=0,
    )
    severe = bool(
        quality["grammar_violations"]
        or len(quality["violations"]) > 2
        or len(quality["sentence_over_length"]) > 1
        or max_overflow > 6
    )
    if not allow_minor or severe:
        raise LLMError("generated teaching text exceeds the level vocabulary budget", "level_violation", details)
    return details


def _placeholder_text(value: str) -> bool:
    lowered = value.lower()
    return "我想了解" in value or "key topic word" in lowered or "placeholder" in lowered or value.strip() in {"...", "…"}


def _example_signature(example: str, target_word: str) -> str:
    without_target = example.replace(target_word, "<目标词>")
    return "".join(character for character in without_target if character.isalnum() or character == "<" or character == ">")


def _validate_vocab_result(result: dict, level: str = "", target_words: list[str] | None = None) -> list[dict]:
    vocab = result.get("vocab") if isinstance(result, dict) else None
    if not isinstance(vocab, list):
        raise LLMError("vocab response must contain a list", "invalid_response")
    normalized = []
    seen_examples: set[str] = set()
    seen_signatures: set[str] = set()
    seen_words: set[str] = set()
    target_words = target_words or []
    for item in vocab:
        if not isinstance(item, dict) or not isinstance(item.get("word"), str) or not item["word"].strip():
            raise LLMError("vocab item is missing word", "invalid_response")
        fields = {key: item.get(key, "") for key in ("word", "pos", "meaning", "example", "pitfall", "sino_viet")}
        if not fields["pos"] or not fields["meaning"] or not fields["example"]:
            raise LLMError("vocab item is missing part of speech, meaning, or example", "invalid_response")
        if target_words and fields["word"] not in target_words:
            raise LLMError("vocab response contains an unrequested word", "invalid_response")
        if fields["word"] in seen_words:
            raise LLMError("vocab response contains a duplicate word", "invalid_response")
        seen_words.add(str(fields["word"]))
        example = str(fields["example"]).strip()
        meaning = str(fields["meaning"]).strip()
        if _placeholder_text(example) or _placeholder_text(meaning):
            raise LLMError("vocab response contains placeholder content", "invalid_response")
        if example in seen_examples:
            raise LLMError("vocab examples must not repeat", "invalid_response")
        seen_examples.add(example)
        signature = _example_signature(example, str(fields["word"]))
        if signature in seen_signatures:
            raise LLMError("vocab examples reuse the same sentence template", "invalid_response")
        seen_signatures.add(signature)
        if level:
            # Keep lexical mismatches visible as warnings; accuracy, coverage,
            # non-empty meanings and non-template examples remain hard checks.
            _level_text_details(example, level, [str(fields["word"]), *target_words])
        normalized.append({key: str(value) for key, value in fields.items()})
    if set(target_words) != seen_words:
        raise LLMError("vocab response did not cover every target word", "invalid_response")
    return normalized


def _validate_questions_result(result: dict, level: str = "", target_words: list[str] | None = None) -> list[dict]:
    questions = result.get("questions") if isinstance(result, dict) else None
    if not isinstance(questions, list) or len(questions) != 3:
        raise LLMError("questions response must contain exactly three items", "invalid_response")
    expected = get_level_profile(level).question_types if level else ("fact", "inference", "discussion")
    objective_types = {"fact", "choice", "sequence", "inference"}
    normalized = []
    for index, item in enumerate(questions):
        if not isinstance(item, dict) or item.get("type") != expected[index] or not isinstance(item.get("q"), str) or not item["q"].strip():
            raise LLMError(f"invalid {expected[index]} question", "invalid_response")
        question_sentences = split_sentences(str(item["q"]))
        if not question_sentences:
            raise LLMError(f"invalid {expected[index]} question text", "invalid_response")
        question_text = next(
            (sentence for sentence in question_sentences if "？" in sentence or "?" in sentence),
            question_sentences[0],
        )
        options = item.get("options", [])
        if not isinstance(options, list):
            raise LLMError(f"invalid {expected[index]} options", "invalid_response")
        if expected[index] in objective_types and len(options) < 3:
            raise LLMError(f"invalid {expected[index]} options", "invalid_response")
        if expected[index] not in objective_types and options:
            raise LLMError(f"{expected[index]} must be an open response", "invalid_response")
        answer = item.get("answer", "")
        if expected[index] in objective_types and (not isinstance(answer, str) or not answer.strip()):
            raise LLMError(f"invalid {expected[index]} answer", "invalid_response")
        follow_up = item.get("follow_up", "")
        if not isinstance(follow_up, str):
            raise LLMError(f"invalid {expected[index]} follow-up", "invalid_response")
        if expected[index] in {"fact", "choice", "sequence"}:
            follow_up = ""
        elif level == "HSK1" and expected[index] == "repeat":
            follow_up = "请说。"
        elif expected[index] == "inference":
            follow_up = "为什么？"
        elif level == "HSK4" and expected[index] == "discussion":
            follow_up = "请说文章内容，再说你的看法。"
        if level:
            # Question type, option count, and answer structure remain hard
            # requirements. Lexical level is report-only because the legacy
            # word list has known gaps; warnings are attached to the response.
            _level_text_details(question_text, level, target_words or [])
            for option in options:
                _level_text_details(str(option), level, target_words or [])
            if follow_up:
                _level_text_details(follow_up, level, target_words or [])
        normalized.append({**item, "q": question_text, "options": [str(option) for option in options], "answer": str(answer), "follow_up": follow_up, "skill": str(item.get("skill", expected[index]))})
    return normalized


def _lesson_plan_error(message: str, detail: str) -> None:
    raise LLMError(message, "invalid_response", [detail])


def _validate_observable_objective(value: object, field: str) -> str:
    text = str(value).strip() if isinstance(value, str) else ""
    if not text:
        _lesson_plan_error(f"{field} is missing", f"{field}：缺少可观察目标")
    for prefix in LESSON_OBJECTIVE_PREFIXES:
        if text.startswith(prefix):
            text = text[len(prefix):].lstrip("，,:： ")
            break
    forbidden = next((term for term in LESSON_PLAN_SPEAK if term in text), "")
    if forbidden:
        _lesson_plan_error(
            f"{field} must be an observable action without lesson-plan narration",
            f"{field}：不要写“{forbidden}”等教案说明，直接写可观察动作",
        )
    has_action = any(action in text for action in LESSON_OBSERVABLE_ACTIONS)
    vague_only = text.startswith(LESSON_VAGUE_OBJECTIVE_PREFIXES) and not has_action
    if vague_only:
        text = _normalize_vague_objective(text, field)
        has_action = True
    if not has_action:
        _lesson_plan_error(
            f"{field} must use an observable action",
            f"{field}：“{text}”不是可观察动作，请改为找出、说出、复述、比较或写出等任务",
        )
    return text


def _normalize_vague_objective(text: str, field: str) -> str:
    """Convert low-risk pedagogical phrasing into a visible learner action.

    This intentionally does not attempt open-ended rewriting. It maps only
    common vague objectives to conservative tasks that remain grounded in the
    supplied reading. Structural errors and teacher narration still fail.
    """
    if any(term in text for term in ("词", "词汇", "生词", "句型")):
        return "说出关键词的意思并用关键词造句"
    if any(term in text for term in ("顺序", "过程", "经过")):
        return "按顺序复述文章内容"
    if "原因" in text:
        return "找出文中的原因并说出来"
    if any(term in text for term in ("人物", "时间", "地点")):
        return "找出文中的人物、时间和地点"
    if any(term in text for term in ("合作", "交流", "表达")):
        return "与同伴完成一次对话"
    if field.startswith("stages[1]"):
        return "说出与文章主题有关的一条信息"
    if field.startswith("stages[3]"):
        return "说出关键词的意思并用关键词造句"
    if field.startswith("stages[4]"):
        return "用文章信息完成问答"
    if field.startswith("stages[5]"):
        return "用两句话总结文章内容"
    return "找出文章中的关键信息并说出来"


def _validate_student_instruction(value: object, field: str) -> str:
    text = str(value).strip() if isinstance(value, str) else ""
    if not text:
        _lesson_plan_error(f"{field} is missing", f"{field}：缺少直接对学生说的指令")
    forbidden = next((term for term in LESSON_PLAN_SPEAK if term in text), "")
    if forbidden or text.startswith("课后作业"):
        marker = forbidden or "课后作业"
        _lesson_plan_error(
            f"{field} must not contain lesson-plan narration",
            f"{field}：不要写“{marker}”等教案或教师动作说明",
        )
    if "？" not in text and "?" not in text and not any(action in text for action in LESSON_DIRECT_ACTIONS):
        _lesson_plan_error(
            f"{field} must be a direct student instruction or question",
            f"{field}：“{text}”不是学生能立刻执行的指令或问题",
        )
    return text


def _validate_lesson_plan(result: dict, level: str = "", target_words: list[str] | None = None) -> dict:
    if isinstance(result, dict) and isinstance(result.get("lesson_plan"), dict):
        result = result["lesson_plan"]
    if not isinstance(result, dict) or not isinstance(result.get("stages"), list) or len(result["stages"]) != 5:
        raise LLMError("lesson plan must contain exactly five stages", "invalid_response")
    level_task = str(result.get("level_task", "")).strip()
    if level:
        valid_tasks = get_level_profile(level).task_focus
        if level_task not in valid_tasks:
            level_task = valid_tasks[0]
    raw_objectives = result.get("objectives")
    if not isinstance(raw_objectives, list) or not 2 <= len(raw_objectives) <= 4:
        _lesson_plan_error("lesson objectives must contain two to four items", "objectives：必须包含 2-4 条可观察目标")
    objectives = [
        _validate_observable_objective(value, f"objectives[{index}]")
        for index, value in enumerate(raw_objectives, start=1)
    ]

    stages = []
    expected_start = 0
    for stage_index, item in enumerate(result["stages"]):
        if not isinstance(item, dict):
            raise LLMError("lesson stage is invalid", "invalid_response")
        duration = LESSON_STAGE_DURATIONS[stage_index]
        start = expected_start
        end = start + duration
        expected_start = end
        title = LESSON_STAGE_TITLES[stage_index]
        objective = _validate_observable_objective(
            item.get("objective", item.get("goal", "")),
            f"stages[{stage_index + 1}].objective",
        )
        expected_output = item.get("expected_output", "")
        for value in (title, objective, expected_output):
            if not isinstance(value, str) or not value.strip():
                raise LLMError("lesson stage text is missing", "invalid_response")
        lists: dict[str, list[str]] = {}
        for key in ("teacher_actions", "student_actions", "prompts"):
            value = item.get(key)
            if isinstance(value, str):
                value = [value]
            if not isinstance(value, list):
                raise LLMError("lesson stage list field is invalid", "invalid_response")
            lists[key] = [str(entry).strip() for entry in value if str(entry).strip()]
            if not lists[key]:
                raise LLMError("lesson stage list field is empty", "invalid_response")
        lists["prompts"] = [
            _validate_student_instruction(value, f"stages[{stage_index + 1}].prompts[{prompt_index}]")
            for prompt_index, value in enumerate(lists["prompts"], start=1)
        ]
        lists["materials"] = list(LESSON_STAGE_MATERIALS[stage_index])
        if level:
            # Only prompts are literal learner-facing Chinese. The other
            # fields are teacher-facing descriptions and may use pedagogy terms.
            # Legacy-list gaps are reported after normalization instead of
            # discarding an otherwise complete 30-minute plan.
            for value in lists["prompts"]:
                _level_text_details(value, level, target_words or [])
        stages.append({
            "title": str(title), "start_minute": start, "end_minute": end, "duration": end - start,
            "objective": str(objective), "teacher_actions": lists["teacher_actions"],
            "student_actions": lists["student_actions"], "materials": lists["materials"],
            "prompts": lists["prompts"], "expected_output": str(expected_output),
        })
    if expected_start != 30:
        raise LLMError("lesson plan must total exactly 30 minutes", "invalid_response")
    homework = _validate_student_instruction(result.get("homework", ""), "homework")
    return {
        "title": str(result.get("title", "30分钟阅读课")),
        "total_minutes": 30,
        "level_task": level_task,
        "objectives": objectives,
        "stages": stages,
        "homework": homework,
        "available": True,
    }


async def _validate_component(
    name: str,
    result: object,
    validator: Callable[..., Any],
    level: str,
    target_words: list[str],
    retry_prompt: str,
) -> Any:
    if isinstance(result, Exception):
        raise result
    try:
        return validator(result, level, target_words)
    except LLMError as exc:
        # Provider-level retry already happens in llm.complete_json. This one
        # repair is for structurally or pedagogically invalid component data.
        if exc.code not in {"invalid_response", "level_violation"}:
            raise
        repair_feedback = str(exc).strip() or exc.code
        try:
            repaired = await complete_json(
                SYSTEM_PROMPT,
                f"{retry_prompt}\n上一次具体错误：{repair_feedback}。只修复这个错误。",
                max_completion_tokens=_component_token_budget(name, level),
            )
        except LLMError:
            # Preserve the original deterministic diagnosis. A repair timeout
            # must not be misreported as if the first provider call failed.
            raise exc
        return validator(repaired, level, target_words)


def _select_target_words(rewritten_text: str, level: str, keep_words: list[str]) -> list[str]:
    profile = get_level_profile(level)
    details = extract_teaching_word_details(rewritten_text, level, top_n=profile.max_target_words * 4)
    # Known compositional phrases such as 回家/家人 are useful analysis hints,
    # but should not automatically become vocabulary cards unless selected.
    teachable = [item for item in details if item.get("status") != "known_composite"]
    ranked = sorted(
        teachable,
        key=lambda item: ({"above_level": 0, "known": 1}.get(str(item.get("status")), 2), -int(item.get("frequency", 0))),
    )
    return _unique([*keep_words, *(str(item["word"]) for item in ranked)])[:profile.max_target_words]


def _component_contract(name: str, rewritten_text: str, level: str, native_lang: str, target_words: list[str]) -> tuple[str, str, Callable[..., Any]]:
    if name == "vocab":
        return (
            vocab_prompt(rewritten_text, target_words, level, native_lang),
            vocab_prompt(rewritten_text, target_words, level, native_lang, retry=True),
            _validate_vocab_result,
        )
    if name == "questions":
        return (
            questions_prompt(rewritten_text, level, target_words),
            questions_prompt(rewritten_text, level, target_words, retry=True),
            _validate_questions_result,
        )
    if name == "lesson_plan":
        return (
            lesson_plan_prompt(rewritten_text, level, native_lang, target_words),
            lesson_plan_prompt(rewritten_text, level, native_lang, target_words, retry=True),
            _validate_lesson_plan,
        )
    raise ValueError(f"Unsupported generation component: {name}")


def _component_level_warnings(name: str, value: Any, level: str, target_words: list[str]) -> list[str]:
    texts: list[tuple[str, str, list[str]]] = []
    if name == "vocab":
        for item in value:
            texts.append((f"{item['word']}例句", str(item["example"]), [str(item["word"]), *target_words]))
    elif name == "questions":
        for index, item in enumerate(value, start=1):
            texts.append((f"第{index}题", str(item["q"]), target_words))
            texts.extend((f"第{index}题选项", str(option), target_words) for option in item.get("options", []))
            if item.get("follow_up"):
                texts.append((f"第{index}题追问", str(item["follow_up"]), target_words))
    elif name == "lesson_plan":
        for stage in value.get("stages", []):
            texts.extend((f"{stage['title']}课堂用语", str(prompt), target_words) for prompt in stage.get("prompts", []))
    warnings: list[str] = []
    for label, text, allowed in texts:
        _, details = _level_text_details(text, level, allowed)
        warnings.extend(f"{label}：{detail}" for detail in details)
    return _unique(warnings)[:12]


def _safe_error_code(exc: Exception) -> str:
    return exc.code if isinstance(exc, LLMError) else "provider_error"


def _extract_vocab_item(result: dict) -> dict:
    if isinstance(result.get("vocab"), list) and result["vocab"]:
        result = result["vocab"][0]
    elif isinstance(result.get("item"), dict):
        result = result["item"]
    if not isinstance(result, dict):
        raise LLMError("vocab item response is invalid", "invalid_response")
    return result


async def _generate_vocab_result(rewritten_text: str, level: str, native_lang: str, target_words: list[str]) -> dict:
    items: list[dict] = []
    for word in target_words:
        last_error = LLMError("vocab item failed", "invalid_response")
        for attempt in range(2):
            try:
                raw = await complete_json(
                    SYSTEM_PROMPT,
                    vocab_item_prompt(rewritten_text, word, level, native_lang, retry=attempt > 0),
                    max_completion_tokens=650,
                )
                item = _extract_vocab_item(raw)
                item["word"] = word
                normalized = _validate_vocab_result({"vocab": [item]}, level, [word])
                items.append(normalized[0])
                break
            except LLMError as exc:
                last_error = exc
                if exc.code not in {"invalid_response", "level_violation"}:
                    raise
        else:
            raise last_error
    return {"vocab": items}


def _extract_question_item(result: dict, expected_type: str) -> dict:
    if isinstance(result.get("questions"), list) and result["questions"]:
        result = result["questions"][0]
    elif isinstance(result.get("question"), dict):
        result = result["question"]
    if not isinstance(result, dict) or not isinstance(result.get("q"), str) or not result["q"].strip():
        raise LLMError("question item response is invalid", "invalid_response")
    item = dict(result)
    item["type"] = expected_type
    item["skill"] = expected_type
    options = item.get("options", [])
    item["options"] = options if isinstance(options, list) else []
    if expected_type not in {"fact", "choice", "sequence", "inference"}:
        item["options"] = []
    if expected_type in {"fact", "choice", "sequence", "inference"} and (
        len(item["options"]) < 3 or not str(item.get("answer", "")).strip()
    ):
        raise LLMError("objective question is incomplete", "invalid_response")
    return item


async def _generate_questions_result(rewritten_text: str, level: str, target_words: list[str]) -> dict:
    items: list[dict] = []
    for question_type in get_level_profile(level).question_types:
        last_error = LLMError("question item failed", "invalid_response")
        for attempt in range(2):
            try:
                raw = await complete_json(
                    SYSTEM_PROMPT,
                    question_item_prompt(rewritten_text, level, question_type, target_words, retry=attempt > 0),
                    max_completion_tokens=650,
                )
                items.append(_extract_question_item(raw, question_type))
                break
            except LLMError as exc:
                last_error = exc
                if exc.code not in {"invalid_response", "level_violation"}:
                    raise
        else:
            raise last_error
    return {"questions": items}


async def generate_component(name: str, rewritten_text: str, level: str, native_lang: str, target_words: list[str]) -> dict:
    profile = get_level_profile(level)
    accepted_words = _unique(target_words)[:profile.max_target_words]
    prompt, retry_prompt, validator = _component_contract(name, rewritten_text, level, native_lang, accepted_words)
    try:
        if name == "vocab":
            result = await _generate_vocab_result(rewritten_text, level, native_lang, accepted_words)
        elif name == "questions":
            result = await _generate_questions_result(rewritten_text, level, accepted_words)
        else:
            result = await complete_json(
                SYSTEM_PROMPT,
                prompt,
                max_completion_tokens=_component_token_budget(name, level),
            )
        value = await _validate_component(name, result, validator, level, accepted_words, retry_prompt)
        warnings = _component_level_warnings(name, value, level, accepted_words)
        return {"component": name, "status": "ai", "code": "ok", "warnings": warnings, "data": value}
    except Exception as exc:
        return {"component": name, "status": "unavailable", "code": _safe_error_code(exc), "details": getattr(exc, "details", []), "warnings": [], "data": None}


async def generate_rewrite_package(text: str, level: str, native_lang: str, keep_words: list[str]) -> dict:
    profile = get_level_profile(level)
    accepted_keep_words = _unique(keep_words)[:profile.max_target_words]
    rewritten, rewrite_fallback, rewrite_code, rewrite_issues, effective_keep_words = await _rewrite(text, level, accepted_keep_words)
    auto_keep_words = [word for word in effective_keep_words if word not in accepted_keep_words]
    accepted_keep_words = effective_keep_words
    rewritten_text = "".join(item["text"] for item in rewritten.get("sentences", []))
    target_words = accepted_keep_words if rewrite_fallback else _select_target_words(rewritten_text, level, accepted_keep_words)
    generation_components = {
        "rewrite": "unavailable" if rewrite_fallback else "ai", "vocab": "unavailable",
        "questions": "unavailable", "lesson_plan": "unavailable",
    }
    fallback_codes: dict[str, str] = {}
    fallback_details: dict[str, list[str]] = {}
    generation_warnings: dict[str, list[str]] = {}
    if rewrite_fallback:
        fallback_codes["rewrite"] = rewrite_code
        fallback_details["rewrite"] = rewrite_issues
    elif rewrite_issues:
        generation_warnings["rewrite"] = rewrite_issues
    quality = validate(rewritten_text, level, set(accepted_keep_words))
    source_limited = quality["total_length_status"] == "below_target" and readable_length(text) < profile.min_total_len
    source_difficulty_limited = float(validate(text, level, set(accepted_keep_words))["compliance_score"]) < 0.55
    has_quality_issues = bool(quality["violations"] or quality["sentence_over_length"] or quality["grammar_violations"])
    quality["details"] = {
        "has_violations": bool(quality["violations"]),
        "has_overlength_sentences": bool(quality["sentence_over_length"]),
        "has_forbidden_grammar": bool(quality["grammar_violations"]),
        "status": "unavailable" if rewrite_fallback else ("needs_review" if has_quality_issues else "ok"),
        "source_limited": source_limited,
        "short_text_target": (
            [readable_length(text), max(readable_length(text), int(readable_length(text) * 1.5))]
            if source_limited else None
        ),
        "source_difficulty_limited": source_difficulty_limited,
        "out_of_level_count": len(quality["violations"]),
        "level_profile": profile.to_dict(),
    }
    if len(fallback_codes) == 1 and "rewrite" in fallback_codes:
        fallback_code = fallback_codes["rewrite"]
    elif fallback_codes:
        fallback_code = ",".join(f"{key}:{value}" for key, value in fallback_codes.items())
    else:
        fallback_code = ""
    mode = "demo" if rewrite_fallback else "partial"
    return {
        "rewritten": rewritten,
        "pinyin": get_pinyin(rewritten_text),
        "pinyin_sentences": [get_pinyin(item["text"]) for item in rewritten.get("sentences", [])],
        "vocab": [],
        "questions": [],
        "lesson_plan": _empty_lesson_plan(),
        "quality": quality,
        "meta": {
            "demo_mode": mode == "demo",
            "generation_mode": mode,
            "generation_components": generation_components,
            "target_words": target_words,
            "ignored_keep_words": _unique(keep_words)[profile.max_target_words:],
            "auto_keep_words": auto_keep_words,
            "level": level,
            "native_lang": native_lang,
            "level_profile": profile.to_dict(),
            "level_comparison": quality["level_comparison"],
            "fallback_code": fallback_code,
            "fallback_codes": fallback_codes,
            "fallback_details": fallback_details,
            "generation_warnings": generation_warnings,
        },
    }


async def generate_package(text: str, level: str, native_lang: str, keep_words: list[str]) -> dict:
    package = await generate_rewrite_package(text, level, native_lang, keep_words)
    components = package["meta"]["generation_components"]
    if components["rewrite"] != "ai":
        return package

    rewritten_text = "".join(item["text"] for item in package["rewritten"]["sentences"])
    target_words = package["meta"]["target_words"]
    component_names = ("vocab", "questions", "lesson_plan")
    contracts_by_name = {
        name: _component_contract(name, rewritten_text, level, native_lang, target_words)
        for name in component_names
    }
    fallback_codes = dict(package["meta"].get("fallback_codes", {}))
    fallback_details = dict(package["meta"].get("fallback_details", {}))
    generation_warnings = dict(package["meta"].get("generation_warnings", {}))

    async def apply_component(name: str, result: object) -> None:
        _, retry_prompt, validator = contracts_by_name[name]
        try:
            value = await _validate_component(name, result, validator, level, target_words, retry_prompt)
            if name == "vocab":
                package["vocab"] = value
            elif name == "questions":
                package["questions"] = value
            else:
                package["lesson_plan"] = value
            components[name] = "ai"
            fallback_codes.pop(name, None)
            fallback_details.pop(name, None)
            warnings = _component_level_warnings(name, value, level, target_words)
            if warnings:
                generation_warnings[name] = warnings
            else:
                generation_warnings.pop(name, None)
        except Exception as exc:
            components[name] = "unavailable"
            fallback_codes[name] = _safe_error_code(exc)
            details = getattr(exc, "details", [])
            if details:
                fallback_details[name] = details

    # The lesson is the primary teacher-facing output. Give both its first
    # attempt and possible repair an uncontended provider slot before extras.
    lesson_contract = contracts_by_name["lesson_plan"]
    try:
        lesson_result: object = await complete_json(
            SYSTEM_PROMPT,
            lesson_contract[0],
            max_completion_tokens=_component_token_budget("lesson_plan", level),
        )
    except Exception as exc:
        lesson_result = exc
    await apply_component("lesson_plan", lesson_result)

    remaining_names = ("vocab", "questions")
    remaining_results = await asyncio.gather(
        *(
            complete_json(
                SYSTEM_PROMPT,
                contracts_by_name[name][0],
                max_completion_tokens=_component_token_budget(name, level),
            )
            for name in remaining_names
        ),
        return_exceptions=True,
    )
    for name, result in zip(remaining_names, remaining_results):
        await apply_component(name, result)

    mode = "partial" if fallback_codes else "ai"
    package["meta"].update({
        "generation_mode": mode,
        "demo_mode": False,
        "fallback_codes": fallback_codes,
        "fallback_details": fallback_details,
        "generation_warnings": generation_warnings,
        "fallback_code": ",".join(f"{key}:{value}" for key, value in fallback_codes.items()),
    })
    return package
