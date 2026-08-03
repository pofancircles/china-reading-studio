export type MaterialSource = {
  rewritten: {
    title: string;
    sentences: { text: string; source_sentence_ids: number[] }[];
    teacher_notes?: string;
  };
  vocab: {
    word: string;
    pos?: string;
    meaning: string;
    example?: string;
    pitfall?: string;
    sino_viet?: string;
  }[];
  questions: {
    type?: string;
    q: string;
    options: string[];
    answer: string;
    follow_up: string;
  }[];
  lesson_plan: {
    title: string;
    total_minutes: number;
    level_task?: string;
    objectives: string[];
    stages: {
      title: string;
      start_minute: number;
      end_minute: number;
      duration: number;
      objective: string;
      teacher_actions: string[];
      student_actions: string[];
      prompts: string[];
      materials: string[];
      expected_output: string;
    }[];
    homework: string;
    available: boolean;
    note?: string;
  };
  meta: {
    level: string;
    target_words?: string[];
  };
};

export type LessonVocabulary = {
  word: string;
  pos: string;
  meaning: string;
  example: string;
  pitfall: string;
  sinoViet: string;
};

export type LessonStageDraft = {
  id: string;
  title: string;
  startMinute: number;
  endMinute: number;
  duration: number;
  objective: string;
  teacherActions: string[];
  studentActions: string[];
  prompts: string[];
  materials: string[];
  expectedOutput: string;
};

export type LessonDraft = {
  title: string;
  level: string;
  totalMinutes: number;
  objectives: string[];
  rewrittenTitle: string;
  rewrittenSentences: string[];
  vocabulary: LessonVocabulary[];
  stages: LessonStageDraft[];
  homework: string;
  teacherNotes: string;
};

export type MaterialSlide = {
  id: string;
  kind: "title" | "warmup" | "reading" | "vocabulary" | "practice" | "interaction" | "summary";
  title: string;
  body: string[];
};

export type DeckDraft = {
  title: string;
  level: string;
  slides: MaterialSlide[];
};

export type WorksheetQuestion = {
  id: string;
  type: string;
  prompt: string;
  options: string[];
  answer: string;
  followUp: string;
};

export type WorksheetDraft = {
  title: string;
  level: string;
  instructions: string;
  questions: WorksheetQuestion[];
  homework: string;
};

export type MaterialDraft = {
  lesson: LessonDraft;
  deck: DeckDraft;
  worksheet: WorksheetDraft;
};

const COLORS = {
  ink: "17201F",
  paper: "F7F8F4",
  moss: "557A68",
  coral: "C96950",
  line: "DFE5DC",
  muted: "64748B",
  paleMoss: "E6F0E5",
  tableHeader: "E8EEF5",
  white: "FFFFFF",
};

const FONT_FACE = "Microsoft YaHei";
export const MIN_SLIDES = 6;
export const MAX_SLIDES = 10;
const EXPECTED_STAGE_COUNT = 5;
const EXPECTED_TOTAL_MINUTES = 30;

const STUDENT_CONTENT_LEAK_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /(?:参考|标准)?答案\s*[:：]/i, label: "答案标记" },
  { pattern: /教师(?:引导|讲解|提示|活动|动作|示范|板书|追问)/, label: "教师操作说明" },
  { pattern: /老师(?:引导|讲解|提示|示范|板书)/, label: "教师操作说明" },
  { pattern: /教学目标|本环节|引导学生|供教师|教师用|教案/, label: "教案说明" },
  { pattern: /预设(?:回答|答案|产出)/, label: "预设答案" },
];

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function compactLines(lines: unknown[]): string[] {
  return lines.map(cleanText).filter(Boolean);
}

function uniqueErrors(errors: string[]): string[] {
  return Array.from(new Set(errors));
}

function studentContentLeak(text: string): string | null {
  return STUDENT_CONTENT_LEAK_PATTERNS.find(({ pattern }) => pattern.test(text))?.label ?? null;
}

function safeStudentLines(lines: unknown[], fallback: string): string[] {
  const safe = compactLines(lines).filter((line) => !studentContentLeak(line));
  return safe.length ? safe : [fallback];
}

function readingPageCount(sentences: string[]): number {
  const totalCharacters = sentences.reduce((total, sentence) => total + sentence.length, 0);
  const bySentenceCount = Math.ceil(sentences.length / 4);
  const byCharacterCount = Math.ceil(totalCharacters / 220);
  return Math.max(1, Math.min(3, sentences.length, Math.max(bySentenceCount, byCharacterCount)));
}

function splitReading(sentences: string[]): string[][] {
  if (!sentences.length) return [];
  const pageCount = readingPageCount(sentences);
  const pages: string[][] = [];
  let cursor = 0;
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const remainingSentences = sentences.length - cursor;
    const remainingPages = pageCount - pageIndex;
    const take = Math.ceil(remainingSentences / remainingPages);
    pages.push(sentences.slice(cursor, cursor + take));
    cursor += take;
  }
  return pages;
}

