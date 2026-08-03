import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).parents[1]))

from config import LEVEL_ORDER, get_level_profile  # noqa: E402
from llm import LLMError, complete_json  # noqa: E402
from prompts import lesson_plan_prompt  # noqa: E402
from services import (  # noqa: E402
    _initial_rewrite_keep_words,
    _normalize_rewrite_result,
    _rewrite_quality_issues,
    _select_target_words,
    _validate_lesson_plan,
    _validate_questions_result,
    _validate_vocab_result,
    generate_component,
)


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def json(self):
        return self.payload


def response_with_content(content: str) -> FakeResponse:
    return FakeResponse({"choices": [{"message": {"content": content}}]})


def observable_lesson_plan() -> dict:
    return {
        "title": "春节回家阅读课",
        "level_task": "说明原因",
        "objectives": ["找出文章的人物和时间", "用三句话复述文章"],
        "stages": [
            {
                "objective": f"说出第{index}阶段的一个关键信息",
                "teacher_actions": ["展示文章并提问"],
                "student_actions": ["阅读并回答"],
                "prompts": ["请找出一个关键信息。"],
                "expected_output": "一条基于文章的回答",
            }
            for index in range(1, 6)
        ],
        "homework": "请用三句话写小林为什么回家。",
    }


class GenerationValidationTests(unittest.TestCase):
    def test_lesson_plan_prompt_separates_teacher_notes_from_student_language(self):
        prompt = lesson_plan_prompt("小林春节回家。", "HSK2", "English", ["春节"])

        self.assertIn("简短、可观察的动作短语", prompt)
        self.assertIn("不要只写“理解、掌握、了解”", prompt)
        self.assertIn("prompts 是课堂上直接展示或直接对学生说的话", prompt)
        self.assertIn("不得描述教师应该怎么做", prompt)
        self.assertIn("homework 必须是一条直接对学生说的完整任务指令", prompt)
        self.assertIn('"objectives":["..."]', prompt)
        self.assertIn('"homework":"..."', prompt)

    def test_lesson_plan_accepts_observable_goals_and_direct_student_language(self):
        result = _validate_lesson_plan(observable_lesson_plan(), "HSK2", ["春节"])

        self.assertTrue(result["available"])
        self.assertEqual(result["total_minutes"], 30)
        self.assertEqual([stage["start_minute"] for stage in result["stages"]], [0, 4, 12, 19, 27])

    def test_lesson_plan_rejects_vague_goals_and_lesson_plan_language(self):
        invalid_cases = []

        vague_objective = observable_lesson_plan()
        vague_objective["objectives"][0] = "理解文章"
        invalid_cases.append((vague_objective, "objectives[1]"))

        vague_stage = observable_lesson_plan()
        vague_stage["stages"][2]["objective"] = "掌握重点词汇"
        invalid_cases.append((vague_stage, "stages[3].objective"))

        narrated_prompt = observable_lesson_plan()
        narrated_prompt["stages"][1]["prompts"] = ["教师引导学生回答问题。"]
        invalid_cases.append((narrated_prompt, "stages[2].prompts[1]"))

        narrated_homework = observable_lesson_plan()
        narrated_homework["homework"] = "课后作业：学生完成三句话。"
        invalid_cases.append((narrated_homework, "homework"))

        indirect_prompt = observable_lesson_plan()
        indirect_prompt["stages"][4]["prompts"] = ["课堂小结"]
        invalid_cases.append((indirect_prompt, "stages[5].prompts[1]"))

        for payload, expected_field in invalid_cases:
            with self.subTest(field=expected_field):
                with self.assertRaises(LLMError) as raised:
                    _validate_lesson_plan(payload, "HSK2", ["春节"])
                self.assertEqual(raised.exception.code, "invalid_response")
                self.assertIn(expected_field, str(raised.exception))
                self.assertTrue(raised.exception.details)

    def test_lesson_plan_validation_failure_is_repaired_once(self):
        invalid = observable_lesson_plan()
        invalid["objectives"][0] = "理解文章"
        mocked = AsyncMock(side_effect=[invalid, observable_lesson_plan()])

        with patch("services.complete_json", mocked):
            result = asyncio.run(generate_component("lesson_plan", "小林春节回家。", "HSK2", "English", ["春节"]))

        self.assertEqual(mocked.await_count, 2)
        self.assertEqual(result["status"], "ai")
        self.assertTrue(result["data"]["available"])
        self.assertIn("objectives[1] must use an observable action", mocked.await_args_list[1].args[1])

    def test_lesson_plan_stays_unavailable_when_repair_is_still_invalid(self):
        invalid = observable_lesson_plan()
        invalid["stages"][0]["prompts"] = ["教师提问，学生回答。"]
        mocked = AsyncMock(side_effect=[invalid, invalid])

        with patch("services.complete_json", mocked):
            result = asyncio.run(generate_component("lesson_plan", "小林春节回家。", "HSK2", "English", ["春节"]))

        self.assertEqual(mocked.await_count, 2)
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["code"], "invalid_response")
        self.assertIsNone(result["data"])
        self.assertTrue(result["details"])

    def test_each_level_requires_its_own_question_types(self):
        objective = {"fact", "choice", "sequence", "inference"}
        with patch("services._validate_level_text"):
            for level in LEVEL_ORDER:
                expected = get_level_profile(level).question_types
                payload = {"questions": [
                    {
                        "type": kind,
                        "q": f"{kind}?",
                        "options": ["A", "B", "C"] if kind in objective else [],
                        "answer": "A" if kind in objective else "",
                        "follow_up": (
                            "请说。" if level == "HSK1" and kind == "repeat"
                            else "为什么？" if kind == "inference"
                            else "请说文章内容，再说你的看法。" if level == "HSK4" and kind == "discussion"
                            else "回答两句" if kind not in objective else ""
                        ),
                    }
                    for kind in expected
                ]}
                normalized = _validate_questions_result(payload, level, [])
                self.assertEqual([item["type"] for item in normalized], list(expected))

                wrong = {"questions": [{**item, "type": "discussion"} for item in payload["questions"]]}
                with self.assertRaises(LLMError):
                    _validate_questions_result(wrong, level, [])

    def test_question_metadata_is_normalized_without_changing_types(self):
        payload = {"questions": [
            {"type": "fact", "q": "谁回家？", "options": ["小林", "老师", "学生"], "answer": "小林", "follow_up": "多余追问"},
            {"type": "inference", "q": "他为什么回家？", "options": ["春节", "工作", "上课"], "answer": "春节", "follow_up": "任意文字"},
            {"type": "discussion", "q": "你春节回家吗？请说四句。", "options": [], "answer": "", "follow_up": "任意文字"},
        ]}
        with patch("services._validate_level_text"):
            result = _validate_questions_result(payload, "HSK4", ["春节"])
        self.assertEqual(result[0]["follow_up"], "")
        self.assertEqual(result[1]["follow_up"], "为什么？")
        self.assertEqual(result[2]["q"], "你春节回家吗？")
        self.assertEqual(result[2]["follow_up"], "请说文章内容，再说你的看法。")

    def test_rewrite_rejects_overlength_unknown_words_and_forbidden_grammar(self):
        source = "因为学校今天不上课，所以我在家学习区块链技术。"
        result = {
            "title": "学习",
            "sentences": [{"text": source, "source_sentence_ids": [0]}],
            "deleted_info": "无",
            "teacher_notes": "",
        }
        issues = _rewrite_quality_issues(result, source, "HSK1", [])
        self.assertTrue(any("超过 8 字" in issue for issue in issues))
        self.assertTrue(any("超纲词" in issue for issue in issues))
        self.assertTrue(any("禁用句型" in issue for issue in issues))

    def test_rewrite_requires_valid_source_sentence_ids(self):
        with self.assertRaises(LLMError) as raised:
            _normalize_rewrite_result(
                {"sentences": [{"text": "我回家。", "source_sentence_ids": [99]}]},
                "我回家。",
            )
        self.assertEqual(raised.exception.code, "invalid_response")

    def test_rewrite_normalizes_common_source_id_numbering_errors(self):
        result = _normalize_rewrite_result(
            {
                "sentences": [
                    {"text": "第一句。", "source_sentence_ids": [0]},
                    {"text": "第二句。", "source_sentence_ids": [1]},
                    {"text": "第三句。", "source_sentence_ids": [2]},
                    {"text": "第三句的补充。", "source_sentence_ids": [3]},
                ]
            },
            "原文一。原文二。原文三。",
        )
        self.assertEqual(result["sentences"][3]["source_sentence_ids"], [2])

        one_based = _normalize_rewrite_result(
            {
                "sentences": [
                    {"text": "第一句。", "source_sentence_ids": [1]},
                    {"text": "第二句。", "source_sentence_ids": [2]},
                ]
            },
            "原文一。原文二。",
        )
        self.assertEqual([item["source_sentence_ids"] for item in one_based["sentences"]], [[0], [1]])

        missing_ids = _normalize_rewrite_result(
            {
                "sentences": [
                    {"text": "第一句。"},
                    {"text": "第一句的补充。"},
                    {"text": "第二句。"},
                    {"text": "第二句的补充。"},
                    {"text": "第三句。"},
                ]
            },
            "原文一。原文二。原文三。",
        )
        self.assertEqual(
            [item["source_sentence_ids"] for item in missing_ids["sentences"]],
            [[0], [0], [1], [1], [2]],
        )

    def test_vocab_must_cover_targets_and_reject_reused_templates(self):
        missing = {"vocab": [{"word": "春节", "pos": "名词", "meaning": "festival", "example": "春节我回家。"}]}
        with patch("services._validate_level_text"):
            with self.assertRaises(LLMError):
                _validate_vocab_result(missing, "HSK2", ["春节", "家乡"])

            repeated = {"vocab": [
                {"word": "春节", "pos": "名词", "meaning": "festival", "example": "我喜欢春节。"},
                {"word": "家乡", "pos": "名词", "meaning": "hometown", "example": "我喜欢家乡。"},
            ]}
            with self.assertRaises(LLMError):
                _validate_vocab_result(repeated, "HSK2", ["春节", "家乡"])

    def test_known_composites_are_not_automatic_vocab_cards(self):
        words = _select_target_words("小林春节回家看家人。", "HSK2", ["春节"])
        self.assertIn("春节", words)
        self.assertNotIn("回家", words)
        self.assertNotIn("家人", words)

    def test_higher_level_can_select_more_teaching_expressions(self):
        text = "春节到了，小林安排回家。他喜欢家乡，也开始准备假期活动。"
        hsk1 = _select_target_words(text, "HSK1", ["春节"])
        hsk4 = _select_target_words(text, "HSK4", ["春节"])
        self.assertLessEqual(len(hsk1), get_level_profile("HSK1").max_target_words)
        self.assertLessEqual(len(hsk4), get_level_profile("HSK4").max_target_words)
        self.assertGreater(len(hsk4), len(hsk1))

    def test_automatic_rewrite_words_respect_level_limit(self):
        words = _initial_rewrite_keep_words("春节时，小林从外地回到家乡。", "HSK1", ["春节"])
        self.assertLessEqual(len(words), get_level_profile("HSK1").max_target_words)
        self.assertEqual(words[0], "春节")

    def test_component_failure_returns_only_safe_status(self):
        with patch("services.complete_json", AsyncMock(side_effect=LLMError("secret upstream detail", "auth_failed"))):
            result = asyncio.run(generate_component("questions", "小林回家。", "HSK2", "English", []))
        self.assertEqual(result, {"component": "questions", "status": "unavailable", "code": "auth_failed", "details": [], "warnings": [], "data": None})


