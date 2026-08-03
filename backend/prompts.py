from __future__ import annotations

from collections.abc import Iterable

from config import LevelProfile, get_level_profile
from data.hsk_vocab import get_cumulative_vocab


def _join(items: Iterable[str]) -> str:
    return "、".join(item for item in items if item)


def _constraints(profile: LevelProfile) -> str:
    return (
        f"允许语法：{_join(profile.allowed_grammar)}\n"
        f"禁止语法：{_join(profile.forbidden_grammar)}\n"
        f"单句不超过 {profile.max_sentence_len} 字；全文约 {profile.min_total_len}-{profile.max_total_len} 字。"
    )


def _vocabulary_rule(level: str, extra_words: list[str] | None = None) -> str:
    words = sorted(get_cumulative_vocab(level))
    extra = _join(extra_words or []) or "无"
    return f"可用旧 HSK 词汇：{', '.join(words)}\n额外允许的主题词：{extra}"


QUESTION_RULES = {
    "fact": "事实题：答案必须能从文章直接找到，提供至少三个选项",
    "choice": "选择辨认题：只考一个清楚信息，提供至少三个短选项",
    "repeat": "复述题：让学生说文章信息，不提供选项；HSK1 的 follow_up 固定写‘请说。’，不要使用‘复述、答案、再说、一句、两句’等元语言",
    "sequence": "顺序题：排列文章中的三件事，options 按未排序顺序给出",
    "reason": "原因题：用因为……所以……回答，不提供虚构选项",
    "inference": "推断题：根据文章内容做一步推断，提供至少三个选项；follow_up 固定写‘为什么？’，不要另加课堂元语言",
    "explain": "解释题：解释人物做法或信息关系，不提供选项",
    "discussion": "讨论题：比较观点或迁移到真实经历，不提供标准答案；follow_up 固定写‘请说文章内容，再说你的看法。’，不要使用‘信息、判断’等超纲元语言",
}


def rewrite_prompt(
    source_text: str,
    level: str,
    vocab: list[str],
    keep_words: list[str],
    retry: bool = False,
    repair_feedback: str = "",
    aggressive_simplification: bool = False,
) -> str:
    profile = get_level_profile(level)
    recovery = (
        "\n这是一次格式/等级修复重试：sentences 必须至少包含 1 个非空句子；"
        "每句都要在目标等级内；不要返回空数组，不要输出解释。"
        if retry else ""
    )
    feedback = f"\n上一次结果需要修复：{repair_feedback}。" if repair_feedback else ""
    difficulty_rule = (
        f"\n原文难度远高于 {level}。不要逐句翻译，也不要保留所有抽象概念或比喻；"
        f"只保留一个中心意思和两三个关键关系，用 6-10 个独立短句表达。"
        f"允许全文短于建议下限，但至少 {max(40, int(profile.min_total_len * 0.55))} 字；"
        "删掉的观点必须写入 deleted_info。"
        if aggressive_simplification else ""
    )
    return f"""你是中文二语教学材料改写专家。把下面的中文材料改写成适合 {level} 学习者的课堂阅读材料。

===== 可用词汇（该等级及以下） =====
{', '.join(vocab)}

===== 保留词（允许超纲） =====
{', '.join(keep_words) or '无'}

===== 等级约束 =====
{_constraints(profile)}
除保留词和专有名词外，不得使用可用词汇表之外的中文词。保留原文最重要的事实，不要编造；允许删减次要信息。
原文已经按 `[0]`、`[1]` 的格式标出真实来源句编号。每个改写句必须填写这些方括号中的编号（0-indexed）；拆分同一个原文句时要重复使用原编号，不能按改写后的句子重新编号。一句可对应多个原文句，不能留空或填写不存在的编号。
如果原文信息量不足以达到建议篇幅，宁可短一些也不得扩写原文没有的人物、时间、地点、数字、原因或结果；在 teacher_notes 中明确写“原文信息量有限”。
不能把文章缩成提纲式的两三句话；在不编造事实的前提下，尽量接近建议篇幅的下限。{difficulty_rule}
如果删去了原文信息，必须在 deleted_info 中具体说明；没有删去则写“无”。{recovery}{feedback}

只输出 JSON，结构必须是：
{{"title":"不超过8字","sentences":[{{"text":"改写后的句子","source_sentence_ids":[0]}}],"deleted_info":"删去的信息","teacher_notes":"备课提示"}}

原文：
{source_text}
"""


