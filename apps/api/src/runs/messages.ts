// User-facing run errors. Full details go to the server log, never the client.
export const RUN_ERRORS = {
  refusal: "That doesn't look like a playlist request.",
  notEnough: "Couldn't find enough tracks for that prompt.",
  timeout: "Generation took too long. Try again.",
  interrupted: "Generation was interrupted. Try again.",
  generic: "Something went wrong generating this playlist.",
} as const;