function lessonStage(source: MaterialSource, preferredIndex: number, titleFragment: string) {
  return source.lesson_plan.stages.find((stage) => cleanText(stage.title).includes(titleFragment))
    ?? source.lesson_plan.stages[preferredIndex];
}

function studentActivityLines(
  stage: MaterialSource["lesson_plan"]["stages"][number] | undefined,
  fallback: string,
): string[] {
  if (!stage) return [fallback];
  return safeStudentLines(stage.prompts, fallback).slice(0, 6);
}

function questionLine(question: MaterialSource["questions"][number], index: number): string {
  const options = compactLines(question.options).map((option, optionIndex) => {
    const alreadyLabelled = /^[A-D][.、．\s]/i.test(option);
    return alreadyLabelled ? option : `${String.fromCharCode(65 + optionIndex)}. ${option}`;
  });
  return `${index + 1}. ${cleanText(question.q)}${options.length ? `　${options.join("　")}` : ""}`;
}

function buildLessonDraft(source: MaterialSource, title: string, level: string): LessonDraft {
  return {
    title,
    level,
    totalMinutes: Number(source.lesson_plan.total_minutes) || EXPECTED_TOTAL_MINUTES,
    objectives: compactLines(source.lesson_plan.objectives),
    rewrittenTitle: cleanText(source.rewritten.title) || "分级改写",
    rewrittenSentences: compactLines(source.rewritten.sentences.map((sentence) => sentence.text)),
    vocabulary: source.vocab.map((item) => ({
      word: cleanText(item.word),
      pos: cleanText(item.pos),
      meaning: cleanText(item.meaning),
      example: cleanText(item.example),
      pitfall: cleanText(item.pitfall),
      sinoViet: cleanText(item.sino_viet),
    })),
    stages: source.lesson_plan.stages.map((stage, index) => ({
      id: `lesson-stage-${index + 1}`,
      title: cleanText(stage.title),
      startMinute: Number(stage.start_minute),
      endMinute: Number(stage.end_minute),
      duration: Number(stage.duration),
      objective: cleanText(stage.objective),
      teacherActions: compactLines(stage.teacher_actions),
      studentActions: compactLines(stage.student_actions),
      prompts: compactLines(stage.prompts),
      materials: compactLines(stage.materials),
      expectedOutput: cleanText(stage.expected_output),
    })),
    homework: cleanText(source.lesson_plan.homework),
    teacherNotes: cleanText(source.rewritten.teacher_notes),
  };
}

function buildDeckDraft(source: MaterialSource, title: string, level: string): DeckDraft {
  const readingPages = splitReading(compactLines(source.rewritten.sentences.map((sentence) => sentence.text)));
  const warmupStage = lessonStage(source, 0, "导入");
  const interactionStage = lessonStage(source, 3, "互动");
  const summaryStage = lessonStage(source, source.lesson_plan.stages.length - 1, "总结");

  const slides: MaterialSlide[] = [
    {
      id: "slide-title",
      kind: "title",
      title,
      body: [`${level} 分级阅读`],
    },
    {
      id: "slide-warmup",
      kind: "warmup",
      title: "先想一想",
      body: studentActivityLines(warmupStage, "观察标题，说一说你想到的内容。"),
    },
    ...readingPages.map((sentences, index): MaterialSlide => ({
      id: `slide-reading-${index + 1}`,
      kind: "reading",
      title: readingPages.length === 1 ? cleanText(source.rewritten.title) || "分级阅读" : `分级阅读 ${index + 1}`,
      body: sentences,
    })),
    {
      id: "slide-vocabulary",
      kind: "vocabulary",
      title: "生词与表达",
      body: source.vocab.length
        ? source.vocab.slice(0, 8).map((item) => {
          const pos = cleanText(item.pos);
          const label = `${cleanText(item.word)}${pos ? `（${pos}）` : ""}`;
          const example = cleanText(item.example);
          return `${label}：${cleanText(item.meaning)}${example ? `｜例：${example}` : ""}`;
        })
        : compactLines(source.meta.target_words ?? []).map((word) => `${word}：请联系上下文猜一猜`).slice(0, 8),
    },
    {
      id: "slide-practice",
      kind: "practice",
      title: "读懂了吗？",
      body: source.questions.length
        ? source.questions.slice(0, 3).map(questionLine)
        : ["用自己的话说一说文章的主要内容。"],
    },
    {
      id: "slide-interaction",
      kind: "interaction",
      title: "一起说一说",
      body: studentActivityLines(interactionStage, "和同伴交换想法，并说明理由。"),
    },
    {
      id: "slide-summary",
      kind: "summary",
      title: "回顾与迁移",
      body: safeStudentLines([
        ...studentActivityLines(summaryStage, "用一句话总结今天的阅读内容。"),
        source.lesson_plan.homework,
      ], "用一句话总结今天的阅读内容。"),
    },
  ];

  return { title, level, slides: slides.slice(0, MAX_SLIDES) };
}

