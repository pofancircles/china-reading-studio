import { describe, expect, it } from "vitest";

import {
  createMaterialDraft,
  getDeckVisibleText,
  getWorksheetVisibleText,
  sanitizeFileName,
  validateDeckDraft,
  validateLessonDraft,
  validateWorksheetDraft,
  type MaterialSource,
} from "./materials";

const stageNames = ["导入", "初读", "精读", "互动", "总结"];
const stageDurations = [4, 8, 7, 8, 3];

function sourceFixture(): MaterialSource {
  let cursor = 0;
  return {
    rewritten: {
      title: "城市里的小菜园",
      sentences: [
        { text: "小林在阳台上种了几盆蔬菜。", source_sentence_ids: [0] },
        { text: "每天早上，他先给蔬菜浇水，再去上学。", source_sentence_ids: [1] },
        { text: "一个月以后，他第一次吃到了自己种的西红柿。", source_sentence_ids: [2] },
      ],
      teacher_notes: "原文信息量有限，课堂上不要补充新的故事情节。",
    },
    vocab: [
      { word: "阳台", pos: "名", meaning: "楼房向外伸出的空间", example: "阳台上有很多花。", pitfall: "不要写成洋台", sino_viet: "dương đài" },
      { word: "浇水", pos: "动", meaning: "把水倒在植物上", example: "我每天给花浇水。" },
    ],
    questions: [
      { type: "单选题", q: "小林在哪里种蔬菜？", options: ["A. 阳台", "B. 学校"], answer: "A", follow_up: "你还可以在哪里种菜？" },
      { type: "简答题", q: "小林每天早上先做什么？", options: [], answer: "给蔬菜浇水。", follow_up: "请按顺序复述他的早晨。" },
    ],
    lesson_plan: {
      title: "从阳台菜园学习顺序表达",
      total_minutes: 30,
      objectives: ["学生能按时间顺序复述小林种菜的过程。"],
      stages: stageNames.map((title, index) => {
        const start = cursor;
        cursor += stageDurations[index];
        return {
          title,
          start_minute: start,
          end_minute: cursor,
          duration: stageDurations[index],
          objective: `完成${title}阶段的阅读任务`,
          teacher_actions: [`教师讲解${title}阶段的做法`],
          student_actions: [`学生完成${title}阶段任务`],
          prompts: [`请完成${title}阶段任务，并说出你的理由。`],
          materials: ["分级阅读材料"],
          expected_output: `${title}阶段口头回答`,
        };
      }),
      homework: "请用“先……再……”写两句话。",
      available: true,
    },
    meta: { level: "HSK 3", target_words: ["阳台", "浇水"] },
  };
}

describe("createMaterialDraft", () => {
  it("creates three self-contained drafts and preserves the fixed lesson timeline", () => {
    const draft = createMaterialDraft(sourceFixture());

    expect(draft.lesson.title).toBe("从阳台菜园学习顺序表达");
    expect(draft.lesson.level).toBe("HSK 3");
    expect(draft.lesson.stages).toHaveLength(5);
    expect(draft.lesson.stages[0].startMinute).toBe(0);
    expect(draft.lesson.stages.at(-1)?.endMinute).toBe(30);
    expect(draft.deck.title).toBe(draft.lesson.title);
    expect(draft.worksheet.level).toBe(draft.lesson.level);
  });

  it("only uses direct student prompts in the deck and keeps the title slide minimal", () => {
    const draft = createMaterialDraft(sourceFixture());
    const visible = getDeckVisibleText(draft.deck).join("\n");

    expect(visible).toContain("请完成导入阶段任务");
    expect(visible).not.toContain("教师讲解");
    expect(visible).not.toContain("学生完成导入阶段任务");
    expect(draft.deck.slides[0].body).toEqual(["HSK 3 分级阅读"]);
    expect(visible).not.toContain("30 分钟");
  });
});

describe("independent validation", () => {
  it("does not let a lesson error block the deck or worksheet", () => {
    const draft = createMaterialDraft(sourceFixture());
    draft.lesson.stages[2].startMinute = 99;

    expect(validateLessonDraft(draft.lesson)).toContain("教师详案：第 3 阶段与上一阶段时间不连续");
    expect(validateDeckDraft(draft.deck)).toEqual([]);
    expect(validateWorksheetDraft(draft.worksheet)).toEqual([]);
  });

  it("locates student-content leaks in the affected product only", () => {
    const draft = createMaterialDraft(sourceFixture());
    draft.deck.slides[1].body = ["教师引导学生看标题"];

    expect(validateDeckDraft(draft.deck)[0]).toContain("学生课件：第 2 页");
    expect(validateWorksheetDraft(draft.worksheet)).toEqual([]);

    draft.worksheet.instructions = "请查看参考答案：A";
    expect(validateWorksheetDraft(draft.worksheet).join("；")).toContain("学生可见内容包含答案标记");
  });
});

describe("student and teacher visibility", () => {
  it("excludes answers and follow-up references from the student worksheet", () => {
    const worksheet = createMaterialDraft(sourceFixture()).worksheet;
    const studentText = getWorksheetVisibleText(worksheet, false).join("\n");
    const teacherText = getWorksheetVisibleText(worksheet, true).join("\n");

    expect(studentText).toContain("小林在哪里种蔬菜？");
    expect(studentText).not.toContain("给蔬菜浇水。");
    expect(studentText).not.toContain("你还可以在哪里种菜？");
    expect(teacherText).toContain("给蔬菜浇水。");
    expect(teacherText).toContain("你还可以在哪里种菜？");
  });
});

describe("sanitizeFileName", () => {
  it("removes unsafe characters and protects Windows reserved names", () => {
    expect(sanitizeFileName('  阅读：城市/菜园*  ')).toBe("阅读-城市-菜园");
    expect(sanitizeFileName("CON")).toBe("课堂材料-CON");
    expect(sanitizeFileName("<>:|?* ")).toBe("课堂材料");
  });
});
