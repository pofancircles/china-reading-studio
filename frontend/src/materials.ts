export type MaterialSource = {
  rewritten: {
    title: string;
    sentences: { text: string; source_sentence_ids?: number[] }[];
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
      objective: string;
      teacher_actions: string[];
      student_actions: string[];
      prompts: string[];
      expected_output: string;
    }[];
    homework: string;
  };
  meta: {
    level: string;
    target_words?: string[];
  };
};

export type MaterialSlide = {
  id: string;
  kind: "title" | "warmup" | "reading" | "vocabulary" | "practice" | "interaction" | "summary";
  title: string;
  body: string[];
};

export type WorksheetQuestion = {
  id: string;
  prompt: string;
  options: string[];
  answer: string;
  followUp: string;
};

export type MaterialDraft = {
  title: string;
  level: string;
  slides: MaterialSlide[];
  worksheet: {
    title: string;
    instructions: string;
    questions: WorksheetQuestion[];
    homework: string;
  };
};

const COLORS = {
  ink: "17201F",
  paper: "F7F8F4",
  moss: "557A68",
  coral: "C96950",
  line: "DFE5DC",
  muted: "64748B",
  paleMoss: "E6F0E5",
};

const FONT_FACE = "Microsoft YaHei";
const MIN_SLIDES = 6;
const MAX_SLIDES = 10;

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function compactLines(lines: unknown[]): string[] {
  return lines.map(cleanText).filter(Boolean);
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
  return source.lesson_plan.stages.find((stage) => stage.title.includes(titleFragment))
    ?? source.lesson_plan.stages[preferredIndex];
}

function activityLines(stage: MaterialSource["lesson_plan"]["stages"][number] | undefined, fallback: string): string[] {
  if (!stage) return fallback ? [fallback] : [];
  return compactLines([
    stage.objective,
    ...stage.prompts,
    ...stage.student_actions,
    stage.expected_output,
  ]).slice(0, 6);
}

function questionLine(question: MaterialSource["questions"][number], index: number): string {
  const options = compactLines(question.options).map((option, optionIndex) => {
    const alreadyLabelled = /^[A-DＡ-Ｄ][.、\s]/i.test(option);
    return alreadyLabelled ? option : `${String.fromCharCode(65 + optionIndex)}. ${option}`;
  });
  return `${index + 1}. ${cleanText(question.q)}${options.length ? `｜${options.join("　")}` : ""}`;
}

export function createMaterialDraft(source: MaterialSource): MaterialDraft {
  const title = cleanText(source.lesson_plan.title) || cleanText(source.rewritten.title) || "分级中文阅读课";
  const level = cleanText(source.meta.level) || "HSK";
  const readingPages = splitReading(compactLines(source.rewritten.sentences.map((sentence) => sentence.text)));
  const warmupStage = lessonStage(source, 0, "导入");
  const interactionStage = lessonStage(source, 3, "交互");
  const summaryStage = lessonStage(source, source.lesson_plan.stages.length - 1, "总结");
  const objectives = compactLines(source.lesson_plan.objectives).slice(0, 3);
  const duration = source.lesson_plan.total_minutes > 0 ? `${source.lesson_plan.total_minutes} 分钟课堂材料` : "课堂阅读材料";

  const slides: MaterialSlide[] = [
    {
      id: "slide-title",
      kind: "title",
      title,
      body: compactLines([`${level} 分级阅读课`, duration, ...objectives.slice(0, 1)]),
    },
    {
      id: "slide-warmup",
      kind: "warmup",
      title: warmupStage?.title || "导入与热身",
      body: activityLines(warmupStage, ""),
    },
    ...readingPages.map((sentences, index): MaterialSlide => ({
      id: `slide-reading-${index + 1}`,
      kind: "reading",
      title: readingPages.length === 1 ? "分级阅读" : `分级阅读 ${index + 1}`,
      body: sentences,
    })),
    {
      id: "slide-vocabulary",
      kind: "vocabulary",
      title: "生词与表达",
      body: source.vocab.length
        ? source.vocab.slice(0, 8).map((item) => {
          const label = [cleanText(item.word), cleanText(item.pos) && `（${cleanText(item.pos)}）`].filter(Boolean).join("");
          const meaning = cleanText(item.meaning);
          const example = cleanText(item.example);
          return `${label}：${meaning}${example ? `｜例：${example}` : ""}`;
        })
        : compactLines(source.meta.target_words ?? []).map((word) => `目标词：${word}`).slice(0, 8),
    },
    {
      id: "slide-practice",
      kind: "practice",
      title: "阅读理解",
      body: source.questions.length
        ? source.questions.slice(0, 3).map(questionLine)
        : [],
    },
    {
      id: "slide-interaction",
      kind: "interaction",
      title: interactionStage?.title || "课堂互动",
      body: activityLines(interactionStage, ""),
    },
    {
      id: "slide-summary",
      kind: "summary",
      title: summaryStage?.title || "总结与迁移",
      body: compactLines([
        ...objectives.slice(0, 2),
        ...activityLines(summaryStage, "").slice(0, 3),
        source.lesson_plan.homework && `课后任务：${source.lesson_plan.homework}`,
      ]).slice(0, 6),
    },
  ];

  const worksheetQuestions: WorksheetQuestion[] = source.questions.map((question, index) => ({
    id: `worksheet-question-${index + 1}`,
    prompt: cleanText(question.q),
    options: compactLines(question.options),
    answer: cleanText(question.answer),
    followUp: cleanText(question.follow_up),
  }));

  return {
    title,
    level,
    slides: slides.slice(0, MAX_SLIDES),
    worksheet: {
      title: `${title}｜课后练习`,
      instructions: "请先独立完成，再回到文章中检查答案。",
      questions: worksheetQuestions,
      homework: cleanText(source.lesson_plan.homework),
    },
  };
}