function buildWorksheetDraft(source: MaterialSource, title: string, level: string): WorksheetDraft {
  return {
    title: `${title}｜课后练习`,
    level,
    instructions: "请先独立完成，再回到文章中检查自己的作答。",
    questions: source.questions.map((question, index) => ({
      id: `worksheet-question-${index + 1}`,
      type: cleanText(question.type) || "阅读理解",
      prompt: cleanText(question.q),
      options: compactLines(question.options),
      answer: cleanText(question.answer),
      followUp: cleanText(question.follow_up),
    })),
    homework: cleanText(source.lesson_plan.homework),
  };
}

export function createMaterialDraft(source: MaterialSource): MaterialDraft {
  const title = cleanText(source.lesson_plan.title) || cleanText(source.rewritten.title) || "分级中文阅读课";
  const level = cleanText(source.meta.level) || "HSK";
  return {
    lesson: buildLessonDraft(source, title, level),
    deck: buildDeckDraft(source, title, level),
    worksheet: buildWorksheetDraft(source, title, level),
  };
}

export function validateLessonDraft(draft: LessonDraft): string[] {
  const errors: string[] = [];
  if (!cleanText(draft.title)) errors.push("教师详案：标题不能为空");
  if (!cleanText(draft.level)) errors.push("教师详案：学习等级不能为空");
  if (draft.totalMinutes !== EXPECTED_TOTAL_MINUTES) errors.push("教师详案：课堂总时长必须为 30 分钟");
  if (!compactLines(draft.objectives).length) errors.push("教师详案：至少需要一个教学目标");
  if (!cleanText(draft.rewrittenTitle)) errors.push("教师详案：改写课文标题不能为空");
  if (!compactLines(draft.rewrittenSentences).length) errors.push("教师详案：改写课文不能为空");
  if (!draft.vocabulary.length) errors.push("教师详案：至少需要一个核心词汇");
  if (!cleanText(draft.homework)) errors.push("教师详案：课后任务不能为空");
  if (draft.stages.length !== EXPECTED_STAGE_COUNT) errors.push("教师详案：必须保留五个课堂阶段");

  const stageIds = new Set<string>();
  draft.stages.forEach((stage, index) => {
    const location = `教师详案：第 ${index + 1} 阶段`;
    if (!cleanText(stage.id) || stageIds.has(stage.id)) errors.push(`${location}编号无效或重复`);
    stageIds.add(stage.id);
    if (!cleanText(stage.title)) errors.push(`${location}缺少标题`);
    if (!cleanText(stage.objective)) errors.push(`${location}缺少阶段目标`);
    if (!compactLines(stage.teacherActions).length) errors.push(`${location}缺少教师活动`);
    if (!compactLines(stage.studentActions).length) errors.push(`${location}缺少学生活动`);
    if (!compactLines(stage.prompts).length) errors.push(`${location}缺少课堂提示语`);
    if (!compactLines(stage.materials).length) errors.push(`${location}缺少使用材料`);
    if (!cleanText(stage.expectedOutput)) errors.push(`${location}缺少可见产出`);
    if (!Number.isFinite(stage.startMinute) || !Number.isFinite(stage.endMinute) || !Number.isFinite(stage.duration)) {
      errors.push(`${location}时间无效`);
    } else {
      if (stage.endMinute <= stage.startMinute) errors.push(`${location}结束时间必须晚于开始时间`);
      if (stage.duration !== stage.endMinute - stage.startMinute) errors.push(`${location}时长与起止时间不一致`);
      if (index === 0 && stage.startMinute !== 0) errors.push("教师详案：第一阶段必须从 0 分钟开始");
      if (index > 0 && stage.startMinute !== draft.stages[index - 1].endMinute) errors.push(`${location}与上一阶段时间不连续`);
      if (index === draft.stages.length - 1 && stage.endMinute !== EXPECTED_TOTAL_MINUTES) errors.push("教师详案：最后阶段必须在第 30 分钟结束");
    }
  });

  draft.vocabulary.forEach((item, index) => {
    if (!cleanText(item.word)) errors.push(`教师详案：第 ${index + 1} 个词汇缺少词语`);
    if (!cleanText(item.meaning)) errors.push(`教师详案：第 ${index + 1} 个词汇缺少释义`);
  });
  return uniqueErrors(errors);
}

export function getDeckVisibleText(draft: DeckDraft): string[] {
  return compactLines([
    draft.title,
    draft.level,
    ...draft.slides.flatMap((slide) => [slide.title, ...slide.body]),
  ]);
}

