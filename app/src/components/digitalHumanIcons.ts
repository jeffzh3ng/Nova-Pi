import { Activity, Bot, DatabaseZap } from "lucide-react";

/**
 * 内置数字员工 → 图标的映射，被 DigitalHumanPicker 与 EmployeeMentionPicker 共享。
 * 未命中的员工回退到通用 Bot 图标。
 */
export const digitalHumanIcons = {
  "data-security-risk-assessment": DatabaseZap,
  "alert-analysis": Activity,
} as const;

export const resolveDigitalHumanIcon = (humanId: string) =>
  digitalHumanIcons[humanId as keyof typeof digitalHumanIcons] ?? Bot;
