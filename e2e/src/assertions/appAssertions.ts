/** Launch-health assertions only. Never re-export product flows from here. */
export function assertNoFatalLaunchErrors(errors: readonly string[]): void {
  if (errors.length > 0) {
    throw new Error(
      `Renderer reported ${errors.length} fatal launch error(s):\n${errors.map((e) => `  - ${e}`).join("\n")}`,
    );
  }
}