def rewrite_repair_prompt(
    rewritten_json: str,
    level: str,
    vocab: list[str],
    keep_words: list[str],
    repair_feedback: str,
) -> str:
    profile = get_level_profile(level)
    return f"""下面是一份已经完成事实删减的 {level} 中文材料。只修复违规句，不要重新参考或扩写原文。

等级约束：
{_constraints(profile)}
可用词汇：{', '.join(vocab)}
允许保留词：{', '.join(keep_words) or '无'}
上一次具体问题：{repair_feedback or '句子长度或词汇超纲'}

必须遵守：
- 不得再次使用“具体问题”中列出的超纲词。
- 只改 sentences 中的 text；保留 title、deleted_info、teacher_notes 和事实。
- 保留每条 source_sentence_ids；拆句时，新句沿用原句的 source_sentence_ids。
- 每句最多 {profile.max_sentence_len} 字；一个长句可以拆成多个短句。
- 不要新增人物、时间、地点、数字、原因或结论。

待修复 JSON：
{rewritten_json}

只输出完整 JSON：
{{"title":"...","sentences":[{{"text":"...","source_sentence_ids":[0]}}],"deleted_info":"...","teacher_notes":"..."}}
必须至少输出一个非空句子。"""


def vocab_prompt(
    rewritten_text: str,
    target_words: list[str],
    level: str,
    native_lang: str,
    retry: bool = False,
) -> str:
    profile = get_level_profile(level)
    extra = "如有准确且有教学价值的汉越词，填写 sino_viet；没有就留空。" if native_lang == "Vietnamese" else "sino_viet 统一留空。"
    recovery = "这是一次修复重试：必须为每个目标词返回 meaning 和自然例句，不能返回占位文本。" if retry else ""
    return f"""为下面的 {level} 阅读材料生成准确、可直接教学的生词表。
目标词由代码选择，只处理给定目标词，不要补造词。meaning 必须用 {native_lang} 给出本文语境中的准确释义；example 必须自然、具体、不能复用同一个句型模板，也不能直接复制文章原句。
例句使用 {level} 及以下词汇；目标词可以在例句中出现，保留词和专有名词除外。词性要准确；pitfall 只写真实常见误用，没有则留空。{extra}
{recovery}
目标词：{', '.join(target_words) or '无'}
文章：{rewritten_text}
{_constraints(profile)}
{_vocabulary_rule(level, target_words)}
只输出 JSON：{{"vocab":[{{"word":"...","pos":"...","meaning":"...","example":"...","pitfall":"","sino_viet":""}}]}}
"""


def vocab_item_prompt(
    rewritten_text: str,
    target_word: str,
    level: str,
    native_lang: str,
    retry: bool = False,
) -> str:
    extra = "如有准确汉越词，填写 sino_viet；没有就留空。" if native_lang == "Vietnamese" else "sino_viet 留空。"
    recovery = "上次缺字段或内容不自然；这次所有字段都必须填写准确。" if retry else ""
    return f"""只为目标词“{target_word}”生成一张 {level} 生词卡。释义使用 {native_lang}，必须符合文章语境。
例句自然、具体，不复制原句，尽量使用 {level} 及以下词汇。pitfall 没有真实常见误用就留空。{extra}{recovery}
文章：{rewritten_text}
只输出 JSON：{{"word":"{target_word}","pos":"...","meaning":"...","example":"...","pitfall":"","sino_viet":""}}
word 必须完全等于“{target_word}”。"""


