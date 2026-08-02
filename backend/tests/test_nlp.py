import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))

from nlp import classify_word, extract_topic_word_details, find_violations, get_pinyin, split_sentences  # noqa: E402


class NlpTests(unittest.TestCase):
    def test_keep_word_is_not_reported(self):
        violations = find_violations("我今天去奶茶店买了一杯珍珠奶茶。", "HSK1", {"奶茶"})
        self.assertNotIn("奶茶", violations)

    def test_pinyin_for_chongqing(self):
        text = "重庆"
        self.assertIn("chóng", " ".join(item["pinyin"] for item in get_pinyin(text)))

    def test_split_sentences(self):
        self.assertEqual(split_sentences("你好。今天很好！"), ["你好。", "今天很好！"])

    def test_split_sentences_keeps_tail_and_closing_quote(self):
        self.assertEqual(split_sentences("他说：‘今天下雨！’我们明天再去"), ["他说：‘今天下雨！’", "我们明天再去"])

    def test_topic_candidates_explain_and_filter_generic_words_and_names(self):
        text = "春节快到了，很多人在外地工作。小林每年春节回家乡，家人一起吃饭。"
        candidates = extract_topic_word_details(text, "HSK2")
        words = [item["word"] for item in candidates]
        self.assertNotIn("小林", words)
        self.assertNotIn("每年", words)
        self.assertTrue(all({"frequency", "pos", "reason"} <= item.keys() for item in candidates))

    def test_level_safe_function_word_is_allowed_from_hsk2_only(self):
        text = "他只是我的朋友。"

        self.assertIn("只是", find_violations(text, "HSK1"))
        self.assertNotIn("只是", find_violations(text, "HSK2"))
        self.assertEqual(find_violations(text, "HSK2"), [])
        self.assertEqual(classify_word("只是", "HSK2"), {
            "word": "只是", "kind": "allowed", "components": ["只是"]
        })
        self.assertEqual(classify_word("只是", "HSK4")["kind"], "allowed")

    def test_function_word_rule_is_exact_and_does_not_allow_all_stopwords_or_characters(self):
        violations = find_violations("这只是一个机会。", "HSK2")

        self.assertNotIn("只是", violations)
        self.assertIn("机会", violations)
        self.assertEqual(classify_word("只书", "HSK2")["kind"], "unknown")
        self.assertEqual(classify_word("于是", "HSK2")["kind"], "unknown")


if __name__ == "__main__":
    unittest.main()