export function validateDeckDraft(draft: DeckDraft): string[] {
  const errors: string[] = [];
  if (!cleanText(draft.title)) errors.push("学生课件：标题不能为空");
  if (!cleanText(draft.level)) errors.push("学生课件：学习等级不能为空");
  [draft.title, draft.level].forEach((line) => {
    const leak = studentContentLeak(line);
    if (leak) errors.push(`学生课件：标题区包含${leak}：“${line.slice(0, 32)}”`);
  });
  if (draft.slides.length < MIN_SLIDES || draft.slides.length > MAX_SLIDES) {
    errors.push(`学生课件：必须保持 ${MIN_SLIDES}–${MAX_SLIDES} 页`);
  }
  const slideIds = new Set<string>();
  draft.slides.forEach((slide, index) => {
    const location = `学生课件：第 ${index + 1} 页`;
    if (!cleanText(slide.id) || slideIds.has(slide.id)) errors.push(`${location}页面编号无效或重复`);
    slideIds.add(slide.id);
    if (!cleanText(slide.title)) errors.push(`${location}缺少标题`);
    const body = compactLines(slide.body);
    if (!body.length) errors.push(`${location}缺少正文`);
    if (body.length > 10) errors.push(`${location}最多保留 10 行内容`);
    if (body.join("").length > 700) errors.push(`${location}内容过多，请精简后导出`);
    [slide.title, ...body].forEach((line) => {
      const leak = studentContentLeak(line);
      if (leak) errors.push(`${location}包含${leak}：“${line.slice(0, 32)}”`);
    });
  });
  return uniqueErrors(errors);
}

export function getWorksheetVisibleText(draft: WorksheetDraft, teacherVersion: boolean): string[] {
  const questionText = draft.questions.flatMap((question) => [
    question.type,
    question.prompt,
    ...question.options,
    ...(teacherVersion ? [question.answer, question.followUp] : []),
  ]);
  return compactLines([draft.title, draft.level, draft.instructions, ...questionText, draft.homework]);
}

export function validateWorksheetDraft(draft: WorksheetDraft): string[] {
  const errors: string[] = [];
  if (!cleanText(draft.title)) errors.push("课后练习：标题不能为空");
  if (!cleanText(draft.level)) errors.push("课后练习：学习等级不能为空");
  if (!cleanText(draft.instructions)) errors.push("课后练习：练习说明不能为空");
  if (!draft.questions.length) errors.push("课后练习：至少需要一道题");
  if (!cleanText(draft.homework)) errors.push("课后练习：课后任务不能为空");

  const questionIds = new Set<string>();
  draft.questions.forEach((question, index) => {
    const location = `课后练习：第 ${index + 1} 题`;
    if (!cleanText(question.id) || questionIds.has(question.id)) errors.push(`${location}编号无效或重复`);
    questionIds.add(question.id);
    if (!cleanText(question.type)) errors.push(`${location}缺少题型`);
    if (!cleanText(question.prompt)) errors.push(`${location}缺少题干`);
    if (question.options.some((option) => !cleanText(option))) errors.push(`${location}含有空选项`);
    if (!cleanText(question.answer)) errors.push(`${location}缺少教师答案`);
  });
  getWorksheetVisibleText(draft, false).forEach((line) => {
    const leak = studentContentLeak(line);
    if (leak) errors.push(`课后练习：学生可见内容包含${leak}：“${line.slice(0, 32)}”`);
  });
  return uniqueErrors(errors);
}

export function sanitizeFileName(value: string): string {
  const cleaned = value
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .replace(/[. -]+$/g, "")
    .trim()
    .slice(0, 80);
  if (!cleaned) return "课堂材料";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)) return `课堂材料-${cleaned}`;
  return cleaned;
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function slideBodyFontSize(slide: MaterialSlide): number {
  const longestLine = Math.max(0, ...slide.body.map((line) => line.length));
  const densityPenalty = Math.max(0, slide.body.length - 4) * 1.4 + Math.max(0, longestLine - 42) * 0.09;
  return Math.max(16, Math.min(24, 23 - densityPenalty));
}

