import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).parents[1]))

from llm import LLMError  # noqa: E402
from services import generate_component, generate_package, generate_rewrite_package  # noqa: E402


def valid_rewrite():
    return {
        "title": "回家过年",
        "sentences": [{"text": "小林春节回家。", "source_sentence_ids": [0]}],
        "deleted_info": "无",
        "teacher_notes": "",
    }


def valid_vocab():
    return {"vocab": [{"word": "春节", "pos": "名词", "meaning": "Spring Festival", "example": "春节，我和家人回家。", "pitfall": "", "sino_viet": ""}]}


def valid_questions():
    return {"questions": [
        {"type": "fact", "q": "谁春节回家？", "options": ["A 小林", "B 老师", "C 医生", "D 学生"], "answer": "A", "follow_up": ""},
        {"type": "sequence", "q": "小林先做什么？", "options": ["回家", "工作", "睡觉"], "answer": "回家", "follow_up": ""},
        {"type": "reason", "q": "小林为什么回家？", "options": [], "answer": "", "follow_up": "用因为所以回答。"},
    ]}


def valid_lesson_plan():
    # Legacy name/minutes/goal keys exercise the one-pass compatibility normalizer.
    durations = [4, 8, 7, 8, 3]
    names = ["导入", "理解阅读", "词汇与句型", "交互练习", "总结与迁移"]
    return {
        "title": "回家过年阅读课",
        "total_minutes": 30,
        "level_task": "说明原因",
        "objectives": ["找出文章的人物和时间", "用三句话说自己的经历"],
        "stages": [{
            "name": name,
            "minutes": duration,
            "goal": "说出本阶段的一个关键信息",
            "teacher_actions": ["提出一个具体问题"],
            "student_actions": ["看一看，再回答。"],
            "materials": ["阅读材料"],
            "prompts": ["你看什么？"],
            "expected_output": "学生回答。",
        } for name, duration in zip(names, durations)],
        "homework": "写三句话。",
    }