export function validateMaterialDraft(draft: MaterialDraft): string[] {
  const errors: string[] = [];
  if (!cleanText(draft.title)) errors.push("材料标题不能为空");
  if (!cleanText(draft.level)) errors.push("学习等级不能为空");
  if (draft.slides.length < MIN_SLIDES || draft.slides.length > MAX_SLIDES) {
    errors.push(`PPT 必须保持 ${MIN_SLIDES}–${MAX_SLIDES} 页`);
  }

  const slideIds = new Set<string>();
  draft.slides.forEach((slide, index) => {
    if (!cleanText(slide.id) || slideIds.has(slide.id)) errors.push(`第 ${index + 1} 页的页面编号无效或重复`);
    slideIds.add(slide.id);
    if (!cleanText(slide.title)) errors.push(`第 ${index + 1} 页缺少标题`);
    const body = compactLines(slide.body);
    if (!body.length) errors.push(`第 ${index + 1} 页缺少正文`);
    if (body.length > 10) errors.push(`第 ${index + 1} 页最多保留 10 行内容`);
    if (body.join("").length > 700) errors.push(`第 ${index + 1} 页内容过多，请精简后导出`);
  });

  if (!cleanText(draft.worksheet.title)) errors.push("练习标题不能为空");
  if (!cleanText(draft.worksheet.instructions)) errors.push("练习说明不能为空");
  if (!draft.worksheet.questions.length) errors.push("课后练习至少需要一道题");
  if (!cleanText(draft.worksheet.homework)) errors.push("课后任务不能为空");

  const questionIds = new Set<string>();
  draft.worksheet.questions.forEach((question, index) => {
    if (!cleanText(question.id) || questionIds.has(question.id)) errors.push(`第 ${index + 1} 题的编号无效或重复`);
    questionIds.add(question.id);
    if (!cleanText(question.prompt)) errors.push(`第 ${index + 1} 题缺少题干`);
    if (question.options.some((option) => !cleanText(option))) errors.push(`第 ${index + 1} 题含有空选项`);
  });
  return Array.from(new Set(errors));
}