export async function exportDeckToPptx(draft: DeckDraft): Promise<void> {
  const errors = validateDeckDraft(draft);
  if (errors.length) throw new Error(errors.join("；"));

  const { default: PptxGenJS } = await import("pptxgenjs");
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "全世界都在说中国话";
  pptx.company = "全世界都在说中国话";
  pptx.subject = `${draft.level} 中文课堂材料`;
  pptx.title = draft.title;
  pptx.theme = { headFontFace: FONT_FACE, bodyFontFace: FONT_FACE };

  draft.slides.forEach((materialSlide, index) => {
    const slide = pptx.addSlide();
    slide.background = { color: COLORS.paper };
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 0.13, fill: { color: COLORS.moss }, line: { color: COLORS.moss } });
    slide.addText(`${draft.level} · ${materialSlide.kind.toUpperCase()}`, {
      x: 10.45, y: 0.46, w: 1.9, h: 0.24, fontFace: FONT_FACE, fontSize: 9, bold: true,
      color: COLORS.moss, align: "right", margin: 0, breakLine: false,
    });
    slide.addText(materialSlide.title, {
      x: 0.88, y: materialSlide.kind === "title" ? 1.45 : 0.78, w: 10.8, h: materialSlide.kind === "title" ? 1.15 : 0.72,
      fontFace: FONT_FACE, fontSize: materialSlide.kind === "title" ? 50 : 35, bold: true,
      color: COLORS.ink, margin: 0, breakLine: false, fit: "shrink",
    });
    slide.addShape(pptx.ShapeType.line, {
      x: 0.88, y: materialSlide.kind === "title" ? 2.75 : 1.62, w: 1.05, h: 0,
      line: { color: COLORS.coral, width: 4, beginArrowType: "none", endArrowType: "none" },
    });

    const lines = compactLines(materialSlide.body);
    const fontSize = materialSlide.kind === "title" ? 24 : slideBodyFontSize(materialSlide);
    const startY = materialSlide.kind === "title" ? 3.18 : 2.0;
    const availableHeight = materialSlide.kind === "title" ? 2.6 : 4.7;
    const rowHeight = Math.min(0.82, availableHeight / Math.max(lines.length, 1));
    lines.forEach((line, lineIndex) => {
      const y = startY + lineIndex * rowHeight;
      slide.addShape(pptx.ShapeType.ellipse, {
        x: 0.92, y: y + Math.max(0.12, rowHeight * 0.34), w: 0.11, h: 0.11,
        fill: { color: COLORS.coral }, line: { color: COLORS.coral },
      });
      slide.addText(line, {
        x: 1.18, y, w: 10.85, h: Math.max(0.42, rowHeight - 0.04), fontFace: FONT_FACE,
        fontSize, color: COLORS.muted, margin: 0, valign: "middle", breakLine: false, fit: "shrink",
      });
    });
    slide.addText(`${index + 1} / ${draft.slides.length}`, {
      x: 11.65, y: 7.05, w: 0.75, h: 0.18, fontFace: FONT_FACE, fontSize: 8,
      color: "A3ADA7", align: "right", margin: 0,
    });
  });

  await pptx.writeFile({ fileName: `${sanitizeFileName(`${draft.title}-${draft.level}-学生课件`)}.pptx`, compression: true });
}

type DocxModule = typeof import("docx");

function textRun(docx: DocxModule, text: string, options: { bold?: boolean; color?: string; size?: number; italics?: boolean } = {}) {
  return new docx.TextRun({
    text,
    font: FONT_FACE,
    size: options.size ?? 22,
    bold: options.bold,
    color: options.color ?? COLORS.ink,
    italics: options.italics,
  });
}

function bodyParagraph(docx: DocxModule, text: string, options: { bold?: boolean; color?: string; size?: number; before?: number; after?: number } = {}) {
  return new docx.Paragraph({
    spacing: { before: options.before ?? 0, after: options.after ?? 120, line: 300 },
    children: [textRun(docx, text, options)],
  });
}

function headingParagraph(docx: DocxModule, text: string, level: "h1" | "h2" | "h3") {
  const config = {
    h1: { heading: docx.HeadingLevel.HEADING_1, size: 32, before: 360, after: 200, color: COLORS.moss },
    h2: { heading: docx.HeadingLevel.HEADING_2, size: 26, before: 280, after: 140, color: COLORS.moss },
    h3: { heading: docx.HeadingLevel.HEADING_3, size: 24, before: 200, after: 100, color: "1F4D78" },
  }[level];
  return new docx.Paragraph({
    heading: config.heading,
    spacing: { before: config.before, after: config.after },
    keepNext: true,
    children: [textRun(docx, text, { bold: true, color: config.color, size: config.size })],
  });
}

function bulletParagraph(docx: DocxModule, text: string, reference: string) {
  return new docx.Paragraph({
    numbering: { reference, level: 0 },
    spacing: { after: 80, line: 300 },
    children: [textRun(docx, text)],
  });
}

function tableCell(docx: DocxModule, children: InstanceType<DocxModule["Paragraph"]>[], width: number, fill?: string) {
  return new docx.TableCell({
    width: { size: width, type: docx.WidthType.DXA },
    margins: { top: 100, bottom: 100, left: 120, right: 120 },
    verticalAlign: docx.VerticalAlign.CENTER,
    shading: fill ? { fill, type: docx.ShadingType.CLEAR, color: "auto" } : undefined,
    children,
  });
}

