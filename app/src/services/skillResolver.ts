import type { SkillManifest } from "./skillRegistry";

export type SkillResolutionCandidate = {
  skillId: string;
  name: string;
  score: number;
  reason: string;
};

export type SkillResolution = {
  skillId: string | null;
  confidence: number;
  reason: string;
  candidates: SkillResolutionCandidate[];
};

// Require at least one trigger hit (worth 6) so a stray keyword in casual
// chat does not hijack routing into a Skill.
const MIN_SKILL_SCORE = 6;

const compact = (value: string) => value.toLowerCase().replace(/\s+/g, "");

const includesToken = (haystack: string, token: string) => {
  const normalized = compact(token);
  return normalized.length > 0 && haystack.includes(normalized);
};

export function resolveSkill(
  request: string,
  skills: SkillManifest[],
): SkillResolution {
  const text = compact(request);
  const candidates = skills
    .filter((skill) => skill.enabled !== false)
    .map((skill) => scoreSkill(text, skill))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));

  const best = candidates[0];
  if (!best || best.score < MIN_SKILL_SCORE) {
    return {
      skillId: null,
      confidence: 0,
      reason: "No installed skill crossed the match threshold.",
      candidates: candidates.slice(0, 5),
    };
  }

  return {
    skillId: best.skillId,
    confidence: Math.min(0.95, best.score / 14),
    reason: best.reason,
    candidates: candidates.slice(0, 5),
  };
}

function scoreSkill(text: string, skill: SkillManifest): SkillResolutionCandidate {
  let score = 0;
  const reasons: string[] = [];

  if (includesToken(text, `skill:${skill.id}`) || includesToken(text, `@${skill.id}`)) {
    score += 12;
    reasons.push("explicit skill id");
  }
  if (includesToken(text, skill.name)) {
    score += 8;
    reasons.push("skill name");
  }
  if (includesToken(text, skill.id)) {
    score += 5;
    reasons.push("skill id");
  }

  const matchedTriggers = skill.triggers.filter((trigger) => includesToken(text, trigger));
  if (matchedTriggers.length) {
    score += Math.min(12, matchedTriggers.length * 6);
    reasons.push(`trigger: ${matchedTriggers.slice(0, 2).join(", ")}`);
  }

  const matchedKeywords = skill.keywords.filter((keyword) => includesToken(text, keyword));
  if (matchedKeywords.length) {
    score += Math.min(10, matchedKeywords.length * 2);
    reasons.push(`keyword: ${matchedKeywords.slice(0, 4).join(", ")}`);
  }

  const descriptionHits = skill.description
    .split(/[,\s;:，。；：、]+/)
    .filter((token) => token.length >= 2 && includesToken(text, token));
  if (descriptionHits.length) {
    score += Math.min(3, descriptionHits.length);
    reasons.push("description overlap");
  }

  return {
    skillId: skill.id,
    name: skill.name,
    score,
    reason: reasons.join("; ") || "low lexical overlap",
  };
}