def questions_prompt(rewritten_text: str, level: str, target_words: list[str] | None = None, retry: bool = False) -> str:
    profile = get_level_profile(level)
    question_types = list(profile.question_types)
    type_rules = "\n".join(f"- {kind}: {QUESTION_RULES[kind]}" for kind in question_types)
    example_items = ",".join(
        f'{{"type":"{kind}","q":"...","options":[],"answer":"","follow_up":"..."}}'
        for kind in question_types
    )
    recovery = f"这是一次修复重试：必须恰好按顺序返回 {', '.join(question_types)} 三题，题干、选项和追问不得越级。" if retry else ""
    return f"""为下面这篇 {level} 中文阅读材料生成三道课堂用题，类型和顺序必须是：{', '.join(question_types)}。
不同等级的题型不能互换。客观题必须能从文章得到答案；开放题必须明确规定学生要说几句、按什么结构回答。题干、选项和追问都使用 {level} 及以下词汇，语法同样受限。错误选项只能使用文中信息制造干扰，不要编造事实。

题型规则：
{type_rules}
{recovery}
文章：{rewritten_text}
{_constraints(profile)}
{_vocabulary_rule(level, target_words)}
只输出 JSON：{{"questions":[{example_items}]}}
"""


def question_item_prompt(
    rewritten_text: str,
    level: str,
    question_type: str,
    target_words: list[str] | None = None,
    retry: bool = False,
) -> str:
    recovery = "上次题目字段、选项或答案不完整；这次严格按结构返回。" if retry else ""
    objective = question_type in {"fact", "choice", "sequence", "inference"}
    option_rule = "必须提供至少三个短选项和非空答案。" if objective else "options 必须是空数组。"
    return f"""根据下面的 {level} 阅读材料，只生成一道 {question_type} 题。
题型规则：{QUESTION_RULES[question_type]}
{option_rule} 题目必须基于文章，不编造事实，课堂用语尽量简单。{recovery}
目标词：{_join(target_words or []) or '无'}
文章：{rewritten_text}
只输出 JSON：{{"type":"{question_type}","q":"...","options":[],"answer":"","follow_up":"...","skill":"{question_type}"}}
type 必须完全等于“{question_type}”。"""


def lesson_plan_prompt(
    rewritten_text: str,
    level: str,
    native_lang: str,
    target_words: list[str],
    retry: bool = False,
) -> str:
    """Ask only for pedagogy content; code supplies the fixed timeline."""
    profile = get_level_profile(level)
    recovery = (
        "这是一次修复重试：必须恰好返回五个非空阶段；只写简短、具体、可执行的教学内容。"
        "再次检查 objectives 和每段 objective 都是可观察动作，prompts 与 homework 都是直接对学生说的话。"
        if retry else ""
    )
    level_task = profile.task_focus[0]
    return f"""为 {level}、母语为 {native_lang} 的学生设计一堂 30 分钟中文阅读课。
代码会自动补齐严格连续的五阶段时间轴、阶段名和材料，因此不要输出时间或 materials。
只按顺序返回五段教学内容：导入、理解阅读、词汇与句型、交互练习、总结与迁移。
每段必须有 objective、teacher_actions、student_actions、prompts、expected_output；每个数组 1-2 条即可。
objectives 返回 2-4 条；objectives 和每段 objective 都必须是简短、可观察的动作短语，例如“找出人物和时间”“用三句话复述”。不要只写“理解、掌握、了解”，不要写“学生能够”“教师引导”等教案腔。
teacher_actions 和 student_actions 是给教师看的具体步骤，可以使用教学术语。
prompts 是课堂上直接展示或直接对学生说的话，每条不超过 {profile.max_sentence_len} 字。只写学生能立刻执行的问题或指令，不得出现“教师、学生、引导、激活、教学目标、本环节、课堂材料、分钟”等教案说明，也不得描述教师应该怎么做。
homework 必须是一条直接对学生说的完整任务指令，例如“请用……写三句话”。不得写“教师布置……”“学生完成……”或“课后作业：”等说明性前缀。
所有活动必须基于文章，不编造事实。词汇阶段实际使用：{', '.join(target_words) or '文章关键词'}。
理解阅读和交互练习围绕同一目标推进。课堂输出任务固定为“{level_task}”，交互练习必须真正执行它。
{recovery}
阅读材料：
{rewritten_text}

只输出 JSON，结构如下：
{{"title":"...","level_task":"{level_task}","objectives":["..."],"stages":[{{"objective":"...","teacher_actions":["..."],"student_actions":["..."],"prompts":["..."],"expected_output":"..."}}],"homework":"..."}}
"""