function compactDocxStyles(docx: DocxModule) {
  return {
    default: {
      document: {
        run: { font: FONT_FACE, size: 22, color: COLORS.ink },
        paragraph: { spacing: { after: 120, line: 300 } },
      },
    },
    paragraphStyles: [
      {
        id: "Title",
        name: "Title",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { font: FONT_FACE, size: 46, bold: true, color: COLORS.ink },
        paragraph: { spacing: { before: 0, after: 160 } },
      },
      {
        id: "Heading1",
        name: "Heading 1",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { font: FONT_FACE, size: 32, bold: true, color: COLORS.moss },
        paragraph: { spacing: { before: 360, after: 200 }, keepNext: true },
      },
      {
        id: "Heading2",
        name: "Heading 2",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { font: FONT_FACE, size: 26, bold: true, color: COLORS.moss },
        paragraph: { spacing: { before: 280, after: 140 }, keepNext: true },
      },
      {
        id: "Heading3",
        name: "Heading 3",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { font: FONT_FACE, size: 24, bold: true, color: "1F4D78" },
        paragraph: { spacing: { before: 200, after: 100 }, keepNext: true },
      },
    ],
  };
}

function docxNumbering(docx: DocxModule) {
  return {
    config: [
      {
        reference: "material-bullets",
        levels: [{
          level: 0,
          format: docx.LevelFormat.BULLET,
          text: "•",
          alignment: docx.AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 540, hanging: 270 }, spacing: { after: 80, line: 300 } } },
        }],
      },
      {
        reference: "worksheet-questions",
        levels: [{
          level: 0,
          format: docx.LevelFormat.DECIMAL,
          text: "%1.",
          alignment: docx.AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 540, hanging: 270 }, spacing: { after: 100, line: 300 } } },
        }],
      },
    ],
  };
}

export function getLessonVisibleText(draft: LessonDraft): string[] {
  return compactLines([
    draft.title,
    draft.level,
    ...draft.objectives,
    draft.rewrittenTitle,
    ...draft.rewrittenSentences,
    ...draft.vocabulary.flatMap((item) => [item.word, item.pos, item.meaning, item.example, item.pitfall, item.sinoViet]),
    ...draft.stages.flatMap((stage) => [
      stage.title,
      stage.objective,
      ...stage.teacherActions,
      ...stage.studentActions,
      ...stage.prompts,
      ...stage.materials,
      stage.expectedOutput,
    ]),
    draft.homework,
    draft.teacherNotes,
  ]);
}

