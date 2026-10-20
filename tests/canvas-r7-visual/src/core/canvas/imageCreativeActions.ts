/** Pure, versioned prompt recipes. Selecting a recipe never submits a generation. */
export type ImageCreativeActionId = 'story-grid' | 'blocking-board' | 'multi-angle' | 'character-sheet' | 'scene-sheet' | 'product-sheet' | 'time-shift' | 'relight' | 'cinematic-grade';
export type CreativeRecipeOptions = {
  grid?: '2x2' | '3x3' | '5x5';
  direction?: 'before' | 'after';
  seconds?: 3 | 5;
  lighting?: 'soft-daylight' | 'golden-hour' | 'neon-night' | 'studio';
  tone?: 'natural-film' | 'warm-vintage' | 'cool-suspense' | 'black-white';
};
export type ImageCreativeRecipe = { version: 1; id: ImageCreativeActionId; options: CreativeRecipeOptions };
export type CreativeRecipeOptionKey = keyof CreativeRecipeOptions;
export type ImageCreativeAction = {
  id: ImageCreativeActionId;
  label: string;
  description: string;
  group: '分镜叙事' | '机位' | '设定' | '质感';
  icon: 'grid' | 'blocking' | 'camera' | 'character' | 'scene' | 'product' | 'time' | 'light' | 'film';
  options: readonly CreativeRecipeOptionKey[];
  defaults: Readonly<CreativeRecipeOptions>;
  /** Some recipes edit an existing image; the others can start from a written description. */
  requiresImage: boolean;
};
export const CREATIVE_RECIPE_OPTION_CHOICES = {
  grid: [{ value: '2x2', label: '四宫格' }, { value: '3x3', label: '九宫格' }, { value: '5x5', label: '二十五宫格' }],
  direction: [{ value: 'before', label: '向前推演' }, { value: 'after', label: '向后推演' }],
  seconds: [{ value: 3, label: '3 秒' }, { value: 5, label: '5 秒' }],
  lighting: [{ value: 'soft-daylight', label: '柔和日光' }, { value: 'golden-hour', label: '黄金时刻' }, { value: 'neon-night', label: '霓虹夜景' }, { value: 'studio', label: '影棚布光' }],
  tone: [{ value: 'natural-film', label: '自然胶片' }, { value: 'warm-vintage', label: '暖调复古' }, { value: 'cool-suspense', label: '冷调悬疑' }, { value: 'black-white', label: '黑白电影' }],
} as const;
export const IMAGE_CREATIVE_ACTIONS: readonly ImageCreativeAction[] = [
  { id: 'story-grid', label: '剧情推演', description: '根据描述或参考图，生成一张连续叙事分镜图。', group: '分镜叙事', icon: 'grid', options: ['grid'], defaults: { grid: '2x2' }, requiresImage: false },
  { id: 'blocking-board', label: '调度分镜草图', description: '用草图和箭头表达人物走位、视线与摄影机运动。', group: '分镜叙事', icon: 'blocking', options: ['grid'], defaults: { grid: '2x2' }, requiresImage: false },
  { id: 'multi-angle', label: '多机位九宫格', description: '围绕同一主体尝试九种构图和拍摄角度。', group: '机位', icon: 'camera', options: [], defaults: {}, requiresImage: false },
  { id: 'character-sheet', label: '角色设定板', description: '整合正侧背视图、面部和服饰细节。', group: '设定', icon: 'character', options: [], defaults: {}, requiresImage: false },
  { id: 'scene-sheet', label: '场景设定板', description: '展示场景全貌、空间关系和局部细节。', group: '设定', icon: 'scene', options: [], defaults: {}, requiresImage: false },
  { id: 'product-sheet', label: '产品设定板', description: '展示产品多视图、材质与结构细节。', group: '设定', icon: 'product', options: [], defaults: {}, requiresImage: false },
  { id: 'time-shift', label: '时间推演', description: '想象原图几秒之前或之后的一张画面。', group: '分镜叙事', icon: 'time', options: ['direction', 'seconds'], defaults: { direction: 'after', seconds: 3 }, requiresImage: true },
  { id: 'relight', label: '重新布光', description: '保持主体与构图，尝试不同光照氛围。', group: '质感', icon: 'light', options: ['lighting'], defaults: { lighting: 'soft-daylight' }, requiresImage: true },
  { id: 'cinematic-grade', label: '电影调色', description: '保持画面内容，尝试电影色彩与明暗质感。', group: '质感', icon: 'film', options: ['tone'], defaults: { tone: 'natural-film' }, requiresImage: true },
];
export const IMAGE_CREATIVE_RECIPE_NOTICE = '这些预设通过提示词引导图像模型，效果取决于模型；创建草稿后需手动生成。不是原生超分、真实三维重建、图层分割或无缝全景功能。';
export const MAX_CREATIVE_USER_PROMPT_LENGTH = 16000;

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function getImageCreativeAction(id: unknown): ImageCreativeAction | undefined {
  return IMAGE_CREATIVE_ACTIONS.find((action) => action.id === id);
}
/** Unknown versions, IDs and option values fail closed instead of silently changing intent. */
export function normalizeCreativeRecipe(value: unknown): ImageCreativeRecipe | null {
  if (!record(value) || value.version !== 1 || Object.keys(value).some((key) => !['version', 'id', 'options'].includes(key))) return null;
  const action = getImageCreativeAction(value.id);
  if (!action || (value.options !== undefined && !record(value.options))) return null;
  const input = (value.options ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!action.options.includes(key as CreativeRecipeOptionKey)) return null;
    const choices = CREATIVE_RECIPE_OPTION_CHOICES[key as CreativeRecipeOptionKey];
    if (!choices.some((choice) => choice.value === input[key])) return null;
  }
  return { version: 1, id: action.id, options: { ...action.defaults, ...input } as CreativeRecipeOptions };
}
export function createCreativeRecipe(id: ImageCreativeActionId, options: CreativeRecipeOptions = {}): ImageCreativeRecipe | null {
  return normalizeCreativeRecipe({ version: 1, id, options });
}
export type CreativeRecipeInputContext = { hasImageReference: boolean; hasPrompt: boolean };
export type CreativeRecipeInputIssue = 'invalid-recipe' | 'image-required' | 'prompt-required';
/** Invalid metadata fails closed. Selection remains available before its inputs are ready. */
export function creativeRecipeRequiresImage(value: unknown): boolean {
  const recipe = normalizeCreativeRecipe(value);
  return !recipe || getImageCreativeAction(recipe.id)!.requiresImage;
}
/** Pass the raw user prompt / connected text state, never the compiled recipe boilerplate. */
export function validateCreativeRecipeInput(value: unknown, context: CreativeRecipeInputContext): CreativeRecipeInputIssue | null {
  const recipe = normalizeCreativeRecipe(value);
  if (!recipe) return 'invalid-recipe';
  if (context.hasImageReference) return null;
  if (creativeRecipeRequiresImage(recipe)) return 'image-required';
  return context.hasPrompt ? null : 'prompt-required';
}
/** hasPrompt includes connected text compiled separately by the shared input pipeline. */
export type CreativeRecipePromptContext = { hasImageReference: boolean; hasPrompt?: boolean };
function gridInstruction(grid: NonNullable<CreativeRecipeOptions['grid']>): string {
  const side = Number(grid[0]);
  return `布局：${grid} 等分网格，共 ${side * side} 格，合成在一张图内。阅读顺序从左到右、从上到下。每格等宽等高，画面铺满各格；无格间留白、无边框、无黑边、无标题栏，方便按等分网格裁切。`;
}
const lightingPrompts: Record<NonNullable<CreativeRecipeOptions['lighting']>, string> = {
  'soft-daylight': '柔和自然日光，宽阔柔光源、细腻阴影与自然肤色',
  'golden-hour': '黄金时刻暖色低角度侧逆光、温暖高光和柔和长阴影',
  'neon-night': '夜间霓虹环境光，克制的冷暖色光对比与可信的反射',
  studio: '专业影棚主光、补光和轮廓光，清晰层次与自然阴影',
};
const tonePrompts: Record<NonNullable<CreativeRecipeOptions['tone']>, string> = {
  'natural-film': '自然胶片色彩、柔和高光过渡、适度细颗粒和真实肤色',
  'warm-vintage': '暖调复古胶片、柔和对比、克制褪色与细腻颗粒',
  'cool-suspense': '冷调悬疑电影、偏冷阴影、克制饱和度与有层次的暗部',
  'black-white': '黑白电影调色、丰富灰阶、清晰明暗层次与细腻颗粒',
};
/** Call only when compiling a new request; immutable historical request snapshots stay unchanged. */
export function compileCreativeRecipePrompt(userPrompt: string, value: unknown, context: CreativeRecipePromptContext = { hasImageReference: true }): string {
  const recipe = normalizeCreativeRecipe(value);
  if (!recipe) throw new Error('创意预设数据无效或版本不受支持，请重新选择预设。');
  if (typeof userPrompt !== 'string' || userPrompt.length > MAX_CREATIVE_USER_PROMPT_LENGTH) throw new Error('补充提示词过长，请缩短后重试。');
  const inputIssue = validateCreativeRecipeInput(recipe, { hasImageReference: context.hasImageReference, hasPrompt: context.hasPrompt === true || userPrompt.trim().length > 0 });
  if (inputIssue === 'image-required') throw new Error('此创作预设需要参考图片，请先添加或连接图片。');
  if (inputIssue === 'prompt-required') throw new Error('请先描述要创作的内容，或连接文字 / 参考图片。');
  const { id, options } = recipe;
  let instruction: string;
  switch (id) {
    case 'story-grid': instruction = `${gridInstruction(options.grid!)}${context.hasImageReference ? '以参考原图为叙事起点' : '以用户描述的角色、场景和事件为叙事起点'}，按时间顺序推演连续、可理解的动作和情节。各格保持角色、服装、道具、场景与空间方向连续；用景别和动作变化讲述故事，避免只是重复${context.hasImageReference ? '原图' : '同一画面'}。`; break;
    case 'blocking-board': instruction = `${gridInstruction(options.grid!)}绘制简洁、可读的调度故事板草图。保留角色外形辨识度和关键空间关系；使用少量明确箭头表示人物走位、视线和摄影机运动，区分主体运动与机位运动。每格表达一个连续调度步骤，不添加长段文字。`; break;
    case 'multi-angle': instruction = `${gridInstruction('3x3')}展示同一时刻、同一主体的九种机位：正面全景、正面中景、正面特写、左侧四分之三、右侧四分之三、侧面、背面、俯拍、低机位仰拍。保持场景布局与主体身份一致，遮挡处仅作合理视觉推测。`; break;
    case 'character-sheet': instruction = `${gridInstruction('3x3')}绘制同一角色的设定板，依次展示正面全身、侧面全身、背面全身、面部正面、面部侧面、表情变化、服装细节、配饰细节、标志性姿态。严格保持脸型、发型、体型、服装配色和身份特征，不生成不同人物。`; break;
    case 'scene-sheet': instruction = `${gridInstruction('3x3')}制作同一场景的设定板，依次展示全景、反向视角、侧向视角、俯视空间关系、入口、主要活动区域、建筑材质、关键道具、环境细节。保持建筑结构、地理关系和视觉风格一致；不可见部分仅作合理概念推测。`; break;
    case 'product-sheet': instruction = `${gridInstruction('3x3')}制作同一产品的设定板，依次展示正面、侧面、背面、顶部、三分之四视角、材质近景、连接结构细节、功能部位细节、使用情境。保留产品轮廓、比例、颜色、材质和原有标识；不新增品牌文字，不宣称工程尺寸准确。`; break;
    case 'time-shift': instruction = `输出单幅完整画面，不使用拼贴或多格。想象参考原图发生${options.direction === 'before' ? '之前' : '之后'} ${options.seconds} 秒的一个瞬间。根据原图中的动作、视线与环境合理推演，保持同一角色、场景和运动连续性。这是静态画面的创意推测，不是视频帧提取或真实时间还原。`; break;
    case 'relight': instruction = `输出单幅完整画面，不使用拼贴或多格。仅改变布光与相应阴影、反射：${lightingPrompts[options.lighting!]}。保持原有主体身份、姿态、构图、镜头和场景结构，避免改变服装或添加物件。`; break;
    case 'cinematic-grade': instruction = `输出单幅完整画面，不使用拼贴或多格。进行电影风格色彩与明暗处理：${tonePrompts[options.tone!]}。保持主体身份、姿态、构图、物件与场景内容，仅调整色彩、对比和视觉质感。`; break;
  }
  const parts = [
    '【图像创意预设】',
    context.hasImageReference
      ? '使用当前连接并固定的原始参考图作为视觉依据，而不是把其他结果当作原图。保留参考图中主体的身份、关键外观、比例与辨识特征。只生成一张输出图像；多格属于这一张图内部的布局，不是多张独立输出。'
      : '根据用户提供的文字描述创作，先建立清晰的主体、外观与场景设计，再在各个视图中保持一致。只生成一张输出图像；多格属于这一张图内部的布局，不是多张独立输出。',
    instruction,
    '以上是对图像模型的视觉生成指引，不代表原生超分、真实三维重建、图层分割或无缝全景处理。不要添加水印或无关文字。',
  ];
  if (userPrompt.length) parts.push('【用户补充要求（原文）】', userPrompt);
  return parts.join('\n\n');
}
