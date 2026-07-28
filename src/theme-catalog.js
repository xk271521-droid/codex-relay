import { ENFP_THEME_CSS } from "./enfp-theme-css.js";
import { INSPIRATION_SCRAPBOOK_THEME_CSS } from "./inspiration-scrapbook-theme-css.js";

const THEMES = Object.freeze([
  {
    id: "inspiration-notes",
    name: "ENFP 灵感版",
    description: "清新明亮的创意工作室：留出可靠的阅读区，把灵感集中在画面右侧。",
    accent: "#0f918e",
    preview: "/themes/enfp-fresh-background.webp",
    image: "/themes/enfp-fresh-background.webp",
    appearance: "light",
    art: Object.freeze({
      focusX: 0.78,
      focusY: 0.44,
      safeArea: "left",
      taskMode: "ambient",
    }),
    palette: Object.freeze({ accent: "oklch(0.63 0.13 180)" }),
    artMetadata: Object.freeze({ ratio: 16 / 9 }),
    brand: "ENFP 灵感发动机",
    signature: "今天适合开脑洞",
    badge: "好点子 +99",
    headline: "先有灵感，再把它变成真的",
    subheadline: "脑暴、试错、灵感乱飞，但最后都能落地。",
    cards: Object.freeze([
      Object.freeze(["灵感脑暴", "把脑子里的一万种可能都倒出来", "围绕当前项目做一次发散脑暴，给出最值得尝试的方向和各自的落地步骤。"]),
      Object.freeze(["快速原型", "想法不等人，先跑起来再说", "基于当前项目做一个可运行的最小原型，保留现有结构并说明验证方式。"]),
      Object.freeze(["边玩边改", "改到爽为止，体验即正义", "检查当前界面的主要使用流程，找出最影响体验的问题并直接修复。"]),
      Object.freeze(["欢乐修 Bug", "Bug 不可怕，把它变成段子吧", "诊断当前最明显的问题，修复根因并增加足够的回归测试。"]),
    ]),
    css: ENFP_THEME_CSS,
  },
  {
    id: "inspiration-scrapbook",
    name: "ENFP 灵感手帐",
    description: "暖白纸感、跳色涂鸦和四张行动卡：把脑洞做成今天能完成的作品。",
    accent: "#16a99d",
    preview: "/themes/inspiration-scrapbook-background.webp",
    image: "/themes/inspiration-scrapbook-background.webp",
    appearance: "light",
    art: Object.freeze({
      focusX: 0.79,
      focusY: 0.44,
      safeArea: "left",
      taskMode: "ambient",
    }),
    palette: Object.freeze({ accent: "oklch(0.64 0.145 184)" }),
    artMetadata: Object.freeze({ ratio: 16 / 9 }),
    brand: "ENFP 灵感手帐",
    signature: "今天适合把点子变成作品",
    badge: "灵感 +99",
    headline: "先有灵感，再把它变成真的",
    subheadline: "先把想法写下来，再用一张张行动卡把它落到今天。",
    cards: Object.freeze([
      Object.freeze(["灵感脑暴", "把一万个可能写成可选方向", "围绕当前项目做一次发散脑暴，给出最值得尝试的方向和各自的落地步骤。"]),
      Object.freeze(["快速原型", "想法不等人，先让它跑起来", "基于当前项目做一个可运行的最小原型，保留现有结构并说明验证方式。"]),
      Object.freeze(["边玩边改", "从体验里找出最值得修的地方", "检查当前界面的主要使用流程，找出最影响体验的问题并直接修复。"]),
      Object.freeze(["欢乐修 Bug", "把卡住的地方变成下一个好点子", "诊断当前最明显的问题，修复根因并增加足够的回归测试。"]),
    ]),
    css: INSPIRATION_SCRAPBOOK_THEME_CSS,
  },
]);

export function themeCatalog() {
  return THEMES.map(({ css: _css, ...theme }) => ({ ...theme }));
}

export function themeById(id) {
  return THEMES.find((theme) => theme.id === id) || null;
}

export function themeCss(id) {
  return themeById(id)?.css || "";
}
