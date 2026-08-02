import asyncio
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).parents[1]))

from config import LEVEL_ORDER, get_level_profile  # noqa: E402
from llm import LLMError, SAFE_ERROR_CODES, probe_model  # noqa: E402
from nlp import (  # noqa: E402
    classify_word,
    compare_levels,
    extract_topic_word_details,
    factual_markers,
    find_violations,
    level_issues,
    validate,
)


class LevelProfileAcceptanceTests(unittest.TestCase):
    def test_all_four_profiles_have_expected_numeric_limits(self):
        expected = {
            "HSK1": (1, 150, 8, (80, 140), 4),
            "HSK2": (2, 300, 12, (140, 220), 5),
            "HSK3": (3, 600, 18, (220, 350), 6),
            "HSK4": (4, 1200, 25, (350, 550), 8),
        }

        self.assertEqual(LEVEL_ORDER, tuple(expected))
        for level, limits in expected.items():
            with self.subTest(level=level):
                profile = get_level_profile(level)
                self.assertEqual(
                    (
                        profile.rank,
                        profile.vocab_size,
                        profile.max_sentence_len,
                        profile.target_total_len,
                        profile.max_target_words,
                    ),
                    limits,
                )
                self.assertTrue(profile.allowed_grammar)
                self.assertTrue(profile.forbidden_grammar)
                self.assertTrue(profile.task_focus)
                self.assertTrue(profile.question_types)

        self.assertIn("因为所以、虽然但是等复句", get_level_profile("HSK1").forbidden_grammar)
        self.assertIn("因为……所以…… / 但是", get_level_profile("HSK2").allowed_grammar)
        self.assertIn("把字句", get_level_profile("HSK2").forbidden_grammar)
        self.assertIn("基础把字句", get_level_profile("HSK3").allowed_grammar)
        self.assertIn("完整被字句", get_level_profile("HSK4").allowed_grammar)

    def test_same_text_has_meaningfully_different_level_metrics(self):
        text = "小林准备参加汉语水平考试，他每天练习阅读和写作。"
        comparison = compare_levels(text)

        self.assertEqual([item["level"] for item in comparison], list(LEVEL_ORDER))
        known_ratios = [item["known_ratio"] for item in comparison]
        violation_counts = [item["out_of_level_words"] for item in comparison]
        sentence_limits = [item["max_sentence_len"] for item in comparison]
        length_targets = [tuple(item["target_total_len"]) for item in comparison]

        self.assertGreater(len(set(known_ratios)), 1)
        self.assertGreater(len(set(violation_counts)), 1)
        self.assertEqual(known_ratios, sorted(known_ratios))
        self.assertEqual(violation_counts, sorted(violation_counts, reverse=True))
        self.assertLess(known_ratios[0], known_ratios[-1])
        self.assertGreater(violation_counts[0], violation_counts[-1])
        self.assertEqual(sentence_limits, [8, 12, 18, 25])
        self.assertEqual(len(set(length_targets)), 4)


class NlpAcceptanceTests(unittest.TestCase):
    def test_composable_known_words_are_not_reported_as_violations(self):
        text = "很多人春节回家看家人，他们一起吃饭。小林在哪儿？请说一句话。请读文章中写的句子。"
        violations = find_violations(text, "HSK1")
        expected_components = {
            "很多": ["很", "多"],
            "回家": ["回", "家"],
            "家人": ["家", "人"],
        }

        for word, components in expected_components.items():
            with self.subTest(word=word):
                self.assertNotIn(word, violations)
                classification = classify_word(word, "HSK1")
                self.assertEqual(classification["kind"], "compound")
                self.assertEqual(classification["components"], components)

        self.assertIn("春节", violations)
        self.assertNotIn("他们", violations)
        self.assertNotIn("吃饭", violations)
        self.assertNotIn("哪儿", violations)
        self.assertNotIn("中写", violations)
        self.assertNotIn("一句", find_violations("请说一句话。", "HSK4"))

    def test_fact_markers_do_not_treat_family_words_as_people_names(self):
        self.assertEqual(factual_markers("小林和家里人一起回家。"), ["小林"])

    def test_topic_candidates_expose_status_and_first_level(self):
        text = "我喜欢音乐。学生在学校上课。春节时，家人一起回家。"
        candidates = extract_topic_word_details(text, "HSK2", top_n=20)
        by_word = {item["word"]: item for item in candidates}

        self.assertEqual(by_word["学校"]["status"], "known")
        self.assertEqual(by_word["学校"]["first_level"], "HSK1")
        self.assertEqual(by_word["音乐"]["status"], "above_level")
        self.assertEqual(by_word["音乐"]["first_level"], "HSK3")
        self.assertEqual(by_word["回家"]["status"], "known_composite")
        self.assertIsNone(by_word["回家"]["first_level"])
        self.assertEqual(by_word["回家"]["components"], ["回", "家"])

        for candidate in candidates:
            self.assertIn(candidate["status"], {"known", "known_composite", "above_level"})
            self.assertIn(candidate["first_level"], {*LEVEL_ORDER, None})

    def test_validation_reports_both_unknown_words_and_overlong_sentence(self):
        text = "我今天在学校学习区块链技术。"
        quality = validate(text, "HSK1")

        self.assertIn("区块", quality["violations"])
        self.assertEqual(quality["sentence_over_length"], [text])
        self.assertEqual(
            set(level_issues(text, "HSK1")),
            {"out_of_level_words", "overlength_sentence"},
        )
        self.assertEqual(quality["level_comparison"]["relation"], "above_target")


class ModelProbeAcceptanceTests(unittest.TestCase):
    def test_probe_normalizes_untrusted_error_and_never_returns_secret_or_message(self):
        fake_secret = "acceptance-test-secret-value"
        raw_message = f"upstream exploded while using {fake_secret}"
        mocked_post = AsyncMock(side_effect=LLMError(raw_message, "internal_debug_code"))

        def fake_setting(name: str, default: str = "") -> str:
            return fake_secret if name == "LLM_API_KEY" else default

        with (
            patch("llm._provider_metadata", return_value=("api.example.test", "test-model", True)),
            patch("llm._validated_base_url", return_value="https://api.example.test/v1"),
            patch("llm._setting", side_effect=fake_setting),
            patch("llm._post_completion", mocked_post),
        ):
            result = asyncio.run(probe_model(2.0))

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "provider_error")
        self.assertIn(result["code"], SAFE_ERROR_CODES)
        self.assertEqual(
            set(result),
            {"ok", "code", "configured", "provider", "model", "latency_ms"},
        )
        serialized = json.dumps(result, ensure_ascii=False)
        self.assertNotIn(fake_secret, serialized)
        self.assertNotIn(raw_message, serialized)
        self.assertNotIn("internal_debug_code", serialized)
        mocked_post.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