export async function buildLessonDocxBlob(draft: LessonDraft): Promise<Blob> {
  const errors = validateLessonDraft(draft);
  if (errors.length) throw new Error(errors.join("；"));
  const docx = await import("docx");
  const children: (InstanceType<typeof docx.Paragraph> | InstanceType<typeof docx.Table>)[] = [];

  children.push(new docx.Paragraph({
    spacing: { before: 0, after: 80 },
    children: [textRun(docx, "课堂教学详案", { bold: true, color: COLORS.moss, size: 20 })],
  }));
  children.push(new docx.Paragraph({
    heading: docx.HeadingLevel.TITLE,
    spacing: { after: 120 },
    children: [textRun(docx, draft.title, { bold: true, size: 46 })],
  }));
  children.push(bodyParagraph(docx, `${draft.level} 中文阅读课`, { color: COLORS.muted, size: 26, after: 260 }));

  const metricWidths = [2340, 2340, 2340, 2340];
  children.push(new docx.Table({
    width: { size: 9360, type: docx.WidthType.DXA },
    indent: { size: 120, type: docx.WidthType.DXA },
    layout: docx.TableLayoutType.FIXED,
    columnWidths: metricWidths,
    rows: [new docx.TableRow({ children: [
      tableCell(docx, [bodyParagraph(docx, "课堂时长", { bold: true, color: COLORS.moss, size: 18, after: 40 }), bodyParagraph(docx, `${draft.totalMinutes} 分钟`, { bold: true, size: 24, after: 0 })], metricWidths[0], "FFF8E8"),
      tableCell(docx, [bodyParagraph(docx, "课堂阶段", { bold: true, color: COLORS.moss, size: 18, after: 40 }), bodyParagraph(docx, `${draft.stages.length} 个`, { bold: true, size: 24, after: 0 })], metricWidths[1], "FFF8E8"),
      tableCell(docx, [bodyParagraph(docx, "核心词汇", { bold: true, color: COLORS.moss, size: 18, after: 40 }), bodyParagraph(docx, `${draft.vocabulary.length} 个`, { bold: true, size: 24, after: 0 })], metricWidths[2], "FFF8E8"),
      tableCell(docx, [bodyParagraph(docx, "练习等级", { bold: true, color: COLORS.moss, size: 18, after: 40 }), bodyParagraph(docx, draft.level, { bold: true, size: 24, after: 0 })], metricWidths[3], "FFF8E8"),
    ] })],
  }));

  children.push(headingParagraph(docx, "一、课程概览", "h1"));
  children.push(headingParagraph(docx, "教学目标", "h2"));
  draft.objectives.forEach((objective) => children.push(bulletParagraph(docx, objective, "material-bullets")));

  children.push(headingParagraph(docx, "二、改写课文与核心词汇", "h1"));
  children.push(headingParagraph(docx, draft.rewrittenTitle, "h2"));
  draft.rewrittenSentences.forEach((sentence) => children.push(bodyParagraph(docx, sentence)));
  children.push(headingParagraph(docx, "核心词汇", "h2"));
  const vocabWidths = [1500, 2160, 2850, 2850];
  const vocabRows = [new docx.TableRow({ tableHeader: true, children: [
    tableCell(docx, [bodyParagraph(docx, "词语", { bold: true, after: 0 })], vocabWidths[0], COLORS.tableHeader),
    tableCell(docx, [bodyParagraph(docx, "释义", { bold: true, after: 0 })], vocabWidths[1], COLORS.tableHeader),
    tableCell(docx, [bodyParagraph(docx, "例句", { bold: true, after: 0 })], vocabWidths[2], COLORS.tableHeader),
    tableCell(docx, [bodyParagraph(docx, "备课提示", { bold: true, after: 0 })], vocabWidths[3], COLORS.tableHeader),
  ] })];
  draft.vocabulary.forEach((item) => vocabRows.push(new docx.TableRow({ children: [
    tableCell(docx, [bodyParagraph(docx, `${item.word}${item.pos ? `（${item.pos}）` : ""}`, { bold: true, after: 0 })], vocabWidths[0]),
    tableCell(docx, [bodyParagraph(docx, item.meaning, { after: 0 })], vocabWidths[1]),
    tableCell(docx, [bodyParagraph(docx, item.example || "—", { after: 0 })], vocabWidths[2]),
    tableCell(docx, [bodyParagraph(docx, compactLines([item.pitfall, item.sinoViet && `汉越词：${item.sinoViet}`]).join("；") || "—", { after: 0 })], vocabWidths[3]),
  ] })));
  children.push(new docx.Table({
    width: { size: 9360, type: docx.WidthType.DXA },
    indent: { size: 120, type: docx.WidthType.DXA },
    layout: docx.TableLayoutType.FIXED,
    columnWidths: vocabWidths,
    rows: vocabRows,
  }));

  children.push(headingParagraph(docx, "三、30 分钟教学流程", "h1"));
  const stageWidths = [1200, 1800, 6360];
  const stageRows = [new docx.TableRow({ tableHeader: true, children: [
    tableCell(docx, [bodyParagraph(docx, "时间", { bold: true, after: 0 })], stageWidths[0], COLORS.tableHeader),
    tableCell(docx, [bodyParagraph(docx, "阶段", { bold: true, after: 0 })], stageWidths[1], COLORS.tableHeader),
    tableCell(docx, [bodyParagraph(docx, "师生活动与产出", { bold: true, after: 0 })], stageWidths[2], COLORS.tableHeader),
  ] })];
  draft.stages.forEach((stage) => {
    const detail: InstanceType<typeof docx.Paragraph>[] = [
      bodyParagraph(docx, `阶段目标：${stage.objective}`, { bold: true, after: 80 }),
      ...stage.teacherActions.map((line) => bodyParagraph(docx, `教师：${line}`, { after: 60 })),
      ...stage.studentActions.map((line) => bodyParagraph(docx, `学生：${line}`, { after: 60 })),
      ...stage.prompts.map((line) => bodyParagraph(docx, `提示语：${line}`, { color: COLORS.moss, after: 60 })),
      bodyParagraph(docx, `使用材料：${stage.materials.join("、")}`, { after: 60 }),
      bodyParagraph(docx, `可见产出：${stage.expectedOutput}`, { bold: true, color: COLORS.coral, after: 0 }),
    ];
    stageRows.push(new docx.TableRow({ children: [
      tableCell(docx, [bodyParagraph(docx, `${stage.startMinute}–${stage.endMinute} 分钟`, { bold: true, after: 0 })], stageWidths[0]),
      tableCell(docx, [bodyParagraph(docx, stage.title, { bold: true, after: 0 })], stageWidths[1]),
      tableCell(docx, detail, stageWidths[2]),
    ] }));
  });
  children.push(new docx.Table({
    width: { size: 9360, type: docx.WidthType.DXA },
    indent: { size: 120, type: docx.WidthType.DXA },
    layout: docx.TableLayoutType.FIXED,
    columnWidths: stageWidths,
    rows: stageRows,
  }));

  children.push(headingParagraph(docx, "四、课后任务与教师备注", "h1"));
  children.push(headingParagraph(docx, "课后任务", "h2"));
  children.push(bodyParagraph(docx, draft.homework));
  children.push(headingParagraph(docx, "教师备注", "h2"));
  children.push(bodyParagraph(docx, draft.teacherNotes || "无补充备注。", { color: COLORS.muted }));

  const document = new docx.Document({
    creator: "全世界都在说中国话",
    title: draft.title,
    description: `${draft.level} 中文阅读课教师详案`,
    styles: compactDocxStyles(docx),
    numbering: docxNumbering(docx),
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440, header: 708, footer: 708 },
        },
      },
      headers: {
        default: new docx.Header({ children: [new docx.Paragraph({
          alignment: docx.AlignmentType.RIGHT,
          children: [textRun(docx, `${draft.level}｜课堂教学详案`, { color: "8A9690", size: 17 })],
        })] }),
      },
      footers: {
        default: new docx.Footer({ children: [new docx.Paragraph({
          alignment: docx.AlignmentType.RIGHT,
          children: [textRun(docx, "第 ", { color: "8A9690", size: 17 }), new docx.TextRun({ children: [docx.PageNumber.CURRENT], font: FONT_FACE, size: 17, color: "8A9690" }), textRun(docx, " 页", { color: "8A9690", size: 17 })],
        })] }),
      },
      children,
    }],
  });
  return docx.Packer.toBlob(document);
}

