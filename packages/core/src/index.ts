export type InvocationMode = "investigate" | "fix";

export function parseInvocationMode(
  text: string | undefined,
): InvocationMode | null {
  const normalized = text?.trim().toLowerCase();

  if (normalized === "@draftsman investigate") {
    return "investigate";
  }

  if (normalized === "@draftsman fix") {
    return "fix";
  }

  return null;
}

export function describeInvocation(): string {
  return "@draftsman investigate | @draftsman fix";
}