class LlmRetryTests(unittest.TestCase):
    def test_empty_json_content_is_not_retried_with_same_prompt(self):
        mocked_post = AsyncMock(return_value=response_with_content(""))
        with (
            patch("llm._setting", side_effect=lambda name, default="": "fake-key" if name == "LLM_API_KEY" else default),
            patch("llm._validated_base_url", return_value="https://example.test/v1"),
            patch("llm._post_completion", mocked_post),
        ):
            with self.assertRaises(LLMError) as raised:
                asyncio.run(complete_json("system", "user"))
        self.assertEqual(raised.exception.code, "invalid_response")
        self.assertEqual(mocked_post.await_count, 1)

    def test_auth_failure_is_not_retried(self):
        mocked_post = AsyncMock(side_effect=LLMError("denied", "auth_failed"))
        with (
            patch("llm._setting", side_effect=lambda name, default="": "fake-key" if name == "LLM_API_KEY" else default),
            patch("llm._validated_base_url", return_value="https://example.test/v1"),
            patch("llm._post_completion", mocked_post),
        ):
            with self.assertRaises(LLMError) as raised:
                asyncio.run(complete_json("system", "user"))
        self.assertEqual(raised.exception.code, "auth_failed")
        self.assertEqual(mocked_post.await_count, 1)


if __name__ == "__main__":
    unittest.main()