export async function exportLessonToDocx(draft: LessonDraft): Promise<void> {
  const blob = await buildLessonDocxBlob(draft);
  saveBlob(blob, `${sanitizeFileName(`${draft.title}-${draft.level}-教师详案`)}.docx`);
}

export async function buildWorksheetDocxBlob(draft: WorksheetDraft, teacherVersion: boolean): Promise<Blob> {
  const errors = validateWorksheetDraft(draft);
  if (errors.length) throw new Error(errors.join("；"));
  const docx = await import("docx");
  const children: InstanceType<typeof docx.Paragraph>[] = [
    new docx.Paragraph({
      heading: docx.HeadingLevel.TITLE,
      alignment: docx.AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [textRun(docx, draft.title, { size: 38, bold: true })],
    }),
    new docx.Paragraph({
      alignment: docx.AlignmentType.CENTER,
      spacing: { after: 260 },
      children: [textRun(docx, teacherVersion ? `${draft.level}｜教师答案版` : `${draft.level}｜学生练习版`, { size: 20, bold: true, color: COLORS.moss })],
    }),
    bodyParagraph(docx, "姓名：_______________　班级：_______________　日期：_______________", { color: COLORS.muted, size: 20 }),
    bodyParagraph(docx, draft.instructions, { color: COLORS.muted }),
  ];

  draft.questions.forEach((question) => {
    children.push(new docx.Paragraph({
      numbering: { reference: "worksheet-questions", level: 0 },
      spacing: { before: 220, after: 100, line: 300 },
      children: [textRun(docx, `[${question.type}] ${question.prompt}`, { size: 23, bold: true })],
    }));
    compactLines(question.options).forEach((option, optionIndex) => {
      const prefix = /^[A-D][.、．\s]/i.test(option) ? "" : `${String.fromCharCode(65 + optionIndex)}. `;
      children.push(new docx.Paragraph({
        indent: { left: 720 },
        spacing: { after: 80 },
        children: [textRun(docx, `${prefix}${option}`, { size: 21, color: COLORS.muted })],
      }));
    });
    if (teacherVersion) {
      children.push(bodyParagraph(docx, `答案：${question.answer}`, { bold: true, color: COLORS.coral, size: 20 }));
      if (cleanText(question.followUp)) children.push(bodyParagraph(docx, `追问参考：${question.followUp}`, { color: COLORS.moss, size: 20 }));
    } else {
      children.push(bodyParagraph(docx, "作答：_______________________________________________________________", { color: "9AA5A0", size: 19 }));
    }
  });

  children.push(headingParagraph(docx, "课后任务", "h2"));
  children.push(bodyParagraph(docx, draft.homework));

  const document = new docx.Document({
    creator: "全世界都在说中国话",
    title: draft.title,
    description: `${draft.level} 中文课后练习`,
    styles: compactDocxStyles(docx),
    numbering: docxNumbering(docx),
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1200, right: 1200, bottom: 1200, left: 1200, header: 708, footer: 708 },
        },
      },
      children,
    }],
  });
  return docx.Packer.toBlob(document);
}

export async function exportWorksheetToDocx(draft: WorksheetDraft, teacherVersion: boolean): Promise<void> {
  const blob = await buildWorksheetDocxBlob(draft, teacherVersion);
  const suffix = teacherVersion ? "教师答案版" : "学生练习版";
  saveBlob(blob, `${sanitizeFileName(`${draft.title}-${draft.level}-${suffix}`)}.docx`);
}