export function sanitizeFileName(value: string): string {
  const cleaned = value
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .replace(/[. ]+$/g, "")
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

export async function exportDeckToPptx(draft: MaterialDraft): Promise<void> {
  const errors = validateMaterialDraft(draft);
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
    slide.addShape(pptx.ShapeType.roundRect, { x: 10.65, y: 0.42, w: 1.75, h: 0.42, rectRadius: 0.06, fill: { color: COLORS.paleMoss }, line: { color: COLORS.paleMoss } });
    slide.addText(`${draft.level} · ${materialSlide.kind.toUpperCase()}`, {
      x: 10.72, y: 0.49, w: 1.61, h: 0.2, fontFace: FONT_FACE, fontSize: 9, bold: true,
      color: COLORS.moss, align: "center", margin: 0, breakLine: false,
    });
    slide.addText(materialSlide.title, {
      x: 0.88, y: materialSlide.kind === "title" ? 1.25 : 0.78, w: 10.5, h: materialSlide.kind === "title" ? 1.1 : 0.72,
      fontFace: FONT_FACE, fontSize: materialSlide.kind === "title" ? 48 : 35, bold: true,
      color: COLORS.ink, margin: 0, breakLine: false, fit: "shrink",
    });
    slide.addShape(pptx.ShapeType.line, {
      x: 0.88, y: materialSlide.kind === "title" ? 2.55 : 1.62, w: 1.05, h: 0,
      line: { color: COLORS.coral, width: 4, beginArrowType: "none", endArrowType: "none" },
    });

    const lines = compactLines(materialSlide.body);
    const fontSize = materialSlide.kind === "title" ? 22 : slideBodyFontSize(materialSlide);
    const startY = materialSlide.kind === "title" ? 3.0 : 2.0;
    const availableHeight = materialSlide.kind === "title" ? 3.2 : 4.7;
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

  await pptx.writeFile({ fileName: `${sanitizeFileName(`${draft.title}-${draft.level}-课堂课件`)}.pptx`, compression: true });
}

export async function exportWorksheetToDocx(draft: MaterialDraft, teacherVersion: boolean): Promise<void> {
  const errors = validateMaterialDraft(draft);
  if (errors.length) throw new Error(errors.join("；"));

  const { AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun } = await import("docx");
  const paragraph = (text: string, options: { bold?: boolean; color?: string; size?: number } = {}) => new Paragraph({
    spacing: { after: 140, line: 320 },
    children: [new TextRun({
      text,
      font: FONT_FACE,
      size: options.size ?? 22,
      bold: options.bold,
      color: options.color ?? COLORS.ink,
    })],
  });
  const children: InstanceType<typeof Paragraph>[] = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 160 },
      children: [new TextRun({ text: draft.worksheet.title, font: FONT_FACE, size: 34, bold: true, color: COLORS.ink })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 300 },
      children: [new TextRun({
        text: teacherVersion ? `${draft.level}｜教师答案版` : `${draft.level}｜学生练习版`,
        font: FONT_FACE, size: 20, bold: true, color: COLORS.moss,
      })],
    }),
    paragraph("姓名：________________　班级：________________　日期：________________", { color: COLORS.muted, size: 20 }),
    paragraph(draft.worksheet.instructions, { color: COLORS.muted }),
  ];

  draft.worksheet.questions.forEach((question, questionIndex) => {
    children.push(new Paragraph({
      spacing: { before: 220, after: 120, line: 340 },
      children: [new TextRun({ text: `${questionIndex + 1}. ${question.prompt}`, font: FONT_FACE, size: 23, bold: true, color: COLORS.ink })],
    }));
    compactLines(question.options).forEach((option, optionIndex) => {
      const prefix = /^[A-DＡ-Ｄ][.、\s]/i.test(option) ? "" : `${String.fromCharCode(65 + optionIndex)}. `;
      children.push(new Paragraph({
        indent: { left: 360 },
        spacing: { after: 80 },
        children: [new TextRun({ text: `${prefix}${option}`, font: FONT_FACE, size: 21, color: COLORS.muted })],
      }));
    });
    if (teacherVersion) {
      children.push(paragraph(`答案：${cleanText(question.answer) || "开放题，无固定答案"}`, { bold: true, color: COLORS.coral, size: 20 }));
      if (cleanText(question.followUp)) children.push(paragraph(`追问：${question.followUp}`, { color: COLORS.moss, size: 20 }));
    } else {
      children.push(paragraph("作答：________________________________________________________________", { color: "9AA5A0", size: 19 }));
    }
  });

  children.push(new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 320, after: 120 },
    children: [new TextRun({ text: "课后任务", font: FONT_FACE, size: 26, bold: true, color: COLORS.moss })],
  }));
  children.push(paragraph(draft.worksheet.homework));

  const document = new Document({
    creator: "全世界都在说中国话",
    title: draft.worksheet.title,
    description: `${draft.level} 中文课后练习`,
    sections: [{
      properties: {
        page: {
          margin: { top: 900, right: 900, bottom: 900, left: 900 },
        },
      },
      children,
    }],
  });
  const blob = await Packer.toBlob(document);
  const suffix = teacherVersion ? "教师答案版" : "学生练习版";
  saveBlob(blob, `${sanitizeFileName(`${draft.title}-${draft.level}-${suffix}`)}.docx`);
}
