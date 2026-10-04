import base from "./playwright.config";
export default {
  ...base,
  projects: (base.projects ?? []).map((project) =>
    /chromium/.test(project.name ?? "")
      ? { ...project, use: { ...project.use, launchOptions: { args: ["--disable-audio-output"] } } }
      : project,
  ),
};