class ServiceTests(unittest.TestCase):
    def test_unexpected_rewrite_runtime_error_becomes_safe_fallback(self):
        with patch("services.complete_json", AsyncMock(side_effect=RuntimeError("loop state failed"))):
            result = asyncio.run(generate_rewrite_package("小林春节回家。", "HSK3", "English", ["春节"]))

        self.assertEqual(result["meta"]["generation_components"]["rewrite"], "unavailable")
        self.assertEqual(result["meta"]["fallback_codes"]["rewrite"], "internal_error")
        self.assertNotIn("loop state failed", str(result))

    def test_best_rewrite_candidate_survives_a_later_provider_timeout(self):
        source = "小林春节在很远的地方工作，他每天都特别忙，但是还希望回到家乡，和家人重新生活在一起。"
        candidate = {
            "title": "春节回家",
            "sentences": [
                {"text": "小林春节回家。", "source_sentence_ids": [0]},
                {"text": "家人也在家。", "source_sentence_ids": [0]},
                {"text": "这是好机会。", "source_sentence_ids": [0]},
            ],
            "deleted_info": "删去工作地点和工作情况。",
            "teacher_notes": "原文信息量有限",
        }
        mocked = AsyncMock(side_effect=[candidate, LLMError("timeout", "provider_error")])
        with patch("services.complete_json", mocked):
            result = asyncio.run(generate_rewrite_package(source, "HSK2", "English", ["春节"]))

        self.assertEqual(result["meta"]["generation_components"]["rewrite"], "ai")
        self.assertNotEqual(result["rewritten"]["title"], "原文预览")
        self.assertTrue(result["meta"]["generation_warnings"]["rewrite"])

    def test_question_level_near_miss_is_returned_with_teacher_warnings(self):
        questions = valid_questions()
        questions["questions"][0]["q"] = "复杂观点之间有什么根本区别？"
        mocked = AsyncMock(return_value=questions)
        with patch("services.complete_json", mocked):
            result = asyncio.run(generate_component("questions", "小林春节回家。", "HSK2", "English", ["春节"]))

        self.assertEqual(result["status"], "ai")
        self.assertEqual(len(result["data"]), 3)
        self.assertTrue(result["warnings"])

    def test_rewrite_stage_stops_before_component_generation(self):
        mocked = AsyncMock(return_value=valid_rewrite())
        with patch("services.complete_json", mocked):
            result = asyncio.run(generate_rewrite_package("小林春节回家。", "HSK2", "English", ["春节"]))

        self.assertEqual(mocked.await_count, 1)
        self.assertEqual(result["meta"]["generation_components"], {
            "rewrite": "ai", "vocab": "unavailable", "questions": "unavailable", "lesson_plan": "unavailable"
        })
        self.assertEqual(result["meta"]["generation_mode"], "partial")
        self.assertEqual(result["vocab"], [])
        self.assertEqual(result["questions"], [])
        self.assertEqual(result["lesson_plan"]["stages"], [])

    def test_short_source_exposes_a_short_text_target_without_blocking_rewrite(self):
        mocked = AsyncMock(return_value=valid_rewrite())
        source = "小林春节回家。"
        with patch("services.complete_json", mocked):
            result = asyncio.run(generate_rewrite_package(source, "HSK2", "English", ["春节"]))

        self.assertEqual(result["meta"]["generation_components"]["rewrite"], "ai")
        self.assertTrue(result["quality"]["details"]["source_limited"])
        self.assertEqual(result["quality"]["details"]["short_text_target"], [6, 9])

    def test_demo_has_no_fake_vocab_or_questions_and_has_marked_template(self):
        text = "这是一句需要完整保留的中文句子。第二句也要保留。"
        mocked = AsyncMock(side_effect=LLMError("missing", "not_configured"))
        with patch("services.complete_json", mocked):
            result = asyncio.run(generate_package(text, "HSK1", "English", []))

        rewritten = "".join(item["text"] for item in result["rewritten"]["sentences"])
        self.assertEqual(rewritten, text)
        self.assertEqual(result["vocab"], [])
        self.assertEqual(result["questions"], [])
        self.assertEqual(result["lesson_plan"]["total_minutes"], 0)
        self.assertFalse(result["lesson_plan"]["available"])
        self.assertEqual(result["lesson_plan"]["stages"], [])
        self.assertEqual(result["meta"]["generation_components"], {
            "rewrite": "unavailable", "vocab": "unavailable", "questions": "unavailable", "lesson_plan": "unavailable"
        })
        self.assertEqual(result["meta"]["fallback_code"], "not_configured")

    def test_ai_components_and_lesson_plan_are_normalized(self):
        mocked = AsyncMock(side_effect=[valid_rewrite(), valid_lesson_plan(), valid_vocab(), valid_questions()])
        with patch("services.complete_json", mocked):
            result = asyncio.run(generate_package("小林春节回家。", "HSK2", "English", ["春节"]))

        self.assertEqual(result["rewritten"]["sentences"][0]["source_sentence_ids"], [0])
        self.assertEqual(result["lesson_plan"]["total_minutes"], 30)
        self.assertEqual(result["lesson_plan"]["stages"][1]["start_minute"], 4)
        self.assertEqual(result["lesson_plan"]["stages"][-1]["end_minute"], 30)
        self.assertEqual(result["meta"]["generation_components"], {
            "rewrite": "ai", "vocab": "ai", "questions": "ai", "lesson_plan": "ai"
        })
        self.assertEqual(result["meta"]["generation_mode"], "ai")
        self.assertEqual([item["type"] for item in result["questions"]], ["fact", "sequence", "reason"])
        self.assertEqual(result["lesson_plan"]["level_task"], "说明原因")

    def test_empty_rewrite_is_retried_before_demo_fallback(self):
        empty_rewrite = {"title": "", "sentences": [], "deleted_info": "", "teacher_notes": ""}
        mocked = AsyncMock(side_effect=[empty_rewrite, valid_rewrite(), valid_lesson_plan(), valid_vocab(), valid_questions()])
        with patch("services.complete_json", mocked):
            result = asyncio.run(generate_package("小林春节回家。", "HSK2", "English", ["春节"]))

        self.assertEqual(mocked.await_count, 5)
        self.assertEqual(result["meta"]["generation_mode"], "ai")
        self.assertEqual(result["meta"]["generation_components"]["rewrite"], "ai")
        self.assertEqual(result["rewritten"]["sentences"][0]["text"], "小林春节回家。")

    def test_failed_real_component_stays_empty_without_affecting_others(self):
        bad_lesson = {"title": "bad", "stages": []}
        mocked = AsyncMock(side_effect=[
            valid_rewrite(),
            bad_lesson,
            bad_lesson,
            LLMError("bad vocab", "invalid_response"),
            valid_questions(),
        ])
        with patch("services.complete_json", mocked):
            result = asyncio.run(generate_package("小林春节回家。", "HSK2", "English", ["春节"]))

        self.assertEqual(result["vocab"], [])
        self.assertEqual(len(result["questions"]), 3)
        self.assertEqual(result["lesson_plan"]["stages"], [])
        self.assertEqual(result["meta"]["generation_components"], {
            "rewrite": "ai", "vocab": "unavailable", "questions": "ai", "lesson_plan": "unavailable"
        })
        self.assertEqual(result["meta"]["generation_mode"], "partial")
        self.assertIn("vocab", result["meta"]["fallback_codes"])
        self.assertIn("lesson_plan", result["meta"]["fallback_codes"])


if __name__ == "__main__":
    unittest.main()
